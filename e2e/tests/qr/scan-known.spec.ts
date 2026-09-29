/** Fake camera shows the QR code of a person that exists (project "qr-camera"). */
import { expect, liveCameraTracks, test, trackCameraStreams } from '../../support/scanner';
import { bookTile, currentPerson, expectPersonTotal, personPicker, signIn } from '../../support/ui';

test.use({ camera: 'known' });

test('scanning a known QR code selects the person, releases the camera and booking works', async ({ page, data, cameraCode }) => {
  const user = await data.user();
  const person = await data.person({ number: cameraCode });
  const {
    offerings: [cola],
  } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);

  await trackCameraStreams(page);
  await signIn(page, user);
  await expect(currentPerson(page)).toHaveAttribute('data-state', 'empty');
  await currentPerson(page).getByRole('button', { name: 'QR scannen' }).click();

  // detection takes well under a second – wait for the result, not for the scanner UI
  await expect(currentPerson(page)).toHaveAttribute('data-person-number', person.number, { timeout: 20_000 });
  await expect(personPicker(page)).toBeHidden();
  await expect.poll(() => liveCameraTracks(page), { message: 'camera released' }).toBe(0);

  await bookTile(page, cola!, 250);
  await expectPersonTotal(page, 250, 1);
});
