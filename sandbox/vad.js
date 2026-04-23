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

// ═══════════════════════════════════════════════════════════════════
// LOAD MODEL
// ═══════════════════════════════════════════════════════════════════

async function loadSileroVAD() {
    try {
        console.log('[VAD] Loading Silero model...');
        
        if (!window.ort) {
            const ortModule = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/esm/ort.min.js');
            ort = ortModule.default || ortModule;
        } else {
            ort = window.ort;
        }
        
        vadSession = await ort.InferenceSession.create('./lib/silero_vad.onnx', {
            executionProviders: ['wasm', 'cpu']
        });
        
        vadReady = true;
        console.log('[VAD] ✅ Silero VAD loaded');
        return true;
    } catch (e) {
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
        return average > 10;
    }
    
    try {
        const float32Data = new Float32Array(audioChunk.length);
        for (let i = 0; i < audioChunk.length; i++) {
            float32Data[i] = (audioChunk[i] - 128) / 128.0;
        }
        
        const tensor = new ort.Tensor('float32', float32Data, [1, float32Data.length]);
        const results = await vadSession.run({ input: tensor });
        return results.output.data[0] > 0.5;
    } catch (e) {
        const average = audioChunk.reduce((a, b) => a + Math.abs(b - 128), 0) / audioChunk.length;
        return average > 10;
    }
}

// ═══════════════════════════════════════════════════════════════════
// VAD CONTROLLER
// ═══════════════════════════════════════════════════════════════════

function startVAD(stream, callbacks) {
    const { onSpeechStart, onSpeechEnd, onAudioData } = callbacks;
    
    if (audioContext) audioContext.close();
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    async function checkAudio() {
        analyser.getByteTimeDomainData(dataArray);
        
        const isTalking = await detectSpeech(dataArray);
        
        if (onAudioData) onAudioData(dataArray, isTalking);

        if (isTalking && !isSpeaking) {
            isSpeaking = true;
            if (onSpeechStart) onSpeechStart();
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
        } else if (!isTalking && isSpeaking) {
            if (!silenceTimer) {
                silenceTimer = setTimeout(() => {
                    isSpeaking = false;
                    silenceTimer = null;
                    if (onSpeechEnd) onSpeechEnd();
                }, SILENCE_THRESHOLD * 1000);
            }
        }

        animationFrame = requestAnimationFrame(checkAudio);
    }

    checkAudio();
}

function stopVAD() {
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

export { loadSileroVAD, startVAD, stopVAD, isVADReady };