import {
  cameraErrorMessage,
  cameraSupportProblem,
  createDeduper,
  INSECURE_CONTEXT_MESSAGE,
  NO_CAMERA_API_MESSAGE,
  supportsTorch,
} from './camera';

describe('cameraSupportProblem', () => {
  it('requires a secure context', () => {
    expect(cameraSupportProblem({ isSecureContext: false, hasGetUserMedia: true })).toBe(INSECURE_CONTEXT_MESSAGE);
    expect(INSECURE_CONTEXT_MESSAGE).toContain('HTTPS oder localhost');
  });

  it('requires getUserMedia', () => {
    expect(cameraSupportProblem({ isSecureContext: true, hasGetUserMedia: false })).toBe(NO_CAMERA_API_MESSAGE);
  });

  it('accepts a capable environment', () => {
    expect(cameraSupportProblem({ isSecureContext: true, hasGetUserMedia: true })).toBeNull();
  });
});

describe('cameraErrorMessage', () => {
  it.each([
    ['NotAllowedError', 'Kein Zugriff auf die Kamera'],
    ['SecurityError', 'Kein Zugriff auf die Kamera'],
    ['NotFoundError', 'keine Kamera gefunden'],
    ['OverconstrainedError', 'keine Kamera gefunden'],
    ['NotReadableError', 'anderen App'],
    ['NotSupportedError', 'nicht unterstützt'],
    ['SomethingElse', 'konnte nicht gestartet werden'],
  ])('%s', (name, expected) => {
    expect(cameraErrorMessage(new DOMException('x', name))).toContain(expected);
  });

  it('handles non-errors', () => {
    expect(cameraErrorMessage('nope')).toContain('konnte nicht gestartet werden');
  });
});

describe('supportsTorch', () => {
  it('reads the torch capability', () => {
    const track = (caps: object) => ({ getCapabilities: () => caps }) as unknown as MediaStreamTrack;
    expect(supportsTorch(track({ torch: true }))).toBe(true);
    expect(supportsTorch(track({}))).toBe(false);
    expect(supportsTorch({} as MediaStreamTrack)).toBe(false);
    expect(supportsTorch(null)).toBe(false);
  });
});

describe('createDeduper', () => {
  it('reports new values immediately and repeats after the interval', () => {
    const shouldReport = createDeduper(2000);
    expect(shouldReport('001', 0)).toBe(true);
    expect(shouldReport('001', 500)).toBe(false);
    expect(shouldReport('002', 600)).toBe(true);
    expect(shouldReport('001', 700)).toBe(true);
    expect(shouldReport('001', 2600)).toBe(false);
    expect(shouldReport('001', 2701)).toBe(true);
  });
});
