// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ZXING_WASM_SHA256, ZXING_WASM_VERSION } from 'barcode-detector/ponyfill';

/**
 * The scanner serves `zxing-wasm/reader/zxing_reader.wasm` itself (no CDN).
 * The JS glue bundled in `barcode-detector` must match that binary exactly –
 * this guards against version drift when upgrading either package.
 */
describe('bundled ZXing WASM', () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
  // dist/reader/zxing_reader.wasm → package root
  const pkgPath = join(dirname(wasmPath), '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; version: string };

  it('has the version expected by barcode-detector', () => {
    expect(pkg.name).toBe('zxing-wasm');
    expect(pkg.version).toBe(ZXING_WASM_VERSION);
  });

  it('has the checksum expected by barcode-detector', () => {
    const hash = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
    expect(hash).toBe(ZXING_WASM_SHA256);
  });
});
