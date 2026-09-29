import type { GroupRecord, OfferingRecord } from '../../lib/types';
import { buildOfferingSections } from './offerings';

const base = { collectionId: 'c', created: '', updated: '' };
const group = (id: string, name: string, sortOrder: number): GroupRecord => ({
  ...base,
  collectionName: 'groups',
  id,
  name,
  sortOrder,
});
const offering = (id: string, groupId: string, name: string, sortOrder: number, active = true): OfferingRecord => ({
  ...base,
  collectionName: 'offerings',
  id,
  group: groupId,
  name,
  sortOrder,
  active,
  priceCents: 100,
});

describe('buildOfferingSections', () => {
  it('groups active offerings, sorted by sortOrder then name', () => {
    const sections = buildOfferingSections(
      [group('g2', 'Snacks', 20), group('g1', 'Getränke', 10), group('g3', 'Leer', 30)],
      [
        offering('o1', 'g1', 'Wasser', 20),
        offering('o2', 'g1', 'Bier', 10),
        offering('o3', 'g1', 'Alt', 10),
        offering('o4', 'g2', 'Chips', 10),
        offering('o5', 'g1', 'Inaktiv', 5, false),
        offering('o6', 'g3', 'Weg', 10, false),
      ],
    );
    expect(sections.map((s) => [s.group.name, s.offerings.map((o) => o.name)])).toEqual([
      ['Getränke', ['Alt', 'Bier', 'Wasser']],
      ['Snacks', ['Chips']],
    ]);
  });

  it('collects offerings of unknown groups under "Sonstiges"', () => {
    const sections = buildOfferingSections([], [offering('o1', 'missing', 'X', 10)]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.group.name).toBe('Sonstiges');
  });
});
