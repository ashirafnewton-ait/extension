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
        console.log('[VAD] checkAudio loop started, frameCount:', frameCount);
        analyser.getByteTimeDomainData(dataArray);
        
        const isTalking = await detectSpeech(dataArray);
        
        frameCount++;
        if (frameCount % 30 === 0) {
            debugLog('VAD status', { isTalking, isSpeaking });
        }
        
        // Always log first 10 frames for debugging
        if (frameCount < 10 || frameCount % 100 === 0) {
            const energy = dataArray.reduce((a, b) => a + Math.abs(b - 128), 0) / dataArray.length;
            console.log('[VAD] frame', frameCount, 'energy:', energy.toFixed(2), 'speaking:', isTalking);
        }
        if (onAudioData) {
            onAudioData(dataArray, isTalking);
        } else {
            console.warn('[VAD] WARNING: onAudioData callback not set!');
        }

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
                    console.log('[VAD] 🔔 SILENCE TIMEOUT FIRED after ' + SILENCE_THRESHOLD + 's');
                    debugLog('Speech ended (silence timeout ' + SILENCE_THRESHOLD + 's)');
                    if (onSpeechEnd) {
                        console.log('[VAD] Calling onSpeechEnd callback...');
                        debugLog('Calling onSpeechEnd callback');
                        onSpeechEnd();
                        console.log('[VAD] onSpeechEnd callback completed');
                    } else {
                        console.error('[VAD] FATAL: onSpeechEnd is STILL not set at timeout!');
                        debugLog('WARNING: onSpeechEnd is not set!');
                    }
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