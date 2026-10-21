import { expect, test } from '../support/fixtures';
import { realtimeSettled } from '../support/realtime';
import {
  bookTile,
  currentPerson,
  euro,
  expectPersonTotal,
  offeringTile,
  pickPerson,
  signIn,
} from '../support/ui';

test.describe('realtime', () => {
  test('bookings and offerings from one phone show up on the others without reload', async ({ page, data, openAs }) => {
    const anna = await data.user();
    const ben = await data.user();
    const {
      group,
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();

    // Ben: the person's bookings on one phone, the booking screen on another
    const benList = await openAs(ben, `/buchungen?person=${person.id}`);
    await expect(benList.getByTestId('bookings-count')).toHaveText('0');
    const benBook = await openAs(ben);
    await pickPerson(benBook, person);
    await expectPersonTotal(benBook, 0, 0);
    for (const phone of [benList, benBook]) {
      await phone.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    }

    // Anna books
    await signIn(page, anna);
    await pickPerson(page, person);
    await bookTile(page, cola!, 250);

    await expect(benList.getByTestId('bookings-count')).toHaveText('1');
    await expect(benList.getByTestId('bookings-total')).toHaveText(euro(250));
    await expect(benList.getByTestId('booking-item')).toContainText(`von ${anna.username}`);
    await expectPersonTotal(benBook, 250, 1);
    await expect(benBook.getByTestId('recent-bookings').getByTestId('booking-item')).toHaveCount(1);

    // an offering added by an admin appears on the booking screens
    const tea = await data.offering(group, { name: data.name('Tee'), priceCents: 200 });
    await expect(offeringTile(page, tea.name)).toBeVisible();
    await expect(offeringTile(benBook, tea.name)).toBeVisible();

    // Anna cancels the booking in her bookings list → Ben's views follow
    // (the booking toast would cover the recent bookings at the end of the booking screen for 6 s)
    await page.goto(`/buchungen?person=${person.id}`);
    await page.getByTestId('booking-item').getByRole('button', { name: 'Buchung stornieren' }).click();
    await page.getByTestId('cancel-booking-dialog').getByRole('button', { name: 'Stornieren' }).click();
    await expect(page.getByText('Buchung storniert')).toBeVisible();
    await expect(benList.getByTestId('bookings-count')).toHaveText('0');
    await expectPersonTotal(benBook, 0, 0);

    for (const phone of [benList, benBook]) {
      expect(await phone.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    }
    await expect(currentPerson(benBook)).toHaveAttribute('data-person-number', person.number);
  });

  test('a long list follows bookings elsewhere without reloading its pages', { tag: '@regression' }, async ({ page, data }) => {
    const user = await data.user();
    const colleague = await data.user();
    const {
      offerings: [water],
    } = await data.catalog([{ label: 'Wasser', priceCents: 100 }]);
    const person = await data.person();
    await Promise.all(Array.from({ length: 53 }, () => data.booking(person, water!, { by: user })));

    // This page subscribes to booking events only: person / offering / group events of parallel
    // tests refetch every booking query (prefix invalidation) and would blur the request count.
    await page.route('**/api/realtime', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      const body = request.postDataJSON() as { subscriptions?: string[] };
      const subscriptions = (body.subscriptions ?? []).filter((topic) => topic.startsWith('bookings/'));
      return route.continue({ postData: JSON.stringify({ ...body, subscriptions }) });
    });
    const settled = realtimeSettled(page);
    await signIn(page, user, `/buchungen?person=${person.id}`);
    const items = page.getByTestId('booking-item');
    await expect(items).toHaveCount(50);
    await page.getByRole('button', { name: 'Weitere laden' }).click();
    await expect(items).toHaveCount(53);
    // (the first connect's refetch of the list, if it came late, is not what this test counts)
    await settled();

    // the booking list requests from now on (their filters)
    const listRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname.endsWith('/api/collections/bookings/records')) {
        listRequests.push(url.searchParams.get('filter') ?? '');
      }
    });

    // a booking elsewhere: only the bookings newer than the newest shown one are loaded
    const extra = await data.booking(person, water!, { by: colleague });
    await expect(items.first()).toHaveAttribute('data-booking-id', extra.id);
    await expect(items).toHaveCount(54);
    await expect(page.getByTestId('bookings-count')).toHaveText('54');
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]).toContain('created >=');

    // cancelled elsewhere: the row disappears without any list request
    await colleague.api.collection('bookings').delete(extra.id);
    await expect(items).toHaveCount(53);
    await expect(page.getByTestId('bookings-count')).toHaveText('53');
    expect(listRequests).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Weitere laden' })).toHaveCount(0);
  });
});
