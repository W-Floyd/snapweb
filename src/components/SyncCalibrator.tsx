import { useState, useRef, useCallback } from 'react';
import {
    Box, Button, CircularProgress, LinearProgress, Typography, Alert,
} from '@mui/material';
import { GraphicEq as GraphicEqIcon } from '@mui/icons-material';
import { SnapStream } from '../snapstream';
import { calibrate, CalibrationError } from '../sync-calibrator';

type State =
    | { kind: 'idle' }
    | { kind: 'recording'; elapsed: number; total: number }
    | { kind: 'correlating' }
    | { kind: 'result'; offsetMs: number; correlation: number }
    | { kind: 'error'; message: string };

const DURATION_MS = 4000;

type Props = {
    snapStream: SnapStream | null;
    currentLatencyMs: number;
    onCalibrated: (newLatencyMs: number) => void;
};

export default function SyncCalibrator({ snapStream, currentLatencyMs, onCalibrated }: Props) {
    const [state, setState] = useState<State>({ kind: 'idle' });
    const abortRef = useRef(false);

    const run = useCallback(async () => {
        if (!snapStream) return;
        abortRef.current = false;

        setState({ kind: 'recording', elapsed: 0, total: DURATION_MS });

        // Mute snapweb output so the mic only hears the target device.
        snapStream.resume();
        snapStream.muteOutput(true);

        try {
            const result = await calibrate(
                snapStream,
                DURATION_MS,
                (elapsed, total) => {
                    if (!abortRef.current) {
                        setState({ kind: 'recording', elapsed, total });
                    }
                },
            );

            if (abortRef.current) return;
            setState({ kind: 'correlating' });
            await new Promise((r) => setTimeout(r, 50));
            if (abortRef.current) return;
            setState({ kind: 'result', ...result });
        } catch (err) {
            if (abortRef.current) return;
            setState({
                kind: 'error',
                message: err instanceof CalibrationError ? err.message : String(err),
            });
        } finally {
            snapStream.muteOutput(false);
        }
    }, [snapStream]);

    const cancel = () => {
        abortRef.current = true;
        snapStream?.muteOutput(false);
        snapStream?.stopReferenceTap();
        setState({ kind: 'idle' });
    };

    const apply = (offsetMs: number) => {
        onCalibrated(Math.round(currentLatencyMs + offsetMs));
        setState({ kind: 'idle' });
    };

    if (!snapStream) return null;

    return (
        <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" gutterBottom>Auto-calibrate latency</Typography>

            {state.kind === 'idle' && (
                <Box>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        Place this device near the target speaker, then tap Calibrate. Music must be playing.
                    </Typography>
                    <Button
                        variant="outlined"
                        size="small"
                        startIcon={<GraphicEqIcon />}
                        onClick={run}
                    >
                        Calibrate
                    </Button>
                </Box>
            )}

            {state.kind === 'recording' && (
                <Box>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                        Listening… {Math.ceil((state.total - state.elapsed) / 1000)}s remaining
                    </Typography>
                    <LinearProgress
                        variant="determinate"
                        value={(state.elapsed / state.total) * 100}
                        sx={{ mb: 1 }}
                    />
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        This device is muted — hold it near the target speaker.
                    </Typography>
                    <Button size="small" onClick={cancel}>Cancel</Button>
                </Box>
            )}

            {state.kind === 'correlating' && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={20} />
                    <Typography variant="body2">Analyzing…</Typography>
                </Box>
            )}

            {state.kind === 'result' && (
                <Box>
                    <Alert severity="success" sx={{ mb: 1 }}>
                        Detected: <strong>{state.offsetMs > 0 ? '+' : ''}{state.offsetMs.toFixed(0)} ms</strong>
                        {' '}(confidence: {(state.correlation * 100).toFixed(0)}%)
                        <br />
                        New latency: {Math.round(currentLatencyMs + state.offsetMs)} ms
                    </Alert>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        {state.offsetMs > 0
                            ? 'Target is playing late — latency will increase to advance it.'
                            : 'Target is playing early — latency will decrease to delay it.'}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                        <Button variant="contained" size="small" onClick={() => apply(state.offsetMs)}>
                            Apply
                        </Button>
                        <Button size="small" onClick={() => setState({ kind: 'idle' })}>
                            Dismiss
                        </Button>
                        <Button size="small" onClick={run}>
                            Retry
                        </Button>
                    </Box>
                </Box>
            )}

            {state.kind === 'error' && (
                <Box>
                    <Alert severity="error" sx={{ mb: 1 }}>{state.message}</Alert>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                        <Button size="small" onClick={run}>Retry</Button>
                        <Button size="small" onClick={() => setState({ kind: 'idle' })}>Dismiss</Button>
                    </Box>
                </Box>
            )}
        </Box>
    );
}
