import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { parseAmount, parseCsvLine } from '../support/csv';
import type { OfferingRecord, PersonRecord, TestData, TestUser } from '../support/data';
import { expect, test } from '../support/fixtures';
import { attr, euro, plainAmount, reloadPage, signIn } from '../support/ui';

const CSV_HEADER = 'Datum;Uhrzeit;Nummer;Name;Nickname;Gruppe;Angebot;Anzahl;Einzelpreis;Summe;Gebucht von';

/** Today in the browser's time zone (config: Europe/Vienna) as YYYY-MM-DD. */
function todayInVienna(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(new Date());
}

interface Scenario {
  me: TestUser;
  colleague: TestUser;
  groupName: string;
  beer: OfferingRecord;
  water: OfferingRecord;
  anna: PersonRecord;
  tricky: PersonRecord;
}

/**
 * me:        anna Bier, anna Bier, anna Wasser, tricky Bier   → 4 bookings, € 11,70
 * colleague: tricky Wasser                                    → 1 booking,  € 1,20
 */
async function scenario(data: TestData): Promise<Scenario> {
  const me = await data.user({ name: 'Kellner Eins' });
  const colleague = await data.user();
  const {
    group,
    offerings: [beer, water],
  } = await data.catalog([
    { label: 'Bier', priceCents: 350 },
    { label: 'Wasser', priceCents: 120 },
  ]);
  const anna = await data.person({ name: data.name('Anna'), nickname: 'Anni' });
  // formula-like name and a separator in the nickname (CSV escaping)
  const tricky = await data.person({ name: `=1+2 ${data.token}`, nickname: 'Max; der "Große"' });
  await data.booking(anna, beer!, { by: me });
  await data.booking(anna, beer!, { by: me });
  await data.booking(anna, water!, { by: me });
  await data.booking(tricky, beer!, { by: me });
  await data.booking(tricky, water!, { by: colleague });
  return { me, colleague, groupName: group.name, beer: beer!, water: water!, anna, tricky };
}

function summary(page: Page) {
  return { count: page.getByTestId('bookings-count'), total: page.getByTestId('bookings-total') };
}

test.describe('bookings page (Buchungen)', () => {
  test('filters: only mine, period and person', async ({ page, data }) => {
    const s = await scenario(data);
    const { count, total } = summary(page);

    await signIn(page, s.me, '/buchungen');
    await page.getByTestId('only-mine').click();
    await expect(page).toHaveURL(/[?&]meine=1/);
    await expect(page.getByTestId('only-mine')).toHaveAttribute('aria-pressed', 'true');
    await expect(count).toHaveText('4');
    await expect(total).toHaveText(euro(1170));
    await expect(page.getByTestId('booking-item')).toHaveCount(4);
    await expect(page.getByRole('region', { name: 'Heute' })).toBeVisible();

    const period = page.getByTestId('period-filter');
    for (const [label, param] of [
      ['Heute', 'heute'],
      ['7 Tage', '7-tage'],
      ['30 Tage', '30-tage'],
    ] as const) {
      await period.getByText(label, { exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`zeitraum=${param}`));
      await expect(count).toHaveText('4');
      await expect(total).toHaveText(euro(1170));
    }

    // custom range in the past → nothing; up to today → everything
    await period.getByText('Von–bis', { exact: true }).click();
    await page.getByLabel('Von', { exact: true }).fill('2020-01-01');
    await page.getByLabel('Bis', { exact: true }).fill('2020-01-31');
    await expect(page).toHaveURL(/zeitraum=zeitraum&von=2020-01-01&bis=2020-01-31/);
    await expect(count).toHaveText('0');
    await expect(total).toHaveText(euro(0));
    await expect(page.getByText('Für diesen Filter gibt es keine Buchungen.')).toBeVisible();
    await page.getByLabel('Bis', { exact: true }).fill(todayInVienna());
    await expect(count).toHaveText('4');

    // person filter, with and without "nur meine"
    await period.getByText('Alle', { exact: true }).click();
    await page.getByTestId('person-filter').selectOption(s.tricky.id);
    await expect(page).toHaveURL(new RegExp(`person=${s.tricky.id}`));
    await expect(count).toHaveText('1');
    await expect(total).toHaveText(euro(350));
    await page.getByTestId('only-mine').click();
    await expect(page.getByTestId('only-mine')).toHaveAttribute('aria-pressed', 'false');
    await expect(count).toHaveText('2');
    await expect(total).toHaveText(euro(470));
    await expect(page.getByTestId('booking-item').filter({ hasText: `von ${s.colleague.username}` })).toHaveCount(1);

    // filters live in the URL
    await reloadPage(page);
    await expect(page.getByTestId('person-filter')).toHaveValue(s.tricky.id);
    await expect(count).toHaveText('2');
  });

  test('totals per person and per offering', async ({ page, data }) => {
    const s = await scenario(data);
    await signIn(page, s.me, '/buchungen?meine=1&ansicht=personen');

    const personRow = (person: PersonRecord) =>
      page.locator(`[data-testid="totals-person-row"][data-person-number="${attr(person.number)}"]`);
    await expect(page.getByTestId('totals-person-row')).toHaveCount(2);
    await expect(personRow(s.anna)).toContainText(euro(820));
    await expect(personRow(s.anna)).toContainText('„Anni“ · 3×');
    await expect(personRow(s.tricky)).toContainText(euro(350));

    const offeringRow = (offering: OfferingRecord) =>
      page.locator(`[data-testid="totals-offering-row"][data-offering-name="${attr(offering.name)}"]`);
    await page.getByTestId('view-switch').getByText('Pro Angebot', { exact: true }).click();
    await expect(page).toHaveURL(/ansicht=angebote/);
    await expect(page.getByTestId('totals-offering-row')).toHaveCount(2);
    await expect(offeringRow(s.beer)).toContainText('3×');
    await expect(offeringRow(s.beer)).toContainText(euro(1050));
    await expect(offeringRow(s.water)).toContainText('1×');
    await expect(offeringRow(s.water)).toContainText(euro(120));
    await expect(page.getByRole('region', { name: s.groupName })).toContainText(euro(1170));

    // a person row opens that person's bookings
    await page.getByTestId('view-switch').getByText('Pro Person', { exact: true }).click();
    await personRow(s.anna).click();
    await expect(page).toHaveURL(new RegExp(`person=${s.anna.id}`));
    await expect(page.getByTestId('view-switch').getByRole('radio', { name: 'Liste' })).toBeChecked();
    await expect(page.getByTestId('booking-item')).toHaveCount(3);
    await expect(page.getByTestId('bookings-total')).toHaveText(euro(820));
  });

  test('CSV export of the current filter', async ({ page, data }) => {
    const s = await scenario(data);
    await signIn(page, s.me, '/buchungen?meine=1');
    await expect(page.getByTestId('bookings-count')).toHaveText('4');

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('csv-export').click();
    const download = await downloadPromise;
    await expect(page.getByText('4 Buchungen exportiert')).toBeVisible();
    const today = todayInVienna();
    expect(download.suggestedFilename()).toBe(`buchungen_alle_${today}.csv`);

    const csv = await readFile(await download.path(), 'utf8');
    expect(csv.charCodeAt(0), 'UTF-8 BOM').toBe(0xfeff);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, ''), 'only CRLF line breaks').not.toMatch(/[\r\n]/);
    const lines = csv.slice(1).split('\r\n').slice(0, -1);
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(1 + 4);

    const [year, month, day] = today.split('-');
    const rows = lines.slice(1).map((line) => parseCsvLine(line));
    for (const row of rows) {
      expect(row).toHaveLength(11);
      expect(row[0]).toBe(`${day}.${month}.${year}`);
      expect(row[1]).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(row[5]).toBe(s.groupName);
      expect(row[10]).toBe(s.me.username);
    }
    const described = rows.map((row) => [row[2], row[6], row[7], row[8], row[9]].join('|')).sort();
    expect(described).toEqual(
      [
        [s.anna.number, s.beer.name, '1', '3,50', '3,50'],
        [s.anna.number, s.beer.name, '1', '3,50', '3,50'],
        [s.anna.number, s.water.name, '1', '1,20', '1,20'],
        [s.tricky.number, s.beer.name, '1', '3,50', '3,50'],
      ]
        .map((row) => row.join('|'))
        .sort(),
    );
    const sum = rows.reduce((acc, row) => acc + parseAmount(row[9]!), 0);
    expect(plainAmount(sum)).toBe('11,70');

    // text cells: formula injection guard and quoting
    const trickyLine = lines.find((line) => line.includes(s.tricky.number))!;
    expect(trickyLine).toContain(`;'=1+2 ${data.token};"Max; der ""Große""";`);
    const annaRow = rows.find((row) => row[2] === s.anna.number)!;
    expect(annaRow[3]).toBe(s.anna.name);
    expect(annaRow[4]).toBe('Anni');
  });

  test('long lists load more bookings on demand', async ({ page, data }) => {
    const user = await data.user();
    const {
      offerings: [water],
    } = await data.catalog([{ label: 'Wasser', priceCents: 100 }]);
    const person = await data.person();
    await Promise.all(Array.from({ length: 53 }, () => data.booking(person, water!, { by: user })));

    await signIn(page, user, `/buchungen?person=${person.id}`);
    await expect(page.getByTestId('bookings-count')).toHaveText('53');
    await expect(page.getByTestId('bookings-total')).toHaveText(euro(5300));
    const items = page.getByTestId('booking-item');
    const more = page.getByRole('button', { name: 'Weitere laden' });
    await expect(items).toHaveCount(50);
    // one tap is enough, even though parallel tests cause realtime refetches all the time
    await more.click();
    await expect(items).toHaveCount(53);
    await expect(more).toHaveCount(0);
  });

  test('"Weitere laden" keeps all bookings when another phone books meanwhile', { tag: '@regression' }, async ({ page, data }) => {
    const user = await data.user();
    const colleague = await data.user();
    const {
      offerings: [water],
    } = await data.catalog([{ label: 'Wasser', priceCents: 100 }]);
    const person = await data.person();
    await Promise.all(Array.from({ length: 53 }, () => data.booking(person, water!, { by: user })));

    await signIn(page, user, `/buchungen?person=${person.id}`);
    await expect(page.getByTestId('bookings-count')).toHaveText('53');
    const items = page.getByTestId('booking-item');
    await expect(items).toHaveCount(50);

    // the second page answers slowly, so the realtime event of the other
    // phone's booking arrives while it is still loading
    await page.route(/\/api\/collections\/bookings\/records\?page=2&/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000)); // simulated slow network
      await route.continue();
    });
    const secondPage = page.waitForRequest(/\/api\/collections\/bookings\/records\?page=2&/);
    await page.getByRole('button', { name: 'Weitere laden' }).click();
    await secondPage;
    const extra = await data.booking(person, water!, { by: colleague });

    await expect(page.getByTestId('bookings-count')).toHaveText('54');
    // (offset paging: while page 2 is answered after the insert, one row can show
    // up twice for a moment – the refetch after the event then settles the list)
    const shown = () => items.evaluateAll((elements) => elements.map((el) => el.getAttribute('data-booking-id') ?? ''));
    await expect
      .poll(async () => {
        const ids = await shown();
        return { rows: ids.length, unique: new Set(ids).size, hasNewBooking: ids.includes(extra.id) };
      })
      .toEqual({ rows: 54, unique: 54, hasNewBooking: true });
    await expect(page.getByRole('button', { name: 'Weitere laden' })).toHaveCount(0);
  });

  test('an empty filter exports nothing', async ({ page, data }) => {
    const user = await data.user();
    await signIn(page, user, '/buchungen?meine=1');
    await expect(page.getByTestId('bookings-count')).toHaveText('0');
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.getByTestId('csv-export').click();
    await expect(page.getByText('Keine Buchungen für diesen Filter.')).toBeVisible();
    expect(downloads).toBe(0);
  });
});
