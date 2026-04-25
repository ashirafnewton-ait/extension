// ═══════════════════════════════════════════════════════════════════
// SANDBOX MAIN CONTROLLER
// ═══════════════════════════════════════════════════════════════════

import { loadSileroVAD, startVAD, stopVAD, isVADReady, enableDebug } from './vad.js';
import { playTTSAudio, clearTTSQueue } from './tts.js';
import {
    clearAudioBuffer,
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
    handleExtensionCommand,
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
let isBusy = false; // Block sends while waiting for response
let sendCooldown = false; // 2s cooldown after lock release

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
            // VAD mode: energy-based auto-send on silence
            sendLog('⚡ VAD mode active', 'info');
            startVAD(localStream, {
                onSpeechStart: () => { sendVADStatus(true); clearTTSQueue(); },
                onSpeechEnd: () => {
                    sendVADStatus(false);
                    if (isBusy || sendCooldown) {
                        sendLog('⏳ Busy/cooldown, skipping', 'info');
                        return;
                    }
                    isBusy = true;
                    sendAccumulatedAudioSocket({
                        onTranscript: sendTranscript,
                        onResponse: sendResponse,
                        onTTS: async (audio) => {
                            if (audio) await handleTTS(audio);
                            sendCooldown = true;
                            isBusy = false;
                            clearAudioBuffer();
                            if (window.resetVADState) window.resetVADState();
                            setTimeout(() => { sendCooldown = false; }, 2000);
                            sendLog('✅ Ready', 'info');
                        },
                        onLog: sendLog
                    });
                },
                onAudioData: () => {}
            });
        } else {
            // PTT mode: just record, send happens on stop_mic
            sendLog('🎤 PTT mode - send on stop', 'info');
        }

        isActive = true;
        window.currentVADMode = currentMode;
        window.currentVADMode = currentMode;
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
            onTTS: async (audio) => {
                        if (audio) await handleTTS(audio);
                        isBusy = false;
                        clearAudioBuffer(); if (window.resetVADState) window.resetVADState();
                        sendLog('✅ Ready for next', 'info');
                    },
                    onResponse: (text) => {
                        sendResponse(text);
                        // Release lock after response even if no TTS
                        setTimeout(() => { isBusy = false; clearAudioBuffer(); if (window.resetVADState) window.resetVADState(); sendLog('✅ Ready', 'info'); }, 3000);
                    },
            onLog: sendLog
        });
    }

    stopRESTRecording();
    if (window.micVad) { window.micVad.destroy(); window.micVad = null; }
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
    // Connect to Gateway via Socket.io (non-blocking)
    try {
        const socket = io('https://surf-gateway.onrender.com', {
            transports: ['websocket', 'polling']
        });
        socket.on('connect', () => {
            sendLog('🔌 Socket.io connected', 'success');
            window.surfSocket = socket;
            // Authenticate immediately if we have a token
            const token = getAuthToken();
            if (token) {
                socket.emit('authenticate', { token });
                sendLog('🔌 Socket authenticated', 'info');
            }
        });
        socket.on('connect_error', () => sendLog('Socket.io unavailable, using REST', 'warn'));
        socket.on('disconnect', () => sendLog('🔌 Socket.io disconnected', 'warn'));
    } catch(e) {
        sendLog('Socket.io error, using REST', 'warn');
    }
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
        // Authenticate socket connection
        if (window.surfSocket && window.surfSocket.connected) {
            window.surfSocket.emit('authenticate', { token: msg.token });
            sendLog('🔌 Socket authenticated', 'info');
        }
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

    // Extension command handler
    onMessage('extension_command', handleExtensionCommand);

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
    function float32ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
}

// Text chat via REST
async function sendTextToAI(text) {
    if (!authToken || !text.trim()) return;
    sendLog('Text: ' + text.substring(0, 40), 'info');
    sendTranscript(text);
    try {
        const res = await fetch('https://surf-gateway.onrender.com/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ text, voice: selectedVoice })
        });
        const data = await res.json();
        if (data.response) sendResponse(data.response);
        if (data.audio_base64) handleTTS(data.audio_base64);
    } catch (e) { sendLog('Text error: ' + e.message, 'error'); }
}

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