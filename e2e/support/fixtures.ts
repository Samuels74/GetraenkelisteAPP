/**
 * Test fixtures:
 *   data        per-test data factory (API) with automatic cleanup, see data.ts
 *   openPage    opens another browser context (same device settings, "another phone")
 *   openAs      the same, logged in as a user
 *   adminApi    API client of the bootstrap admin (per worker)
 *   pageErrors  (auto) uncaught exceptions in any page of the test fail the test
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type PocketBase from 'pocketbase';
import { apiLogin, TestData, type TestUser } from './data';
import { BOOTSTRAP_ADMIN } from './env';
import { signIn } from './ui';

interface TestFixtures {
  data: TestData;
  /** A page in a new browser context (another phone), not logged in. */
  openPage: () => Promise<Page>;
  /** A page in a new browser context, logged in as `user`, showing `path`. */
  openAs: (user: TestUser, path?: string) => Promise<Page>;
  pageErrors: string[];
}

interface WorkerFixtures {
  adminApi: PocketBase;
}

/**
 * WebKit logs requests that are aborted by a navigation as "Fetch API cannot load
 * <url> due to access control checks." and Playwright reports that as a page error.
 * The app only talks to its own origin, so this is never a real CORS problem.
 */
const IGNORED_PAGE_ERRORS = [/ due to access control checks\.?$/];

function watchErrors(context: BrowserContext, errors: string[]): void {
  context.on('weberror', (webError) => {
    const message = webError.error().message;
    if (IGNORED_PAGE_ERRORS.some((pattern) => pattern.test(message))) return;
    errors.push(`${webError.page()?.url() ?? '?'}: ${message}`);
  });
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  adminApi: [
    async ({}, use) => {
      await use(await apiLogin(BOOTSTRAP_ADMIN.username, BOOTSTRAP_ADMIN.password));
    },
    { scope: 'worker' },
  ],

  data: async ({ adminApi }, use) => {
    const data = new TestData(adminApi);
    await use(data);
    await data.cleanup();
  },

  pageErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      watchErrors(context, errors);
      await use(errors);
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],

  openPage: async ({ browser, pageErrors }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext();
      watchErrors(context, pageErrors);
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((context) => context.close()));
  },

  openAs: async ({ openPage }, use) => {
    await use(async (user, path = '/') => {
      const page = await openPage();
      await signIn(page, user, path);
      return page;
    });
  },
});

export { expect };
