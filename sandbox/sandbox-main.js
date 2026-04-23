// ═══════════════════════════════════════════════════════════════════
// SANDBOX MAIN CONTROLLER
// ═══════════════════════════════════════════════════════════════════

import { loadSileroVAD, startVAD, stopVAD, isVADReady } from './vad.js';
import { playTTSAudio, clearTTSQueue } from './tts.js';
import { 
    setAuthToken as setRestAuthToken, 
    setVoice,
    sendAccumulatedAudio, 
    startRESTRecording, 
    stopRESTRecording 
} from './rest-client.js';
import { connectWebRTC, disconnectWebRTC } from './webrtc-client.js';
import {
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
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        
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
    
    sendLog('Starting mic...');
    
    try {
        // Try to get microphone first
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        
        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');
        
        // Try WebRTC first
        sendLog('📡 Attempting WebRTC SFU...', 'info');
        
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
            
            // Still start VAD for potential fallback
            startVAD(localStream, {
                onSpeechStart: () => sendVADStatus(true),
                onSpeechEnd: () => sendVADStatus(false)
            });
            
            return;
        }
        
        // Fallback to REST
        sendLog('⚠️ WebRTC failed, falling back to REST', 'warn');
        await startRESTMode();
        
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
// STOP MIC
// ═══════════════════════════════════════════════════════════════════

function stopMic() {
    sendLog('Stopping mic...');
    
    isActive = false;
    
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
    setVoice(voice); // Pass to REST client
    sendLog('Voice: ' + voice, 'info');
}

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

async function init() {
    // Load Silero VAD
    await loadSileroVAD();
    
    // Set up message handlers from extension
    onMessage('start_mic', startMic);
    onMessage('stop_mic', stopMic);
    onMessage('set_voice', (msg) => setVoice(msg.voice));
    onMessage('ping', () => postMessage({ type: 'pong', timestamp: Date.now() }));
    
    // Set REST auth token when received
    const token = getAuthToken();
    if (token) setRestAuthToken(token);
    
    // Mark as ready
    markReady();
    
    // Expose for debugging
    window.SurfSandbox = {
        start: startMic,
        stop: stopMic,
        setVoice: setVoice,
        getStatus: () => ({ isActive, currentMode, vadReady: isVADReady() })
    };
}

// Start everything
init();