// ═══════════════════════════════════════════════════════════════════
// SANDBOX MAIN CONTROLLER
// ═══════════════════════════════════════════════════════════════════

import { loadSileroVAD, startVAD, stopVAD, isVADReady, enableDebug } from './vad.js';
import { playTTSAudio, clearTTSQueue } from './tts.js';
import {
    sendAccumulatedAudioSocket,
    setAuthToken as setRestAuthToken,
    setVoice as setRestVoice,
    sendAccumulatedAudio,
    startRESTRecording,
    stopRESTRecording,
    isTokenValid,
    refreshAuthToken
} from './rest-client.js';
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
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        }

        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');

        // Start REST recording
        startRESTRecording(localStream);

        if (currentMode === 'vad') {
            // VAD mode: start VAD with auto-send on silence
            sendLog('⚡ VAD mode - auto-send on silence', 'info');
            startVAD(localStream, {
                onSpeechStart: () => sendVADStatus(true),
                onSpeechEnd: () => {
                    sendVADStatus(false);
                    sendAccumulatedAudioSocket({
                        onTranscript: sendTranscript,
                        onResponse: sendResponse,
                        onTTS: handleTTS,
                        onLog: sendLog
                    });
                },
                onAudioData: (data, isTalking) => {
                    // Required callback - VAD needs this
                    // Energy visualization could go here
                }
            });
        } else {
            // PTT mode: just record, send happens on stop_mic
            sendLog('🎤 PTT mode - send on stop', 'info');
        }

        isActive = true;
        startMicInProgress = false;
        sendStreaming('rest');
        sendStatus('REST Recording');
        sendLog('🎤 ' + (currentMode === 'vad' ? 'VAD' : 'PTT') + ' mode active', 'success');

    } catch (e) {
        sendLog('REST mode failed: ' + e.message, 'error');
        sendError(e.message);
        startMicInProgress = false;
    }
}

// ═══════════════════════════════════════════════════════════════════
// START MIC
// ═══════════════════════════════════════════════════════════════════

async function startMic(mode = 'vad') {
    if (startMicInProgress) {
        sendLog('⚠️ Already starting mic, ignoring duplicate', 'warn');
        return;
    }
    startMicInProgress = true;
    currentMode = mode;

    const token = getAuthToken();

    if (!token) {
        sendLog('❌ No auth token', 'error');
        sendError('No authentication token');
        startMicInProgress = false;
        return;
    }

    // ✅ ENSURE TOKEN IS SET IN REST CLIENT BEFORE ANYTHING
    setRestAuthToken(token);
    sendLog('🔐 Token set for REST client', 'info');

    sendLog('🚀 Starting mic...', 'info');

    try {
        // First try to get mic access
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
        } catch (micError) {
            sendLog('❌ Mic access denied: ' + micError.message, 'error');
            sendError('Microphone access denied. Click on the page first, then try again.');
            startMicInProgress = false;
            return;
        }

        sendLog('🎤 Mic: ' + localStream.getAudioTracks()[0].label, 'success');
        sendLog('⚡ Using REST mode', 'info');
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

    // If PTT mode, send accumulated audio before stopping
    if (currentMode === 'ptt') {
        sendLog('📤 PTT: sending accumulated audio', 'info');
        sendAccumulatedAudioSocket({
            onTranscript: sendTranscript,
            onResponse: sendResponse,
            onTTS: handleTTS,
            onLog: sendLog
        });
    }

    stopRESTRecording();
    stopVAD();
    clearTTSQueue();
    currentMode = null;

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
    // Connect to Gateway via Socket.io for real-time voice
    const socket = io('https://surf-gateway.onrender.com', {
        transports: ['websocket', 'polling']
    });
    socket.on('connect', () => {
        sendLog('🔌 Socket.io connected', 'success');
        window.surfSocket = socket;
    });
    socket.on('disconnect', () => sendLog('🔌 Socket.io disconnected', 'warn'));
    sendLog('🔄 Initializing sandbox...', 'info');

    try {
        await loadSileroVAD();
        sendLog('✅ VAD loaded', 'success');
    } catch (e) {
        sendLog('⚠️ VAD failed to load: ' + e.message, 'warn');
    }

    // Core message handlers
    onMessage('start_mic', (msg) => startMic(msg.mode || 'vad'));
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
            tokenValid: isTokenValid()
        });
    });

    // ✅ Set REST token when received from extension
    onMessage('auth_token', (msg) => {
        sendLog('🔐 REST token received from extension', 'info');
        setRestAuthToken(msg.token);
    });

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

    // ✅ Set REST auth token if already available
    const token = getAuthToken();
    if (token) {
        setRestAuthToken(token);
        sendLog('✅ REST token available', 'success');
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
            vadReady: isVADReady()
        }),
        refreshToken: refreshAuthToken,
        resetState: () => {
            startMicInProgress = false;
            resetTokenState();
        },
        // Pre-request mic permission (must be called from a click)
        requestMic: async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
                sendLog('🎤 Mic permission granted', 'success');
                return true;
            } catch (e) {
                sendLog('❌ Mic permission denied', 'error');
                return false;
            }
        }
    };
}

init();