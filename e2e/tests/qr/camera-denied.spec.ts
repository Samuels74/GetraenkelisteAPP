/** Camera permission denied (project "qr-camera"). */
import { expect, test } from '../../support/scanner';
import { currentPerson, personPicker, signIn } from '../../support/ui';

// Full Chromium (new headless) reports a denied permission like a real browser
// (NotAllowedError); the default headless shell throws NotSupportedError instead.
test.use({ channel: 'chromium', permissions: [], camera: 'blank', cameraAutoAccept: false });

test('a denied camera permission shows a German explanation and the search still works', async ({ page, data }) => {
  const user = await data.user();
  const person = await data.person();
  await signIn(page, user);

  await currentPerson(page).getByRole('button', { name: 'QR scannen' }).click();
  const picker = personPicker(page);
  await expect(page.getByTestId('qr-scanner')).toHaveAttribute('data-status', 'error', { timeout: 20_000 });
  await expect(page.getByTestId('scanner-error')).toContainText('Kein Zugriff auf die Kamera');
  await expect(picker.getByRole('button', { name: 'Erneut versuchen' })).toBeVisible();

  await picker.getByRole('button', { name: 'Stattdessen suchen' }).click();
  await picker.getByTestId('person-search').fill(person.number);
  await picker.getByTestId('person-search').press('Enter');
  await expect(picker).toBeHidden();
  await expect(currentPerson(page)).toHaveAttribute('data-person-number', person.number);
});
