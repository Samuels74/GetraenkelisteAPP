import { computeReorder } from './mutations';

const items = (orders: number[]) => orders.map((sortOrder, i) => ({ id: `i${i}`, sortOrder }));

describe('computeReorder', () => {
  it('swaps only the two affected items when sort orders are distinct', () => {
    expect(computeReorder(items([10, 20, 30, 40]), 2, -1)).toEqual([
      { id: 'i2', sortOrder: 20 },
      { id: 'i1', sortOrder: 30 },
    ]);
    expect(computeReorder(items([10, 20, 30]), 0, 1)).toEqual([
      { id: 'i0', sortOrder: 20 },
      { id: 'i1', sortOrder: 10 },
    ]);
  });

  it('swaps irregular but distinct values without touching other items', () => {
    expect(computeReorder(items([5, 100, 101, 900]), 3, -1)).toEqual([
      { id: 'i3', sortOrder: 101 },
      { id: 'i2', sortOrder: 900 },
    ]);
  });

  it('renumbers (only changed items) when there are duplicate sort orders', () => {
    expect(computeReorder(items([0, 0, 0]), 2, -1)).toEqual([
      { id: 'i0', sortOrder: 10 },
      { id: 'i2', sortOrder: 20 },
      { id: 'i1', sortOrder: 30 },
    ]);
    expect(computeReorder(items([10, 20, 20, 40]), 0, 1)).toEqual([
      { id: 'i1', sortOrder: 10 },
      { id: 'i0', sortOrder: 20 },
      { id: 'i2', sortOrder: 30 },
    ]);
  });

  it('ignores moves beyond the edges', () => {
    expect(computeReorder(items([10, 20]), 0, -1)).toEqual([]);
    expect(computeReorder(items([10, 20]), 1, 1)).toEqual([]);
  });
});
