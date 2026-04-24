// ═══════════════════════════════════════════════════════════════════
// REST CLIENT MODULE
// ═══════════════════════════════════════════════════════════════════

const GATEWAY_URL = 'https://surf-gateway.onrender.com';
const SUPABASE_URL = 'https://ljksgzttnufecxohwtwm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxqa3NnenR0bnVmZWN4b2h3dHdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxOTc1NzQsImV4cCI6MjA5MTc3MzU3NH0.jSnVFEe6w-fUA39iD7o9BP0EygB7yejofuU4GUbK6Bk';

let authToken = null;
let refreshToken = null;
let tokenExpiry = null;
let refreshTimer = null;
let audioBuffer = [];
let mediaRecorder = null;
let chunkInterval = null;
let selectedVoice = 'en-US-AriaNeural';

// ═══════════════════════════════════════════════════════════════════
// TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function setAuthToken(token, refresh = null) { 
    authToken = token;
    refreshToken = refresh;
    
    // Decode JWT to get expiry
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        tokenExpiry = payload.exp * 1000; // Convert to milliseconds
        scheduleTokenRefresh();
    } catch (e) {
        console.warn('[REST] Could not decode token expiry');
    }
}

function scheduleTokenRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!refreshToken || !tokenExpiry) return;
    
    const refreshTime = tokenExpiry - Date.now() - 60000; // Refresh 1 minute before expiry
    if (refreshTime <= 0) {
        refreshAuthToken();
    } else {
        refreshTimer = setTimeout(refreshAuthToken, refreshTime);
        console.log(`[REST] Token refresh scheduled in ${Math.round(refreshTime / 1000)}s`);
    }
}

async function refreshAuthToken() {
    if (!refreshToken) {
        console.warn('[REST] No refresh token available');
        return false;
    }
    
    try {
        console.log('[REST] 🔄 Refreshing token...');
        const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ refresh_token: refreshToken })
        });
        
        const data = await response.json();
        
        if (response.ok && data.access_token) {
            authToken = data.access_token;
            refreshToken = data.refresh_token;
            tokenExpiry = Date.now() + (data.expires_in * 1000);
            scheduleTokenRefresh();
            console.log('[REST] ✅ Token refreshed, expires in ' + data.expires_in + 's');
            return true;
        }
    } catch (e) {
        console.error('[REST] Token refresh failed:', e.message);
    }
    return false;
}

function getAuthToken() {
    return authToken;
}

function isTokenValid() {
    return authToken && tokenExpiry && Date.now() < tokenExpiry;
}

function clearTokenRefresh() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

function setVoice(voice) { 
    selectedVoice = voice; 
}

// ═══════════════════════════════════════════════════════════════════
// SEND AUDIO
// ═══════════════════════════════════════════════════════════════════

function sendAccumulatedAudioSocket(callbacks) {
    const { onTranscript, onResponse, onTTS, onLog } = callbacks;
    if (audioBuffer.length === 0) return;
    const blob = new Blob(audioBuffer, { type: 'audio/webm' });
    audioBuffer = [];
    
    const socket = window.surfSocket;
    
    // Setup listeners once
    if (socket && !socket._voiceListenersSet) {
        socket._voiceListenersSet = true;
        socket.on('transcript', (data) => {
            console.log('[Socket] transcript:', data.text);
            if (onTranscript) onTranscript(data.text);
        });
        socket.on('response', (data) => {
            console.log('[Socket] response:', data.text);
            if (onResponse) onResponse(data.text);
        });
        socket.on('tts', (data) => {
            console.log('[Socket] tts:', data.audio?.substring(0, 20));
            if (onTTS) onTTS(data.audio);
        });
    }
    
    if (blob.size < 2000) {
        if (onLog) onLog('📤 Skipped (silence)', 'info');
        return;
    }
    if (socket && socket.connected) {
        const reader = new FileReader();
        reader.onload = () => {
            socket.emit('voice', {
                audio: reader.result,
                voice: selectedVoice,
                token: authToken
            });
        };
        reader.readAsArrayBuffer(blob);
        if (onLog) onLog('📤 Sent via Socket.io', 'info');
    } else {
        if (blob.size >= 2000) {
            sendChunkToREST(blob, callbacks);
            if (onLog) onLog('📤 Sent via REST (fallback)', 'warn');
        }
    }
}

function sendAccumulatedAudio(callbacks) {
    const { onTranscript, onResponse, onTTS, onLog } = callbacks;
    
    if (audioBuffer.length === 0) return;

    const blob = new Blob(audioBuffer, { type: 'audio/webm' });
    sendChunkToREST(blob, callbacks);
    audioBuffer = [];
    
    if (onLog) onLog('📤 Sent after silence', 'info');
}

async function sendChunkToREST(audioBlob, callbacks) {
    const { onTranscript, onResponse, onTTS, onLog } = callbacks;
    
    // Check token validity before sending
    if (!isTokenValid() && refreshToken) {
        if (onLog) onLog('🔄 Token expired, refreshing...', 'warn');
        const refreshed = await refreshAuthToken();
        if (!refreshed) {
            if (onLog) onLog('❌ Token refresh failed', 'error');
            return null;
        }
    }
    
    const formData = new FormData();
    formData.append('audio', audioBlob, 'chunk.webm');
    formData.append('voice', selectedVoice);

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
        
        if (data.transcript && onTranscript) {
            onTranscript(data.transcript);
            if (onLog) onLog('📝 ' + data.transcript, 'transcript');
        }
        if (data.response && onResponse) {
            onResponse(data.response);
            if (onLog) onLog('🤖 ' + data.response, 'response');
        }
        if (data.audio_base64 && onTTS) {
            onTTS(data.audio_base64);
        }
        
        return data;
    } catch (e) {
        if (onLog) onLog('REST error: ' + e.message, 'error');
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════════
// RECORDING
// ═══════════════════════════════════════════════════════════════════

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
}

function stopRESTRecording() {
    clearTokenRefresh();
    if (chunkInterval) {
        clearInterval(chunkInterval);
        chunkInterval = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder = null;
    }
    audioBuffer = [];
}

function isRecording() {
    return mediaRecorder && mediaRecorder.state === 'recording';
}

export { 
    sendAccumulatedAudioSocket,
    setAuthToken,
    setVoice,
    sendAccumulatedAudio, 
    startRESTRecording, 
    stopRESTRecording,
    isRecording,
    getAuthToken,
    refreshAuthToken,
    isTokenValid
};