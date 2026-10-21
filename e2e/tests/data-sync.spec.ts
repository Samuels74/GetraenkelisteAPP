import type { Page, Request } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { realtimeSettled, subscribeOnly } from '../support/realtime';
import { expectPersonTotal, offeringTile, pickPerson, signIn } from '../support/ui';

const SESSION_EXPIRED = 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.';

/** A request of booking list pages. */
function isListRequest(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/api/collections/bookings/records');
}

/** Full (re)loads of list pages (head requests of new bookings – `created >=` – excluded). */
function recordListLoads(page: Page): string[] {
  const loads: string[] = [];
  page.on('request', (request) => {
    if (!isListRequest(request)) return;
    const filter = new URL(request.url()).searchParams.get('filter') ?? '';
    if (!filter.includes('created >=')) loads.push(filter);
  });
  return loads;
}

/** The UTC instant of hh:mm on the Vienna calendar day of `instant`. */
function viennaTime(instant: Date, hours: number, minutes: number): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', dateStyle: 'short' }).format(instant);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  for (const offset of [1, 2]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hours - offset, minutes));
    const shown = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', timeStyle: 'short' }).format(candidate);
    if (shown === `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`) return candidate;
  }
  throw new Error(`no ${hours}:${minutes} on ${day} in Vienna`);
}

test.describe('session', () => {
  test('a tap of a user who was disabled meanwhile: "session expired", not a permission error', { tag: '@regression' }, async ({
    page,
    data,
  }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();
    // no events: a refetch caused by a parallel test would meet the revoked token first (also a 401 → login)
    await subscribeOnly(page, []);
    await signIn(page, user);
    await pickPerson(page, person);
    // the card has loaded (a request still under way would meet the revoked token first)
    await expectPersonTotal(page, 0, 0);
    await expect(page.getByText('Noch keine Buchungen.')).toBeVisible();

    await data.disableUser(user); // PocketBase answers the revoked token like a guest: the booking → 400
    await offeringTile(page, cola!.name).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(SESSION_EXPIRED)).toHaveCount(1);
    await expect(page.getByText('Das ist nicht möglich', { exact: false })).toHaveCount(0);
    expect(await data.bookingsOf(person)).toEqual([]);
  });
});

test.describe('data that follows changes elsewhere', () => {
  test('"Heute" moves on to the new day at midnight – without any booking', { tag: '@regression' }, async ({ page, data }) => {
    const user = await data.user();
    const {
      offerings: [water],
    } = await data.catalog([{ label: 'Wasser', priceCents: 100 }]);
    const person = await data.person();
    const booking = await data.booking(person, water!, { by: user });

    // the page's clock: one minute before the end of the booking's day (Vienna)
    await page.clock.install({ time: viennaTime(new Date(booking.created.replace(' ', 'T')), 23, 59) });
    await subscribeOnly(page, ['bookings']);
    await signIn(page, user, `/buchungen?zeitraum=heute&person=${person.id}`);
    await expect(page.getByTestId('bookings-count')).toHaveText('1');
    await expect(page.getByTestId('booking-item')).toHaveCount(1);

    await page.clock.fastForward('02:00'); // 00:01 of the next day
    await expect(page.getByTestId('bookings-count')).toHaveText('0');
    await expect(page.getByTestId('booking-item')).toHaveCount(0);
  });

  test('a renamed person or user: the open list shows the new names without reloading its pages', { tag: '@regression' }, async ({
    page,
    data,
    adminApi,
  }) => {
    const user = await data.user();
    const colleague = await data.user({ name: data.name('Anna') });
    const {
      offerings: [water],
    } = await data.catalog([{ label: 'Wasser', priceCents: 100 }]);
    const person = await data.person();
    for (let i = 0; i < 3; i++) await data.booking(person, water!, { by: colleague });

    await subscribeOnly(page, ['bookings', 'persons', 'users']);
    // (person and user events of parallel tests reload the persons all the time: only list requests count)
    const settled = realtimeSettled(page, isListRequest);
    await signIn(page, user, `/buchungen?person=${person.id}`);
    const items = page.getByTestId('booking-item');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText(`von ${colleague.name}`);
    // the first connect's refetch of the list is no reload because of a rename
    await settled();
    const loads = recordListLoads(page);

    // the person: the filter shows the new name; no list page is loaded again (before: all of them, FLOW-7)
    const personName = data.name('Neu');
    await adminApi.collection('persons').update(person.id, { name: personName });
    await expect(page.getByTestId('person-filter')).toContainText(personName);

    // another user (a non-admin device sees other users' names with their bookings, FLOW-11)
    const colleagueName = data.name('Anna Neu');
    await adminApi.collection('users').update(colleague.id, { name: colleagueName });
    for (const item of await items.all()) await expect(item).toContainText(`von ${colleagueName}`);
    expect(loads).toEqual([]);
  });
});
