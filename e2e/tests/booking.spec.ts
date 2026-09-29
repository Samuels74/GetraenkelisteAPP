import { expect, test } from '../support/fixtures';
import {
  attr,
  bookingToast,
  bookTile,
  currentPerson,
  euro,
  expectPersonTotal,
  offeringTile,
  personPicker,
  pickPerson,
  reloadPage,
  SELECTED_PERSON_KEY,
  signIn,
} from '../support/ui';

test.describe('booking screen (Buchen)', () => {
  test('search a person, book two offerings and undo the last booking', async ({ page, data }) => {
    const user = await data.user();
    const {
      offerings: [cola, chips],
    } = await data.catalog([
      { label: 'Cola', priceCents: 250 },
      { label: 'Chips', priceCents: 180 },
    ]);
    const person = await data.person({ name: data.name('Maria'), nickname: 'Mimi' });

    await signIn(page, user);
    await expect(currentPerson(page)).toHaveAttribute('data-state', 'empty');
    await currentPerson(page).getByRole('button', { name: 'Person wählen' }).click();
    const picker = personPicker(page);
    await expect(picker.getByTestId('person-search')).toBeFocused();
    await picker.getByTestId('person-search').fill(person.name.toLowerCase());
    await expect(picker.getByTestId('person-option')).toHaveCount(1);
    await picker.locator(`[data-testid="person-option"][data-person-number="${attr(person.number)}"]`).click();
    await expect(picker).toBeHidden();
    await expect(currentPerson(page)).toHaveAttribute('data-person-number', person.number);
    await expect(page.getByTestId('current-person-name')).toHaveText(person.name);
    await expectPersonTotal(page, 0, 0);
    await expect(page.getByTestId('recent-bookings')).toContainText('Noch keine Buchungen.');

    await bookTile(page, cola!, 250);
    await expectPersonTotal(page, 250, 1);
    await bookTile(page, chips!, 180);
    await expectPersonTotal(page, 430, 2);
    const recent = page.getByTestId('recent-bookings').getByTestId('booking-item');
    await expect(recent).toHaveCount(2);
    await expect(recent.first()).toContainText(chips!.name);

    await page.getByRole('button', { name: 'Rückgängig' }).click();
    await expect(page.getByText('Buchung rückgängig gemacht')).toBeVisible();
    await expectPersonTotal(page, 250, 1);
    await expect(recent).toHaveCount(1);
    await expect(recent.first()).toContainText(cola!.name);
    expect((await data.bookingsOf(person)).map((booking) => booking.offering)).toEqual([cola!.id]);
  });

  test('tapping an offering without a person opens the picker and books after the selection', async ({ page, data }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();

    await signIn(page, user);
    await expect(currentPerson(page)).toHaveAttribute('data-state', 'empty');
    await offeringTile(page, cola!.name).click();
    const picker = personPicker(page);
    await expect(picker.getByTestId('pending-offering')).toHaveText(`Nach der Auswahl wird ${cola!.name} gebucht.`);

    // exact number + Enter selects the person
    await picker.getByTestId('person-search').fill(person.number);
    await picker.getByTestId('person-search').press('Enter');
    await expect(picker).toBeHidden();
    await expect(bookingToast(page, cola!.name, 250)).toBeVisible();
    await expect(currentPerson(page)).toHaveAttribute('data-person-number', person.number);
    await expectPersonTotal(page, 250, 1);
    expect(await data.bookingsOf(person)).toHaveLength(1);
  });

  test('the selected person survives a reload', async ({ page, data }) => {
    const user = await data.user();
    await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();

    await signIn(page, user);
    await pickPerson(page, person);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SELECTED_PERSON_KEY)).toBe(person.id);
    await reloadPage(page);
    await expect(currentPerson(page)).toHaveAttribute('data-person-number', person.number);

    await page.getByTestId('clear-person').click();
    await expect(currentPerson(page)).toHaveAttribute('data-state', 'empty');
    await reloadPage(page);
    await expect(currentPerson(page)).toHaveAttribute('data-state', 'empty');
  });

  test('a new person can be created from the picker', async ({ page, data }) => {
    const user = await data.user();
    const number = data.id('n');
    const name = data.name('Neu');

    await signIn(page, user);
    await currentPerson(page).getByRole('button', { name: 'Person wählen' }).click();
    const picker = personPicker(page);
    await picker.getByTestId('person-search').fill(number);
    await expect(picker.getByText('Keine Person gefunden')).toBeVisible();
    await picker.getByRole('button', { name: `Person ${number} anlegen` }).click();
    await expect(picker.getByLabel('Nummer')).toHaveValue(number);
    await picker.getByLabel('Name', { exact: true }).fill(name);
    await picker.getByRole('button', { name: 'Anlegen und auswählen' }).click();
    await expect(picker).toBeHidden();
    await expect(currentPerson(page)).toHaveAttribute('data-person-number', number);
    await expect(page.getByTestId('current-person-name')).toHaveText(name);
    expect(await data.findPerson(number)).toMatchObject({ number, name });
  });

  test('a double tap on "Rückgängig" cancels the booking exactly once', { tag: '@regression' }, async ({ page, data }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();
    const deletes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/api/collections/bookings/records/')) {
        deletes.push(request.url());
      }
    });

    await signIn(page, user);
    await pickPerson(page, person);
    await bookTile(page, cola!, 250);
    await expectPersonTotal(page, 250, 1);

    await page.getByRole('button', { name: 'Rückgängig' }).dblclick();
    await expect(page.getByText('Buchung rückgängig gemacht')).toBeVisible();
    await expectPersonTotal(page, 0, 0);
    expect(await data.bookingsOf(person)).toHaveLength(0);
    expect(deletes, 'DELETE requests').toHaveLength(1);
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
    await expect(page.getByText('Die Buchung war bereits storniert.')).toHaveCount(0);
  });

  test('the booking toast does not cover the last recent booking', { tag: '@regression' }, async ({ page, data }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();
    for (let i = 0; i < 4; i++) await data.booking(person, cola!, { by: user });

    await signIn(page, user);
    await pickPerson(page, person);
    const rows = page.getByTestId('recent-bookings').getByTestId('booking-item');
    await expect(rows).toHaveCount(4);
    await bookTile(page, cola!, 250); // the toast stays for 6 s
    await expect(rows).toHaveCount(5);
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: `${cola!.name} gebucht` });
    const last = rows.last();
    const cancel = last.getByRole('button', { name: 'Buchung stornieren' });

    const bookingId = await last.getAttribute('data-booking-id');
    const dialog = page.getByTestId('cancel-booking-dialog');

    // Scrolled to the end, the last row sits above the toast and can be tapped.
    // (Repeated if groups of parallel tests push the list down meanwhile.)
    await expect(async () => {
      if (await dialog.isVisible()) return;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const toastBox = await toast.boundingBox();
      const cancelBox = await cancel.boundingBox();
      expect(toastBox && cancelBox).toBeTruthy();
      expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(toastBox!.y);
      await cancel.click({ timeout: 1_000 }); // times out if the toast intercepts the tap
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 5_000 });
    await expect(toast).toBeVisible(); // i.e. tapped while the toast was shown

    await dialog.getByRole('button', { name: 'Stornieren' }).click();
    await expect(page.getByText('Buchung storniert')).toBeVisible();
    await expect(page.locator(`[data-testid="booking-item"][data-booking-id="${attr(bookingId!)}"]`)).toHaveCount(0);
    await expectPersonTotal(page, 1000, 4);
  });

  test('a booking can be cancelled from the recent bookings', async ({ page, data }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();
    await data.booking(person, cola!, { by: user });
    await data.booking(person, cola!, { by: user });

    await signIn(page, user);
    await pickPerson(page, person);
    await expectPersonTotal(page, 500, 2);
    const recent = page.getByTestId('recent-bookings').getByTestId('booking-item');
    await expect(recent).toHaveCount(2);
    await recent.first().getByRole('button', { name: 'Buchung stornieren' }).click();
    const dialog = page.getByTestId('cancel-booking-dialog');
    await expect(dialog).toContainText(`${cola!.name} (${euro(250)}) für ${person.number}`);
    await dialog.getByRole('button', { name: 'Stornieren' }).click();
    await expect(page.getByText('Buchung storniert')).toBeVisible();
    await expect(recent).toHaveCount(1);
    await expectPersonTotal(page, 250, 1);
  });
});
