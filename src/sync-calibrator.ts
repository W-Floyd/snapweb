import SynAudio from 'synaudio';
import { SnapStream } from './snapstream';

export interface CalibrationResult {
    offsetMs: number;
    correlation: number;
    /** Raw mono mic capture — for debug playback only. */
    micMono: Float32Array;
    /** Reference window used for correlation — for debug playback only. */
    refWindow: Float32Array;
    sampleRate: number;
}

export class CalibrationError extends Error {
    micMono?: Float32Array;
    refWindow?: Float32Array;
    sampleRate?: number;

    constructor(message: string, captures?: { micMono: Float32Array; refWindow: Float32Array; sampleRate: number }) {
        super(message);
        this.name = 'CalibrationError';
        if (captures) {
            this.micMono    = captures.micMono;
            this.refWindow  = captures.refWindow;
            this.sampleRate = captures.sampleRate;
        }
    }
}

function concat(chunks: Float32Array[]): Float32Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
}

// Bandpass filter via OfflineAudioContext (highpass + lowpass biquad chain).
async function bandpass(samples: Float32Array, sampleRate: number, lowHz = 200, highHz = 8000): Promise<Float32Array> {
    const ctx = new OfflineAudioContext(1, samples.length, sampleRate);
    const buf = ctx.createBuffer(1, samples.length, sampleRate);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = lowHz;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = highHz;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    return new Float32Array(rendered.getChannelData(0));
}

function rmsNormalize(samples: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    if (rms > 0) for (let i = 0; i < samples.length; i++) samples[i] /= rms;
}

// Decode a Blob of encoded audio (webm/ogg/etc.) and resample to targetRate.
async function decodeBlob(blob: Blob, targetRate: number): Promise<Float32Array> {
    const arrayBuffer = await blob.arrayBuffer();
    const decodeCtx = new AudioContext();
    let raw: AudioBuffer;
    try {
        raw = await decodeCtx.decodeAudioData(arrayBuffer);
    } finally {
        await decodeCtx.close();
    }

    if (raw.sampleRate === targetRate) {
        return new Float32Array(raw.getChannelData(0));
    }

    // Resample to targetRate using OfflineAudioContext.
    const targetLength = Math.ceil(raw.duration * targetRate);
    const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);
    const src = offlineCtx.createBufferSource();
    src.buffer = raw;
    src.connect(offlineCtx.destination);
    src.start();
    const resampled = await offlineCtx.startRendering();
    return new Float32Array(resampled.getChannelData(0));
}

export async function calibrate(
    snapStream: SnapStream,
    durationMs: number = 8000,
    onProgress?: (elapsed: number, total: number) => void,
): Promise<CalibrationResult> {
    const sampleRate = snapStream.sampleRate;

    // --- Reference tap: collect what getNextBuffer produces (pre-gain, float32) ---
    const refChunks: Float32Array[] = [];
    snapStream.startReferenceTap((left) => { refChunks.push(left); });

    // --- Mic capture via MediaRecorder (reliable on all browsers incl. Firefox) ---
    if (!navigator.mediaDevices?.getUserMedia) {
        snapStream.stopReferenceTap();
        throw new CalibrationError(
            'Microphone access requires a secure connection (HTTPS). ' +
            'Open this page over HTTPS and try again.',
        );
    }

    let micStream: MediaStream;
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
    } catch (err) {
        snapStream.stopReferenceTap();
        throw new CalibrationError(err instanceof Error ? err.message : 'Microphone access denied');
    }

    // Delay before starting capture so any tap/click sound from pressing the
    // button has faded before we record.
    const PRE_DELAY_MS = 500;
    await new Promise<void>((resolve) => {
        const startMs = performance.now();
        const tick = () => {
            if (onProgress) onProgress(0, durationMs);
            if (performance.now() - startMs >= PRE_DELAY_MS) resolve(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });

    const mediaRecorder = new MediaRecorder(micStream);
    const micBlobs: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) micBlobs.push(e.data); };
    mediaRecorder.start();

    // Wait for the recording window.
    await new Promise<void>((resolve) => {
        const startMs = performance.now();
        const tick = () => {
            const elapsed = performance.now() - startMs;
            onProgress?.(elapsed, durationMs);
            elapsed >= durationMs ? resolve() : requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });

    // Stop capture.
    snapStream.stopReferenceTap();
    await new Promise<void>((resolve) => { mediaRecorder.onstop = () => resolve(); mediaRecorder.stop(); });
    micStream.getTracks().forEach((t) => t.stop());

    const refMono = concat(refChunks);

    if (micBlobs.length === 0) {
        throw new CalibrationError('No audio was recorded from the microphone.');
    }

    const micBlob = new Blob(micBlobs, { type: micBlobs[0].type });
    const micMono = await decodeBlob(micBlob, sampleRate);

    if (refMono.length < sampleRate || micMono.length < sampleRate) {
        throw new CalibrationError('Not enough audio captured. Is music playing?');
    }

    const micPeak = micMono.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    if (micPeak < 0.001) {
        throw new CalibrationError(
            'Microphone is silent. Check that:\n' +
            '• System microphone permission is granted to this browser\n' +
            '• The correct input device is selected\n' +
            '• The microphone is not muted',
            { micMono, refWindow: new Float32Array(0), sampleRate },
        );
    }

    const micFiltered = await bandpass(micMono, sampleRate);
    rmsNormalize(micFiltered);

    const refFiltered = await bandpass(refMono, sampleRate);
    rmsNormalize(refFiltered);

    // synaudio requires the comparison to be shorter than the base so it can
    // slide it to find the best alignment. A fixed 2s window from the middle of
    // the reference gives ~2s of searchable offset range with a 4s mic recording.
    // correlationSampleSize of ~1s gives synaudio enough musical structure for
    // reliable matching even with room reverb and noise.
    const windowSamples  = Math.min(Math.floor(sampleRate * 2), Math.floor(refFiltered.length * 0.6));
    const windowStart    = Math.floor((refFiltered.length - windowSamples) / 2);
    const refWindow      = refFiltered.slice(windowStart, windowStart + windowSamples);
    const refWindowRaw   = refMono.slice(windowStart, windowStart + windowSamples);

    const synAudio = new SynAudio({ correlationSampleSize: 44100, correlationThreshold: 0.3 });
    const result = await synAudio.sync(
        { channelData: [micFiltered], samplesDecoded: micFiltered.length },
        { channelData: [refWindow],   samplesDecoded: refWindow.length },
    );

    if (!isFinite(result.correlation) || result.correlation < 0.3) {
        throw new CalibrationError(
            'Could not match audio — make sure music is playing on the target device ' +
            'and hold this device close to its speaker.',
            { micMono, refWindow: refWindowRaw, sampleRate },
        );
    }

    // result.sampleOffset: where refWindow[0] aligns within micMono.
    // refWindow[0] === refMono[windowStart], so the wall-clock offset is:
    //   offsetSamples = sampleOffset - windowStart
    // Positive → target played content later than snapweb → target is BEHIND
    // Negative → target is AHEAD
    // Caller applies: newLatency = currentLatency + offsetMs
    const rawOffsetSamples = result.sampleOffset - windowStart;
    const offsetMs = (rawOffsetSamples / sampleRate) * 1000;

    return { offsetMs, correlation: result.correlation, micMono, refWindow: refWindowRaw, sampleRate };
}
