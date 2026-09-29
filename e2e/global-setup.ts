/**
 * Runs once before all tests (after the webServer is up):
 * - writes the fake camera videos (they must exist before Chromium starts)
 * - external instance (BASE_URL): optionally disables the login throttling
 * - checks that the app answers and the bootstrap admin can log in
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { FullConfig } from '@playwright/test';
import PocketBase from 'pocketbase';
import { blankVideo, qrCodeVideo } from './support/camera';
import { BASE_URL, BOOTSTRAP_ADMIN, CAMERA_CODES_FILE, CAMERA_DIR, cameraFile, EXTERNAL_BASE_URL } from './support/env';

async function waitForHealth(deadline: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${BASE_URL}/api/health is not reachable: ${String(lastError)}`);
}

/**
 * The app throttles logins (10 / 60 s per IP) and the parallel workers share
 * one IP. The PocketBase started by the webServer is already prepared; an
 * external instance (BASE_URL) is only changed when superuser credentials
 * are given – the rate limiter then stays disabled until re-enabled in the
 * dashboard (Settings → Rate limits).
 */
async function disableLoginThrottlingOnExternalInstance(): Promise<void> {
  const { E2E_SUPERUSER_EMAIL: identity, E2E_SUPERUSER_PASSWORD: password } = process.env;
  if (!identity || !password) {
    console.warn('[e2e] BASE_URL without E2E_SUPERUSER_EMAIL/PASSWORD: login throttling may cause HTTP 429.');
    return;
  }
  const pb = new PocketBase(BASE_URL);
  await pb.collection('_superusers').authWithPassword(identity, password);
  await pb.settings.update({ rateLimits: { enabled: false } });
  console.warn(`[e2e] login throttling disabled on ${BASE_URL} (re-enable it in the dashboard afterwards).`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Person numbers encoded in the QR videos: one pair per parallel worker slot,
  // unique per run (the same instance may be tested repeatedly via BASE_URL).
  const run = randomBytes(3).toString('hex');
  const slots = Array.from({ length: Math.max(1, config.workers) }, (_, index) => index);
  const codes = {
    known: slots.map((index) => `qk${run}${index}`),
    unknown: slots.map((index) => `qu${run}${index}`),
  };
  await rm(CAMERA_DIR, { recursive: true, force: true });
  await mkdir(CAMERA_DIR, { recursive: true });
  await writeFile(cameraFile('blank', 0), blankVideo());
  for (const index of slots) {
    await writeFile(cameraFile('known', index), qrCodeVideo(codes.known[index]!));
    await writeFile(cameraFile('unknown', index), qrCodeVideo(codes.unknown[index]!));
  }
  await writeFile(CAMERA_CODES_FILE, JSON.stringify(codes));

  await waitForHealth(Date.now() + 30_000);
  if (EXTERNAL_BASE_URL) await disableLoginThrottlingOnExternalInstance();
  const index = await fetch(`${BASE_URL}/`);
  const html = await index.text();
  if (!index.ok || !html.includes('<div id="root">')) {
    throw new Error(`${BASE_URL}/ does not serve the SPA (HTTP ${index.status})`);
  }
  const pb = new PocketBase(BASE_URL);
  try {
    await pb.collection('users').authWithPassword(BOOTSTRAP_ADMIN.username, BOOTSTRAP_ADMIN.password);
  } catch (error) {
    throw new Error(
      `bootstrap admin "${BOOTSTRAP_ADMIN.username}" cannot log in at ${BASE_URL} ` +
        `(set E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD): ${String(error)}`,
    );
  }
  if (pb.authStore.record?.role !== 'admin') {
    throw new Error(`bootstrap user "${BOOTSTRAP_ADMIN.username}" is not an admin`);
  }
}
