/**
 * QR code detection.
 *
 * Uses the native Barcode Detection API where it exists and supports QR codes
 * (Android Chrome, macOS Chrome), otherwise the `barcode-detector` ponyfill
 * (ZXing-C++ compiled to WebAssembly) – e.g. iOS Safari, Firefox, Chromium on
 * Linux/Windows. The WASM binary is bundled by Vite and served by us; nothing
 * is fetched from a CDN.
 */
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export interface DetectedCode {
  rawValue: string;
}

export interface QrDetector {
  readonly kind: 'native' | 'wasm';
  detect(source: HTMLVideoElement): Promise<DetectedCode[]>;
}

interface NativeBarcodeDetector {
  detect(source: HTMLVideoElement): Promise<DetectedCode[]>;
}

interface NativeBarcodeDetectorConstructor {
  new (options: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

async function createNativeDetector(): Promise<QrDetector | null> {
  const Native = (globalThis as { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector;
  if (!Native) return null;
  try {
    const formats = await Native.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    const detector = new Native({ formats: ['qr_code'] });
    return { kind: 'native', detect: (source) => detector.detect(source) };
  } catch {
    return null;
  }
}

let wasmDetector: Promise<QrDetector> | null = null;

/** Loads the WASM based detector (once) and preloads the WASM module. */
export function createWasmDetector(): Promise<QrDetector> {
  wasmDetector ??= (async () => {
    const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
    await prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
      },
      fireImmediately: true,
    });
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    return { kind: 'wasm', detect: (source: HTMLVideoElement) => detector.detect(source) } satisfies QrDetector;
  })();
  wasmDetector.catch(() => {
    wasmDetector = null;
  });
  return wasmDetector;
}

/** Native detector if usable, otherwise the WASM fallback. */
export async function createQrDetector(): Promise<QrDetector> {
  return (await createNativeDetector()) ?? createWasmDetector();
}
