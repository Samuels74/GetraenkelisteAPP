/**
 * Screenshots of the main screens for manual review (every project):
 * <results>/screenshots/<project>/NN-name.png.
 * Only light assertions – the behaviour is covered by the other specs.
 */
import { expect, test } from '../support/fixtures';
import {
  bookingToast,
  currentPerson,
  forcePasswordScreen,
  loginViaUi,
  offeringTile,
  personPicker,
  pickPerson,
  saveScreenshot,
  signIn,
} from '../support/ui';

test('screenshots of the main screens', async ({ page, data, openPage }, testInfo) => {
  test.setTimeout(120_000);
  const shot = (name: string, fullPage = true) => saveScreenshot(page, testInfo, name, fullPage);

  const admin = await data.user({ role: 'admin', name: 'Maria Wirt' });
  // offering names only need to be unique within their group (the group carries the token)
  // sortOrder below the other test groups → first on the booking screen
  const group = await data.group({ name: `Bar ${data.token}`, sortOrder: -1_900_000_000 + Math.floor(Math.random() * 1_000) });
  const menu: Array<[string, number]> = [
    ['Bier', 350],
    ['Spritzer', 280],
    ['Cola', 250],
    ['Mineralwasser', 150],
    ['Kaffee', 220],
    ['Pfand', -200],
  ];
  const [beer, spritzer, cola, water, coffee, deposit] = await Promise.all(
    menu.map(([name, priceCents], index) => data.offering(group, { name, priceCents, sortOrder: (index + 1) * 10 })),
  );
  const barSection = page.locator(`[data-testid="offering-group"][data-group-id="${group.id}"]`);
  const anna = await data.person({ number: data.id(''), name: 'Anna Berger', nickname: 'Anni' });
  const bernd = await data.person({ number: data.id(''), name: 'Bernd Maier', nickname: '' });
  const clara = await data.person({ number: data.id(''), name: 'Clara Huber', nickname: 'Claire' });
  for (const [person, offering] of [
    [anna, beer],
    [anna, spritzer],
    [bernd, coffee],
    [bernd, water],
    [clara, cola],
    [clara, deposit],
    [anna, beer],
  ] as const) {
    await data.booking(person, offering!, { by: admin });
  }

  // logged out, then the blocking password screen of a new account
  const newcomer = await data.user({ name: 'Neue Kellnerin', mustChangePassword: true });
  const loginPage = await openPage();
  await loginPage.goto('/login');
  await expect(loginPage.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  await saveScreenshot(loginPage, testInfo, '01-login', false);
  await loginViaUi(loginPage, newcomer.username, newcomer.password);
  await expect(forcePasswordScreen(loginPage)).toBeVisible();
  await saveScreenshot(loginPage, testInfo, '01b-neues-passwort-festlegen', false);
  await loginPage.close();

  // Buchen
  await signIn(page, admin);
  await expect(offeringTile(barSection, beer!.name)).toBeVisible();
  await shot('02-buchen-leer', false);
  await currentPerson(page).getByRole('button', { name: 'Person wählen' }).click();
  await expect(personPicker(page).getByTestId('person-option').first()).toBeVisible();
  await personPicker(page).getByTestId('person-search').fill('Berger');
  await expect(personPicker(page).getByTestId('person-option')).toHaveCount(1);
  await shot('03-personenauswahl', false);
  await personPicker(page).getByTestId('dialog-close').click();
  await pickPerson(page, anna);
  await offeringTile(barSection, spritzer!.name).click();
  await expect(bookingToast(page, spritzer!.name, 280)).toBeVisible();
  await shot('04-buchen-gebucht', false);
  await shot('05-buchen-ganze-seite');

  // Personen
  await page.getByTestId('nav-personen').click();
  await expect(page.getByTestId('person-row').first()).toBeVisible();
  await shot('06-personen');
  await page.goto(`/personen/${anna.id}`);
  await expect(page.getByTestId('qr-code')).toBeVisible();
  await expect(page.getByTestId('person-total')).not.toHaveText('…');
  await shot('07-person-detail');
  await page.goto(`/personen/qr-codes?ids=${[anna.id, bernd.id, clara.id].join(',')}`);
  await expect(page.getByTestId('qr-card')).toHaveCount(3);
  await shot('08-qr-bogen');

  // Buchungen
  await page.goto('/buchungen?meine=1');
  await expect(page.getByTestId('booking-item').first()).toBeVisible();
  await shot('09-buchungen-liste');
  await page.getByTestId('view-switch').getByText('Pro Person', { exact: true }).click();
  await expect(page.getByTestId('totals-person-row')).toHaveCount(3);
  await shot('10-buchungen-pro-person');
  await page.getByTestId('view-switch').getByText('Pro Angebot', { exact: true }).click();
  await expect(page.getByRole('region', { name: group.name })).toBeVisible();
  await shot('11-buchungen-pro-angebot');
  await page.getByTestId('view-switch').getByText('Liste', { exact: true }).click();
  await page.getByTestId('booking-item').first().getByRole('button', { name: 'Buchung stornieren' }).click();
  await expect(page.getByTestId('cancel-booking-dialog')).toBeVisible();
  await shot('12-storno-dialog', false);
  await page.getByTestId('cancel-booking-dialog').getByRole('button', { name: 'Abbrechen' }).click();

  // Verwaltung
  await page.getByTestId('nav-verwaltung').click();
  await expect(page.getByRole('button', { name: `${beer!.name} bearbeiten` }).first()).toBeVisible();
  await shot('13-verwaltung-angebote');
  await page
    .locator(`section[aria-labelledby="admin-group-${group.id}"]`)
    .getByRole('button', { name: `${beer!.name} bearbeiten` })
    .click();
  await expect(page.getByTestId('offering-dialog')).toBeVisible();
  await shot('14-angebot-dialog', false);
  await page.getByTestId('offering-dialog').getByTestId('dialog-close').click();
  await page.getByTestId('admin-tab-gruppen').click();
  await expect(page.getByTestId('group-row').first()).toBeVisible();
  await shot('15-verwaltung-gruppen');
  await page.getByTestId('admin-tab-benutzer').click();
  await expect(page.getByTestId('user-row').first()).toBeVisible();
  await shot('16-verwaltung-benutzer');
  await page.getByRole('button', { name: 'Neuer Benutzer' }).click();
  await expect(page.getByTestId('user-dialog')).toBeVisible();
  await shot('17-benutzer-anlegen', false);
  await page.getByTestId('user-dialog').getByTestId('dialog-close').click();

  // Konto
  await page.getByTestId('nav-konto').click();
  await expect(page.getByTestId('password-form')).toBeVisible();
  await shot('18-konto');

  // dark mode
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByTestId('nav-buchen').click();
  await expect(currentPerson(page)).toHaveAttribute('data-person-number', anna.number);
  await expect(offeringTile(barSection, beer!.name)).toBeVisible();
  await shot('19-buchen-dunkel', false);
  await page.goto('/buchungen?meine=1');
  await expect(page.getByTestId('booking-item').first()).toBeVisible();
  await shot('20-buchungen-dunkel', false);
});
