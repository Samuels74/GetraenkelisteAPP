/**
 * Fake camera videos for Chromium (`--use-file-for-fake-video-capture`):
 * YUV4MPEG2 (4:2:0) files showing a QR code or an empty scene. Chromium loops
 * the file, so a few identical frames are enough.
 */
import QRCode from 'qrcode';

const WIDTH = 640;
const HEIGHT = 480;
const FRAMES = 2;

function y4m(luma: Buffer): Buffer {
  const chroma = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2), 128); // no colour
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F15:1 Ip A1:1 C420jpeg\n`);
  return Buffer.concat([header, ...Array.from({ length: FRAMES }, () => frame)]);
}

/** A QR code (black on white, quiet zone) centred on a grey "room" background. */
export function qrCodeVideo(text: string): Buffer {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  const quiet = 4;
  const scale = Math.floor(300 / (n + quiet * 2));
  const size = (n + quiet * 2) * scale;
  const x0 = Math.floor((WIDTH - size) / 2);
  const y0 = Math.floor((HEIGHT - size) / 2);
  const luma = Buffer.alloc(WIDTH * HEIGHT, 90);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - quiet;
      const col = Math.floor(x / scale) - quiet;
      const dark = row >= 0 && col >= 0 && row < n && col < n && modules.data[row * n + col] === 1;
      luma[(y0 + y) * WIDTH + (x0 + x)] = dark ? 16 : 235;
    }
  }
  return y4m(luma);
}

/** A smooth pattern without any code. */
export function blankVideo(): Buffer {
  const luma = Buffer.alloc(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      luma[y * WIDTH + x] = 60 + Math.round(40 * Math.sin(x / 40) * Math.cos(y / 50));
    }
  }
  return y4m(luma);
}
