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
import { disconnectWebRTC, isWebRTCConnected } from './webrtc-client.js';
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
    markReady,
    resetTokenState
} from './messages.js';

// State
let isActive = false;
let localStream = null;
let currentMode = null;
let selectedVoice = 'en-US-AriaNeural';
let startMicInProgress = false;
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
// REST MODE (PRIMARY)
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
        startMicInProgress = false;
        sendStreaming('rest');
        sendStatus('REST Recording');
        sendLog('🎤 REST mode active', 'success');

    } catch (e) {
        sendLog('REST mode failed: ' + e.message, 'error');
        sendError(e.message);
        startMicInProgress = false;
    }
}

// ═══════════════════════════════════════════════════════════════════
// START MIC
// ═══════════════════════════════════════════════════════════════════

async function startMic() {
    if (startMicInProgress) {
        sendLog('⚠️ Already starting mic, ignoring duplicate', 'warn');
        return;
    }
    startMicInProgress = true;

    const token = getAuthToken();

    if (!token) {
        sendLog('❌ No auth token', 'error');
        sendError('No authentication token');
        startMicInProgress = false;
        return;
    }

    sendLog('🚀 Starting mic...', 'info');

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');

        // ✅ Skip WebRTC, use REST directly
        sendLog('⚡ Using REST mode (WebRTC RTP unavailable on this platform)', 'info');
        await startRESTMode();

    } catch (e) {
        sendLog('Failed to start: ' + e.message, 'error');
        sendError(e.message);
        startMicInProgress = false;

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
    sendLog('Stopping mic...', 'info');

    isActive = false;
    startMicInProgress = false;

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
// RESPONSE HANDLERS
// ═══════════════════════════════════════════════════════════════════

function handleTranscribe(msg) {
    sendLog('📝 Transcribe requested', 'info');
    sendTranscript('This is a test transcript response');
}

function handleChatMessage(msg) {
    sendLog('💬 Chat message: ' + msg.text?.substring(0, 50), 'info');
    sendChatResponse('AI response to: ' + msg.text);
    sendResponse('AI: I received your message!');
}

function handleSummarize(msg) {
    sendLog('📄 Summarize requested', 'info');
    sendSummaryResponse('This is a test summary of the text.');
    sendResponse('📄 Summary: This is a test summary.');
}

function handleQuiz(msg) {
    sendLog('📝 Quiz requested', 'info');
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

    // Response handlers
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
    sendLog('✅ Sandbox ready (REST mode)', 'success');

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
        resetState: () => {
            startMicInProgress = false;
            resetTokenState();
        }
    };
}

init();