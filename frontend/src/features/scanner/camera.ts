/**
 * Camera helpers for the QR scanner (pure / environment-injectable so they can
 * be unit-tested).
 */

export const INSECURE_CONTEXT_MESSAGE =
  'Die Kamera ist nur über eine sichere Verbindung verfügbar (HTTPS oder localhost). ' +
  'Bitte öffne die App über ihre HTTPS-Adresse oder suche die Person über Nummer oder Namen.';

export const NO_CAMERA_API_MESSAGE =
  'Dieser Browser unterstützt keinen Kamerazugriff. Bitte suche die Person über Nummer oder Namen.';

interface CameraEnvironment {
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
}

export function currentCameraEnvironment(): CameraEnvironment {
  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
    hasGetUserMedia:
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices !== 'undefined' &&
      typeof navigator.mediaDevices.getUserMedia === 'function',
  };
}

/** Returns a German explanation if the camera cannot be used at all, else `null`. */
export function cameraSupportProblem(env: CameraEnvironment = currentCameraEnvironment()): string | null {
  if (!env.isSecureContext) return INSECURE_CONTEXT_MESSAGE;
  if (!env.hasGetUserMedia) return NO_CAMERA_API_MESSAGE;
  return null;
}

/** Maps getUserMedia errors to German messages. */
export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return (
        'Kein Zugriff auf die Kamera. Bitte erlaube den Kamerazugriff für diese Seite ' +
        '(Browser-Einstellungen → Website-Berechtigungen) und versuche es erneut.'
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Es wurde keine Kamera gefunden.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Die Kamera kann nicht gestartet werden – vielleicht wird sie gerade von einer anderen App verwendet.';
    case 'NotSupportedError':
      return 'Die Kamera wird hier nicht unterstützt. Bitte öffne die App über HTTPS in einem aktuellen Browser.';
    default:
      return 'Die Kamera konnte nicht gestartet werden.';
  }
}

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

export function supportsTorch(track: MediaStreamTrack | null | undefined): boolean {
  if (!track || typeof track.getCapabilities !== 'function') return false;
  try {
    return (track.getCapabilities() as TorchCapabilities).torch === true;
  } catch {
    return false;
  }
}

export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
}

/**
 * Suppresses repeated reports of the same code: a value is reported when it
 * differs from the previous one or after `repeatAfterMs`.
 */
export function createDeduper(repeatAfterMs = 2000) {
  let lastValue: string | null = null;
  let lastTime = -Infinity;
  return (value: string, now: number): boolean => {
    if (value === lastValue && now - lastTime < repeatAfterMs) return false;
    lastValue = value;
    lastTime = now;
    return true;
  };
}
