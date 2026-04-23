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

        socket.on('routerRtpCapabilities', (caps) => {
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
        const caps = await requestRouterCapabilities();
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: caps });
        if (onLog) onLog('📡 SFU ready', 'success');

        const transportInfo = await createProducerTransport();
        producerTransport = device.createSendTransport({
            id: transportInfo.id,
            iceParameters: transportInfo.iceParameters,
            iceCandidates: transportInfo.iceCandidates,
            dtlsParameters: transportInfo.dtlsParameters
        });

        producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectProducerTransport', { dtlsParameters }, (res) => {
                if (res?.error) errback(new Error(res.error));
                else callback();
            });
        });

        producerTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            socket.emit('produce', { kind, rtpParameters }, (res) => {
                if (res?.error) errback(new Error(res.error));
                else callback({ id: res.id });
            });
        });

        producerTransport.on('connectionstatechange', (state) => {
            if (onLog) onLog('Transport: ' + state);
            if (state === 'connected') {
                if (onStatusChange) onStatusChange('SFU Streaming', 'sfu');
            }
        });

        audioProducer = await producerTransport.produce({
            track: stream.getAudioTracks()[0],
            codecOptions: { opusStereo: false, opusDtx: true, opusFec: true }
        });

        if (onLog) onLog('🎤 Producer created', 'success');
        return true;

    } catch (e) {
        if (onLog) onLog('SFU failed: ' + e.message, 'error');
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════

async function connectWebRTC(token, stream, callbacks) {
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

    if (!authToken) {
        if (onLog) onLog('❌ No auth token', 'error');
        return false;
    }

    socket = io(GATEWAY_URL, { 
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });

    return new Promise((resolve) => {
        socket.on('connect', async () => {
            if (onLog) onLog('✅ Gateway connected', 'success');
            if (onStatusChange) onStatusChange('Gateway Connected');
            startKeepAlive();
            
            socket.emit('authenticate', { token: authToken });
        });

        socket.on('authenticated', async (response) => {
            if (response?.success) {
                if (onLog) onLog(`✅ Authenticated as ${response.user_id?.slice(0, 8)}...`, 'success');
                
                const success = await setupWebRTC(stream);
                isConnected = success;
                resolve(success);
            } else {
                if (onLog) onLog('❌ Auth failed: ' + response?.error, 'error');
                resolve(false);
            }
        });

        socket.on('connect_error', (e) => {
            if (onLog) onLog('Connection error: ' + e.message, 'error');
            resolve(false);
        });

        socket.on('disconnect', (reason) => {
            if (onLog) onLog('Gateway disconnected: ' + reason, 'info');
            isConnected = false;
            stopKeepAlive();
            if (onStatusChange) onStatusChange('Disconnected');
            
            if (authToken) {
                reconnectTimer = setTimeout(() => connectWebRTC(token, stream, callbacks), 2000);
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
    
    stopKeepAlive();

    if (audioProducer) {
        audioProducer.close();
        audioProducer = null;
    }
    if (producerTransport) {
        producerTransport.close();
        producerTransport = null;
    }
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
    
    device = null;
    isConnected = false;
}

function isWebRTCConnected() {
    return isConnected;
}

export { connectWebRTC, disconnectWebRTC, isWebRTCConnected };