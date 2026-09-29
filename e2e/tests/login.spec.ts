import { expect, test } from '../support/fixtures';
import { BOOTSTRAP_ADMIN, SEEDED_ADMIN } from '../support/env';
import { forcePasswordScreen, loginViaUi, logoutViaUi, signIn } from '../support/ui';

test.describe('login', () => {
  test('the seeded admin must set a new password first (not changed here)', async ({ page }) => {
    test.skip(
      BOOTSTRAP_ADMIN.password !== SEEDED_ADMIN.password,
      'the seeded admin password was changed on this instance',
    );
    await loginViaUi(page, SEEDED_ADMIN.username, SEEDED_ADMIN.password);

    const screen = forcePasswordScreen(page);
    await expect(screen.getByRole('heading', { level: 1, name: 'Neues Passwort festlegen' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    const form = page.getByTestId('force-password-form');
    await expect(form.getByLabel('Neues Passwort', { exact: true })).toBeVisible();
    await expect(form.getByLabel('Neues Passwort wiederholen')).toBeVisible();
    // the login password is reused as the current one (kept in memory only)
    await expect(form.getByLabel('Aktuelles Passwort')).toHaveCount(0);
    await expect(page.getByTestId('main-nav')).toHaveCount(0);

    // every route shows the blocking screen – after a reload it asks for the current password
    await page.goto('/buchungen');
    await expect(screen).toBeVisible();
    await expect(page).toHaveURL(/\/buchungen$/);
    await expect(form.getByLabel('Aktuelles Passwort')).toBeVisible();
    await expect(page.getByTestId('bookings-count')).toHaveCount(0);

    // leave without changing the seeded password
    await screen.getByTestId('logout').click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password shows a German error message', async ({ page, data }) => {
    const user = await data.user();
    await loginViaUi(page, user.username, 'falsches-passwort');

    const form = page.getByRole('form', { name: 'Anmelden' });
    await expect(form.getByRole('alert')).toHaveText(
      'Anmeldung fehlgeschlagen: Benutzername oder Passwort ist falsch.',
    );
    await expect(page).toHaveURL(/\/login$/);

    // usernames are case-insensitive; the correct password works afterwards
    await loginViaUi(page, user.username.toUpperCase(), user.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('current-person')).toBeVisible();
    await expect(forcePasswordScreen(page)).toHaveCount(0);
  });

  test('a disabled account cannot log in', async ({ page, data }) => {
    const user = await data.user();
    await data.disableUser(user);
    await loginViaUi(page, user.username, user.password);

    await expect(page.getByRole('form', { name: 'Anmelden' }).getByRole('alert')).toHaveText(
      'Dieses Konto ist deaktiviert. Bitte wende dich an die Verwaltung.',
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test('an empty form and unknown pages are handled', async ({ page, data }) => {
    await page.goto('/login');
    await page.getByRole('form', { name: 'Anmelden' }).getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByRole('form', { name: 'Anmelden' }).getByRole('alert')).toHaveText(
      'Bitte Benutzername und Passwort eingeben.',
    );

    const user = await data.user();
    await loginViaUi(page, user.username, user.password);
    await expect(page.getByTestId('main-nav')).toBeVisible();
    await page.goto('/gibt-es-nicht');
    await expect(page.getByText('Seite nicht gefunden')).toBeVisible();
    await page.getByRole('link', { name: 'Zum Buchen' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('current-person')).toBeVisible();
  });

  test('a deep link survives the login redirect', async ({ page, data }) => {
    const user = await data.user();
    await page.goto('/buchungen?zeitraum=heute');
    await expect(page).toHaveURL(/\/login$/);
    await loginViaUi(page, user.username, user.password);

    await expect(page).toHaveURL(/\/buchungen\?zeitraum=heute$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Buchungen' })).toBeVisible();
    await expect(page.getByTestId('period-filter').getByRole('radio', { name: 'Heute' })).toBeChecked();
  });

  test('after "Abmelden" the next user starts on the booking screen', { tag: '@regression' }, async ({ page, data }) => {
    const first = await data.user();
    const second = await data.user();
    await signIn(page, first, '/konto');
    await expect(page.getByTestId('account-username')).toHaveText(first.username);
    await logoutViaUi(page);

    await loginViaUi(page, second.username, second.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('current-person')).toBeVisible();
    await page.getByTestId('nav-konto').click();
    await expect(page.getByTestId('account-username')).toHaveText(second.username);
  });
});
