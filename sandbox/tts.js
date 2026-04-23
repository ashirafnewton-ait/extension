// ═══════════════════════════════════════════════════════════════════
// TTS QUEUE MODULE
// ═══════════════════════════════════════════════════════════════════

let ttsQueue = [];
let isPlaying = false;

// ═══════════════════════════════════════════════════════════════════
// DECODE AUDIO
// ═══════════════════════════════════════════════════════════════════

function decodeAudio(encodedAudio) {
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
    
    return bytes;
}

// ═══════════════════════════════════════════════════════════════════
// QUEUE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function playTTSAudio(encodedAudio) {
    return new Promise((resolve) => {
        ttsQueue.push({ encodedAudio, resolve });
        processTTSQueue();
    });
}

async function processTTSQueue() {
    if (isPlaying || ttsQueue.length === 0) return;
    
    isPlaying = true;
    const { encodedAudio, resolve } = ttsQueue.shift();
    
    try {
        const bytes = decodeAudio(encodedAudio);
        const blob = new Blob([bytes], { type: 'audio/mp3' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        
        audio.onended = () => {
            URL.revokeObjectURL(url);
            isPlaying = false;
            if (resolve) resolve();
            processTTSQueue();
        };
        
        audio.onerror = () => {
            URL.revokeObjectURL(url);
            isPlaying = false;
            if (resolve) resolve();
            processTTSQueue();
        };
        
        await audio.play();
    } catch (e) {
        console.error('[TTS] Playback error:', e);
        isPlaying = false;
        if (resolve) resolve();
        processTTSQueue();
    }
}

function clearTTSQueue() {
    ttsQueue = [];
    isPlaying = false;
}

function isTTSPlaying() {
    return isPlaying;
}

function getQueueLength() {
    return ttsQueue.length;
}

export { playTTSAudio, clearTTSQueue, isTTSPlaying, getQueueLength };