/**
 * Settings shared by the Playwright config, global setup and the tests.
 *
 * Environment:
 *   BASE_URL            test an already running instance instead of starting PocketBase
 *   E2E_PORT            port of the throw-away PocketBase (default 18181)
 *   E2E_WORKERS         number of parallel workers
 *   E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD
 *                       bootstrap admin used to create test data through the API
 *                       (default: the seeded admin/admin – never modified by the tests)
 *   E2E_SUPERUSER_EMAIL / E2E_SUPERUSER_PASSWORD
 *                       only with BASE_URL: superuser that disables the login throttling
 *                       of the external instance (the tests log in far more than 10×/min)
 *   TEST_RESULTS_DIR    reports go to $TEST_RESULTS_DIR/e2e (default: e2e/test-results)
 *   PB_BIN, PB_MIGRATIONS_DIR, PB_HOOKS_DIR, PB_PUBLIC_DIR
 *                       see scripts/start-pocketbase.mjs
 */
import os from 'node:os';
import path from 'node:path';

export const E2E_DIR = path.resolve(import.meta.dirname, '..');

export const RESULTS_DIR = process.env.TEST_RESULTS_DIR
  ? path.resolve(process.env.TEST_RESULTS_DIR, 'e2e')
  : path.join(E2E_DIR, 'test-results');

export const PORT = Number(process.env.E2E_PORT || 18181);

/** Set when testing an external instance (no PocketBase is started). */
export const EXTERNAL_BASE_URL = process.env.BASE_URL?.trim().replace(/\/+$/, '') || undefined;

export const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/** The seeded admin (ARCHITECTURE.md §4). Its password is never changed by the tests. */
export const SEEDED_ADMIN = { username: 'admin', password: 'admin' } as const;

export const BOOTSTRAP_ADMIN = {
  username: process.env.E2E_ADMIN_USERNAME || SEEDED_ADMIN.username,
  password: process.env.E2E_ADMIN_PASSWORD || SEEDED_ADMIN.password,
};

/**
 * Fake camera videos (Chromium `--use-file-for-fake-video-capture`), written by
 * the global setup. The QR videos exist once per parallel worker slot, each with
 * its own person number, so parallel scan tests never see each other's persons.
 */
export const CAMERA_DIR = path.join(os.tmpdir(), 'getraenkeliste-e2e-camera');

/** JSON `{ known: string[], unknown: string[] }`: the numbers per parallel index. */
export const CAMERA_CODES_FILE = path.join(CAMERA_DIR, 'codes.json');

/** `known`: a person the test creates, `unknown`: nobody has that number, `blank`: no code at all. */
export type CameraVideo = 'known' | 'unknown' | 'blank';

export function cameraFile(video: CameraVideo, parallelIndex: number): string {
  return path.join(CAMERA_DIR, video === 'blank' ? 'blank.y4m' : `qr-${video}-${parallelIndex}.y4m`);
}

/** Chromium flags for a fake camera that plays `file`. */
export function fakeCameraArgs(file: string, { autoAccept = true } = {}): string[] {
  return [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${file}`,
    ...(autoAccept ? ['--use-fake-ui-for-media-stream'] : []),
  ];
}
