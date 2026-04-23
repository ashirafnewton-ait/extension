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
    sendTokenReceived,
    sendNotesUpdated,
    sendSettingsUpdated,
    sendChatResponse,
    sendCallStatus,
    sendQuizResponse,
    sendSummaryResponse,
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
let notes = [];
let settings = {
    theme: 'dark',
    notifications: true,
    defaultVoice: 'en-US-AriaNeural'
};

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
        disconnectWebRTC();
        
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        }

        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');
        startRESTRecording(localStream);

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
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { 
                echoCancellation: true, 
                noiseSuppression: true, 
                autoGainControl: true 
            }
        });

        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');
        await attemptWebRTC(token);

    } catch (e) {
        sendLog('Failed to start: ' + e.message, 'error');
        sendError(e.message);

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// ATTEMPT WEBRTC
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

            startVAD(localStream, {
                onSpeechStart: () => sendVADStatus(true),
                onSpeechEnd: () => sendVADStatus(false)
            });

            setupWebRTCFallback(token);
            return;
        }

        handleWebRTCFailure(token);

    } catch (e) {
        sendLog('WebRTC error: ' + e.message, 'error');
        handleWebRTCFailure(token);
    }
}

function handleWebRTCFailure(token) {
    if (webrtcAttempts < MAX_WEBRTC_ATTEMPTS) {
        sendLog(`⏳ Retrying WebRTC in 2 seconds...`, 'warn');
        setTimeout(() => attemptWebRTC(token), 2000);
    } else {
        sendLog('⚠️ WebRTC failed, falling back to REST', 'warn');
        startRESTMode();
    }
}

function setupWebRTCFallback(token) {
    const checkInterval = setInterval(() => {
        if (currentMode === 'sfu' && !isWebRTCConnected()) {
            clearInterval(checkInterval);
            sendLog('🔌 WebRTC disconnected, falling back to REST', 'warn');
            if (currentMode === 'sfu') {
                startRESTMode();
            }
        }
        if (currentMode !== 'sfu') {
            clearInterval(checkInterval);
        }
    }, 3000);
    
    setTimeout(() => clearInterval(checkInterval), 60000);
}

// ═══════════════════════════════════════════════════════════════════
// STOP MIC
// ═══════════════════════════════════════════════════════════════════

function stopMic() {
    sendLog('Stopping mic...', 'info');
    isActive = false;
    webrtcAttempts = 0;

    disconnectWebRTC();
    stopRESTRecording();
    stopVAD();
    clearTTSQueue();

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
// HANDLE TOKEN UPDATE
// ═══════════════════════════════════════════════════════════════════

function handleTokenUpdate(token) {
    sendLog('🔐 Token updated', 'info');
    setRestAuthToken(token);
}

// ═══════════════════════════════════════════════════════════════════
// ✅ RESPONSE HANDLERS (NEW)
// ═══════════════════════════════════════════════════════════════════

function handleTranscribe(msg) {
    sendLog('📝 Transcribe requested', 'info');
    // TODO: Implement actual transcription
    sendTranscript('This is a test transcript response');
}

function handleChatMessage(msg) {
    sendLog('💬 Chat message: ' + msg.text?.substring(0, 50), 'info');
    // TODO: Call AI chat API
    sendChatResponse('AI response to: ' + msg.text);
    sendResponse('AI: I received your message!');
}

function handleSummarize(msg) {
    sendLog('📄 Summarize requested', 'info');
    // TODO: Call summarize API
    sendSummaryResponse('This is a test summary of the text.');
    sendResponse('📄 Summary: This is a test summary.');
}

function handleQuiz(msg) {
    sendLog('📝 Quiz requested', 'info');
    // TODO: Call quiz API
    const quiz = [
        { question: 'Test Q1?', options: ['A', 'B', 'C'], answer: 'A' }
    ];
    sendQuizResponse(quiz);
    sendResponse('📝 Quiz generated! Check the panel.');
}

function handleGetNotes() {
    sendLog('📋 Fetching notes...', 'info');
    sendNotesUpdated(notes);
}

function handleSaveNote(msg) {
    sendLog('💾 Saving note...', 'info');
    if (msg.note) {
        notes.push({ id: Date.now(), text: msg.note, timestamp: new Date().toISOString() });
    }
    sendNotesUpdated(notes);
}

function handleUpdateSettings(msg) {
    sendLog('⚙️ Updating settings...', 'info');
    if (msg.settings) {
        settings = { ...settings, ...msg.settings };
    }
    sendSettingsUpdated(settings);
}

function handleStartCall(msg) {
    sendLog('📞 Starting call to: ' + msg.peerId, 'info');
    sendCallStatus('calling', { peerId: msg.peerId });
    // TODO: Implement WebRTC call
}

function handleEndCall(msg) {
    sendLog('📞 Ending call: ' + msg.callId, 'info');
    sendCallStatus('ended', { callId: msg.callId });
}

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

async function init() {
    sendLog('🔄 Initializing sandbox...', 'info');
    
    try {
        await loadSileroVAD();
        sendLog('✅ VAD loaded', 'success');
    } catch (e) {
        sendLog('⚠️ VAD failed to load: ' + e.message, 'warn');
    }

    // Core message handlers
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

    // ✅ NEW: Response handlers
    onMessage('transcribe', handleTranscribe);
    onMessage('chat_message', handleChatMessage);
    onMessage('summarize', handleSummarize);
    onMessage('quiz', handleQuiz);
    onMessage('get_notes', handleGetNotes);
    onMessage('save_note', handleSaveNote);
    onMessage('update_settings', handleUpdateSettings);
    onMessage('start_call', handleStartCall);
    onMessage('end_call', handleEndCall);

    // Set REST auth token when received
    const token = getAuthToken();
    if (token) {
        setRestAuthToken(token);
        sendLog('✅ Token available', 'success');
    } else {
        sendLog('⏳ Waiting for auth token...', 'warn');
    }

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

init();