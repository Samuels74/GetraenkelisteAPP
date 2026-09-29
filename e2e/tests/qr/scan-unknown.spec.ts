/** Fake camera shows the QR code of a number that no person has (project "qr-camera"). */
import { expect, test } from '../../support/scanner';
import { currentPerson, personPicker, signIn } from '../../support/ui';

test.use({ camera: 'unknown' });

test('an unknown QR code shows "nicht gefunden" and offers to create the person', async ({ page, data, cameraCode: unknown }) => {
  const user = await data.user();
  const name = data.name('Gescannt');

  await signIn(page, user);
  await currentPerson(page).getByRole('button', { name: 'QR scannen' }).click();
  const hint = page.getByTestId('scan-unknown');
  await expect(hint).toContainText(`Nummer ${unknown} nicht gefunden`, { timeout: 20_000 });
  await expect(page.getByTestId('qr-scanner')).toHaveAttribute('data-status', 'scanning'); // keeps scanning

  await hint.getByRole('button', { name: `Person ${unknown} anlegen` }).click();
  const picker = personPicker(page);
  await expect(page.getByTestId('qr-scanner')).toHaveCount(0);
  await expect(picker.getByLabel('Nummer')).toHaveValue(unknown);
  await picker.getByLabel('Name', { exact: true }).fill(name);
  await picker.getByRole('button', { name: 'Anlegen und auswählen' }).click();
  await expect(picker).toBeHidden();
  await expect(currentPerson(page)).toHaveAttribute('data-person-number', unknown);
  await expect(page.getByTestId('current-person-name')).toHaveText(name);
});
