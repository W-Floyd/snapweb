import { SnapStream } from './snapstream'

/**
 * <snapclient src="ws://snapserver:1704" autoplay></snapclient>
 *
 * Attributes:
 *   src      – snapcast server WebSocket base URL (required)
 *   autoplay – connect immediately when the element is attached to the DOM
 *
 * Methods:
 *   play()   – start streaming (required from a user-gesture in regular browser contexts)
 *   stop()   – tear down the stream
 *   resync() – re-sync clock after a background/suspend gap
 *
 * Events (bubble):
 *   playing  – stream connected and playing
 *   stopped  – stream torn down
 *   error    – SnapStream constructor threw (e.g. Web Audio not supported)
 */
class SnapClient extends HTMLElement {
    private stream: SnapStream | null = null
    private _onVisibility: () => void

    constructor() {
        super()
        this._onVisibility = () => {
            if (document.visibilityState === 'visible' && this.stream) {
                this.stream.resync()
            }
        }
    }

    static get observedAttributes() {
        return ['src', 'autoplay']
    }

    connectedCallback() {
        document.addEventListener('visibilitychange', this._onVisibility)
        if (this.hasAttribute('autoplay') && this.getAttribute('src')) {
            this._start()
        }
    }

    disconnectedCallback() {
        document.removeEventListener('visibilitychange', this._onVisibility)
        this._stop()
    }

    attributeChangedCallback(name: string, _old: string | null, next: string | null) {
        if (name === 'src' && this.stream) {
            this._stop()
            if (next) this._start()
        }
    }

    play() {
        this._start()
    }

    stop() {
        this._stop()
    }

    resync() {
        this.stream?.resync()
    }

    private _start() {
        const src = this.getAttribute('src')
        if (!src) return
        this._stop()
        try {
            this.stream = new SnapStream(src)
            this.dispatchEvent(new Event('playing', { bubbles: true }))
        } catch (err) {
            this.dispatchEvent(new ErrorEvent('error', {
                bubbles: true,
                error: err,
                message: err instanceof Error ? err.message : String(err),
            }))
        }
    }

    private _stop() {
        if (this.stream) {
            this.stream.stop()
            this.stream = null
            this.dispatchEvent(new Event('stopped', { bubbles: true }))
        }
    }
}

if (!customElements.get('snapclient')) {
    customElements.define('snapclient', SnapClient)
}

export { SnapClient }
