import { readFile } from 'node:fs/promises';
import { expect, test } from '../support/fixtures';
import { attr, bookTile, currentPerson, euro, expectPersonTotal, signIn } from '../support/ui';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test.describe('persons (Personen)', () => {
  test('create a person: validation, QR code, PNG download, book for this person', async ({ page, data }) => {
    const user = await data.user();
    const existing = await data.person();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const number = data.id('p');
    const name = data.name('Josef');

    await signIn(page, user, '/personen');
    await page.getByRole('button', { name: 'Neu', exact: true }).click();
    const dialog = page.getByTestId('person-dialog');
    const numberField = dialog.getByLabel('Nummer');
    await expect(numberField).toBeFocused();

    // numbers are unique (case-insensitive) and restricted to letters, digits, - and _
    await numberField.fill(existing.number.toUpperCase());
    await dialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dialog.getByText('Diese Nummer ist bereits vergeben.')).toBeVisible();
    await numberField.fill('12 34');
    await dialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dialog.getByText('Nur Buchstaben, Ziffern, „-“ und „_“ erlaubt (keine Leerzeichen).')).toBeVisible();

    await numberField.fill(number);
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Nickname').fill('Sepp');
    await dialog.getByRole('button', { name: 'Anlegen' }).click();
    await expect(page).toHaveURL(/\/personen\/\w+$/);
    await expect(page.getByText(`Person ${number} angelegt`)).toBeVisible();
    await expect(page.getByTestId('person-number')).toHaveText(`Person ${number}`);
    await expect(page.getByText('Person angelegt. Du kannst den QR-Code jetzt herunterladen oder ausdrucken.')).toBeVisible();
    const qr = page.getByTestId('qr-code');
    await expect(qr).toHaveAttribute('data-qr-value', number);
    await expect(qr).toHaveAccessibleName(`QR-Code für Nummer ${number}`);
    await expect(page.getByTestId('person-total')).toHaveText(euro(0));

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PNG' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`qr-${number}.png`);
    const png = await readFile(await download.path());
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature').toBe(true);

    await page.getByRole('button', { name: 'Für diese Person buchen' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(currentPerson(page)).toHaveAttribute('data-person-number', number);
    await bookTile(page, cola!, 250);
    await expectPersonTotal(page, 250, 1);

    // the person list shows the total and finds the person by nickname
    await page.getByTestId('nav-personen').click();
    await page.getByTestId('persons-search').fill('sepp');
    await expect(page).toHaveURL(/q=sepp/);
    const row = page.locator(`[data-testid="person-row"][data-person-number="${attr(number)}"]`);
    await expect(row).toContainText(name);
    await expect(row).toContainText(euro(250));
    await expect(row).toContainText('1 Buchung');
  });

  test('the QR sheet has a card with the right code per person', async ({ page, data }) => {
    const user = await data.user();
    const first = await data.person();
    const second = await data.person({ nickname: 'Bibi' });

    await signIn(page, user, '/personen');
    await page.getByRole('link', { name: 'Alle QR-Codes drucken' }).click();
    await expect(page).toHaveURL(/\/personen\/qr-codes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'QR-Codes drucken' })).toBeVisible();
    const sheet = page.getByTestId('qr-sheet');
    for (const person of [first, second]) {
      const card = sheet.locator(`[data-testid="qr-card"][data-person-number="${attr(person.number)}"]`);
      await expect(card).toBeVisible();
      await expect(card.getByTestId('qr-code')).toHaveAttribute('data-qr-value', person.number);
      await expect(card).toContainText(person.name);
    }
    await expect(sheet.locator(`[data-testid="qr-card"][data-person-number="${attr(second.number)}"]`)).toContainText(
      '„Bibi“',
    );
    // (other tests create persons in parallel, so the exact number is not known here)
    await expect(page.getByText(/^\d+ Personen$/)).toBeVisible();

    // a selection of persons only
    await page.goto(`/personen/qr-codes?ids=${first.id},${second.id}`);
    await expect(sheet.getByTestId('qr-card')).toHaveCount(2);
    await expect(page.getByText('2 Personen', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Zurück' }).click();
    await expect(page).toHaveURL(/\/personen\/qr-codes$/);
  });

  test('admins can delete persons without bookings only', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const booked = await data.person();
    const unbooked = await data.person();
    await data.booking(booked, cola!);

    await signIn(page, admin, `/personen/${booked.id}`);
    await expect(page.getByTestId('person-total')).toHaveText(euro(250));
    await expect(page.getByTestId('delete-person-hint')).toHaveText(
      'Diese Person hat Buchungen und kann nicht gelöscht werden.',
    );
    await expect(page.getByRole('button', { name: 'Löschen' })).toBeDisabled();

    await page.goto(`/personen/${unbooked.id}`);
    await expect(page.getByTestId('delete-person-hint')).toHaveText('Nur möglich, solange die Person keine Buchungen hat.');
    await page.getByRole('button', { name: 'Löschen' }).click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toContainText(unbooked.number);
    await confirm.getByRole('button', { name: 'Löschen' }).click();
    await expect(page).toHaveURL(/\/personen$/);
    await expect(page.getByText(`Person ${unbooked.number} gelöscht`)).toBeVisible();
    await expect(page.locator(`[data-testid="person-row"][data-person-number="${attr(unbooked.number)}"]`)).toHaveCount(0);
    expect(await data.findPerson(unbooked.number)).toBeNull();
  });
});
