// ═══════════════════════════════════════════════════════════════════
// REST CLIENT MODULE
// ═══════════════════════════════════════════════════════════════════

const GATEWAY_URL = 'https://surf-gateway.onrender.com';

let authToken = null;
let audioBuffer = [];
let mediaRecorder = null;
let chunkInterval = null;
let selectedVoice = 'en-US-AriaNeural';

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

function setAuthToken(token) { 
    authToken = token; 
}

function setVoice(voice) { 
    selectedVoice = voice; 
}

// ═══════════════════════════════════════════════════════════════════
// SEND AUDIO
// ═══════════════════════════════════════════════════════════════════

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
    setAuthToken, 
    setVoice,
    sendAccumulatedAudio, 
    startRESTRecording, 
    stopRESTRecording,
    isRecording
};