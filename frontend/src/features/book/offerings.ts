import type { GroupRecord, OfferingRecord } from '../../lib/types';

export interface OfferingSection {
  group: Pick<GroupRecord, 'id' | 'name'>;
  offerings: OfferingRecord[];
}

/**
 * Active offerings grouped by group, both sorted by `sortOrder` (then name).
 * Groups without active offerings are omitted.
 */
export function buildOfferingSections(groups: readonly GroupRecord[], offerings: readonly OfferingRecord[]): OfferingSection[] {
  const bySort = <T extends { sortOrder: number; name: string }>(a: T, b: T) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'de');
  const active = offerings.filter((o) => o.active);
  const sections: OfferingSection[] = [...groups].sort(bySort).map((group) => ({
    group,
    offerings: active.filter((o) => o.group === group.id).sort(bySort),
  }));
  const known = new Set(groups.map((g) => g.id));
  const orphans = active.filter((o) => !known.has(o.group)).sort(bySort);
  if (orphans.length > 0) sections.push({ group: { id: '_other', name: 'Sonstiges' }, offerings: orphans });
  return sections.filter((section) => section.offerings.length > 0);
}
