/**
 * Continuous QR scanner (lazy-loaded). Starts the rear camera, scans ~8×/s
 * and reports each (deduplicated) value via `onDetected`. The camera is
 * stopped on unmount and while the page is hidden.
 */
import { CameraOff, Flashlight, FlashlightOff, RotateCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, IconButton } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { Spinner } from '../../components/ui/Spinner';
import {
  CAMERA_CONSTRAINTS,
  cameraErrorMessage,
  cameraSupportProblem,
  createDeduper,
  setTorch,
  stopStream,
  supportsTorch,
} from './camera';
import { createQrDetector, createWasmDetector, type QrDetector } from './detector';

const SCAN_INTERVAL_MS = 120;

type Status = 'starting' | 'scanning' | 'error';

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    () => true,
  );
}

export interface QrScannerProps {
  onDetected: (value: string) => void;
  /** Shown below the camera image while the camera works (hidden on errors). */
  footer?: ReactNode;
  className?: string;
}

export default function QrScanner({ onDetected, footer, className }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const onDetectedRef = useRef(onDetected);
  useLayoutEffect(() => {
    onDetectedRef.current = onDetected;
  });

  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<QrDetector['kind'] | null>(null);
  const [torch, setTorchState] = useState({ supported: false, on: false });
  const pageVisible = usePageVisible();
  const unsupported = cameraSupportProblem();

  useEffect(() => {
    const video = videoRef.current;
    if (unsupported || !pageVisible || !video) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const shouldReport = createDeduper(2000);

    const fail = (message: string) => {
      if (cancelled) return;
      setError(message);
      setStatus('error');
    };

    const run = async () => {
      const detectorPromise = createQrDetector();
      detectorPromise.catch(() => undefined);

      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      } catch (err) {
        fail(cameraErrorMessage(err));
        return;
      }
      if (cancelled) {
        stopStream(stream);
        return;
      }

      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // muted + playsInline normally allows autoplay; detection still works once frames arrive
      }
      const track = stream.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      if (!cancelled) setTorchState({ supported: supportsTorch(track), on: false });

      let detector: QrDetector;
      try {
        detector = await detectorPromise;
      } catch {
        fail('Der QR-Scanner konnte nicht geladen werden. Bitte lade die Seite neu.');
        return;
      }
      if (cancelled) return;
      setEngine(detector.kind);
      setStatus('scanning');

      let failures = 0;
      const tick = async () => {
        if (cancelled) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
          try {
            const codes = await detector.detect(video);
            failures = 0;
            const value = codes.map((code) => code.rawValue.trim()).find(Boolean);
            if (value && !cancelled && shouldReport(value, performance.now())) onDetectedRef.current(value);
          } catch {
            failures += 1;
            // A broken native implementation → switch to the WASM engine.
            if (detector.kind === 'native' && failures >= 5) {
              try {
                detector = await createWasmDetector();
                failures = 0;
                if (!cancelled) setEngine(detector.kind);
              } catch {
                // keep trying with the native one
              }
            }
          }
        }
        if (!cancelled) timer = window.setTimeout(() => void tick(), SCAN_INTERVAL_MS);
      };
      void tick();
    };

    void run();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stopStream(stream);
      trackRef.current = null;
      video.srcObject = null;
    };
  }, [attempt, pageVisible, unsupported]);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torch.on;
    try {
      await setTorch(track, next);
      setTorchState({ supported: true, on: next });
    } catch {
      setTorchState({ supported: false, on: false });
    }
  }

  function retry() {
    setError(null);
    setStatus('starting');
    setAttempt((n) => n + 1);
  }

  const problem = unsupported ?? (status === 'error' ? error : null);

  return (
    <div className="space-y-4">
      <div
        data-testid="qr-scanner"
        data-status={problem ? 'error' : status}
        data-engine={engine ?? undefined}
        className={cn('relative w-full overflow-hidden rounded-3xl bg-black', className)}
      >
        <div className="relative aspect-[3/4] max-h-[62dvh] w-full sm:aspect-square">
          <video
            ref={videoRef}
            className={cn('absolute inset-0 size-full object-cover', problem && 'invisible')}
            playsInline
            muted
            autoPlay
            aria-label="Kamerabild"
          />
          {problem ? (
            <div
              role="alert"
              className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white"
            >
              <CameraOff className="size-10 opacity-80" aria-hidden />
              <p className="max-w-xs text-base font-medium" data-testid="scanner-error">
                {problem}
              </p>
              {unsupported ? null : (
                <Button variant="secondary" icon={<RotateCw className="size-5" aria-hidden />} onClick={retry}>
                  Erneut versuchen
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Viewfinder */}
              <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative aspect-square w-[68%] max-w-72 rounded-3xl shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]">
                  <span className="absolute -top-0.5 -left-0.5 size-10 rounded-tl-3xl border-t-4 border-l-4 border-white" />
                  <span className="absolute -top-0.5 -right-0.5 size-10 rounded-tr-3xl border-t-4 border-r-4 border-white" />
                  <span className="absolute -bottom-0.5 -left-0.5 size-10 rounded-bl-3xl border-b-4 border-l-4 border-white" />
                  <span className="absolute -right-0.5 -bottom-0.5 size-10 rounded-br-3xl border-r-4 border-b-4 border-white" />
                </div>
              </div>
              {status === 'starting' ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
                  <Spinner className="size-8" />
                  <span className="text-sm font-medium">Kamera wird gestartet …</span>
                </div>
              ) : null}
              {torch.supported ? (
                <IconButton
                  label={torch.on ? 'Taschenlampe ausschalten' : 'Taschenlampe einschalten'}
                  aria-pressed={torch.on}
                  variant="secondary"
                  className="absolute top-3 right-3 border-white/30! bg-black/50! text-white!"
                  onClick={() => void toggleTorch()}
                >
                  {torch.on ? (
                    <FlashlightOff className="size-6" aria-hidden />
                  ) : (
                    <Flashlight className="size-6" aria-hidden />
                  )}
                </IconButton>
              ) : null}
            </>
          )}
        </div>
      </div>
      {problem ? null : footer}
    </div>
  );
}
