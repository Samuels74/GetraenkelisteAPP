import { expect, test } from '../support/fixtures';
import {
  forcePasswordScreen,
  loginViaUi,
  logoutViaUi,
  openEditDialog,
  reloadPage,
  setForcedPassword,
  setSwitch,
  signIn,
  userRow,
} from '../support/ui';

test.describe('user administration (Verwaltung › Benutzer)', () => {
  test('a new user must set an own password first, then the requested page opens', { tag: '@regression' }, async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const username = data.id('neu');
    const initialPassword = `start-${data.token}`;
    const newPassword = `eigenes-${data.token}`;

    await signIn(page, admin, '/verwaltung/benutzer');
    await page.getByRole('button', { name: 'Neuer Benutzer' }).click();
    const dialog = page.getByTestId('user-dialog');
    await dialog.getByLabel('Benutzername').fill(username);
    await dialog.getByLabel('Name (optional)').fill('Neue Kellnerin');
    await dialog.getByLabel('Startpasswort').fill(initialPassword);
    await dialog.getByLabel('Passwort wiederholen').fill(initialPassword);
    await dialog.getByLabel('Rolle').selectOption({ label: 'Benutzer' });
    await dialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Benutzer ${username} angelegt`)).toBeVisible();
    await expect(userRow(page, username)).toContainText('Passwort ändern');
    await logoutViaUi(page);

    // the new user opens a link on the shared phone and logs in
    await page.goto('/buchungen?meine=1');
    await expect(page).toHaveURL(/\/login$/);
    await loginViaUi(page, username, initialPassword);
    const screen = forcePasswordScreen(page);
    await expect(screen.getByRole('heading', { name: 'Neues Passwort festlegen' })).toBeVisible();
    await expect(page).toHaveURL(/\/buchungen\?meine=1$/);
    await expect(page.getByTestId('main-nav')).toHaveCount(0);

    // the start password cannot be kept
    const form = page.getByTestId('force-password-form');
    await expect(form.getByLabel('Aktuelles Passwort')).toHaveCount(0);
    await form.getByLabel('Neues Passwort', { exact: true }).fill(initialPassword);
    await form.getByLabel('Neues Passwort wiederholen').fill(initialPassword);
    await form.getByRole('button', { name: 'Passwort speichern' }).click();
    await expect(form.getByText('Das neue Passwort muss sich vom aktuellen unterscheiden.')).toBeVisible();

    await setForcedPassword(page, newPassword);
    await expect(page.getByRole('heading', { level: 1, name: 'Buchungen' })).toBeVisible();
    await expect(page.getByTestId('only-mine')).toHaveAttribute('aria-pressed', 'true');

    // still logged in after a reload (re-authenticated with the new password)
    await reloadPage(page);
    await expect(page.getByTestId('bookings-count')).toBeVisible();
    await expect(screen).toHaveCount(0);
    await logoutViaUi(page);

    // the start password is gone, the new one works
    await loginViaUi(page, username, initialPassword);
    await expect(page.getByRole('form', { name: 'Anmelden' }).getByRole('alert')).toContainText(
      'Benutzername oder Passwort ist falsch',
    );
    await loginViaUi(page, username, newPassword);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('current-person')).toBeVisible();
    await expect(screen).toHaveCount(0);
  });

  test('a user created with the admin role can open the administration', async ({ page, data, openPage }) => {
    const admin = await data.user({ role: 'admin' });
    const username = data.id('chef');
    const password = `start-${data.token}`;

    await signIn(page, admin, '/verwaltung/benutzer');
    await page.getByRole('button', { name: 'Neuer Benutzer' }).click();
    const dialog = page.getByTestId('user-dialog');
    await dialog.getByLabel('Benutzername').fill(username);
    await dialog.getByLabel('Startpasswort').fill(password);
    await dialog.getByLabel('Passwort wiederholen').fill(password);
    await dialog.getByLabel('Rolle').selectOption({ label: 'Admin' });
    await dialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dialog).toBeHidden();
    await expect(userRow(page, username)).toContainText('Admin');

    const phone = await openPage(); // the new admin's phone
    await loginViaUi(phone, username, password);
    await expect(forcePasswordScreen(phone)).toBeVisible();
    await setForcedPassword(phone, `eigenes-${data.token}`);
    await phone.getByTestId('nav-verwaltung').click();
    await expect(phone).toHaveURL(/\/verwaltung\/angebote$/);
    await expect(phone.getByTestId('admin-tab-benutzer')).toBeVisible();
  });

  test('after an admin password reset the user must set a new password again', { tag: '@regression' }, async ({ page, data, openPage }) => {
    const admin = await data.user({ role: 'admin' });
    const user = await data.user();
    const resetPassword = `reset-${data.token}`;
    const ownPassword = `eigenes-${data.token}`;

    await signIn(page, admin, '/verwaltung/benutzer');
    await expect(userRow(page, user.username)).not.toContainText('Passwort ändern');
    const dialog = await openEditDialog(page, 'user', user.username);
    const reset = dialog.getByRole('form', { name: 'Passwort zurücksetzen' });
    await reset.getByLabel('Neues Passwort', { exact: true }).fill(resetPassword);
    await reset.getByLabel('Neues Passwort wiederholen').fill(resetPassword);
    await reset.getByRole('button', { name: 'Passwort setzen' }).click();
    await expect(page.getByText(`Passwort für ${user.username} gesetzt`)).toBeVisible();
    await dialog.getByTestId('dialog-close').click();
    await expect(userRow(page, user.username)).toContainText('Passwort ändern');

    // the user logs in on their phone with the new password → blocking screen
    const phone = await openPage();
    await loginViaUi(phone, user.username, user.password);
    await expect(phone.getByRole('form', { name: 'Anmelden' }).getByRole('alert')).toContainText(
      'Benutzername oder Passwort ist falsch',
    );
    await loginViaUi(phone, user.username, resetPassword);
    const screen = forcePasswordScreen(phone);
    await expect(screen).toBeVisible();

    // after a reload the login password is no longer known → it is asked for
    await reloadPage(phone);
    const form = phone.getByTestId('force-password-form');
    await expect(form.getByLabel('Aktuelles Passwort')).toBeVisible();
    await form.getByLabel('Aktuelles Passwort').fill('falsches-passwort');
    await form.getByLabel('Neues Passwort', { exact: true }).fill(ownPassword);
    await form.getByLabel('Neues Passwort wiederholen').fill(ownPassword);
    await form.getByRole('button', { name: 'Passwort speichern' }).click();
    await expect(form.getByText('Das aktuelle Passwort ist falsch.')).toBeVisible();
    await expect(screen).toBeVisible();

    await setForcedPassword(phone, ownPassword, resetPassword);
    await expect(phone).toHaveURL(/\/$/);
    await expect(phone.getByTestId('current-person')).toBeVisible();
    await expect(userRow(page, user.username)).not.toContainText('Passwort ändern');
  });

  test('a role change takes effect in the open app without a new login', async ({ page, data, openAs }) => {
    const admin = await data.user({ role: 'admin' });
    const user = await data.user();
    const phone = await openAs(user);
    await expect(phone.getByTestId('nav-buchen')).toBeVisible();
    await expect(phone.getByTestId('nav-verwaltung')).toHaveCount(0);

    await signIn(page, admin, '/verwaltung/benutzer');
    const dialog = await openEditDialog(page, 'user', user.username);
    await dialog.getByLabel('Rolle').selectOption({ label: 'Admin' });
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog).toBeHidden();
    await expect(userRow(page, user.username)).toContainText('Admin');

    // realtime update of the own record → the administration appears
    await expect(phone.getByTestId('nav-verwaltung')).toBeVisible();
    await phone.getByTestId('nav-verwaltung').click();
    await expect(phone.getByTestId('offering-row').first()).toBeVisible();
  });

  test('disabling a user ends the open session and blocks the login', async ({ page, data, openAs }) => {
    const admin = await data.user({ role: 'admin' });
    const user = await data.user();
    const phone = await openAs(user, '/buchungen');
    await expect(phone.getByTestId('bookings-count')).toHaveText(/^\d+$/);

    await signIn(page, admin, '/verwaltung/benutzer');
    const dialog = await openEditDialog(page, 'user', user.username);
    await expect(dialog.getByRole('switch', { name: /^Konto aktiv/ })).toBeChecked();
    await setSwitch(dialog, 'Konto aktiv', false);
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog).toBeHidden();
    await expect(userRow(page, user.username)).toContainText('Deaktiviert');

    // The user's app ends the session: right away (realtime update of the own
    // record) or with the next request (the token was revoked → 401).
    await expect(async () => {
      if (!new URL(phone.url()).pathname.startsWith('/login')) {
        await phone.getByTestId('nav-personen').click({ timeout: 2_000 });
      }
      await expect(phone).toHaveURL(/\/login$/, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await loginViaUi(phone, user.username, user.password);
    await expect(phone.getByRole('form', { name: 'Anmelden' }).getByRole('alert')).toHaveText(
      'Dieses Konto ist deaktiviert. Bitte wende dich an die Verwaltung.',
    );
  });

  test('users without bookings can be deleted, users with bookings cannot', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const idle = await data.user();
    const busy = await data.user();
    const {
      offerings: [coffee],
    } = await data.catalog([{ label: 'Kaffee', priceCents: 250 }]);
    await data.booking(await data.person(), coffee!, { by: busy });

    await signIn(page, admin, '/verwaltung/benutzer');
    const dialog = page.getByTestId('user-dialog');

    await openEditDialog(page, 'user', busy.username);
    await expect(dialog.getByTestId('delete-hint')).toHaveText('Hat Buchungen erfasst – stattdessen deaktivieren.');
    await expect(dialog.getByRole('button', { name: 'Benutzer löschen' })).toBeDisabled();
    await dialog.getByTestId('dialog-close').click();

    await openEditDialog(page, 'user', admin.username);
    await expect(dialog.getByTestId('delete-hint')).toHaveText('Du kannst dich nicht selbst löschen.');
    await expect(dialog.getByRole('button', { name: 'Benutzer löschen' })).toBeDisabled();
    await expect(dialog.getByLabel('Rolle')).toBeDisabled();
    await dialog.getByTestId('dialog-close').click();

    await openEditDialog(page, 'user', idle.username);
    await dialog.getByRole('button', { name: 'Benutzer löschen' }).click();
    const confirm = page.getByTestId('confirm-dialog');
    await confirm.getByRole('button', { name: 'Löschen' }).click();
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Benutzer ${idle.username} gelöscht`)).toBeVisible();
    await expect(userRow(page, idle.username)).toHaveCount(0);
    await expect(userRow(page, busy.username)).toBeVisible();
  });

  test('the server refuses to delete a user who booked in the meantime', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const user = await data.user();
    const {
      offerings: [coffee],
    } = await data.catalog([{ label: 'Kaffee', priceCents: 250 }]);
    const person = await data.person();

    await signIn(page, admin, '/verwaltung/benutzer');
    const dialog = await openEditDialog(page, 'user', user.username);
    await dialog.getByRole('button', { name: 'Benutzer löschen' }).click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();

    await data.booking(person, coffee!, { by: user }); // booked on another phone meanwhile
    await confirm.getByRole('button', { name: 'Löschen' }).click();
    await expect(confirm.getByRole('alert')).toHaveText(
      'Dieser Benutzer hat bereits Buchungen erfasst und kann nicht gelöscht werden. Deaktiviere das Konto stattdessen.',
    );
    await confirm.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(userRow(page, user.username)).toBeVisible();
  });
});
