/** Fake camera without a QR code (project "qr-camera"). */
import { expect, liveCameraTracks, test, trackCameraStreams } from '../../support/scanner';
import { currentPerson, personPicker, signIn } from '../../support/ui';

test.use({ camera: 'blank' });

test('the scanner runs until it is closed or left and then releases the camera', async ({ page, data }) => {
  const user = await data.user();
  await trackCameraStreams(page);
  await signIn(page, user);

  await currentPerson(page).getByRole('button', { name: 'QR scannen' }).click();
  const picker = personPicker(page);
  const scanner = page.getByTestId('qr-scanner');
  await expect(scanner).toHaveAttribute('data-status', 'scanning', { timeout: 20_000 });
  await expect(scanner).toHaveAttribute('data-engine', /^(native|wasm)$/);
  await expect(picker.getByText('Halte den QR-Code der Person in den Rahmen.')).toBeVisible();
  await expect.poll(() => liveCameraTracks(page)).toBe(1);

  // switching to the search stops the camera
  await picker.getByRole('button', { name: 'Stattdessen suchen' }).click();
  await expect(picker.getByTestId('person-search')).toBeVisible();
  await expect.poll(() => liveCameraTracks(page)).toBe(0);

  // closing the dialog while scanning stops it as well
  await picker.getByRole('button', { name: 'QR scannen' }).click();
  await expect(scanner).toHaveAttribute('data-status', 'scanning', { timeout: 20_000 });
  await picker.getByTestId('dialog-close').click();
  await expect(picker).toBeHidden();
  await expect.poll(() => liveCameraTracks(page)).toBe(0);
});
