'use strict';

const GATEWAY_URL = 'https://surf-gateway.onrender.com';

let socket = null;
let device = null;
let producerTransport = null;
let audioProducer = null;
let localStream = null;
let isConnected = false;
let mediaRecorder = null;
let chunkInterval = null;
let audioBuffer = [];

// Auth state
let authToken = null;
let userId = null;
let sessionId = null;
let isAuthenticated = false;
let authPending = false;
let reconnectTimer = null;
let pingInterval = null;

// Silero VAD
let vadSession = null;
let ort = null;
let isSpeaking = false;
let silenceTimer = null;
const SILENCE_THRESHOLD = 1.5;
let audioContext = null;
let analyser = null;
let vadReady = false;

// ═══════════════════════════════════════════════════════════════════
// POST MESSAGE TO EXTENSION
// ═══════════════════════════════════════════════════════════════════

function postMessage(data) {
    if (window.parent && window.parent !== window) {
        window.parent.postMessage(data, '*');
    }
}

function updateStatus(text) {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = `⚡ ${text}`;
    postMessage({ type: 'status', text: text });
}

function log(message, type = 'info') {
    console.log(`[Sandbox] ${message}`);
    postMessage({ type: 'log', level: type, message: message });
}

// ═══════════════════════════════════════════════════════════════════
// SILERO VAD (ONNX)
// ═══════════════════════════════════════════════════════════════════

async function loadSileroVAD() {
    try {
        log('📦 Loading Silero VAD model...', 'info');
        
        // Load ONNX runtime if not already available
        if (!window.ort) {
            const ortModule = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/esm/ort.min.js');
            ort = ortModule.default || ortModule;
        } else {
            ort = window.ort;
        }
        
        // Load model from same origin
        vadSession = await ort.InferenceSession.create('./silero_vad.onnx', {
            executionProviders: ['wasm', 'cpu']
        });
        
        vadReady = true;
        log('✅ Silero VAD loaded', 'success');
        return true;
    } catch (e) {
        log('⚠️ Silero VAD failed, using fallback: ' + e.message, 'warn');
        vadReady = false;
        return false;
    }
}

async function detectSpeechWithSilero(audioChunk) {
    if (!vadSession || !vadReady) return null;
    
    try {
        // Convert audio chunk to float32 array
        const float32Data = new Float32Array(audioChunk.length);
        for (let i = 0; i < audioChunk.length; i++) {
            float32Data[i] = (audioChunk[i] - 128) / 128.0;
        }
        
        // Create tensor and run inference
        const tensor = new ort.Tensor('float32', float32Data, [1, float32Data.length]);
        const results = await vadSession.run({ input: tensor });
        
        // Get speech probability
        const probability = results.output.data[0];
        return probability > 0.5;
    } catch (e) {
        console.warn('[VAD] Silero inference error:', e);
        return null;
    }
}

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
// TTS PLAYBACK
// ═══════════════════════════════════════════════════════════════════

function playTTSAudio(encodedAudio) {
    try {
        let bytes;
        if (encodedAudio.match(/^[0-9a-f]+$/i)) {
            bytes = new Uint8Array(encodedAudio.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else {
            const binaryString = atob(encodedAudio);
            bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
        }

        const blob = new Blob([bytes], { type: 'audio/mp3' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play();

        postMessage({ type: 'tts_playing' });
    } catch (e) {
        log('TTS error: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════
// VAD (Voice Activity Detection) - Uses Silero with fallback
// ═══════════════════════════════════════════════════════════════════

function startVAD(stream) {
    if (audioContext) audioContext.close();
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512; // Larger for better resolution
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    async function checkAudio() {
        if (!isConnected) return;

        analyser.getByteTimeDomainData(dataArray);
        
        // Try Silero first
        let isTalking = false;
        if (vadReady) {
            const result = await detectSpeechWithSilero(dataArray);
            if (result !== null) {
                isTalking = result;
            } else {
                // Fallback to simple threshold
                const average = dataArray.reduce((a, b) => a + Math.abs(b - 128), 0) / dataArray.length;
                isTalking = average > 10;
            }
        } else {
            // Simple threshold fallback
            const average = dataArray.reduce((a, b) => a + Math.abs(b - 128), 0) / dataArray.length;
            isTalking = average > 10;
        }

        if (isTalking && !isSpeaking) {
            isSpeaking = true;
            postMessage({ type: 'vad', speaking: true });
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
        } else if (!isTalking && isSpeaking) {
            if (!silenceTimer) {
                silenceTimer = setTimeout(() => {
                    isSpeaking = false;
                    silenceTimer = null;
                    postMessage({ type: 'vad', speaking: false });
                    sendAccumulatedAudio();
                }, SILENCE_THRESHOLD * 1000);
            }
        }

        requestAnimationFrame(checkAudio);
    }

    checkAudio();
}

function stopVAD() {
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
    isSpeaking = false;
}

// ═══════════════════════════════════════════════════════════════════
// REST CHUNKING (Fallback)
// ═══════════════════════════════════════════════════════════════════

function sendAccumulatedAudio() {
    if (audioBuffer.length === 0) return;

    const blob = new Blob(audioBuffer, { type: 'audio/webm' });
    sendChunkToREST(blob);
    audioBuffer = [];
    log('Sent after silence', 'info');
}

async function sendChunkToREST(audioBlob) {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'chunk.webm');
    formData.append('voice', 'en-US-AriaNeural');

    const headers = {};
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
        const res = await fetch(`${GATEWAY_URL}/voice`, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        const data = await res.json();
        if (data.transcript) {
            log('📝 ' + data.transcript);
            postMessage({ type: 'transcript', text: data.transcript });
        }
        if (data.response) {
            log('🤖 ' + data.response);
            postMessage({ type: 'response', text: data.response });
        }
        if (data.audio_base64) {
            playTTSAudio(data.audio_base64);
        }
    } catch (e) {
        log('REST error: ' + e.message, 'error');
    }
}

function startRESTRecording(stream) {
    audioBuffer = [];

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
            audioBuffer.push(e.data);
        }
    };

    mediaRecorder.start(1000);

    chunkInterval = setInterval(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.requestData();
        }
    }, 1000);

    startVAD(stream);
}

function stopRESTRecording() {
    if (chunkInterval) {
        clearInterval(chunkInterval);
        chunkInterval = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder = null;
    }
    stopVAD();
    audioBuffer = [];
}

// ═══════════════════════════════════════════════════════════════════
// MEDIASOUP WEBRTC (SFU Mode)
// ═══════════════════════════════════════════════════════════════════

async function setupWebRTC() {
    try {
        const caps = await requestRouterCapabilities();
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: caps });
        log('📡 SFU ready', 'success');

        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        log('🎤 Mic: ' + localStream.getAudioTracks()[0].label);
        
        // Start VAD for SFU mode
        startVAD(localStream);

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
            log('Transport: ' + state);
            if (state === 'connected') {
                updateStatus('SFU Streaming');
                postMessage({ type: 'streaming', mode: 'sfu' });
            }
        });

        audioProducer = await producerTransport.produce({
            track: localStream.getAudioTracks()[0],
            codecOptions: { opusStereo: false, opusDtx: true, opusFec: true }
        });

        log('🎤 Producer created', 'success');
        isConnected = true;

    } catch (e) {
        log('SFU failed: ' + e.message, 'error');
        updateStatus('Falling back to REST');
        await startRESTMode();
    }
}

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

async function connectMediasoup() {
    // Cancel any pending reconnect
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (!authToken) {
        log('❌ Cannot connect: No auth token', 'error');
        updateStatus('No auth token');
        postMessage({ type: 'error', message: 'No authentication token' });
        return;
    }

    // REUSE EXISTING SOCKET if connected
    if (socket && socket.connected) {
        log('✅ Reusing existing socket', 'success');
        
        if (!isAuthenticated) {
            log('🔐 Authenticating existing socket...', 'info');
            authPending = true;
            socket.emit('authenticate', { token: authToken });
        } else {
            log('✅ Already authenticated, setting up WebRTC...', 'success');
            setupWebRTC();
        }
        return;
    }

    // Create new socket only if needed
    log('📡 Creating new socket connection...', 'info');
    
    // Clean up old socket if exists
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
    }

    socket = io(GATEWAY_URL, { 
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });

    socket.on('connect', () => {
        log('✅ Gateway connected', 'success');
        updateStatus('Gateway Connected');
        startKeepAlive();
        
        log('🔐 Authenticating...', 'info');
        authPending = true;
        socket.emit('authenticate', { token: authToken });
    });

    socket.on('authenticated', (response) => {
        authPending = false;
        
        if (response?.success) {
            userId = response.user_id;
            sessionId = response.session_id;
            isAuthenticated = true;
            log(`✅ Authenticated as ${userId.slice(0, 8)}...`, 'success');
            updateStatus(`Auth: ${userId.slice(0, 8)}...`);
            postMessage({ type: 'auth_success', userId: userId, sessionId: sessionId });
            
            setupWebRTC();
        } else {
            log('❌ Auth failed: ' + (response?.error || 'Unknown error'), 'error');
            updateStatus('Auth Failed');
            postMessage({ type: 'auth_error', error: response?.error });
        }
    });

    socket.on('connect_error', (e) => {
        log('Connection error: ' + e.message, 'error');
        updateStatus('Connection Error');
        postMessage({ type: 'error', message: e.message });
    });

    socket.on('disconnect', (reason) => {
        log('Gateway disconnected: ' + reason, 'info');
        isConnected = false;
        isAuthenticated = false;
        stopKeepAlive();
        updateStatus('Disconnected');
        postMessage({ type: 'disconnected' });
        
        // Auto-reconnect after 2 seconds
        if (authToken) {
            log('🔄 Will reconnect in 2s...', 'info');
            reconnectTimer = setTimeout(() => connectMediasoup(), 2000);
        }
    });

    socket.on('tts_audio', (data) => {
        if (data?.audio) playTTSAudio(data.audio);
        if (data?.transcript) postMessage({ type: 'transcript', text: data.transcript });
        if (data?.response) postMessage({ type: 'response', text: data.response });
    });
}

async function startRESTMode() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });

        startRESTRecording(localStream);
        isConnected = true;
        updateStatus('REST Recording');
        postMessage({ type: 'streaming', mode: 'rest' });

        log('🎤 REST mode active', 'success');
    } catch (e) {
        log('REST mode failed: ' + e.message, 'error');
        postMessage({ type: 'error', message: e.message });
    }
}

function disconnect() {
    isConnected = false;
    isAuthenticated = false;
    authPending = false;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    stopKeepAlive();
    stopVAD();

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

    stopRESTRecording();

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }

    device = null;
    updateStatus('Ready');
    postMessage({ type: 'disconnected' });
}

// ═══════════════════════════════════════════════════════════════════
// MESSAGE HANDLER FROM EXTENSION
// ═══════════════════════════════════════════════════════════════════

window.addEventListener('message', (event) => {
    const msg = event.data;

    if (msg.type === 'auth_token') {
        authToken = msg.token;
        log('🔐 Auth token received');
        postMessage({ type: 'token_received' });
        window.authToken = authToken;
    } else if (msg.type === 'start_mic') {
        if (!authToken) {
            log('❌ No auth token - request auth first', 'error');
            postMessage({ type: 'error', message: 'No authentication token' });
            return;
        }
        log('Starting mic...');
        connectMediasoup();
    } else if (msg.type === 'stop_mic') {
        log('Stopping mic...');
        disconnect();
    } else if (msg.type === 'ping') {
        postMessage({ type: 'pong', timestamp: Date.now() });
    }
});

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

async function init() {
    log('Sandbox ready');
    updateStatus('Ready');
    
    // Load Silero VAD
    await loadSileroVAD();
    
    // Expose for debugging
    window.authToken = authToken;
    window.socket = socket;
    window.debug = { log, postMessage, connectMediasoup, disconnect };
    
    postMessage({ type: 'sandbox_ready' });
}

init();