/**
 * Runs in the "isolated-*" projects, after all other tests: the server is quiet,
 * so no realtime event of a parallel test refreshes the page by accident – the
 * page must recover on its own.
 */
import { expect, test } from '../../support/fixtures';
import { signIn } from '../../support/ui';

test('realtime recovers when the first connection attempts fail', { tag: '@regression' }, async ({ page, data }) => {
  const anna = await data.user();
  const ben = await data.user();
  const {
    offerings: [cola],
  } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
  const person = await data.person();

  // Ben's phone cannot open the realtime connection twice (server restarting,
  // bad reception, …); the app retries with backoff (1 s, 2 s, …).
  let failedAttempts = 0;
  await page.route('**/api/realtime', async (route) => {
    if (route.request().method() === 'GET' && failedAttempts < 2) {
      failedAttempts += 1;
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });
  await signIn(page, ben, `/buchungen?person=${person.id}`);
  await expect(page.getByTestId('bookings-count')).toHaveText('0');
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await expect.poll(() => failedAttempts).toBe(2);

  // Anna books while Ben's realtime connection is still down …
  await data.booking(person, cola!, { by: anna });
  // … Ben sees it once the connection is up – without reload, without another event
  await expect(page.getByTestId('bookings-count')).toHaveText('1', { timeout: 15_000 });
  // and later bookings arrive through the connection
  await data.booking(person, cola!, { by: anna });
  await expect(page.getByTestId('bookings-count')).toHaveText('2');
  await expect(page.getByTestId('booking-item')).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});
