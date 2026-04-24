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

const SILENCE_THRESHOLD = 1.5; // seconds

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
    try {
        debugLog('Loading Silero model...');
        
        if (!window.ort) {
            const ortModule = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/esm/ort.min.js');
            ort = ortModule.default || ortModule;
        ort.env.wasm.wasmPaths = './lib/';
            debugLog('ONNX Runtime loaded');
        } else {
            ort = window.ort;
        }
        
        vadSession = await ort.InferenceSession.create('./lib/silero_vad.onnx', {
            executionProviders: ['wasm', 'cpu']
        });
        
        vadReady = true;
        debugLog('✅ Silero VAD loaded successfully');
        console.log('[VAD] ✅ Silero VAD loaded');
        return true;
    } catch (e) {
        debugLog('⚠️ Silero failed, using fallback', { error: e.message });
        console.warn('[VAD] ⚠️ Silero failed, using fallback:', e.message);
        vadReady = false;
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════
// SPEECH DETECTION
// ═══════════════════════════════════════════════════════════════════

async function detectSpeech(audioChunk) {
    if (!vadSession || !vadReady) {
        // Fallback: simple threshold
        const average = audioChunk.reduce((a, b) => a + Math.abs(b - 128), 0) / audioChunk.length;
        const threshold = 10;
        const result = average > threshold;
        debugLog('Fallback detection', { average, threshold, result });
        return result;
    }
    
    try {
        const float32Data = new Float32Array(audioChunk.length);
        for (let i = 0; i < audioChunk.length; i++) {
            float32Data[i] = (audioChunk[i] - 128) / 128.0;
        }
        
        const tensor = new ort.Tensor('float32', float32Data, [1, float32Data.length]);
        const results = await vadSession.run({ input: tensor });
        const probability = results.output.data[0];
        const result = probability > 0.5;
        
        debugLog('Silero detection', { probability, result });
        return result;
    } catch (e) {
        debugLog('Detection error', { error: e.message });
        const average = audioChunk.reduce((a, b) => a + Math.abs(b - 128), 0) / audioChunk.length;
        return average > 10;
    }
}

// ═══════════════════════════════════════════════════════════════════
// VAD CONTROLLER
// ═══════════════════════════════════════════════════════════════════

function startVAD(stream, callbacks) {
    const { onSpeechStart, onSpeechEnd, onAudioData } = callbacks;
    
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
        analyser.getByteTimeDomainData(dataArray);
        
        const isTalking = await detectSpeech(dataArray);
        
        frameCount++;
        if (frameCount % 30 === 0) {
            debugLog('VAD status', { isTalking, isSpeaking });
        }
        
        if (onAudioData) onAudioData(dataArray, isTalking);

        if (isTalking && !isSpeaking) {
            isSpeaking = true;
            debugLog('Speech started');
            if (onSpeechStart) onSpeechStart();
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
        } else if (!isTalking && isSpeaking) {
            if (!silenceTimer) {
                debugLog(`Silence detected, waiting ${SILENCE_THRESHOLD}s`);
                silenceTimer = setTimeout(() => {
                    isSpeaking = false;
                    silenceTimer = null;
                    debugLog('Speech ended (silence timeout)');
                    if (onSpeechEnd) onSpeechEnd();
                }, SILENCE_THRESHOLD * 1000);
            }
        }

        animationFrame = requestAnimationFrame(checkAudio);
    }

    checkAudio();
}

function stopVAD() {
    debugLog('Stopping VAD');
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
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