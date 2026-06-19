import { AudioContext, IAudioBuffer, IAudioContext, IAudioBufferSourceNode, IGainNode } from 'standardized-audio-context'
import { config } from './config'

// Decoders are loaded on demand via dynamic import so only the codec in use
// is fetched. Type-only imports are erased at compile time.
import type { FLACDecoderWebWorker, FLACDecodedAudio } from "@wasm-audio-decoders/flac";
import type { OggVorbisDecoderWebWorker, OggVorbisDecodedAudio } from "@wasm-audio-decoders/ogg-vorbis";
import type { OpusDecoderWebWorker, OpusDecoderSampleRate, OpusDecodedAudio } from "opus-decoder";


declare global {
    // declare window.webkitAudioContext for the ts compiler
    interface Window {
        webkitAudioContext: typeof AudioContext
    }
}

// declare AudioContext.outputLatency for the ts compiler
interface IAudioContextPatched extends IAudioContext {
    readonly getOutputTimestamp?: () => AudioTimestamp;
    readonly outputLatency: number;
}

class AudioContextPatched extends AudioContext implements IAudioContextPatched {
    get outputLatency(): number {
        const ctx = (<any>this)._nativeAudioContext;
        if (ctx && ctx.outputLatency !== undefined) {
            return ctx.outputLatency;
        }
        return 0;
    }
}

function getChromeVersion(): number | null {
    const raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);
    return raw ? parseInt(raw[2]) : null;
}

function uuidv4(): string {
    // crypto.randomUUID is only available in secure contexts (https/localhost);
    // fall back to a Math.random-based UUID when it's missing or throws.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        try {
            return crypto.randomUUID();
        } catch {
            /* fall through */
        }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
    });
}


class Tv {
    constructor(sec: number, usec: number) {
        this.sec = sec;
        this.usec = usec;
    }

    setMilliseconds(ms: number) {
        this.sec = Math.floor(ms / 1000);
        this.usec = Math.floor(ms * 1000) % 1000000;
    }

    getMilliseconds(): number {
        return this.sec * 1000 + this.usec / 1000;
    }

    sec: number = 0;
    usec: number = 0;
}


class BaseMessage {
    deserialize(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        this.type = view.getUint16(0, true);
        this.id = view.getUint16(2, true);
        this.refersTo = view.getUint16(4, true);
        this.received = new Tv(view.getInt32(6, true), view.getInt32(10, true));
        this.sent = new Tv(view.getInt32(14, true), view.getInt32(18, true));
        this.size = view.getUint32(22, true);
    }

    serialize(): ArrayBuffer {
        this.size = 26 + this.getSize();
        const buffer = new ArrayBuffer(this.size);
        const view = new DataView(buffer);
        view.setUint16(0, this.type, true);
        view.setUint16(2, this.id, true);
        view.setUint16(4, this.refersTo, true);
        view.setInt32(6, this.sent.sec, true);
        view.setInt32(10, this.sent.usec, true);
        view.setInt32(14, this.received.sec, true);
        view.setInt32(18, this.received.usec, true);
        view.setUint32(22, this.size, true);
        return buffer;
    }

    getSize() {
        return 0;
    }

    type: number = 0;
    id: number = 0;
    refersTo: number = 0;
    received: Tv = new Tv(0, 0);
    sent: Tv = new Tv(0, 0);
    size: number = 0;
}


class CodecMessage extends BaseMessage {
    constructor(buffer?: ArrayBuffer) {
        super();
        this.payload = new ArrayBuffer(0);
        if (buffer) {
            this.deserialize(buffer);
        }
        this.type = 1;
    }

    deserialize(buffer: ArrayBuffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        const codecSize = view.getInt32(26, true);
        const decoder = new TextDecoder("utf-8");
        this.codec = decoder.decode(buffer.slice(30, 30 + codecSize));
        const payloadSize = view.getInt32(30 + codecSize, true);
        console.debug("payload size: " + payloadSize);
        this.payload = buffer.slice(34 + codecSize, 34 + codecSize + payloadSize);
        console.debug("payload: " + this.payload);
    }

    codec: string = "";
    payload: ArrayBuffer;
}


class TimeMessage extends BaseMessage {
    constructor(buffer?: ArrayBuffer) {
        super();
        if (buffer) {
            this.deserialize(buffer);
        }
        this.type = 4;
    }

    deserialize(buffer: ArrayBuffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        this.latency = new Tv(view.getInt32(26, true), view.getInt32(30, true));
    }

    serialize(): ArrayBuffer {
        const buffer = super.serialize();
        const view = new DataView(buffer);
        view.setInt32(26, this.latency.sec, true);
        view.setInt32(30, this.latency.usec, true);
        return buffer;
    }

    getSize() {
        return 8;
    }

    latency: Tv = new Tv(0, 0);
}


class JsonMessage extends BaseMessage {
    constructor(buffer?: ArrayBuffer) {
        super();
        if (buffer) {
            this.deserialize(buffer);
        }
    }

    deserialize(buffer: ArrayBuffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        const size = view.getUint32(26, true);
        const decoder = new TextDecoder();
        this.json = JSON.parse(decoder.decode(buffer.slice(30, 30 + size)));
    }

    serialize(): ArrayBuffer {
        this._encoded = null; // force fresh encode for updated this.json
        const buffer = super.serialize(); // calls getSize() → encodes once, caches in _encoded
        const view = new DataView(buffer);
        // size must be the UTF-8 byte length, not the UTF-16 string length
        view.setUint32(26, this._encoded!.length, true);
        new Uint8Array(buffer).set(this._encoded!, 30);
        this._encoded = null;
        return buffer;
    }

    getSize() {
        if (!this._encoded)
            this._encoded = new TextEncoder().encode(JSON.stringify(this.json));
        return this._encoded.length + 4;
    }

    json: any;
    private _encoded: Uint8Array | null = null;
}


class HelloMessage extends JsonMessage {
    constructor(buffer?: ArrayBuffer) {
        super(buffer);
        if (buffer) {
            this.deserialize(buffer);
        }
        this.type = 5;
    }

    deserialize(buffer: ArrayBuffer) {
        super.deserialize(buffer);
        this.mac = this.json["MAC"];
        this.hostname = this.json["HostName"];
        this.version = this.json["Version"];
        this.clientName = this.json["ClientName"];
        this.os = this.json["OS"];
        this.arch = this.json["Arch"];
        this.instance = this.json["Instance"];
        this.uniqueId = this.json["ID"];
        this.snapStreamProtocolVersion = this.json["SnapStreamProtocolVersion"];
    }

    serialize(): ArrayBuffer {
        this.json = { "MAC": this.mac, "HostName": this.hostname, "Version": this.version, "ClientName": this.clientName, "OS": this.os, "Arch": this.arch, "Instance": this.instance, "ID": this.uniqueId, "SnapStreamProtocolVersion": this.snapStreamProtocolVersion };
        return super.serialize();
    }

    mac: string = "";
    hostname: string = "";
    version: string = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "0.0.0";
    clientName: string = (import.meta.env.VITE_APP_NAME as string | undefined) ?? "Snapweb";
    os: string = "";
    arch: string = "web";
    instance: number = 1;
    uniqueId: string = "";
    snapStreamProtocolVersion: number = 2;
}


class ServerSettingsMessage extends JsonMessage {
    constructor(buffer?: ArrayBuffer) {
        super(buffer);
        if (buffer) {
            this.deserialize(buffer);
        }
        this.type = 3;
    }

    deserialize(buffer: ArrayBuffer) {
        super.deserialize(buffer);
        this.bufferMs = this.json["bufferMs"];
        this.latency = this.json["latency"];
        this.volumePercent = this.json["volume"];
        this.muted = this.json["muted"];
    }

    serialize(): ArrayBuffer {
        this.json = { "bufferMs": this.bufferMs, "latency": this.latency, "volume": this.volumePercent, "muted": this.muted };
        return super.serialize();
    }

    bufferMs: number = 0;
    latency: number = 0;
    volumePercent: number = 0;
    muted: boolean = false;
}


class PcmChunkMessage extends BaseMessage {
    constructor(buffer: ArrayBuffer, sampleFormat: SampleFormat) {
        super();
        this.deserialize(buffer);
        this.sampleFormat = sampleFormat;
        this.type = 2;
    }

    deserialize(buffer: ArrayBuffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        this.timestamp = new Tv(view.getInt32(26, true), view.getInt32(30, true));
        // this.payloadSize = view.getUint32(34, true);
        this.payload = buffer.slice(38);//, this.payloadSize + 38));// , this.payloadSize);
        // console.log("ts: " + this.timestamp.sec + " " + this.timestamp.usec + ", payload: " + this.payloadSize + ", len: " + this.payload.byteLength);
    }

    readFrames(frames: number): Uint8Array {
        let frameCnt = frames;
        const frameSize = this.sampleFormat.frameSize();
        if (this.idx + frames > this.payloadSize() / frameSize)
            frameCnt = (this.payloadSize() / frameSize) - this.idx;
        const begin = this.idx * frameSize;
        this.idx += frameCnt;
        return new Uint8Array(this.payload, begin, frameCnt * frameSize);
    }

    getFrameCount(): number {
        return (this.payloadSize() / this.sampleFormat.frameSize());
    }

    isEndOfChunk(): boolean {
        return this.idx >= this.getFrameCount();
    }

    startMs(): number {
        return this.timestamp.getMilliseconds() + 1000 * (this.idx / this.sampleFormat.rate);
    }

    duration(): number {
        return 1000 * ((this.getFrameCount() - this.idx) / this.sampleFormat.rate);
    }

    payloadSize(): number {
        return this.payload.byteLength;
    }

    clearPayload(): void {
        this.payload = new ArrayBuffer(0);
    }

    addPayload(buffer: ArrayBuffer) {
        const combined = new Uint8Array(this.payload.byteLength + buffer.byteLength);
        combined.set(new Uint8Array(this.payload), 0);
        combined.set(new Uint8Array(buffer), this.payload.byteLength);
        this.payload = combined.buffer;
    }

    timestamp: Tv = new Tv(0, 0);
    // payloadSize: number = 0;
    payload: ArrayBuffer = new ArrayBuffer(0);
    idx: number = 0;
    sampleFormat: SampleFormat;
}


class AudioStream {
    constructor(public _timeProvider: TimeProvider, public _sampleFormat: SampleFormat, public _bufferMs: number) {
    }

    refTapCallback: ((left: Float32Array, right: Float32Array) => void) | null = null;

    chunks: Array<PcmChunkMessage> = new Array<PcmChunkMessage>();

    setVolume(percent: number, muted: boolean) {
        // let base = 10;
        this.volume = percent / 100; // (Math.pow(base, percent / 100) - 1) / (base - 1);
        console.log("setVolume: " + percent + " => " + this.volume + ", muted: " + this.muted);
        this.muted = muted;
    }

    addChunk(chunk: PcmChunkMessage) {
        this.chunks.push(chunk);
        // let oldest = this.timeProvider.serverNow() - this.chunks[0].timestamp.getMilliseconds();
        // let newest = this.timeProvider.serverNow() - this.chunks[this.chunks.length - 1].timestamp.getMilliseconds();
        // console.debug("chunks: " + this.chunks.length + ", oldest: " + oldest.toFixed(2) + ", newest: " + newest.toFixed(2));

        while (this.chunks.length > 0) {
            const age = this._timeProvider.serverNow() - this.chunks[0].timestamp.getMilliseconds();
            // todo: consider buffer ms
            if (age > 5000 + this._bufferMs) {
                this.chunks.shift();
                console.log("Dropping old chunk: " + age.toFixed(2) + ", left: " + this.chunks.length);
            }
            else
                break;
        }
    }

    getNextBuffer(buffer: IAudioBuffer, playTimeMs: number) {
        if (!this.chunk) {
            this.chunk = this.chunks.shift()
        }
        // let age = this.timeProvider.serverTime(this.playTime * 1000) - startMs;
        const frames = buffer.length;
        // console.debug("getNextBuffer: " + frames + ", play time: " + playTimeMs.toFixed(2));
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        let read = 0;
        let pos = 0;
        // let volume = this.muted ? 0 : this.volume;
        const serverPlayTimeMs = this._timeProvider.serverTime(playTimeMs);
        if (this.chunk) {
            let age = serverPlayTimeMs - this.chunk.startMs();// - 500;
            const reqChunkDuration = frames / this._sampleFormat.msRate();
            const secs = Math.floor(Date.now() / 1000);
            if (this.lastLog !== secs) {
                this.lastLog = secs;
                console.log("age: " + age.toFixed(2) + ", req: " + reqChunkDuration);
            }
            if (age < -reqChunkDuration) {
                console.log("age: " + age.toFixed(2) + " < req: " + reqChunkDuration * -1 + ", chunk.startMs: " + this.chunk.startMs().toFixed(2) + ", timestamp: " + this.chunk.timestamp.getMilliseconds().toFixed(2));
                console.log("Chunk too young, returning silence");
            } else {
                if (Math.abs(age) > 5) {
                    // We are 5ms apart, do a hard sync, i.e. don't play faster/slower,
                    // but seek to the desired position instead
                    while (this.chunk && age > this.chunk.duration()) {
                        console.log("Chunk too old, dropping (age: " + age.toFixed(2) + " > " + this.chunk.duration().toFixed(2) + ")");
                        this.chunk = this.chunks.shift();
                        if (!this.chunk)
                            break;
                        age = serverPlayTimeMs - (this.chunk as PcmChunkMessage).startMs();
                    }
                    if (this.chunk) {
                        if (age > 0) {
                            console.log("Fast forwarding " + age.toFixed(2) + "ms");
                            this.chunk.readFrames(Math.floor(age * this.chunk.sampleFormat.msRate()));
                        }
                        else if (age < 0) {
                            console.log("Playing silence " + -age.toFixed(2) + "ms");
                            const silentFrames = Math.floor(-age * this.chunk.sampleFormat.msRate());
                            left.fill(0, 0, silentFrames);
                            right.fill(0, 0, silentFrames);
                            read = silentFrames;
                            pos = silentFrames;
                        }
                        age = 0;
                    }
                }
                // else if (age > 0.1) {
                //     let rate = age * 0.0005;
                //     rate = 1.0 - Math.min(rate, 0.0005);
                //     console.debug("Age > 0, rate: " + rate);
                //     // we are late (age > 0), this means we are not playing fast enough
                //     // => the real sample rate seems to be lower, we have to drop some frames
                //     this.setRealSampleRate(this.sampleFormat.rate * rate); // 0.9999);
                // }
                // else if (age < -0.1) {
                //     let rate = -age * 0.0005;
                //     rate = 1.0 + Math.min(rate, 0.0005);
                //     console.debug("Age < 0, rate: " + rate);
                //     // we are early (age > 0), this means we are playing too fast
                //     // => the real sample rate seems to be higher, we have to insert some frames
                //     this.setRealSampleRate(this.sampleFormat.rate * rate); // 0.9999);
                // }
                // else {
                //     this.setRealSampleRate(this.sampleFormat.rate);
                // }


                let addFrames = 0;
                let everyN = 0;
                if (age > 0.1) {
                    addFrames = Math.ceil(age); // / 5);
                } else if (age < -0.1) {
                    addFrames = Math.floor(age); // / 5);
                }
                // addFrames = -2;
                const readFrames = frames + addFrames - read;
                if (addFrames !== 0)
                    everyN = Math.ceil((frames + addFrames - read) / (Math.abs(addFrames) + 1));

                // addFrames = 0;
                // console.debug("frames: " + frames + ", readFrames: " + readFrames + ", addFrames: " + addFrames + ", everyN: " + everyN);
                while ((read < readFrames) && this.chunk) {
                    const pcmChunk = this.chunk as PcmChunkMessage;
                    const pcmView = pcmChunk.readFrames(readFrames - read);
                    // Signed PCM peaks at 2^(bits-1) — divide by that to get [-1, 1)
                    const normalize: number = 2 ** (pcmChunk.sampleFormat.bits - 1);
                    let payload: Int32Array | Int16Array;
                    if (pcmChunk.sampleFormat.bits >= 24)
                        payload = new Int32Array(pcmView.buffer, pcmView.byteOffset, pcmView.byteLength >> 2);
                    else
                        payload = new Int16Array(pcmView.buffer, pcmView.byteOffset, pcmView.byteLength >> 1);
                    // console.debug("readFrames: " + (frames - read) + ", read: " + pcmBuffer.byteLength + ", payload: " + payload.length);
                    // read += (pcmBuffer.byteLength / this.sampleFormat.frameSize());
                    for (let i = 0; i < payload.length; i += 2) {
                        read++;
                        left[pos] = (payload[i] / normalize);
                        right[pos] = (payload[i + 1] / normalize);
                        if ((everyN !== 0) && (read % everyN === 0)) {
                            if (addFrames > 0) {
                                pos--;
                            } else {
                                left[pos + 1] = left[pos];
                                right[pos + 1] = right[pos];
                                pos++;
                                // console.log("Add: " + pos);
                            }
                        }
                        pos++;
                    }
                    if (pcmChunk.isEndOfChunk()) {
                        this.chunk = this.chunks.shift();
                    }
                }
                if (addFrames !== 0)
                    console.debug("Pos: " + pos + ", frames: " + frames + ", add: " + addFrames + ", everyN: " + everyN);
                if (read === readFrames)
                    read = frames;
            }
        }

        if (read < frames) {
            console.log("Failed to get chunk, read: " + read + "/" + frames + ", chunks left: " + this.chunks.length);
            left.fill(0, pos);
            right.fill(0, pos);
        }

        if (this.refTapCallback) {
            this.refTapCallback(new Float32Array(left), new Float32Array(right));
        }

        // copyToChannel is not supported by Safari
        buffer.getChannelData(0).set(left);
        buffer.getChannelData(1).set(right);
    }


    // setRealSampleRate(sampleRate: number) {
    //     if (sampleRate == this.sampleFormat.rate) {
    //         this.correctAfterXFrames = 0;
    //     }
    //     else {
    //         this.correctAfterXFrames = Math.ceil((this.sampleFormat.rate / sampleRate) / (this.sampleFormat.rate / sampleRate - 1.));
    //         console.debug("setRealSampleRate: " + sampleRate + ", correct after X: " + this.correctAfterXFrames);
    //     }
    // }


    chunk?: PcmChunkMessage = undefined;
    volume: number = 1;
    muted: boolean = false;
    lastLog: number = 0;
    // correctAfterXFrames: number = 0;
}


// 2-state Kalman filter with Sage-Husa M-estimate adaptive noise.
// Ported from snapclient/components/timefilter/TimeFilter.c
// State vector: [offset (ms), drift (ms/ms = dimensionless rate)]
//
// Sage-Husa estimates measurement noise R̂ from the innovation sequence so no
// manual threshold is required. The M-estimate (Mohamed & Schwarz 1999) variant
// applies a Huber weight to each innovation, preventing outlier spikes from
// corrupting the state or R̂ while still allowing the filter to track real
// offset changes.
//
// R̂ is intentionally NOT reset on reset() — the learned network characteristics
// carry over so re-sync converges faster.
class KalmanTimeFilter {
    private count = 0
    private offset = 0
    private drift = 0
    private offsetCov = Infinity
    private offsetDriftCov = 0
    private driftCov = 0
    private lastUpdate = 0
    private useDrift = false

    private rHat: number  // Sage-Husa adaptive measurement noise estimate (ms²)

    private readonly processVar: number
    private readonly driftProcessVar: number
    private readonly forgettingFactor: number  // b ∈ (0.95, 0.99)
    private readonly huberC: number            // 1.345 → 95% Gaussian efficiency
    private readonly rMin: number              // hard floor on R̂ (ms²)
    private readonly minSamples: number
    private readonly driftSigThreshSq: number

    constructor(
        processStdDev      = 0.01,   // offset process noise (ms/√ms)
        driftProcessStdDev = 1e-7,   // drift process noise
        rHatInit           = 25.0,   // initial R̂ (ms²) — ~5ms std dev, ~10ms RTT assumed
        forgettingFactor   = 0.97,   // b — gives ~33-sample memory at 1Hz
        huberC             = 1.345,  // standard Huber constant
        rMin               = 0.01,   // minimum R̂ (ms²) — 0.1ms floor
        minSamples         = 5,
        driftSigThreshold  = 2.0
    ) {
        this.processVar       = processStdDev * processStdDev
        this.driftProcessVar  = driftProcessStdDev * driftProcessStdDev
        this.rHat             = rHatInit
        this.forgettingFactor = forgettingFactor
        this.huberC           = huberC
        this.rMin             = rMin
        this.minSamples       = minSamples
        this.driftSigThreshSq = driftSigThreshold * driftSigThreshold
    }

    reset() {
        this.count          = 0
        this.offset         = 0
        this.drift          = 0
        this.offsetCov      = Infinity
        this.offsetDriftCov = 0
        this.driftCov       = 0
        this.lastUpdate     = 0
        this.useDrift       = false
        // rHat intentionally preserved — learned noise carries over to re-sync
    }

    insert(measurement: number, timeAdded: number) {
        if (timeAdded <= this.lastUpdate) return

        // Cap dt to 5s to prevent driftCov*dt² explosion after a long suspension
        const dt  = Math.min(timeAdded - this.lastUpdate, 5000)
        const dt2 = dt * dt
        this.lastUpdate = timeAdded

        if (this.count === 0) {
            this.count++
            this.offset    = measurement
            this.offsetCov = this.rHat
            return
        }

        if (this.count === 1) {
            this.count++
            this.drift     = (measurement - this.offset) / dt
            this.offset    = measurement
            this.driftCov  = (this.offsetCov + this.rHat) / dt2
            this.offsetCov = this.rHat
            return
        }

        // Predict: x = F*x, P = F*P*F^T + Q  (F = [1,dt; 0,1])
        const predOffset      = this.offset + this.drift * dt
        const newDriftCov     = this.driftCov + dt * this.driftProcessVar
        const newOffsetDriftCov = this.offsetDriftCov + this.driftCov * dt
        const newOffsetCov    = this.offsetCov + 2 * this.offsetDriftCov * dt +
                                this.driftCov * dt2 + dt * this.processVar

        // Innovation
        const residual  = measurement - predOffset
        const innovStd  = Math.sqrt(newOffsetCov + this.rHat)

        // Huber M-weight: downweight outliers beyond huberC·σ without rejecting them
        const normResid = Math.abs(residual) / innovStd
        const weight    = normResid <= this.huberC ? 1.0 : this.huberC / normResid

        // Effective R for this step — inflated for outliers so gain is auto-reduced
        const rEffective = this.rHat / weight

        // Update: K = P*H^T*(H*P*H^T + R_eff)^-1, H = [1,0]
        const invS    = 1.0 / (newOffsetCov + rEffective)
        const kOffset = newOffsetCov * invS
        const kDrift  = newOffsetDriftCov * invS

        this.offset         = predOffset + kOffset * residual
        this.drift         += kDrift * residual
        this.driftCov       = newDriftCov       - kDrift  * newOffsetDriftCov
        this.offsetDriftCov = newOffsetDriftCov - kDrift  * newOffsetCov
        this.offsetCov      = newOffsetCov      - kOffset * newOffsetCov

        // Sage-Husa M-estimate: update R̂ from robustified innovation
        if (this.count >= this.minSamples) {
            const robustResid = weight * residual  // Huber-clipped innovation
            const d           = 1 - this.forgettingFactor
            const rHatRaw     = (1 - d) * this.rHat + d * (robustResid * robustResid - newOffsetCov)
            this.rHat         = Math.max(rHatRaw, this.rMin)
        } else {
            this.count++
        }

        this.useDrift = this.drift * this.drift > this.driftSigThreshSq * this.driftCov
    }

    // Returns estimated clock offset at clientTimeMs, extrapolating forward
    // from the last measurement using drift when drift is statistically significant.
    getOffset(clientTimeMs: number): number {
        const dt = clientTimeMs - this.lastUpdate
        return this.offset + (this.useDrift ? this.drift : 0) * dt
    }
}


class TimeProvider {
    constructor(ctx?: IAudioContextPatched) {
        if (ctx) {
            this.setAudioContext(ctx);
        }
    }

    setAudioContext(ctx: IAudioContextPatched) {
        this.ctx = ctx;
        this.reset();
    }

    reset() {
        this.filter.reset()
    }

    setDiff(c2s: number, s2c: number) {
        this.filter.insert((c2s - s2c) / 2, this.now())
    }

    now() {
        if (!this.ctx) {
            return window.performance.now();
        } else {
            const ctx = this.ctx as IAudioContextPatched;
            // Use the more accurate getOutputTimestamp if available, fallback to ctx.currentTime otherwise.
            const contextTime = ctx.getOutputTimestamp ? ctx.getOutputTimestamp().contextTime : undefined;
            return (contextTime !== undefined ? contextTime : ctx.currentTime) * 1000;
        }
    }

    nowSec() {
        return this.now() / 1000;
    }

    serverNow() {
        return this.serverTime(this.now());
    }

    serverTime(localTimeMs: number) {
        return localTimeMs + this.filter.getOffset(localTimeMs)
    }

    private filter = new KalmanTimeFilter()
    ctx?: AudioContext;
}


class SampleFormat {
    rate: number = 48000;
    channels: number = 2;
    bits: number = 16;

    public msRate(): number {
        return this.rate / 1000;
    }

    public toString(): string {
        return this.rate + ":" + this.bits + ":" + this.channels;
    }

    public sampleSize(): number {
        if (this.bits === 24) {
            return 4;
        }
        return this.bits / 8;
    }

    public frameSize(): number {
        return this.channels * this.sampleSize();
    }

    public durationMs(bytes: number) {
        return (bytes / this.frameSize()) * this.msRate();
    }
}


class Decoder {
    setHeader(_buffer: ArrayBuffer) {}

    free() {}

    decode(_chunk: PcmChunkMessage): PcmChunkMessage | null | Promise<PcmChunkMessage | null> {
        return null;
    }

    sampleFormat: SampleFormat | null = null;
}


// Unified WebWorker-based decoder for FLAC, Opus, and Ogg/Vorbis.
// Decoders run off the main thread; codec WASM binary is loaded on demand.
class WasmAudioDecoder extends Decoder {
    constructor(codec: string) {
        super()
        this.codec = codec;
        this._init();
    }

    free() {
        if (this._decoder) {
            this._freed = true;
            const d = this._decoder;
            d.ready.then(() => d.free());
        }
    }

    setHeader(buffer: ArrayBuffer) {
        // Opus embeds sample-format in its header; others auto-detect on first decode.
        if (this.codec === "opus") {
            const view = new DataView(buffer);
            const ID_OPUS = 0x4F505553;
            if (buffer.byteLength < 12) {
                console.error("Opus header too small:", buffer.byteLength);
                return;
            } else if (view.getUint32(0, true) !== ID_OPUS) {
                console.error("Invalid Opus header magic");
                return;
            }
            this.sampleFormat = new SampleFormat();
            this.sampleFormat.rate     = view.getUint32(4, true);
            this.sampleFormat.bits     = view.getUint16(8, true);
            this.sampleFormat.channels = view.getUint16(10, true);
            console.log("Opus sampleformat:", this.sampleFormat.toString());
        } else if (this.codec === "ogg") {
            this._oggSetupPackets = buffer;
        }
    }

    async decode(chunk: PcmChunkMessage): Promise<PcmChunkMessage | null> {
        if (!this._decodeFrame) {
            console.log("Audio decoder still initializing, playback will start shortly.");
            return null;
        }

        const decoded = await this._decodeFrame(chunk.payload);

        if (this.sampleFormat === null) {
            if (decoded.samplesDecoded === 0) {
                console.log("Determining sample format, playback will start shortly.");
                return null;
            }
            // FLAC/Vorbis: auto-detect from first decoded frame; always float32 output.
            this.sampleFormat = new SampleFormat();
            this.sampleFormat.bits     = 32;
            this.sampleFormat.channels = decoded.channelData.length;
            this.sampleFormat.rate     = decoded.sampleRate;
        }

        const numSamples    = decoded.channelData[0].length;
        const bytesPerSample = this.sampleFormat.sampleSize();
        const numChannels   = this.sampleFormat.channels;
        // Use 2** instead of << to avoid int32 overflow when bits === 32.
        const scale = 2 ** (this.sampleFormat.bits - 1) - 1;
        const buffer = new ArrayBuffer(numSamples * bytesPerSample * numChannels);

        if (bytesPerSample === 4) {
            const out = new Int32Array(buffer);
            for (let i = 0; i < numSamples; i++) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const s = decoded.channelData[ch][i];
                    out[i * numChannels + ch] = (s < -1 ? -scale : s > 1 ? scale : s * scale) | 0;
                }
            }
        } else {
            const out = new Int16Array(buffer);
            for (let i = 0; i < numSamples; i++) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const s = decoded.channelData[ch][i];
                    out[i * numChannels + ch] = (s < -1 ? -scale : s > 1 ? scale : s * scale) | 0;
                }
            }
        }

        chunk.sampleFormat = this.sampleFormat;
        chunk.payload = buffer;
        return chunk;
    }

    private async _init() {
        switch (this.codec) {
            case "flac": {
                const { FLACDecoderWebWorker } = await import("@wasm-audio-decoders/flac");
                if (this._freed) return;
                const d = new FLACDecoderWebWorker();
                await d.ready;
                this._decoder = d;
                this._decodeFrame = (p) => (this._decoder as FLACDecoderWebWorker).decode(new Uint8Array(p));
                break;
            }
            case "opus": {
                const { OpusDecoderWebWorker } = await import("opus-decoder");
                if (this._freed) return;
                const d = new OpusDecoderWebWorker({
                    sampleRate: this.sampleFormat!.rate as OpusDecoderSampleRate,
                    channels:   this.sampleFormat!.channels,
                });
                await d.ready;
                this._decoder = d;
                this._decodeFrame = (p) => (this._decoder as OpusDecoderWebWorker<OpusDecoderSampleRate>).decodeFrame(new Uint8Array(p));
                break;
            }
            case "ogg": {
                const { OggVorbisDecoderWebWorker } = await import("@wasm-audio-decoders/ogg-vorbis");
                if (this._freed) return;
                const d = new OggVorbisDecoderWebWorker();
                await d.ready;
                if (this._oggSetupPackets) await d.decode(new Uint8Array(this._oggSetupPackets));
                this._decoder = d;
                this._decodeFrame = (p) => (this._decoder as OggVorbisDecoderWebWorker).decode(new Uint8Array(p));
                break;
            }
            default:
                throw new Error("Unsupported codec: " + this.codec);
        }
    }

    private readonly codec: string;
    private _freed = false;
    private _oggSetupPackets: ArrayBuffer | null = null;
    private _decoder: FLACDecoderWebWorker | OpusDecoderWebWorker<OpusDecoderSampleRate> | OggVorbisDecoderWebWorker | undefined;
    private _decodeFrame: ((p: ArrayBuffer) => Promise<FLACDecodedAudio | OpusDecodedAudio<OpusDecoderSampleRate> | OggVorbisDecodedAudio>) | undefined;
}

class PlayBuffer {
    constructor(buffer: IAudioBuffer, playTime: number, source: IAudioBufferSourceNode<IAudioContext>, destination: IGainNode<IAudioContext>) {
        this.buffer = buffer;
        this.playTime = playTime;
        this.source = source;
        this.source.buffer = this.buffer;
        this.source.connect(destination);
        this.onended = (_playBuffer: PlayBuffer) => { };
    }

    public onended: (_playBuffer: PlayBuffer) => void

    start() {
        this.source.onended = () => {
            this.onended(this);
        }
        this.source.start(this.playTime);
    }

    buffer: IAudioBuffer;
    playTime: number;
    source: IAudioBufferSourceNode<IAudioContext>;
    num: number = 0;
}


class PcmDecoder extends Decoder {
    setHeader(buffer: ArrayBuffer) {
        this.sampleFormat = new SampleFormat();
        const view = new DataView(buffer);
        this.sampleFormat.channels = view.getUint16(22, true);
        this.sampleFormat.rate     = view.getUint32(24, true);
        this.sampleFormat.bits     = view.getUint16(34, true);
    }

    decode(chunk: PcmChunkMessage): PcmChunkMessage | null {
        return chunk;
    }
}


class SnapStream {
    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
        this.timeProvider = new TimeProvider();

        if (this.setupAudioContext()) {
            this.connect();
        } else {
            throw new Error("Web Audio API is not supported in this browser");
        }
    }

    public resume() {
        this.ctx.resume();
    }

    private setupAudioContext(): boolean {
        if (AudioContext) {
            let options: AudioContextOptions | undefined;
            options = { latencyHint: "interactive", sampleRate: this.sampleFormat ? this.sampleFormat.rate : undefined };

            const chromeVersion = getChromeVersion();
            if ((chromeVersion !== null && chromeVersion < 55) || !window.AudioContext) {
                // Some older browsers won't decode the stream if options are provided.
                options = undefined;
            }

            this.ctx = new AudioContextPatched(options);
            this.gainNode = this.ctx.createGain();
            this.gainNode.connect(this.ctx.destination);
        } else {
            // Web Audio API is not supported
            return false;
        }
        return true;
    }

    public static getClientId(): string {
        const key = "uniqueId";
        if (window.localStorage) {
            const stored = window.localStorage.getItem(key);
            if (stored !== null) return stored;
            const id = uuidv4();
            window.localStorage.setItem(key, id);
            return id;
        }
        return uuidv4();
    }

    private connect() {
        this.streamsocket = new WebSocket(this.baseUrl + '/stream');
        this.streamsocket.binaryType = "arraybuffer";
        this.streamsocket.onmessage = (ev) => this.onMessage(ev);

        this.streamsocket.onopen = () => {
            console.log("on open");
            const hello = new HelloMessage();

            hello.mac = "00:00:00:00:00:00";
            hello.arch = "web";
            hello.os = navigator?.platform || "unknown";
            hello.hostname = "Snapweb client";
            hello.uniqueId = SnapStream.getClientId();

            this.sendMessage(hello);
            this.startSyncLoop();
        }
        this.streamsocket.onerror = (ev) => { console.error('error:', ev); };
        this.streamsocket.onclose = () => {
            window.clearInterval(this.syncHandle);
            window.clearInterval(this.burstHandle);
            console.info('connection lost, reconnecting in 1s');
            setTimeout(() => this.connect(), 1000);
        }
    }

    // Called once the sample format is known (immediately for PCM/Opus, lazily
    // for FLAC/Vorbis whose format is determined from the first decoded frame).
    private setSampleFormat(sampleFormat: SampleFormat) {
        this.sampleFormat = sampleFormat;
        console.log("Sampleformat: " + this.sampleFormat.toString());
        if ((this.sampleFormat.channels !== 2) || (this.sampleFormat.bits < 16)) {
            console.error("Stream must be stereo with 16, 24 or 32 bit depth, actual format: " + this.sampleFormat.toString());
        } else {
            if (this.bufferDurationMs !== 0) {
                this.bufferFrameCount = Math.floor(this.bufferDurationMs * this.sampleFormat.msRate());
            }

            // NOTE (curiousercreative): this breaks iOS audio output on v15.7.5 at least
            if (window.AudioContext) {
                if (this.sampleFormat.rate !== this.ctx.sampleRate.valueOf()) {
                    console.log("Stream samplerate != audio context samplerate (" + this.sampleFormat.rate + " != " + this.ctx.sampleRate.valueOf() + "), switching audio context to " + this.sampleFormat.rate + " Hz");
                    this.stopAudio();
                    this.setupAudioContext();
                }
            }

            this.ctx.resume();
            this.timeProvider.setAudioContext(this.ctx);
            this.gainNode.gain.value = this.serverSettings!.muted ? 0 : this.serverSettings!.volumePercent / 100;
            this.stream = new AudioStream(this.timeProvider, this.sampleFormat, this.bufferMs);
            this.latency = (this.ctx.baseLatency !== undefined ? this.ctx.baseLatency : 0) + (this.ctx.outputLatency !== undefined ? this.ctx!.outputLatency : 0);
            console.log("Base latency: " + this.ctx.baseLatency + ", output latency: " + this.ctx!.outputLatency + ", latency: " + this.latency);
            this.play();
        }
    }

    private onMessage(msg: MessageEvent) {
        const view = new DataView(msg.data);
        const type = view.getUint16(0, true);
        if (type === 1) {
            const codec = new CodecMessage(msg.data);
            console.log("Codec: " + codec.codec);
            this.decoder?.free();
            this.sampleFormat = null;
            if (codec.codec === "pcm") {
                const d = new PcmDecoder();
                d.setHeader(codec.payload);
                this.decoder = d;
                this.setSampleFormat(d.sampleFormat!);
            } else if (codec.codec === "flac" || codec.codec === "opus" || codec.codec === "ogg") {
                try {
                    const d = new WasmAudioDecoder(codec.codec);
                    d.setHeader(codec.payload);
                    this.decoder = d;
                    // Opus: format known immediately; FLAC/Vorbis: lazy via first decode.
                    if (d.sampleFormat !== null) {
                        this.setSampleFormat(d.sampleFormat);
                    }
                } catch (err) {
                    console.error("Failed to init decoder:", err);
                }
            } else {
                console.error("Codec not supported: " + codec.codec);
            }
        } else if (type === 2) {
            const pcmChunk = new PcmChunkMessage(msg.data, this.sampleFormat as SampleFormat);
            if (this.decoder) {
                Promise.resolve(this.decoder.decode(pcmChunk)).then(decoded => {
                    if (decoded) {
                        // FLAC/Vorbis: sample format is known after the first decoded frame.
                        if (this.sampleFormat === null && decoded.sampleFormat !== null) {
                            this.setSampleFormat(decoded.sampleFormat!);
                        }
                        this.stream!.addChunk(decoded);
                    }
                }).catch(err => {
                    console.error("Error decoding chunk:", err);
                });
            }
        } else if (type === 3) {
            this.serverSettings = new ServerSettingsMessage(msg.data);
            this.gainNode.gain.value = this.serverSettings.muted ? 0 : this.serverSettings.volumePercent / 100;
            this.bufferMs = this.serverSettings.bufferMs - this.serverSettings.latency;
            console.log("ServerSettings bufferMs: " + this.serverSettings.bufferMs + ", latency: " + this.serverSettings.latency + ", volume: " + this.serverSettings.volumePercent + ", muted: " + this.serverSettings.muted);
        } else if (type === 4) {
            if (this.timeProvider) {
                const time = new TimeMessage(msg.data);
                this.timeProvider.setDiff(time.latency.getMilliseconds(), this.timeProvider.now() - time.sent.getMilliseconds());
            }
            // console.log("Time sec: " + time.latency.sec + ", usec: " + time.latency.usec + ", diff: " + this.timeProvider.diff);
        } else {
            console.info("Message not handled, type: " + type);
        }
    }

    private sendMessage(msg: BaseMessage) {
        msg.sent = new Tv(0, 0);
        msg.sent.setMilliseconds(this.timeProvider.now());
        msg.id = ++this.msgId;
        if (this.streamsocket.readyState === this.streamsocket.OPEN) {
            this.streamsocket.send(msg.serialize());
        }
    }

    private syncTime() {
        const t = new TimeMessage();
        t.latency.setMilliseconds(this.timeProvider.now());
        this.sendMessage(t);
        // console.log("prepareSource median: " + Math.round(this.median * 10) / 10);
    }

    private stopAudio() {
        // if (this.ctx) {
        //     this.ctx.close();
        // }
        this.ctx.suspend();
        while (this.audioBuffers.length > 0) {
            const buffer = this.audioBuffers.pop();
            buffer!.onended = () => { };
            buffer!.source.stop();
        }
        while (this.freeBuffers.length > 0) {
            this.freeBuffers.pop();
        }
    }

    // Call after page visibility is restored (e.g. returning from homescreen).
    // Resets filter state and fires a quick-sync burst so the filter
    // re-converges in ~1s instead of waiting for the steady-state interval.
    public resync() {
        this.timeProvider.reset();
        this.ctx.resume();
        this.startSyncLoop();
    }

    // Fire BURST_COUNT syncs every BURST_INTERVAL_MS, then settle to
    // STEADY_INTERVAL_MS. Mirrors the embedded snapclient startup behaviour.
    private startSyncLoop() {
        window.clearInterval(this.syncHandle);
        window.clearInterval(this.burstHandle);

        let sent = 0;
        const burst = window.setInterval(() => {
            this.syncTime();
            if (++sent >= SnapStream.BURST_COUNT) {
                window.clearInterval(burst);
                this.syncHandle = window.setInterval(() => this.syncTime(), SnapStream.STEADY_INTERVAL_MS);
            }
        }, SnapStream.BURST_INTERVAL_MS);
        this.burstHandle = burst;
    }

    get sampleRate(): number {
        return this.sampleFormat?.rate ?? this.ctx.sampleRate;
    }

    public startReferenceTap(callback: (left: Float32Array, right: Float32Array) => void) {
        if (this.stream) this.stream.refTapCallback = callback;
    }

    public stopReferenceTap() {
        if (this.stream) this.stream.refTapCallback = null;
    }

    get localOffsetMs(): number {
        return config.localOffsetMs;
    }

    set localOffsetMs(ms: number) {
        config.localOffsetMs = ms;
    }

    public muteOutput(muted: boolean) {
        if (!this.gainNode || !this.serverSettings) return;
        this.gainNode.gain.value = (muted || this.serverSettings.muted)
            ? 0
            : this.serverSettings.volumePercent / 100;
    }

    public stop() {
        window.clearInterval(this.syncHandle);
        window.clearInterval(this.burstHandle);
        this.stopAudio();
        this.decoder?.free();
        if (this.streamsocket.readyState === WebSocket.OPEN || this.streamsocket.readyState === WebSocket.CONNECTING) {
            this.streamsocket.onclose = () => { };
            this.streamsocket.close();
        }
    }

    public play() {
        this.playTime = this.timeProvider.nowSec() + 0.1;
        for (let i = 1; i <= this.audioBufferCount; ++i) {
            this.playNext();
        }
    }

    public playNext() {
        const buffer = this.freeBuffers.pop() || this.ctx!.createBuffer(this.sampleFormat!.channels, this.bufferFrameCount, this.sampleFormat!.rate);
        const playTimeMs = (this.playTime + this.latency) * 1000 - this.bufferMs;
        this.stream!.getNextBuffer(buffer, playTimeMs);

        const source = this.ctx!.createBufferSource();
        const playBuffer = new PlayBuffer(buffer, this.playTime, source, this.gainNode!);
        this.audioBuffers.push(playBuffer);
        playBuffer.num = ++this.bufferNum;
        playBuffer.onended = (buffer: PlayBuffer) => {
            // let diff = this.timeProvider.nowSec() - buffer.playTime;
            this.freeBuffers.push(this.audioBuffers.splice(this.audioBuffers.indexOf(buffer), 1)[0].buffer);
            // console.debug("PlayBuffer " + playBuffer.num + " ended after: " + (diff * 1000) + ", in flight: " + this.audioBuffers.length);
            this.playNext();
        }
        playBuffer.start();
        this.playTime += this.bufferFrameCount / (this.sampleFormat as SampleFormat).rate;
    }

    static readonly BURST_COUNT        = 10;   // quick syncs on connect/resync
    static readonly BURST_INTERVAL_MS  = 100;  // ms between burst syncs
    static readonly STEADY_INTERVAL_MS = 250;  // ms between steady-state syncs

    baseUrl: string;
    streamsocket!: WebSocket;
    playTime: number = 0;
    msgId: number = 0;
    bufferDurationMs: number = 80; // 0;
    bufferFrameCount: number = 3844; // 9600; // 2400;//8192;
    syncHandle: number = -1;
    burstHandle: number = -1;
    // ageBuffer: Array<number>;
    audioBuffers: Array<PlayBuffer> = new Array<PlayBuffer>();
    freeBuffers: Array<IAudioBuffer> = new Array<IAudioBuffer>();

    timeProvider: TimeProvider;
    stream: AudioStream | undefined;
    ctx!: IAudioContextPatched; // | undefined;
    gainNode!: IGainNode<IAudioContext>;
    serverSettings: ServerSettingsMessage | undefined;
    decoder: Decoder | undefined;
    sampleFormat: SampleFormat | null = null;

    // median: number = 0;
    audioBufferCount: number = 3;
    bufferMs: number = 1000;
    bufferNum: number = 0;

    latency: number = 0;
}

export { SnapStream }
