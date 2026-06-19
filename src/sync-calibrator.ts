import SynAudio from 'synaudio';
import { SnapStream } from './snapstream';

export interface CalibrationResult {
    offsetMs: number;
    correlation: number;
}

export class CalibrationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CalibrationError';
    }
}

// Concatenates an array of Float32Array chunks into one.
function concat(chunks: Float32Array[]): Float32Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

export async function calibrate(
    snapStream: SnapStream,
    durationMs: number = 8000,
    onProgress?: (elapsed: number, total: number) => void,
): Promise<CalibrationResult> {
    const sampleRate = snapStream.sampleRate;

    // --- Reference tap: collect what getNextBuffer produces (pre-gain, float32) ---
    const refChunks: Float32Array[] = [];
    snapStream.startReferenceTap((left) => {
        refChunks.push(left);
    });

    // --- Mic capture via a separate native AudioContext ---
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
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        });
    } catch (err) {
        snapStream.stopReferenceTap();
        throw new CalibrationError(
            err instanceof Error ? err.message : 'Microphone access denied',
        );
    }

    // Use a native AudioContext at the stream's sample rate so samples are
    // directly comparable with the reference without resampling arithmetic.
    const micCtx = new AudioContext({ sampleRate });
    const micSource = micCtx.createMediaStreamSource(micStream);
    // ScriptProcessorNode is deprecated but universally supported in browsers
    // and avoids the AudioWorklet module-file requirement. Calibration runs
    // only briefly (≤10s) so the deprecation trade-off is acceptable.
    const micProcessor = micCtx.createScriptProcessor(4096, 1, 1);
    const micChunks: Float32Array[] = [];

    micProcessor.onaudioprocess = (e) => {
        micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    micSource.connect(micProcessor);
    // Must be connected to a destination or browsers won't fire onaudioprocess.
    micProcessor.connect(micCtx.destination);

    // Wait for the recording window.
    await new Promise<void>((resolve) => {
        const startMs = performance.now();
        const tick = () => {
            const elapsed = performance.now() - startMs;
            onProgress?.(elapsed, durationMs);
            if (elapsed >= durationMs) {
                resolve();
            } else {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    });

    // Stop capture.
    snapStream.stopReferenceTap();
    micProcessor.disconnect();
    micSource.disconnect();
    micStream.getTracks().forEach((t) => t.stop());
    await micCtx.close();

    const refMono = concat(refChunks);
    const micMono = concat(micChunks);

    if (refMono.length < sampleRate || micMono.length < sampleRate) {
        throw new CalibrationError('Not enough audio captured. Is music playing?');
    }

    // synaudio requires the comparison to be a subset of the base.
    // Use mic as base (longer in practice due to getUserMedia startup lag),
    // reference as comparison trimmed by 0.5s each side to ensure containment.
    const trimSamples = Math.floor(sampleRate * 0.5);
    const refTrimmed = refMono.length > trimSamples * 2
        ? refMono.slice(trimSamples, refMono.length - trimSamples)
        : refMono;

    const synAudio = new SynAudio({ correlationSampleSize: 11025, correlationThreshold: 0.3 });

    const result = await synAudio.sync(
        { channelData: [micMono],   samplesDecoded: micMono.length },
        { channelData: [refTrimmed], samplesDecoded: refTrimmed.length },
    );

    if (!isFinite(result.correlation) || result.correlation < 0.3) {
        throw new CalibrationError(
            'Could not match audio — make sure music is playing on the target device ' +
            'and hold this device close to its speaker.',
        );
    }

    // sampleOffset: where refTrimmed[0] aligns within micMono.
    // Positive → mic has N samples of audio before the reference starts
    //           → the target device played that content N samples AFTER snapweb did
    //           → the target device is N samples BEHIND (playing late)
    //           → increase its Snapcast latency to make it play earlier
    // Negative → target device is AHEAD (playing early)
    //           → decrease its Snapcast latency
    // Caller applies: newLatency = currentLatency + offsetMs
    //
    // The trim shifts the comparison forward by trimSamples relative to the original
    // reference, so subtract trimSamples to recover wall-clock-aligned offset.
    const rawOffsetSamples = result.sampleOffset - trimSamples;
    const offsetMs = (rawOffsetSamples / sampleRate) * 1000;

    return { offsetMs, correlation: result.correlation };
}
