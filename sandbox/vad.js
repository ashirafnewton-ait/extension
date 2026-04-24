// ═══════════════════════════════════════════════════════════════════
// SILERO VAD MODULE
// ═══════════════════════════════════════════════════════════════════

let vadSession = null;
let ort = null;
let vadReady = false;
let audioContext = null;
let analyser = null;
let isSpeaking = false;
let silenceTimer = null;
let animationFrame = null;

const SILENCE_THRESHOLD = 1.0; // seconds (faster real-time response)

// Debug logging (can be enabled from extension)
let debugEnabled = false;

// ═══════════════════════════════════════════════════════════════════
// DEBUG LOGGING (SENDS TO EXTENSION)
// ═══════════════════════════════════════════════════════════════════

function debugLog(message, data = {}) {
    if (!debugEnabled) return;
    
    console.log(`[VAD Debug] ${message}`, data);
    
    // Send to parent extension if available
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({
            type: 'vad_debug',
            message: message,
            data: data,
            timestamp: Date.now()
        }, '*');
    }
}

function enableDebug(enabled = true) {
    debugEnabled = enabled;
    debugLog('Debug ' + (enabled ? 'enabled' : 'disabled'));
}

// ═══════════════════════════════════════════════════════════════════
// LOAD MODEL
// ═══════════════════════════════════════════════════════════════════

async function loadSileroVAD() {
    // Skip ONNX model loading - not compatible with browser (missing STFT preprocessing)
    // Using energy-based VAD instead (96.9% F1 in Colab testing)
    vadReady = true;
    console.log('[VAD] ✅ Energy-based VAD ready (ONNX skipped)');
    debugLog('✅ Energy-based VAD ready');
    return true;
}

// ═══════════════════════════════════════════════════════════════════
// SPEECH DETECTION
// ═══════════════════════════════════════════════════════════════════

async function detectSpeech(audioChunk) {
    // USE ENERGY-BASED VAD (Silero ONNX doesn't work in browser - no STFT)
    // This scored 96.9% F1 vs Whisper in Colab testing
    const energy = audioChunk.reduce((a, b) => a + Math.abs(b - 128), 0) / audioChunk.length;
    const threshold = 8; // Energy threshold (tuned from Colab)
    const result = energy > threshold;
    return result;
}

// ═══════════════════════════════════════════════════════════════════
// VAD CONTROLLER
// ═══════════════════════════════════════════════════════════════════

function startVAD(stream, callbacks) {
    console.log('[VAD] startVAD called');
    console.log('[VAD] callbacks object:', callbacks);
    console.log('[VAD] callbacks keys:', Object.keys(callbacks || {}));
    
    const { onSpeechStart, onSpeechEnd, onAudioData } = callbacks || {};
    console.log('[VAD] onSpeechStart:', typeof onSpeechStart);
    console.log('[VAD] onSpeechEnd:', typeof onSpeechEnd);
    console.log('[VAD] onAudioData:', typeof onAudioData);
    
    if (!onSpeechEnd) {
        console.error('[VAD] FATAL: onSpeechEnd is not provided! Auto-send will NOT work.');
    }
    if (!onAudioData) {
        console.error('[VAD] FATAL: onAudioData is not provided! Frame analysis will be logged but callbacks wont fire.');
    }
    
    debugLog('Starting VAD');
    
    if (audioContext) audioContext.close();
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let frameCount = 0;

    async function checkAudio() {
        try {
            analyser.getByteTimeDomainData(dataArray);
            
            const isTalking = await detectSpeech(dataArray);
            
            frameCount++;
            
            // Always log first 20 frames and every 50th thereafter
            if (frameCount <= 20 || frameCount % 50 === 0) {
                const energy = dataArray.reduce((a, b) => a + Math.abs(b - 128), 0) / dataArray.length;
                console.log('[VAD] frame', frameCount, 'energy:', energy.toFixed(2), 'talking:', isTalking, 'speaking:', isSpeaking);
            }
            
            if (onAudioData) {
                onAudioData(dataArray, isTalking);
            }

            if (isTalking && !isSpeaking) {
                isSpeaking = true;
                console.log('[VAD] 🗣️ Speech STARTED');
                if (onSpeechStart) onSpeechStart();
                if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
            } else if (!isTalking && isSpeaking) {
                if (!silenceTimer) {
                    console.log('[VAD] 🔇 Silence detected, timer starting...');
                    silenceTimer = setTimeout(() => {
                        isSpeaking = false;
                        silenceTimer = null;
                        console.log('[VAD] 🔔 SILENCE TIMEOUT — sending audio');
                        if (onSpeechEnd) {
                            onSpeechEnd();
                        } else {
                            console.error('[VAD] FATAL: onSpeechEnd missing at timeout!');
                        }
                    }, SILENCE_THRESHOLD * 1000);
                }
            }
        } catch (e) {
            console.error('[VAD] checkAudio error:', e.message, e.stack);
        }
    }

    checkAudio();
    animationFrame = setInterval(checkAudio, 50); // Run every 50ms
}

function stopVAD() {
    debugLog('Stopping VAD');
    if (animationFrame) {
        clearInterval(animationFrame);
        animationFrame = null;
    }
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

function isVADReady() {
    return vadReady;
}

// Expose debug control to window
window.VADDebug = {
    enable: () => enableDebug(true),
    disable: () => enableDebug(false),
    status: () => ({ vadReady, isSpeaking, debugEnabled })
};

export { loadSileroVAD, startVAD, stopVAD, isVADReady, enableDebug };