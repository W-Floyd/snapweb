import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { SnapStream } from '../snapstream';
import silence from '../assets/10-seconds-of-silence.mp3';

// Reads ?src=ws://... from the query string, falls back to persisted config.
function resolveServerUrl(): string {
    const param = new URLSearchParams(window.location.search).get('src');
    return param ?? config.baseUrl;
}

export default function Headless() {
    const streamRef = useRef<SnapStream | null>(null);
    const audioRef  = useRef(new Audio());
    const [blocked, setBlocked] = useState(false);

    function start() {
        const src = resolveServerUrl();
        audioRef.current.src  = silence;
        audioRef.current.loop = true;
        audioRef.current.play().then(
            () => {
                try {
                    streamRef.current = new SnapStream(src);
                    setBlocked(false);
                } catch (err) {
                    console.error('SnapStream init failed:', err);
                }
            },
            () => setBlocked(true)
        );
    }

    useEffect(() => {
        start();

        const onVisibility = () => {
            if (document.visibilityState === 'visible' && streamRef.current) {
                streamRef.current.resync();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            streamRef.current?.stop();
            streamRef.current = null;
            audioRef.current.pause();
            audioRef.current.src = '';
        };
    }, []);

    if (!blocked) return null;

    // Autoplay was blocked — show a minimal fullscreen tap target.
    return (
        <div
            onClick={start}
            style={{
                position: 'fixed', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#000', color: '#fff',
                fontSize: '1.5rem', cursor: 'pointer',
                userSelect: 'none',
            }}
        >
            ▶ Tap to play
        </div>
    );
}
