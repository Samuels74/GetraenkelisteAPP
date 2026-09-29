import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import {
  bookTile,
  currentPerson,
  expectNoHorizontalOverflow,
  expectTapTargets,
  forcePasswordScreen,
  loginViaUi,
  offeringRow,
  offeringTile,
  personPicker,
  pickPerson,
  signIn,
} from '../support/ui';

const LONG_NAME = 'Maximiliane Theresia Oberhuber-Wimmersberger';

test.describe('phone layout at 360 px', { tag: '@mobile' }, () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('the main pages do not scroll horizontally', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin', name: LONG_NAME });
    const {
      offerings: [longOffering, expensive],
    } = await data.catalog([
      { label: 'Holunderblütensirup-Spritzer', priceCents: 450 },
      { label: 'Magnum', priceCents: 99_999 },
    ]);
    const person = await data.person({ number: data.id('Nummer-'), name: data.name(LONG_NAME), nickname: 'Der mit dem langen Namen' });
    await data.booking(person, longOffering!, { by: admin });
    await data.booking(person, expensive!, { by: admin });

    const pages: Array<[string, (page: Page) => Locator]> = [
      ['/', (p) => offeringTile(p, longOffering!.name)],
      ['/personen', (p) => p.getByTestId('person-row').first()],
      [`/personen/${person.id}`, (p) => p.getByTestId('qr-code')],
      ['/personen/qr-codes', (p) => p.getByTestId('qr-card').first()],
      ['/buchungen?meine=1', (p) => p.getByTestId('booking-item').first()],
      ['/buchungen?meine=1&ansicht=personen', (p) => p.getByTestId('totals-person-row').first()],
      ['/buchungen?meine=1&ansicht=angebote', (p) => p.getByTestId('totals-offering-row').first()],
      ['/buchungen?zeitraum=zeitraum', (p) => p.getByLabel('Von', { exact: true })],
      ['/verwaltung/angebote', (p) => p.getByTestId('offering-row').first()],
      ['/verwaltung/gruppen', (p) => p.getByTestId('group-row').first()],
      ['/verwaltung/benutzer', (p) => p.getByTestId('user-row').first()],
      ['/konto', (p) => p.getByTestId('password-form')],
    ];

    await signIn(page, admin);
    for (const [path, ready] of pages) {
      await page.goto(path);
      await expect(ready(page)).toBeVisible();
      await expectNoHorizontalOverflow(page, path);
    }

    // booking screen with a selected person, and the person picker
    await page.goto('/');
    await pickPerson(page, person);
    await expect(page.getByTestId('recent-bookings').getByTestId('booking-item')).toHaveCount(2);
    await expectNoHorizontalOverflow(page, '/ (person selected)');
    await currentPerson(page).getByRole('button', { name: /^Person wechseln/ }).click();
    await expect(personPicker(page).getByTestId('person-option').first()).toBeVisible();
    await expectNoHorizontalOverflow(page, 'person picker');
    await personPicker(page).getByTestId('dialog-close').click();

    // login screen and the blocking password screen of a new account
    await page.getByTestId('nav-konto').click();
    await page.getByTestId('logout').click();
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
    await expectNoHorizontalOverflow(page, '/login');
    const newcomer = await data.user({ name: LONG_NAME, mustChangePassword: true });
    await loginViaUi(page, newcomer.username, newcomer.password);
    await expect(forcePasswordScreen(page)).toBeVisible();
    await expectNoHorizontalOverflow(page, 'force password screen');
  });

  test('bottom navigation and tap targets of at least 48 px', async ({ page, data }) => {
    const admin = await data.user({ role: 'admin' });
    const {
      offerings: [cola],
    } = await data.catalog([
      { label: 'Cola', priceCents: 250 },
      { label: 'Kracherl', priceCents: 200 },
      { label: 'Eistee', priceCents: 300 },
    ]);
    const person = await data.person();
    await signIn(page, admin);
    await expect(offeringTile(page, cola!.name)).toBeVisible();

    // bottom bar across the full width at the bottom edge of the viewport
    const nav = page.getByTestId('main-nav');
    await expect(nav).toBeVisible();
    const viewport = page.viewportSize()!;
    const box = (await nav.boundingBox())!;
    expect(box.x).toBeCloseTo(0, 0);
    expect(box.width).toBeCloseTo(viewport.width, 0);
    expect(box.y + box.height).toBeCloseTo(viewport.height, 0);
    await expect(nav.getByRole('link')).toHaveText(['Buchen', 'Personen', 'Buchungen', 'Verwaltung', 'Konto']);

    await expectTapTargets(nav.getByRole('link'));
    await expectTapTargets(page.getByTestId('offering-tile'));
    await expectTapTargets(page.getByTestId('group-chip'));
    await expectTapTargets(currentPerson(page).getByRole('button'));

    await pickPerson(page, person);
    await expectTapTargets(currentPerson(page).getByRole('button'));
    await bookTile(page, cola!, 250);
    await expectTapTargets(page.getByRole('button', { name: 'Rückgängig' }));
    await expect(page.getByTestId('recent-bookings').getByTestId('booking-item')).toHaveCount(1);
    await expectTapTargets(page.getByTestId('recent-bookings').getByRole('button'));

    // the fixed bar does not cover the end of the page
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = page.getByTestId('recent-bookings').getByTestId('booking-item').last();
    await expect(last).toBeInViewport({ ratio: 1 });
    const lastBox = (await last.boundingBox())!;
    const navBox = (await nav.boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(navBox.y + 1);

    // filters and administration controls
    await page.getByTestId('nav-buchungen').click();
    await expect(page.getByTestId('bookings-count')).toBeVisible();
    await expectTapTargets(page.getByTestId('period-filter').locator('label'));
    await expectTapTargets(page.getByTestId('view-switch').locator('label'));
    await expectTapTargets(page.getByTestId('person-filter'));
    await expectTapTargets(page.getByTestId('only-mine'));
    await expectTapTargets(page.getByTestId('csv-export'));
    await page.getByTestId('nav-verwaltung').click();
    await expect(offeringRow(page, cola!.name)).toBeVisible();
    await expectTapTargets(page.getByRole('navigation', { name: 'Verwaltung' }).getByRole('link'));
    await expectTapTargets(offeringRow(page, cola!.name).getByRole('button'));
  });
});

test.describe('large screen layout', () => {
  test('the navigation is a sidebar and nothing overflows', async ({ page, data }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, 'sidebar only from 1024 px');
    const user = await data.user();
    await data.catalog([{ label: 'Cola', priceCents: 250 }]);
    await signIn(page, user);
    await expect(page.getByTestId('offering-tile').first()).toBeVisible();

    const nav = page.getByTestId('main-nav');
    const box = (await nav.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeCloseTo(0, 0);
    expect(box.y).toBeCloseTo(0, 0);
    expect(box.height).toBeCloseTo(viewport.height, 0);
    expect(box.width).toBeLessThan(viewport.width / 3);
    await expectTapTargets(nav.getByRole('link', { name: /Buchen|Personen|Buchungen|Konto/ }));
    for (const path of ['/', '/personen', '/buchungen', '/konto']) {
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeAttached();
      await expectNoHorizontalOverflow(page, path);
    }
  });
});
