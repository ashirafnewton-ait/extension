// ═══════════════════════════════════════════════════════════════════
// WEBRTC CLIENT MODULE (Mediasoup)
// ═══════════════════════════════════════════════════════════════════

const GATEWAY_URL = 'https://surf-gateway.onrender.com';

let socket = null;
let device = null;
let producerTransport = null;
let audioProducer = null;
let isConnected = false;
let authToken = null;
let reconnectTimer = null;
let pingInterval = null;
let authTimeout = null;
let isConnecting = false;

// Callbacks
let onStatusChange = null;
let onLog = null;
let onTTS = null;
let onTranscript = null;
let onResponse = null;

// ═══════════════════════════════════════════════════════════════════
// SOCKET KEEP-ALIVE
// ═══════════════════════════════════════════════════════════════════

function startKeepAlive() {
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
        if (socket && socket.connected) {
            socket.emit('ping');
        }
    }, 20000);
}

function stopKeepAlive() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// TRANSPORT SETUP
// ═══════════════════════════════════════════════════════════════════

async function requestRouterCapabilities() {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);

        socket.once('routerRtpCapabilities', (caps) => {
            clearTimeout(timeout);
            if (caps?.error) reject(new Error(caps.error));
            else resolve(caps);
        });

        socket.emit('getRouterRtpCapabilities');
    });
}

async function createProducerTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('createProducerTransport', (response) => {
            if (response?.error) reject(new Error(response.error));
            else resolve(response);
        });
    });
}

async function setupWebRTC(stream) {
    try {
        if (onLog) onLog('📡 Requesting router capabilities...', 'info');

        const caps = await requestRouterCapabilities();
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: caps });
        if (onLog) onLog('📡 SFU ready', 'success');

        if (onLog) onLog('🔗 Creating producer transport...', 'info');
        const transportInfo = await createProducerTransport();

        producerTransport = device.createSendTransport({
            id: transportInfo.id,
            iceParameters: transportInfo.iceParameters,
            iceCandidates: transportInfo.iceCandidates,
            dtlsParameters: transportInfo.dtlsParameters
        });

        producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            if (onLog) onLog('🔗 Connecting transport...', 'info');
            socket.emit('connectProducerTransport', { dtlsParameters }, (res) => {
                if (res?.error) {
                    errback(new Error(res.error));
                } else {
                    if (onLog) onLog('✅ Transport connected', 'success');
                    callback();
                }
            });
        });

        producerTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            if (onLog) onLog('🎤 Producing audio...', 'info');
            socket.emit('produce', { kind, rtpParameters }, (res) => {
                if (res?.error) {
                    errback(new Error(res.error));
                } else {
                    if (onLog) onLog('✅ Producer created: ' + res.id?.slice(0, 8) + '...', 'success');
                    callback({ id: res.id });
                }
            });
        });

        producerTransport.on('connectionstatechange', (state) => {
            if (onLog) onLog('Transport: ' + state, 'info');
            if (state === 'connected') {
                isConnected = true;
                if (onStatusChange) onStatusChange('SFU Streaming');
            }
        });

        audioProducer = await producerTransport.produce({
            track: stream.getAudioTracks()[0],
            codecOptions: { opusStereo: false, opusDtx: true, opusFec: true }
        });

        if (onLog) onLog('🎉 SFU fully connected!', 'success');
        return true;

    } catch (e) {
        if (onLog) onLog('SFU setup failed: ' + e.message, 'error');
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════

async function connectWebRTC(token, stream, callbacks) {
    // ✅ Prevent duplicate connections
    if (isConnecting) {
        if (callbacks.onLog) callbacks.onLog('⚠️ Already connecting, ignoring duplicate', 'warn');
        return false;
    }
    isConnecting = true;

    authToken = token;
    onStatusChange = callbacks.onStatusChange;
    onLog = callbacks.onLog;
    onTTS = callbacks.onTTS;
    onTranscript = callbacks.onTranscript;
    onResponse = callbacks.onResponse;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
    }

    if (!authToken) {
        if (onLog) onLog('❌ No auth token', 'error');
        isConnecting = false;
        return false;
    }

    socket = io(GATEWAY_URL, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });

    return new Promise((resolve) => {
        let resolved = false;

        socket.on('connect', () => {
            if (onLog) onLog('✅ Gateway connected', 'success');
            if (onStatusChange) onStatusChange('Gateway Connected');
            startKeepAlive();

            if (onLog) onLog('🔐 Authenticating with Gateway...', 'info');
            socket.emit('authenticate', { token: authToken });

            authTimeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    isConnecting = false;
                    if (onLog) onLog('❌ Authentication timeout', 'error');
                    resolve(false);
                }
            }, 10000);
        });

        socket.on('authenticated', async (response) => {
            if (authTimeout) {
                clearTimeout(authTimeout);
                authTimeout = null;
            }

            if (onLog) onLog('📨 Received authenticated event', 'debug');

            if (response?.success) {
                if (onLog) onLog(`✅ Authenticated as ${response.user_id?.slice(0, 8)}...`, 'success');
                if (onLog) onLog(`🏠 Room: ${response.room_name}`, 'info');

                const success = await setupWebRTC(stream);
                isConnected = success;

                if (!resolved) {
                    resolved = true;
                    isConnecting = false;
                    resolve(success);
                }
            } else {
                if (onLog) onLog('❌ Auth failed: ' + (response?.error || 'Unknown'), 'error');
                if (!resolved) {
                    resolved = true;
                    isConnecting = false;
                    resolve(false);
                }
            }
        });

        socket.on('connect_error', (e) => {
            if (onLog) onLog('Connection error: ' + e.message, 'error');
            if (!resolved) {
                resolved = true;
                isConnecting = false;
                resolve(false);
            }
        });

        socket.on('disconnect', (reason) => {
            if (onLog) onLog('Gateway disconnected: ' + reason, 'warn');
            isConnected = false;
            stopKeepAlive();
            if (onStatusChange) onStatusChange('Disconnected');

            if (authToken && !reconnectTimer) {
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    isConnecting = false;
                    if (onLog) onLog('🔄 Reconnecting...', 'info');
                    connectWebRTC(authToken, stream, callbacks);
                }, 2000);
            }
        });

        socket.on('tts_audio', (data) => {
            if (data?.audio && onTTS) onTTS(data.audio);
            if (data?.transcript && onTranscript) onTranscript(data.transcript);
            if (data?.response && onResponse) onResponse(data.response);
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
// DISCONNECT
// ═══════════════════════════════════════════════════════════════════

function disconnectWebRTC() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
    }

    stopKeepAlive();

    if (audioProducer) {
        try { audioProducer.close(); } catch (e) {}
        audioProducer = null;
    }
    if (producerTransport) {
        try { producerTransport.close(); } catch (e) {}
        producerTransport = null;
    }
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }

    device = null;
    isConnected = false;
    isConnecting = false;
}

function isWebRTCConnected() {
    return isConnected && socket?.connected;
}

export { connectWebRTC, disconnectWebRTC, isWebRTCConnected };