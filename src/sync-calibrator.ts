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
            this.micMono   = captures.micMono;
            this.refWindow = captures.refWindow;
            this.sampleRate = captures.sampleRate;
        }
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

    // synaudio requires the comparison to be shorter than the base so it can
    // slide it to find the best alignment. Taking a fixed 2s window from the
    // middle of the reference (rather than trimming both ends) maximises the
    // search range: with a 4s mic recording, this gives ~2s of searchable
    // offset range (±1s). A larger correlationSampleSize (~1s) gives synaudio
    // enough musical structure for reliable matching even with reverb/noise.
    const windowSamples = Math.min(Math.floor(sampleRate * 2), Math.floor(refMono.length * 0.6));
    const windowStart = Math.floor((refMono.length - windowSamples) / 2);
    const refWindow = refMono.slice(windowStart, windowStart + windowSamples);

    const synAudio = new SynAudio({ correlationSampleSize: 44100, correlationThreshold: 0.3 });

    const result = await synAudio.sync(
        { channelData: [micMono],  samplesDecoded: micMono.length },
        { channelData: [refWindow], samplesDecoded: refWindow.length },
    );

    if (!isFinite(result.correlation) || result.correlation < 0.3) {
        throw new CalibrationError(
            'Could not match audio — make sure music is playing on the target device ' +
            'and hold this device close to its speaker.',
            { micMono, refWindow, sampleRate },
        );
    }

    // result.sampleOffset: where refWindow[0] aligns within micMono.
    // refWindow[0] is refMono[windowStart], so the wall-clock offset is:
    //   offsetSamples = sampleOffset - windowStart
    // Positive → target played that content later than snapweb → target is BEHIND
    // Negative → target is AHEAD
    // Caller applies: newLatency = currentLatency + offsetMs
    const rawOffsetSamples = result.sampleOffset - windowStart;
    const offsetMs = (rawOffsetSamples / sampleRate) * 1000;

    return { offsetMs, correlation: result.correlation, micMono, refWindow, sampleRate };
}
