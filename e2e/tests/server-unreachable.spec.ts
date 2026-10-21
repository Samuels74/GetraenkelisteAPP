import type { Page, Route } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { realtimeSettled, subscribeOnly } from '../support/realtime';
import { AUTH_STORAGE_KEY, bookTile, expectPersonTotal, offeringTile, pickPerson, signIn } from '../support/ui';

const UNREACHABLE = 'Der Server ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.';
const HINT = 'Verbindung zum Server unterbrochen – Anzeige evtl. nicht aktuell.';

/**
 * A reverse proxy whose upstream is gone for a moment (the app container
 * restarting): every API request but the realtime stream gets its page –
 * Traefik's "404 page not found" (text) or a 502 (HTML). Returns the undo.
 */
async function proxyWithoutUpstream(page: Page, status: 404 | 502): Promise<() => Promise<void>> {
  const handler = (route: Route) => {
    if (new URL(route.request().url()).pathname === '/api/realtime') return route.fallback();
    return status === 404
      ? route.fulfill({ status, contentType: 'text/plain', body: '404 page not found\n' })
      : route.fulfill({ status, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' });
  };
  await page.route('**/api/**', handler);
  return () => page.unroute('**/api/**', handler);
}

test.describe('the server cannot be reached for a moment', () => {
  test('a proxy\'s 404 page does not log the phone out – not on a tap, not on the minute\'s session check', { tag: '@regression' }, async ({
    page,
    data,
  }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();
    await page.clock.install();
    await subscribeOnly(page, []);
    await signIn(page, user);
    await pickPerson(page, person);
    await expectPersonTotal(page, 0, 0);

    const restore = await proxyWithoutUpstream(page, 404);
    await offeringTile(page, cola!.name).click();
    await expect(page.getByText(UNREACHABLE)).toBeVisible();
    // the minute's session check meets the 404 as well
    const check = page.waitForRequest((request) => request.url().includes('/auth-refresh'));
    await page.clock.fastForward(61_000);
    await check;
    await page.waitForTimeout(500);
    await expect(page).not.toHaveURL(/\/login/);
    expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_STORAGE_KEY)).toContain('token');
    await expect(page.getByText('Deine Sitzung ist abgelaufen', { exact: false })).toHaveCount(0);

    // the app is back: booking works – nothing was booked meanwhile
    await restore();
    await bookTile(page, cola!, 250);
    await expectPersonTotal(page, 250, 1);
    expect(await data.bookingsOf(person)).toHaveLength(1);
  });

  test('a refresh that fails keeps the numbers – with a hint and a retry', { tag: '@regression' }, async ({ page, data }) => {
    const user = await data.user();
    const anna = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();
    await data.booking(person, cola!, { by: anna });
    await subscribeOnly(page, ['bookings']);
    const settled = realtimeSettled(page);
    await signIn(page, user, `/buchungen?person=${person.id}`);
    await expect(page.getByTestId('bookings-count')).toHaveText('1');
    await expect(page.getByTestId('booking-item')).toHaveCount(1);
    // (a late answer of the first connect's refetch would already contain the next booking)
    await settled();

    const restore = await proxyWithoutUpstream(page, 502);
    // another phone books: the event arrives, the refresh fails (502 – after its retries)
    await data.booking(person, cola!, { by: anna });
    const hint = page.getByTestId('connection-hint');
    await expect(hint).toHaveText(new RegExp(HINT));
    await expect(page.getByTestId('bookings-count')).toHaveText('1'); // kept, not blanked
    await expect(page.getByTestId('booking-item')).toHaveCount(1);

    await restore();
    await hint.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByTestId('bookings-count')).toHaveText('2');
    await expect(page.getByTestId('booking-item')).toHaveCount(2);
    await expect(hint).toHaveCount(0);
  });

  test('a cancellation on its way cannot be called off – the answer closes the dialog', { tag: '@regression' }, async ({
    page,
    data,
  }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();
    await data.booking(person, cola!, { by: user });
    await subscribeOnly(page, ['bookings']);
    await signIn(page, user, `/buchungen?person=${person.id}`);
    await expect(page.getByTestId('booking-item')).toHaveCount(1);

    // the DELETE takes a while (slow network)
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/collections/bookings/records/*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      await held;
      return route.continue();
    });
    await page.getByTestId('booking-item').getByRole('button', { name: 'Buchung stornieren' }).click();
    const dialog = page.getByTestId('cancel-booking-dialog');
    await dialog.getByRole('button', { name: 'Stornieren' }).click();
    await expect(dialog.getByRole('button', { name: 'Abbrechen' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Schließen' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    release();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Buchung storniert')).toBeVisible();
    await expect(page.getByTestId('booking-item')).toHaveCount(0);
    expect(await data.bookingsOf(person)).toEqual([]);
  });
});
