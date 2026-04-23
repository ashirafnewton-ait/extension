// ═══════════════════════════════════════════════════════════════════
// POST MESSAGE COMMUNICATION WITH EXTENSION
// ═══════════════════════════════════════════════════════════════════

let messageHandlers = {};
let authToken = null;
let isSandboxReady = false;

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

// Setup message listener
window.addEventListener('message', (event) => {
    const msg = event.data;
    
    if (msg.type === 'auth_token') {
        authToken = msg.token;
        sendLog('🔐 Auth token received');
        sendTokenReceived();
        window.authToken = authToken;
    }
    
    const handler = messageHandlers[msg.type];
    if (handler) {
        handler(msg);
    } else {
        sendLog(`📨 Received: ${msg.type}`);
    }
});

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

function markReady() {
    isSandboxReady = true;
    sendLog('Sandbox ready');
    sendStatus('Ready');
    postMessage({ type: 'sandbox_ready' });
}

export {
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
    onMessage,
    getAuthToken,
    isReady,
    markReady
};