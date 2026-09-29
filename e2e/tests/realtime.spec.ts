import { expect, test } from '../support/fixtures';
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
});
