import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import {
  bookTile,
  currentPerson,
  expectPersonTotal,
  offeringTile,
  personPicker,
  pickPerson,
  signIn,
} from '../support/ui';

const NO_CONNECTION = 'Keine Verbindung zum Server. Bitte prüfe die Netzwerkverbindung.';

/**
 * Takes the browser off / back on the network – and reports it like a phone
 * does with the window's `offline` / `online` event (Chromium's emulation
 * fires it; for WebKit's this is not guaranteed). The app reacts to changes
 * only, so a second event changes nothing.
 */
async function setNetwork(page: Page, online: boolean): Promise<void> {
  await page.context().setOffline(!online);
  await page.evaluate((type) => window.dispatchEvent(new Event(type)), online ? 'online' : 'offline');
}

/**
 * There is no offline mode (bookings need the server): without a connection
 * nothing may be queued and sent later – a tap the bartender gave up on must
 * not book minutes later for whoever was selected then.
 */
test.describe('without a network connection', () => {
  test('banner and waiting tiles; actions fail at once and nothing runs after reconnecting', { tag: '@regression' }, async ({
    page,
    data,
  }) => {
    const user = await data.user();
    const {
      offerings: [cola],
    } = await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    const person = await data.person();

    await signIn(page, user);
    await pickPerson(page, person);
    await bookTile(page, cola!, 250);
    await expectPersonTotal(page, 250, 1);
    const recent = page.getByTestId('recent-bookings').getByTestId('booking-item');
    await expect(recent).toHaveCount(1);

    await setNetwork(page, false);
    await expect(page.getByTestId('offline-banner')).toHaveText('Keine Verbindung');
    const tile = offeringTile(page, cola!.name);
    await expect(tile).toBeDisabled();
    await tile.click({ force: true }); // a tap on a waiting tile does nothing

    // cancelling fails at once with the German message – no spinner that waits for the network
    await recent.getByRole('button', { name: 'Buchung stornieren' }).click();
    const dialog = page.getByTestId('cancel-booking-dialog');
    await dialog.getByRole('button', { name: 'Stornieren' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(NO_CONNECTION, { timeout: 3_000 });
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();

    // creating a person in the picker as well
    const number = data.id('off');
    await currentPerson(page).getByRole('button', { name: /^Person wechseln/ }).click();
    const picker = personPicker(page);
    await picker.getByRole('button', { name: 'Neue Person' }).click();
    await picker.getByLabel('Nummer').fill(number);
    await picker.getByRole('button', { name: 'Anlegen und auswählen' }).click();
    await expect(picker.getByRole('alert')).toHaveText(NO_CONNECTION, { timeout: 3_000 });
    await picker.getByTestId('dialog-close').click();

    // back online: the tiles work again – and nothing of the above is sent now
    await setNetwork(page, true);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
    await expect(tile).toBeEnabled();
    await page.waitForTimeout(1_500); // a queued request would go out right after the "online" event
    expect(await data.bookingsOf(person)).toHaveLength(1);
    expect(await data.findPerson(number)).toBeNull();
    await expect(page.getByText('Buchung storniert')).toHaveCount(0);
    await expect(currentPerson(page)).toHaveAttribute('data-person-number', person.number);

    await bookTile(page, cola!, 250);
    await expectPersonTotal(page, 500, 2);
    expect(await data.bookingsOf(person)).toHaveLength(2);
  });
});
