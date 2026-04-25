// ═══════════════════════════════════════════════════════════════════
// POST MESSAGE COMMUNICATION WITH EXTENSION
// ═══════════════════════════════════════════════════════════════════

let messageHandlers = {};
let authToken = null;
let isSandboxReady = false;
let tokenReceived = false;

// ═══════════════════════════════════════════════════════════════════
// SEND MESSAGES TO EXTENSION
// ═══════════════════════════════════════════════════════════════════

function postMessage(data) {
    if (window.parent && window.parent !== window) {
        window.parent.postMessage(data, '*');
    }
}

function sendStatus(text) {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = `⚡ ${text}`;
    postMessage({ type: 'status', text: text });
}

function sendLog(message, level = 'info') {
    console.log(`[Sandbox] ${message}`);
    postMessage({ type: 'log', level: level, message: message });
}

function sendTranscript(text) {
    postMessage({ type: 'transcript', text: text });
}

function sendResponse(text) {
    postMessage({ type: 'response', text: text });
}

function sendTTSPlaying() {
    postMessage({ type: 'tts_playing' });
}

function sendStreaming(mode) {
    postMessage({ type: 'streaming', mode: mode });
}

function sendVADStatus(speaking) {
    postMessage({ type: 'vad', speaking: speaking });
}

function sendAuthSuccess(userId, sessionId) {
    postMessage({ type: 'auth_success', userId: userId, sessionId: sessionId });
}

function sendAuthError(error) {
    postMessage({ type: 'auth_error', error: error });
}

function sendError(message) {
    postMessage({ type: 'error', message: message });
}

function sendDisconnected() {
    postMessage({ type: 'disconnected' });
}

function sendTokenReceived() {
    postMessage({ type: 'token_received' });
}

function sendNotesUpdated(notes) {
    postMessage({ type: 'notes_updated', notes: notes });
}

function sendSettingsUpdated(settings) {
    postMessage({ type: 'settings_updated', settings: settings });
}

function sendChatResponse(text) {
    postMessage({ type: 'chat_response', text: text });
}

function sendCallStatus(status, data = {}) {
    postMessage({ type: 'call_status', status: status, ...data });
}

function sendQuizResponse(quiz) {
    postMessage({ type: 'quiz_response', quiz: quiz });
}

function sendSummaryResponse(summary) {
    postMessage({ type: 'summary_response', summary: summary });
}

// ═══════════════════════════════════════════════════════════════════
// RECEIVE MESSAGES FROM EXTENSION
// ═══════════════════════════════════════════════════════════════════

function onMessage(type, handler) {
    messageHandlers[type] = handler;
}

function getAuthToken() {
    return authToken;
}

function isReady() {
    return isSandboxReady;
}

// Extension commands
function handleExtensionCommand(msg) {
    switch (msg.action) {
        case 'getVoices':
            postMessage({ type: 'voices', voices: [
                { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'female' },
                { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'male' },
                { id: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', gender: 'female' },
                { id: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', gender: 'male' }
            ]});
            break;
        case 'getNotes':
            postMessage({ type: 'notes_updated', notes: notes || [] });
            break;
        case 'saveNote':
            if (msg.note) {
                notes = notes || [];
                notes.push({ id: Date.now(), text: msg.note, timestamp: new Date().toISOString() });
            }
            postMessage({ type: 'notes_updated', notes });
            break;
        case 'deleteNote':
            notes = (notes || []).filter(n => n.id !== msg.noteId);
            postMessage({ type: 'notes_updated', notes });
            break;
        case 'getSettings':
            postMessage({ type: 'settings_updated', settings });
            break;
        case 'updateSettings':
            settings = { ...settings, ...msg.settings };
            postMessage({ type: 'settings_updated', settings });
            break;
        case 'scanPage':
            // Forward to AI
            startMic('ptt');
            break;
        case 'startMic':
            startMic(msg.mode || 'ptt');
            break;
        case 'stopMic':
            stopMic();
            break;
        case 'sendText':
            sendTextToAI(msg.text);
            break;
        case 'setVoice':
            setVoice(msg.voice);
            break;
    }
}

// Setup message listener
window.addEventListener('message', (event) => {
    const msg = event.data;

    if (msg.type === 'auth_token') {
        if (tokenReceived) { console.log('[Sandbox] Ignoring duplicate auth_token'); return; }
        tokenReceived = true;
        authToken = msg.token;
        sendLog('🔐 Auth token received');
        sendTokenReceived();
        window.authToken = authToken;
        // Authenticate socket when token arrives
        if (window.surfSocket && window.surfSocket.connected) {
            window.surfSocket.emit('authenticate', { token: msg.token });
            console.log('[Sandbox] Socket authenticated');
        }
    }

    const handler = messageHandlers[msg.type];
    if (handler) {
        handler(msg);
    } else {
        if (msg.type !== 'log') {
            sendLog(`📨 Received: ${msg.type}`);
        }
    }
});

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

// Socket.io response listeners
function setupSocketListeners() {
    const socket = window.surfSocket;
    if (!socket) return;
    socket.on('transcript', (data) => {
        console.log('[Socket] transcript:', data.text);
        sendTranscript(data.text);
    });
    socket.on('response', (data) => {
        console.log('[Socket] response:', data.text);
        sendResponse(data.text);
    });
    socket.on('tts', (data) => {
        console.log('[Socket] tts audio received');
        postMessage({ type: 'tts_audio', audio: data.audio });
    });
}

function markReady() {
    isSandboxReady = true;
    // Setup socket listeners if socket is connected
    setTimeout(() => {
        if (window.surfSocket && window.surfSocket.connected) {
            setupSocketListeners();
            sendLog('Socket listeners ready', 'info');
        }
    }, 500);
    sendLog('Sandbox ready');
    sendStatus('Ready');
    postMessage({ type: 'sandbox_ready' });
}

// ✅ Reset token state (for reconnection)
function resetTokenState() {
    tokenReceived = false;
    authToken = null;
}

export {
    setupSocketListeners,
    postMessage,
    sendStatus,
    sendLog,
    sendTranscript,
    sendResponse,
    sendTTSPlaying,
    sendStreaming,
    sendVADStatus,
    sendAuthSuccess,
    sendAuthError,
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
    isReady,
    markReady,
    resetTokenState
};