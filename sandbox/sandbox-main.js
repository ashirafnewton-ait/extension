// ═══════════════════════════════════════════════════════════════════
// SANDBOX MAIN CONTROLLER
// ═══════════════════════════════════════════════════════════════════

import { loadSileroVAD, startVAD, stopVAD, isVADReady, enableDebug } from './vad.js';
import { playTTSAudio, clearTTSQueue } from './tts.js';
import { 
    setAuthToken as setRestAuthToken, 
    setVoice as setRestVoice,
    sendAccumulatedAudio, 
    startRESTRecording, 
    stopRESTRecording,
    isTokenValid,
    refreshAuthToken
} from './rest-client.js';
import { connectWebRTC, disconnectWebRTC, isWebRTCConnected } from './webrtc-client.js';
import {
    postMessage,
    sendStatus,
    sendLog,
    sendTranscript,
    sendResponse,
    sendStreaming,
    sendVADStatus,
    sendError,
    sendDisconnected,
    onMessage,
    getAuthToken,
    markReady
} from './messages.js';

// State
let isActive = false;
let localStream = null;
let currentMode = null; // 'sfu' or 'rest'
let selectedVoice = 'en-US-AriaNeural';
let webrtcAttempts = 0;
const MAX_WEBRTC_ATTEMPTS = 2;

// ═══════════════════════════════════════════════════════════════════
// TTS CALLBACK
// ═══════════════════════════════════════════════════════════════════

async function handleTTS(audioBase64) {
    await playTTSAudio(audioBase64);
}

// ═══════════════════════════════════════════════════════════════════
// REST MODE
// ═══════════════════════════════════════════════════════════════════

async function startRESTMode() {
    try {
        // Stop any existing WebRTC connection
        disconnectWebRTC();
        
        // Get fresh microphone stream if needed
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        }

        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');

        // Start REST recording
        startRESTRecording(localStream);

        // Start VAD
        startVAD(localStream, {
            onSpeechStart: () => sendVADStatus(true),
            onSpeechEnd: () => {
                sendVADStatus(false);
                sendAccumulatedAudio({
                    onTranscript: sendTranscript,
                    onResponse: sendResponse,
                    onTTS: handleTTS,
                    onLog: sendLog
                });
            }
        });

        isActive = true;
        currentMode = 'rest';
        sendStreaming('rest');
        sendStatus('REST Recording');
        sendLog('🎤 REST mode active', 'success');

    } catch (e) {
        sendLog('REST mode failed: ' + e.message, 'error');
        sendError(e.message);
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════════
// START MIC
// ═══════════════════════════════════════════════════════════════════

async function startMic() {
    const token = getAuthToken();

    if (!token) {
        sendLog('❌ No auth token', 'error');
        sendError('No authentication token');
        return;
    }

    sendLog('🚀 Starting mic...', 'info');
    webrtcAttempts = 0;

    try {
        // Get microphone stream
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { 
                echoCancellation: true, 
                noiseSuppression: true, 
                autoGainControl: true 
            }
        });

        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');

        // Try WebRTC first
        await attemptWebRTC(token);

    } catch (e) {
        sendLog('Failed to start: ' + e.message, 'error');
        sendError(e.message);

        // Cleanup
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// ATTEMPT WEBRTC (with retry)
// ═══════════════════════════════════════════════════════════════════

async function attemptWebRTC(token) {
    webrtcAttempts++;
    sendLog(`📡 Attempting WebRTC SFU... (attempt ${webrtcAttempts}/${MAX_WEBRTC_ATTEMPTS})`, 'info');

    try {
        const webrtcSuccess = await connectWebRTC(token, localStream, {
            onStatusChange: (status) => sendStatus(status),
            onLog: sendLog,
            onTTS: handleTTS,
            onTranscript: sendTranscript,
            onResponse: sendResponse
        });

        if (webrtcSuccess) {
            currentMode = 'sfu';
            isActive = true;
            webrtcAttempts = 0;
            
            sendStreaming('sfu');
            sendStatus('SFU Streaming');
            sendLog('✅ WebRTC SFU connected!', 'success');

            // Start VAD for potential fallback
            startVAD(localStream, {
                onSpeechStart: () => sendVADStatus(true),
                onSpeechEnd: () => sendVADStatus(false)
            });

            // Set up disconnect handler for auto-fallback
            setupWebRTCFallback(token);
            
            return;
        }

        // WebRTC failed
        handleWebRTCFailure(token);

    } catch (e) {
        sendLog('WebRTC error: ' + e.message, 'error');
        handleWebRTCFailure(token);
    }
}

// ═══════════════════════════════════════════════════════════════════
// HANDLE WEBRTC FAILURE
// ═══════════════════════════════════════════════════════════════════

function handleWebRTCFailure(token) {
    if (webrtcAttempts < MAX_WEBRTC_ATTEMPTS) {
        sendLog(`⏳ Retrying WebRTC in 2 seconds...`, 'warn');
        setTimeout(() => attemptWebRTC(token), 2000);
    } else {
        sendLog('⚠️ WebRTC failed after ' + MAX_WEBRTC_ATTEMPTS + ' attempts, falling back to REST', 'warn');
        startRESTMode();
    }
}

// ═══════════════════════════════════════════════════════════════════
// SETUP WEBRTC FALLBACK ON DISCONNECT
// ═══════════════════════════════════════════════════════════════════

function setupWebRTCFallback(token) {
    // Monitor WebRTC connection state
    const checkInterval = setInterval(() => {
        if (currentMode === 'sfu' && !isWebRTCConnected()) {
            clearInterval(checkInterval);
            sendLog('🔌 WebRTC disconnected, falling back to REST', 'warn');
            
            // Don't switch if already in REST mode
            if (currentMode === 'sfu') {
                startRESTMode();
            }
        }
        
        // Stop checking if mode changed
        if (currentMode !== 'sfu') {
            clearInterval(checkInterval);
        }
    }, 3000);
    
    // Clean up interval after 60 seconds max
    setTimeout(() => clearInterval(checkInterval), 60000);
}

// ═══════════════════════════════════════════════════════════════════
// STOP MIC
// ═══════════════════════════════════════════════════════════════════

function stopMic() {
    sendLog('Stopping mic...', 'info');

    isActive = false;
    webrtcAttempts = 0;

    // Stop WebRTC
    disconnectWebRTC();

    // Stop REST
    stopRESTRecording();

    // Stop VAD
    stopVAD();

    // Clear TTS queue
    clearTTSQueue();

    // Stop microphone
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }

    currentMode = null;
    sendStatus('Ready');
    sendDisconnected();
    sendLog('⏹️ Stopped', 'info');
}

// ═══════════════════════════════════════════════════════════════════
// SET VOICE
// ═══════════════════════════════════════════════════════════════════

function setVoice(voice) {
    selectedVoice = voice;
    setRestVoice(voice);
    sendLog('Voice: ' + voice, 'info');
}

// ═══════════════════════════════════════════════════════════════════
// HANDLE TOKEN UPDATE FROM EXTENSION
// ═══════════════════════════════════════════════════════════════════

function handleTokenUpdate(token) {
    sendLog('🔐 Token updated', 'info');
    setRestAuthToken(token);
    
    // If we're active in REST mode, update the token
    if (isActive && currentMode === 'rest') {
        setRestAuthToken(token);
    }
}

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

async function init() {
    sendLog('🔄 Initializing sandbox...', 'info');
    
    // Load Silero VAD
    try {
        await loadSileroVAD();
        sendLog('✅ VAD loaded', 'success');
    } catch (e) {
        sendLog('⚠️ VAD failed to load: ' + e.message, 'warn');
    }

    // Set up message handlers from extension
    onMessage('start_mic', startMic);
    onMessage('stop_mic', stopMic);
    onMessage('set_voice', (msg) => setVoice(msg.voice));
    onMessage('enable_vad_debug', () => enableDebug(true));
    onMessage('disable_vad_debug', () => enableDebug(false));
    onMessage('ping', () => postMessage({ type: 'pong', timestamp: Date.now() }));
    onMessage('get_status', () => {
        postMessage({
            type: 'sandbox_status',
            isActive,
            currentMode,
            vadReady: isVADReady(),
            tokenValid: isTokenValid(),
            webrtcConnected: isWebRTCConnected()
        });
    });
    onMessage('token_updated', (msg) => handleTokenUpdate(msg.token));

    // Set REST auth token when received
    const token = getAuthToken();
    if (token) {
        setRestAuthToken(token);
        sendLog('✅ Token available', 'success');
    } else {
        sendLog('⏳ Waiting for auth token...', 'warn');
    }

    // Mark as ready
    markReady();
    sendLog('✅ Sandbox ready', 'success');

    // Expose for debugging
    window.SurfSandbox = {
        start: startMic,
        stop: stopMic,
        setVoice: setVoice,
        getStatus: () => ({ 
            isActive, 
            currentMode, 
            vadReady: isVADReady(),
            webrtcConnected: isWebRTCConnected()
        }),
        refreshToken: refreshAuthToken,
        forceRest: startRESTMode,
        forceWebRTC: () => attemptWebRTC(getAuthToken())
    };
}

// Start everything
init();