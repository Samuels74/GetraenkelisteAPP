import { expect, test } from '../support/fixtures';
import { attr, loginViaUi, logoutViaUi, signIn } from '../support/ui';

test.describe('account (Konto)', () => {
  test('the display name can be changed and shows up in the bookings', async ({ page, data }) => {
    const user = await data.user({ name: 'Alter Name' });
    const {
      offerings: [coffee],
    } = await data.catalog([{ label: 'Kaffee', priceCents: 220 }]);
    const person = await data.person();
    const booking = await data.booking(person, coffee!, { by: user });

    await signIn(page, user, '/konto');
    await expect(page.getByTestId('account-name')).toHaveText('Alter Name');
    await expect(page.getByTestId('account-username')).toHaveText(user.username);
    const nameForm = page.getByRole('form', { name: 'Anzeigename' });
    const save = nameForm.getByRole('button', { name: 'Speichern' });
    await expect(save).toBeDisabled(); // unchanged
    await nameForm.getByRole('textbox').fill('Neuer Name');
    await save.click();
    await expect(page.getByText('Name gespeichert')).toBeVisible();
    await expect(page.getByTestId('account-name')).toHaveText('Neuer Name');

    await page.getByTestId('nav-buchungen').click();
    await expect(page.locator(`[data-testid="booking-item"][data-booking-id="${attr(booking.id)}"]`)).toContainText(
      'von Neuer Name',
    );
  });

  test('the password form validates the input', async ({ page, data }) => {
    const user = await data.user();
    await signIn(page, user, '/konto');
    const form = page.getByTestId('password-form');
    const current = form.getByLabel('Aktuelles Passwort');
    const next = form.getByLabel('Neues Passwort', { exact: true });
    const repeat = form.getByLabel('Neues Passwort wiederholen');
    const submit = form.getByRole('button', { name: 'Passwort ändern' });

    await submit.click();
    await expect(form.getByText('Bitte das aktuelle Passwort eingeben.')).toBeVisible();
    await expect(form.getByText('Das Passwort muss mindestens 8 Zeichen lang sein.')).toBeVisible();

    await current.fill(user.password);
    await next.fill('kurz');
    await repeat.fill('kurz');
    await submit.click();
    await expect(form.getByText('Das Passwort muss mindestens 8 Zeichen lang sein.')).toBeVisible();

    await next.fill('ganz-neues-passwort');
    await repeat.fill('anderes-passwort');
    await submit.click();
    await expect(form.getByText('Die Passwörter stimmen nicht überein.')).toBeVisible();

    await current.fill('falsches-passwort');
    await repeat.fill('ganz-neues-passwort');
    await submit.click();
    await expect(form.getByText('Das aktuelle Passwort ist falsch.')).toBeVisible();

    // nothing changed: the old password still works
    await logoutViaUi(page);
    await loginViaUi(page, user.username, user.password);
    await expect(page.getByTestId('main-nav')).toBeVisible();
  });
});
