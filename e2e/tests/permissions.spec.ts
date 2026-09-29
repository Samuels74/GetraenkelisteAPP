import { expect, test } from '../support/fixtures';
import { attr, currentPerson, euro, signIn } from '../support/ui';

test.describe('permissions of a normal user', () => {
  test('there is no administration for non-admins', async ({ page, data }) => {
    const user = await data.user();
    await signIn(page, user);
    await expect(page.getByTestId('nav-buchen')).toBeVisible();
    await expect(page.getByTestId('nav-konto')).toBeVisible();
    await expect(page.getByTestId('nav-verwaltung')).toHaveCount(0);

    for (const path of ['/verwaltung', '/verwaltung/angebote', '/verwaltung/gruppen', '/verwaltung/benutzer']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(currentPerson(page)).toBeVisible();
      await expect(page.getByTestId('admin-tab-angebote')).toHaveCount(0);
    }
  });

  test('persons can be created and edited, but not deleted', async ({ page, data }) => {
    const user = await data.user();
    const number = data.id('p');
    const name = data.name('Maria');
    const renamed = data.name('Maria Huber');
    const newNumber = data.id('q');

    await signIn(page, user, '/personen');
    await page.getByRole('button', { name: 'Neu', exact: true }).click();
    const dialog = page.getByTestId('person-dialog');
    await dialog.getByLabel('Nummer').fill(number);
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Nickname').fill('Mia');
    await dialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(page).toHaveURL(/\/personen\/\w+$/);
    await expect(page.getByTestId('person-number')).toHaveText(`Person ${number}`);
    await expect(page.getByText(`${name} „Mia“`)).toBeVisible();
    const personId = new URL(page.url()).pathname.split('/').pop()!;

    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    await expect(dialog.getByLabel('Nummer')).toHaveValue(number);
    await dialog.getByLabel('Nummer').fill(newNumber);
    await dialog.getByLabel('Name', { exact: true }).fill(renamed);
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${renamed} „Mia“`)).toBeVisible();
    await expect(page.getByTestId('person-number')).toHaveText(`Person ${newNumber}`);
    await expect(page.getByTestId('qr-code')).toHaveAttribute('data-qr-value', newNumber);

    // no delete section for users – and the server refuses as well
    await expect(page.getByTestId('delete-person-hint')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
    await expect(user.api.collection('persons').delete(personId)).rejects.toMatchObject({ status: 404 });

    await page.getByRole('button', { name: 'Zurück zu den Personen' }).click();
    await expect(page.locator(`[data-testid="person-row"][data-person-number="${attr(newNumber)}"]`)).toContainText(renamed);
    await expect(page.locator(`[data-testid="person-row"][data-person-number="${attr(number)}"]`)).toHaveCount(0);
  });

  test('only own bookings can be cancelled', async ({ page, data }) => {
    const user = await data.user();
    const colleague = await data.user();
    const {
      offerings: [coffee],
    } = await data.catalog([{ label: 'Kaffee', priceCents: 250 }]);
    const person = await data.person();
    const own = await data.booking(person, coffee!, { by: user });
    const foreign = await data.booking(person, coffee!, { by: colleague });

    await signIn(page, user, `/buchungen?person=${person.id}`);
    await expect(page.getByTestId('bookings-count')).toHaveText('2');
    const ownItem = page.locator(`[data-testid="booking-item"][data-booking-id="${own.id}"]`);
    const foreignItem = page.locator(`[data-testid="booking-item"][data-booking-id="${foreign.id}"]`);
    await expect(foreignItem).toContainText(`von ${colleague.username}`);
    await expect(foreignItem.getByRole('button', { name: 'Buchung stornieren' })).toHaveCount(0);

    await ownItem.getByRole('button', { name: 'Buchung stornieren' }).click();
    const dialog = page.getByTestId('cancel-booking-dialog');
    await expect(dialog).toContainText(coffee!.name);
    await dialog.getByRole('button', { name: 'Stornieren' }).click();
    await expect(page.getByText('Buchung storniert')).toBeVisible();
    await expect(ownItem).toHaveCount(0);
    await expect(page.getByTestId('bookings-count')).toHaveText('1');
    await expect(page.getByTestId('bookings-total')).toHaveText(euro(250));

    // the server refuses to delete somebody else's booking
    await expect(user.api.collection('bookings').delete(foreign.id)).rejects.toMatchObject({ status: 404 });
    await expect(foreignItem).toBeVisible();
  });
});
