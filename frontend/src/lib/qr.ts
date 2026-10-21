/**
 * QR code generation (payload = person number, ARCHITECTURE.md §2).
 * Rendered as SVG path (screen/print) or onto a canvas (PNG download).
 */
import { create } from 'qrcode';

export interface QrMatrix {
  size: number;
  dark: (row: number, col: number) => boolean;
}

export function qrMatrix(value: string): QrMatrix {
  const { modules } = create(value, { errorCorrectionLevel: 'M' });
  return {
    size: modules.size,
    dark: (row, col) => modules.data[row * modules.size + col] === 1,
  };
}

export interface QrPath {
  path: string;
  /** Total size in modules, quiet zone included. */
  size: number;
}

/**
 * Paths of the most recently used codes (least recently used dropped first).
 * Encoding is the expensive part (≈ 0.1 ms per code, 4× that on a phone) and
 * a person's code never changes; the print sheet renders one per person
 * (docs/LOADTEST-FINDINGS.md F4). ≈ 1.6 KB per entry.
 */
const PATH_CACHE_SIZE = 2500;
const pathCache = new Map<string, QrPath>();

/**
 * SVG path for the dark modules (horizontal runs merged), including a quiet
 * zone of `margin` modules. Returns the path and the total size in modules.
 * Cached per value and margin; the result is shared (frozen).
 */
export function qrSvgPath(value: string, margin = 4): QrPath {
  const key = `${margin}:${value}`;
  const cached = pathCache.get(key);
  if (cached) {
    pathCache.delete(key); // Map order = recency
    pathCache.set(key, cached);
    return cached;
  }
  const result = Object.freeze(buildSvgPath(value, margin));
  pathCache.set(key, result);
  if (pathCache.size > PATH_CACHE_SIZE) {
    const oldest = pathCache.keys().next();
    if (!oldest.done) pathCache.delete(oldest.value);
  }
  return result;
}

function buildSvgPath(value: string, margin: number): QrPath {
  const matrix = qrMatrix(value);
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.dark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.dark(row, col)) col++;
      parts.push(`M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`);
    }
  }
  return { path: parts.join(''), size: matrix.size + margin * 2 };
}

interface QrCardOptions {
  value: string;
  title: string;
  subtitle?: string;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

/** Draws QR code + labels (number, name) onto a canvas, white background. */
export function drawQrCard(canvas: HTMLCanvasElement, { value, title, subtitle }: QrCardOptions): void {
  const matrix = qrMatrix(value);
  const margin = 4;
  const modules = matrix.size + margin * 2;
  const scale = Math.max(8, Math.floor(800 / modules));
  const qrPx = modules * scale;
  const textHeight = subtitle ? 200 : 130;
  canvas.width = qrPx;
  canvas.height = qrPx + textHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.dark(row, col)) ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
    }
  }

  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 84px ${font}`;
  ctx.fillText(fitText(ctx, title, qrPx - 40), qrPx / 2, qrPx + 70);
  if (subtitle) {
    ctx.font = `44px ${font}`;
    ctx.fillStyle = '#333333';
    ctx.fillText(fitText(ctx, subtitle, qrPx - 40), qrPx / 2, qrPx + 150);
  }
}

export function qrCardPngBlob(options: QrCardOptions): Promise<Blob> {
  const canvas = document.createElement('canvas');
  drawQrCard(canvas, options);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))), 'image/png');
  });
}

/** File-name safe version of a person number. */
export function qrFileName(number: string): string {
  return `qr-${number.replace(/[^A-Za-z0-9_-]/g, '_')}.png`;
}
