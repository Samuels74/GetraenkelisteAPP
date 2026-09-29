/**
 * Page helpers shared by the specs (locators, login, booking, checks).
 */
import path from 'node:path';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { TestUser } from './data';
import { RESULTS_DIR } from './env';

/** localStorage key of the PocketBase SDK auth store. */
export const AUTH_STORAGE_KEY = 'pocketbase_auth';
/** localStorage key of the selected person on the booking screen. */
export const SELECTED_PERSON_KEY = 'gl.selectedPersonId';

const currency = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });

/** Display format of the app (`€ 3,50`); Playwright text matching normalizes the no-break space. */
export function euro(cents: number): string {
  return currency.format(cents / 100).replace(/[\u00a0\u202f]/g, ' ');
}

/** CSV / input format: `3,50`, `-0,50`. */
export function plainAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Value for a CSS attribute selector in double quotes. */
export function attr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Logs `user` in by putting the SDK auth state into localStorage (fast path; the login UI has its own tests). */
export async function signIn(page: Page, user: Pick<TestUser, 'api'>, target = '/'): Promise<void> {
  const auth = JSON.stringify({ token: user.api.authStore.token, record: user.api.authStore.record });
  await page.goto('/login');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [AUTH_STORAGE_KEY, auth] as const);
  await page.goto(target);
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
}

/**
 * `page.reload()`, repeated once when WebKit fails it with "internal error" – a
 * browser hiccup that happens (rarely, under load) when the reload races with
 * the app's own requests right after a navigation.
 */
export async function reloadPage(page: Page): Promise<void> {
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('WebKit encountered an internal error')) throw error;
    await page.reload();
  }
}

export async function loginViaUi(page: Page, username: string, password: string): Promise<void> {
  if (!new URL(page.url(), 'http://x').pathname.startsWith('/login')) await page.goto('/login');
  const form = page.getByRole('form', { name: 'Anmelden' });
  await form.getByLabel('Benutzername').fill(username);
  await form.getByLabel('Passwort', { exact: true }).fill(password);
  await form.getByRole('button', { name: 'Anmelden' }).click();
}

export async function logoutViaUi(page: Page): Promise<void> {
  await page.getByTestId('nav-konto').click();
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
}

// ------------------------------------------------------------------ forced password change

/** The blocking "Neues Passwort festlegen" screen (users with `mustChangePassword`). */
export function forcePasswordScreen(page: Page): Locator {
  return page.getByTestId('force-password');
}

/**
 * Sets the own password on the blocking screen. `current` is only asked for
 * after a reload (the login password is kept in memory only).
 */
export async function setForcedPassword(page: Page, password: string, current?: string): Promise<void> {
  const form = page.getByTestId('force-password-form');
  if (current !== undefined) await form.getByLabel('Aktuelles Passwort').fill(current);
  await form.getByLabel('Neues Passwort', { exact: true }).fill(password);
  await form.getByLabel('Neues Passwort wiederholen').fill(password);
  await form.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page.getByText('Passwort gespeichert')).toBeVisible();
  await expect(forcePasswordScreen(page)).toHaveCount(0);
}

// ------------------------------------------------------------------ booking screen

/** Offering tile by name (optionally within a group section, names are only unique per group). */
export function offeringTile(scope: Page | Locator, name: string): Locator {
  return scope.locator(`[data-testid="offering-tile"][data-offering-name="${attr(name)}"]`);
}

export function currentPerson(page: Page): Locator {
  return page.getByTestId('current-person');
}

export function personPicker(page: Page): Locator {
  return page.getByTestId('person-picker');
}

/** Opens the picker from the person card and selects `person` by searching `query` (default: its number). */
export async function pickPerson(page: Page, person: { number: string }, query = person.number): Promise<void> {
  const card = currentPerson(page);
  await card.getByRole('button', { name: /^(Person wählen|Person wechseln)/ }).click();
  const picker = personPicker(page);
  await picker.getByTestId('person-search').fill(query);
  await picker.locator(`[data-testid="person-option"][data-person-number="${attr(person.number)}"]`).click();
  await expect(picker).toBeHidden();
  await expect(card).toHaveAttribute('data-person-number', person.number);
}

const BOOKING_CREATE = /\/api\/collections\/bookings\/records(\?|$)/;

/**
 * Taps an offering tile and waits for the confirmation toast. Parallel tests
 * add/remove groups above the tile (realtime); WebKit has no scroll anchoring,
 * so the tile can move between Playwright's hit test and the tap. A tap that
 * sent no booking request is simply repeated – like a user would.
 */
export async function bookTile(page: Page, offering: { name: string }, unitPriceCents: number): Promise<void> {
  const tile = offeringTile(page, offering.name);
  for (let attempt = 1; ; attempt++) {
    const sent = page
      .waitForRequest((request) => request.method() === 'POST' && BOOKING_CREATE.test(request.url()), { timeout: 3_000 })
      .then(
        () => true,
        () => false,
      );
    await tile.click();
    if (await sent) break;
    if (attempt === 3) throw new Error(`tapping "${offering.name}" sent no booking request (3 attempts)`);
  }
  await expect(bookingToast(page, offering.name, unitPriceCents)).toBeVisible();
}

export function bookingToast(page: Page, offeringName: string, unitPriceCents: number): Locator {
  return page.getByText(`${offeringName} gebucht · ${euro(unitPriceCents)}`, { exact: true });
}

export async function expectPersonTotal(page: Page, totalCents: number, count: number): Promise<void> {
  await expect(page.getByTestId('current-person-total')).toHaveText(euro(totalCents));
  await expect(page.getByTestId('current-person-count')).toHaveText(`· ${count} ${count === 1 ? 'Buchung' : 'Buchungen'}`);
}

// ------------------------------------------------------------------ admin screens

/**
 * Sets a switch row (label + `role="switch"` checkbox) by tapping its label, like a
 * user does. Repeats the tap if WebKit under load drops it while a dialog animates in.
 */
export async function setSwitch(scope: Locator, label: string, checked: boolean): Promise<void> {
  const control = scope.getByRole('switch', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
  await expect(async () => {
    if ((await control.isChecked()) !== checked) await scope.getByText(label, { exact: true }).click({ timeout: 2_000 });
    await expect(control).toBeChecked({ checked, timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

export function offeringRow(page: Page, name: string): Locator {
  return page.locator(`[data-testid="offering-row"][data-offering-name="${attr(name)}"]`);
}

export function groupRow(page: Page, name: string): Locator {
  return page.locator(`[data-testid="group-row"][data-group-name="${attr(name)}"]`);
}

export function userRow(page: Page, username: string): Locator {
  return page.locator(`[data-testid="user-row"][data-username="${attr(username)}"]`);
}

/**
 * Opens the edit dialog of an offering, group or user ("<name> bearbeiten") and
 * makes sure it belongs to that record before the test changes anything: rows of
 * parallel tests appear/disappear above it, which can move the row in WebKit
 * between hit test and tap. A wrong dialog is closed and the tap repeated.
 */
export async function openEditDialog(page: Page, kind: 'offering' | 'group' | 'user', name: string): Promise<Locator> {
  const dialog = page.getByTestId(`${kind}-dialog`);
  await expect(async () => {
    if (await dialog.isVisible()) await dialog.getByTestId('dialog-close').click();
    await page.getByRole('button', { name: `${name} bearbeiten`, exact: true }).click();
    if (kind === 'user') {
      await expect(dialog.getByRole('heading', { name: `Benutzer ${name}`, exact: true })).toBeVisible({ timeout: 2_000 });
    } else {
      await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name, { timeout: 2_000 });
    }
  }).toPass({ timeout: 20_000 });
  return dialog;
}

// ------------------------------------------------------------------ checks

/** The document must not scroll horizontally (call after the page content is rendered). */
export async function expectNoHorizontalOverflow(page: Page, label = page.url()): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `horizontal overflow on ${label}`).toBeLessThanOrEqual(clientWidth);
}

/** Every element matched by `locator` must be at least `min` × `min` CSS pixels. */
export async function expectTapTargets(locator: Locator, min = 48): Promise<void> {
  const boxes = await locator.evaluateAll((elements) =>
    elements.map((el) => {
      const rect = el.getBoundingClientRect();
      const label = el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.textContent?.trim() || el.tagName;
      return { label, width: rect.width, height: rect.height };
    }),
  );
  expect(boxes.length, 'no tap targets found').toBeGreaterThan(0);
  const tooSmall = boxes.filter((box) => box.width < min - 0.5 || box.height < min - 0.5);
  expect(tooSmall, `tap targets smaller than ${min}px`).toEqual([]);
}

/**
 * Screenshot for manual review: <results>/screenshots/<project>/<name>.png (not attached to
 * the report, which would store every image twice more). `fullPage` enlarges the viewport
 * to the document height first, so fixed elements (bottom navigation, toasts) end up where
 * a user would see them at the end of the page.
 */
export async function saveScreenshot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
  const file = path.join(RESULTS_DIR, 'screenshots', testInfo.project.name, `${name}.png`);
  const viewport = page.viewportSize();
  const height = fullPage ? await page.evaluate(() => document.documentElement.scrollHeight) : 0;
  const resize = viewport !== null && height > viewport.height;
  if (resize) await page.setViewportSize({ width: viewport.width, height });
  try {
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  } finally {
    if (resize) await page.setViewportSize(viewport);
  }
}
