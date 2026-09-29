/**
 * QR scanner specs (project "qr-camera"): Chromium with a fake camera.
 *
 *   test.use({ camera: 'known' })   // top level of a spec file (it selects the browser)
 *   test('…', async ({ page, cameraCode }) => { … })
 *
 * The browser plays the video of the worker's parallel slot (written by the
 * global setup), `cameraCode` is the person number shown in it.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { CAMERA_CODES_FILE, cameraFile, fakeCameraArgs, type CameraVideo } from './env';
import { test as base } from './fixtures';

export const test = base.extend<{ cameraCode: string }, { camera: CameraVideo; cameraAutoAccept: boolean }>({
  camera: ['blank', { scope: 'worker', option: true }],
  /** false: no automatic camera permission (Chromium then denies the request). */
  cameraAutoAccept: [true, { scope: 'worker', option: true }],

  launchOptions: [
    async ({ camera, cameraAutoAccept }, use, workerInfo) => {
      const file = cameraFile(camera, workerInfo.parallelIndex);
      await use({ args: fakeCameraArgs(file, { autoAccept: cameraAutoAccept }) });
    },
    { scope: 'worker' },
  ],

  cameraCode: async ({ camera }, use, testInfo) => {
    if (camera === 'blank') return use('');
    const codes = JSON.parse(readFileSync(CAMERA_CODES_FILE, 'utf8')) as Record<'known' | 'unknown', string[]>;
    const code = codes[camera][testInfo.parallelIndex];
    if (!code) throw new Error(`no camera code for parallel index ${testInfo.parallelIndex}`);
    await use(code);
  },
});

export { expect } from './fixtures';

/** Records every camera stream the app opens, to check that the camera is released again. */
export async function trackCameraStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    (window as unknown as { __cameraStreams: MediaStream[] }).__cameraStreams = streams;
    const devices = navigator.mediaDevices;
    const original = devices?.getUserMedia?.bind(devices);
    if (!original) return;
    devices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      streams.push(stream);
      return stream;
    };
  });
}

export function liveCameraTracks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      ((window as unknown as { __cameraStreams?: MediaStream[] }).__cameraStreams ?? [])
        .flatMap((stream) => stream.getTracks())
        .filter((track) => track.readyState === 'live').length,
  );
}
