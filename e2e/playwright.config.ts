import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, EXTERNAL_BASE_URL, PORT, RESULTS_DIR } from './support/env';

const CI = Boolean(process.env.CI);

/** QR scanning needs Chromium's fake camera → own project, see tests/qr/. */
const SCAN_SPEC = /[\\/]tests[\\/]qr[\\/][^\\/]+\.spec\.ts$/;
/** Tests that need a quiet server (no realtime events of parallel tests), see tests/isolated/. */
const ISOLATED_SPEC = /[\\/]tests[\\/]isolated[\\/][^\\/]+\.spec\.ts$/;
const MAIN_PROJECTS = ['mobile-chrome', 'mobile-safari', 'desktop-chrome', 'qr-camera'];

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(RESULTS_DIR, 'artifacts'),
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : CI ? 4 : '50%',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(RESULTS_DIR, 'html-report'), open: 'never' }],
    ['junit', { outputFile: path.join(RESULTS_DIR, 'junit.xml') }],
  ],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL: BASE_URL,
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-first-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testIgnore: [SCAN_SPEC, ISOLATED_SPEC],
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 15'] },
      testIgnore: [SCAN_SPEC, ISOLATED_SPEC],
    },
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [SCAN_SPEC, ISOLATED_SPEC],
      // phone-only checks (bottom bar, 360 px layout) are tagged @mobile
      grepInvert: /@mobile/,
    },
    {
      // Chromium with a fake camera; each spec file picks its video (support/scanner.ts)
      name: 'qr-camera',
      use: { ...devices['Pixel 7'], permissions: ['camera'] },
      testMatch: SCAN_SPEC,
    },
    // after all other projects, one after the other (see ISOLATED_SPEC)
    {
      name: 'isolated-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: ISOLATED_SPEC,
      dependencies: MAIN_PROJECTS,
      fullyParallel: false,
    },
    {
      name: 'isolated-safari',
      use: { ...devices['iPhone 15'] },
      testMatch: ISOLATED_SPEC,
      dependencies: ['isolated-chrome'],
      fullyParallel: false,
    },
  ],

  // A fresh PocketBase (temp data dir) serving the built SPA – unless BASE_URL is set.
  // Ready = healthy AND login throttling disabled, so no `url` check (it would
  // report ready as soon as /api/health answers).
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: 'exec node scripts/start-pocketbase.mjs',
        wait: { stdout: /\[pocketbase\] ready/ },
        timeout: 60_000,
        stdout: 'ignore',
        stderr: 'pipe',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
        env: {
          E2E_PORT: String(PORT),
          PB_LOG_FILE: path.join(RESULTS_DIR, 'pocketbase.log'),
        },
      },
});
