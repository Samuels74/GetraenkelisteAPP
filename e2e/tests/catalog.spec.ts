import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import {
  bookTile,
  euro,
  expectPersonTotal,
  groupRow,
  offeringRow,
  offeringTile,
  openEditDialog,
  pickPerson,
  reloadPage,
  setSwitch,
  signIn,
} from '../support/ui';

/** Offering names in display order on the booking screen (one group). */
function tileNames(page: Page, groupId: string): Promise<string[]> {
  return page
    .locator(`[data-testid="offering-group"][data-group-id="${groupId}"] [data-testid="offering-tile"]`)
    .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-offering-name') ?? ''));
}

/** Offering names in display order in the administration (one group). */
function adminRowNames(page: Page, groupId: string): Promise<string[]> {
  return page
    .locator(`section[aria-labelledby="admin-group-${groupId}"] [data-testid="offering-row"]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-offering-name') ?? ''));
}

test.describe('groups and offerings (Verwaltung)', () => {
  test('a new group and offering appear on the booking screen with their price', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const groupName = data.name('Snacks');
    const offeringName = data.name('Chips');

    await signIn(page, admin, '/verwaltung/gruppen');
    await page.getByRole('button', { name: 'Neue Gruppe' }).click();
    const groupDialog = page.getByTestId('group-dialog');
    await groupDialog.getByLabel('Name', { exact: true }).fill(groupName);
    await groupDialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(groupDialog).toBeHidden();
    await expect(groupRow(page, groupName)).toContainText('0 Angebote');

    await page.getByTestId('admin-tab-angebote').click();
    await page.getByRole('button', { name: 'Neues Angebot' }).click();
    const dialog = page.getByTestId('offering-dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(offeringName);
    await dialog.getByLabel('Gruppe').selectOption({ label: groupName });
    await dialog.getByLabel('Preis in €').fill('3,50');
    await dialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dialog).toBeHidden();
    await expect(offeringRow(page, offeringName)).toContainText(euro(350));

    await page.getByTestId('nav-buchen').click();
    const tile = offeringTile(page, offeringName);
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(euro(350));
    await expect(tile).toHaveAccessibleName(`${offeringName}, ${euro(350)}`);
    await expect(page.getByRole('heading', { level: 2, name: groupName })).toBeVisible();
  });

  test('a price change applies to new bookings only', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const {
      offerings: [beer],
    } = await data.catalog([{ label: 'Bier', priceCents: 350 }]);
    const person = await data.person();
    await data.booking(person, beer!); // booked at € 3,50

    await signIn(page, admin, '/verwaltung/angebote');
    const dialog = await openEditDialog(page, 'offering', beer!.name);
    await expect(dialog.getByLabel('Preis in €')).toHaveValue('3,50');
    await dialog.getByLabel('Preis in €').fill('4.20');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog).toBeHidden();
    await expect(offeringRow(page, beer!.name)).toContainText(euro(420));

    await page.getByTestId('nav-buchen').click();
    await expect(offeringTile(page, beer!.name)).toContainText(euro(420));
    await pickPerson(page, person);
    await expectPersonTotal(page, 350, 1);
    await bookTile(page, beer!, 420);
    await expectPersonTotal(page, 770, 2);

    await page.goto(`/buchungen?person=${person.id}`);
    await expect(page.getByTestId('bookings-count')).toHaveText('2');
    await expect(page.getByTestId('bookings-total')).toHaveText(euro(770));
    const items = page.getByTestId('booking-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText(euro(420)); // newest first
    await expect(items.nth(1)).toContainText(euro(350));

    await page.getByTestId('view-switch').getByText('Pro Angebot', { exact: true }).click();
    const row = page.locator(`[data-testid="totals-offering-row"][data-offering-name="${beer!.name}"]`);
    await expect(row).toContainText('2×');
    await expect(row).toContainText(euro(770));

    const stored = await data.bookingsOf(person);
    expect(stored.map((booking) => booking.unitPriceCents)).toEqual([420, 350]);
  });

  test('a deactivated offering disappears from the booking screen', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const {
      offerings: [juice, water],
    } = await data.catalog([
      { label: 'Saft', priceCents: 200 },
      { label: 'Wasser', priceCents: 150 },
    ]);

    await signIn(page, admin);
    await expect(offeringTile(page, juice!.name)).toBeVisible();
    await page.getByTestId('nav-verwaltung').click();
    await expect(page).toHaveURL(/\/verwaltung\/angebote$/);
    const dialog = await openEditDialog(page, 'offering', juice!.name);
    await expect(dialog.getByRole('switch', { name: /^Aktiv/ })).toBeChecked();
    await setSwitch(dialog, 'Aktiv', false);
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog).toBeHidden();
    await expect(offeringRow(page, juice!.name)).toContainText('Inaktiv');

    await page.getByTestId('nav-buchen').click();
    await expect(offeringTile(page, water!.name)).toBeVisible();
    await expect(offeringTile(page, juice!.name)).toHaveCount(0);
  });

  test('booked offerings cannot be deleted, unbooked ones can', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const {
      offerings: [booked, unbooked, bookedMeanwhile],
    } = await data.catalog([
      { label: 'Bier', priceCents: 350 },
      { label: 'Radler', priceCents: 330 },
      { label: 'Most', priceCents: 300 },
    ]);
    const person = await data.person();
    await data.booking(person, booked!);

    await signIn(page, admin, '/verwaltung/angebote');
    await expect(offeringRow(page, booked!.name)).toContainText('Gebucht');
    const dialog = page.getByTestId('offering-dialog');
    const confirm = page.getByTestId('confirm-dialog');

    await openEditDialog(page, 'offering', booked!.name);
    await expect(dialog.getByTestId('delete-hint')).toHaveText('Hat Buchungen – stattdessen deaktivieren.');
    await expect(dialog.getByRole('button', { name: 'Angebot löschen' })).toBeDisabled();
    await dialog.getByTestId('dialog-close').click();

    await openEditDialog(page, 'offering', unbooked!.name);
    await dialog.getByRole('button', { name: 'Angebot löschen' }).click();
    await confirm.getByRole('button', { name: 'Löschen' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Angebot „${unbooked!.name}“ gelöscht`)).toBeVisible();
    await expect(offeringRow(page, unbooked!.name)).toHaveCount(0);

    // booked on another phone while the confirmation is open → server message
    await openEditDialog(page, 'offering', bookedMeanwhile!.name);
    await dialog.getByRole('button', { name: 'Angebot löschen' }).click();
    await expect(confirm).toBeVisible();
    await data.booking(person, bookedMeanwhile!);
    await confirm.getByRole('button', { name: 'Löschen' }).click();
    await expect(confirm.getByRole('alert')).toHaveText(
      'Dieses Angebot hat bereits Buchungen und kann nicht gelöscht werden. Deaktiviere es stattdessen.',
    );
    await confirm.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(offeringRow(page, bookedMeanwhile!.name)).toBeVisible();
  });

  test('groups with offerings cannot be deleted, empty groups can', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const { group: full } = await data.catalog([{ label: 'Wein', priceCents: 400 }]);
    const empty = await data.group();
    const filledMeanwhile = await data.group();

    await signIn(page, admin, '/verwaltung/gruppen');
    const dialog = page.getByTestId('group-dialog');
    const confirm = page.getByTestId('confirm-dialog');

    await expect(groupRow(page, full.name)).toContainText('1 Angebot');
    await openEditDialog(page, 'group', full.name);
    await expect(dialog.getByTestId('delete-hint')).toHaveText('Enthält noch 1 Angebot – kann nicht gelöscht werden.');
    await expect(dialog.getByRole('button', { name: 'Gruppe löschen' })).toBeDisabled();
    await dialog.getByTestId('dialog-close').click();

    await openEditDialog(page, 'group', empty.name);
    await dialog.getByRole('button', { name: 'Gruppe löschen' }).click();
    await confirm.getByRole('button', { name: 'Löschen' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Gruppe „${empty.name}“ gelöscht`)).toBeVisible();
    await expect(groupRow(page, empty.name)).toHaveCount(0);

    // an offering is added on another device while the confirmation is open → server message
    await openEditDialog(page, 'group', filledMeanwhile.name);
    await dialog.getByRole('button', { name: 'Gruppe löschen' }).click();
    await expect(confirm).toBeVisible();
    await data.offering(filledMeanwhile, { name: data.name('Tee') });
    await confirm.getByRole('button', { name: 'Löschen' }).click();
    await expect(confirm.getByRole('alert')).toHaveText('Diese Gruppe enthält noch Angebote und kann nicht gelöscht werden.');
  });

  test('saving an offering sends only the changed fields (concurrent edit)', { tag: '@regression' }, async ({ page, data, openAs }) => {
    const adminA = await data.user({ role: 'admin' });
    const adminB = await data.user({ role: 'admin' });
    const {
      offerings: [wine],
    } = await data.catalog([{ label: 'Wein', priceCents: 400 }]);

    // admin B opens the dialog …
    await signIn(page, adminB, '/verwaltung/angebote');
    const dialog = await openEditDialog(page, 'offering', wine!.name);
    await expect(dialog.getByLabel('Preis in €')).toHaveValue('4,00');
    await expect(dialog.getByRole('switch', { name: /^Aktiv/ })).toBeChecked();

    // … admin A deactivates the offering on another phone meanwhile …
    const phoneA = await openAs(adminA, '/verwaltung/angebote');
    const dialogA = await openEditDialog(phoneA, 'offering', wine!.name);
    await setSwitch(dialogA, 'Aktiv', false);
    await dialogA.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialogA).toBeHidden();
    await expect(offeringRow(page, wine!.name)).toContainText('Inaktiv'); // B's list (behind the dialog)

    // … and B changes only the price
    const bodies: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().includes(`/api/collections/offerings/records/${wine!.id}`)) {
        bodies.push(request.postDataJSON());
      }
    });
    await dialog.getByLabel('Preis in €').fill('4,50');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog).toBeHidden();
    expect(bodies).toEqual([{ priceCents: 450 }]);
    expect(await data.admin.collection('offerings').getOne(wine!.id)).toMatchObject({ priceCents: 450, active: false });
    await expect(offeringRow(page, wine!.name)).toContainText('Inaktiv');
    await expect(offeringRow(page, wine!.name)).toContainText(euro(450));
  });

  test('moving an offering changes the order on the booking screen', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const {
      group,
      offerings: [first, second, third],
    } = await data.catalog([
      { label: 'Eins', priceCents: 100 },
      { label: 'Zwei', priceCents: 200 },
      { label: 'Drei', priceCents: 300 },
    ]);
    const [a, b, c] = [first!.name, second!.name, third!.name];

    await signIn(page, admin);
    await expect.poll(() => tileNames(page, group.id)).toEqual([a, b, c]);

    await page.getByTestId('nav-verwaltung').click();
    await expect.poll(() => adminRowNames(page, group.id)).toEqual([a, b, c]);
    await expect(page.getByRole('button', { name: `${a} nach oben` })).toBeDisabled();
    // with distinct sortOrders a move only swaps the two records (2 updates)
    const updates: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().includes('/api/collections/offerings/records/')) {
        updates.push(request.url());
      }
    });
    await page.getByRole('button', { name: `${c} nach oben` }).click();
    await expect.poll(() => adminRowNames(page, group.id)).toEqual([a, c, b]);
    await expect.poll(() => updates.length).toBe(2);
    await page.getByRole('button', { name: `${a} nach unten` }).click();
    await expect.poll(() => adminRowNames(page, group.id)).toEqual([c, a, b]);
    await expect.poll(() => updates.length).toBe(4);

    await page.getByTestId('nav-buchen').click();
    await expect.poll(() => tileNames(page, group.id)).toEqual([c, a, b]);
    await reloadPage(page);
    await expect.poll(() => tileNames(page, group.id)).toEqual([c, a, b]);
  });

  test('moving a group changes the group order on the booking screen', async ({ page, data }, testInfo) => {
    // Group order is global. A move only swaps the two groups as long as all
    // sortOrders are distinct – groups created in parallel through the UI
    // (max + 10) can collide, and then the app renumbers every group. So this
    // runs in one project only (no second instance renumbering meanwhile), with
    // its groups first in the list (updated first if a renumbering happens).
    test.skip(testInfo.project.name !== 'desktop-chrome', 'global group order – desktop-chrome only');
    const admin = await data.user({ role: 'admin' });
    // two adjacent sortOrders below all others (seed: 10, other test data: creation time × 1000)
    const base = -2_000_000_000 - Math.floor(Math.random() * 10_000) * 10;
    const upper = await data.catalog([{ label: 'Oben', priceCents: 100 }], { name: data.name('Gruppe A'), sortOrder: base - 1 });
    const lower = await data.catalog([{ label: 'Unten', priceCents: 100 }], { name: data.name('Gruppe B'), sortOrder: base });
    const ids = [upper.group.id, lower.group.id];
    const order = (testId: 'offering-group' | 'group-chip') =>
      page
        .getByTestId(testId)
        .evaluateAll(
          (elements, wanted) =>
            elements
              .map((el) => el.getAttribute('data-group-id') ?? el.textContent?.trim() ?? '')
              .filter((key) => wanted.includes(key)),
          [...ids, upper.group.name, lower.group.name],
        );

    await signIn(page, admin);
    await expect.poll(() => order('offering-group')).toEqual([upper.group.id, lower.group.id]);
    await expect.poll(() => order('group-chip')).toEqual([upper.group.name, lower.group.name]);

    await page.goto('/verwaltung/gruppen');
    await expect(groupRow(page, lower.group.name)).toBeVisible();
    await page.getByRole('button', { name: `${lower.group.name} nach oben` }).click();
    const rows = () =>
      page
        .getByTestId('group-row')
        .evaluateAll((elements, wanted) => elements.map((el) => el.getAttribute('data-group-name') ?? '').filter((n) => wanted.includes(n)), [
          upper.group.name,
          lower.group.name,
        ]);
    await expect.poll(rows).toEqual([lower.group.name, upper.group.name]);

    await page.getByTestId('nav-buchen').click();
    await expect.poll(() => order('offering-group')).toEqual([lower.group.id, upper.group.id]);
    await expect.poll(() => order('group-chip')).toEqual([lower.group.name, upper.group.name]);
    await reloadPage(page);
    await expect.poll(() => order('offering-group')).toEqual([lower.group.id, upper.group.id]);
  });
});
