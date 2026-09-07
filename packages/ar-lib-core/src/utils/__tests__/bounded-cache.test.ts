import { describe, expect, it } from 'vitest';
import { setBoundedMapEntry } from '../bounded-cache';

describe('setBoundedMapEntry', () => {
  it('evicts the oldest entry at capacity', () => {
    const cache = new Map([
      ['oldest', 1],
      ['newer', 2],
    ]);

    setBoundedMapEntry(cache, 'newest', 3, 2);

    expect([...cache.entries()]).toEqual([
      ['newer', 2],
      ['newest', 3],
    ]);
  });

  it('refreshes an existing entry as the most recently used entry', () => {
    const cache = new Map([
      ['first', 1],
      ['second', 2],
    ]);

    setBoundedMapEntry(cache, 'first', 3, 2);
    setBoundedMapEntry(cache, 'third', 4, 2);

    expect([...cache.entries()]).toEqual([
      ['first', 3],
      ['third', 4],
    ]);
  });

  it('rejects invalid limits without changing the cache', () => {
    const cache = new Map([['entry', 1]]);

    expect(() => setBoundedMapEntry(cache, 'other', 2, 0)).toThrow(RangeError);
    expect([...cache.entries()]).toEqual([['entry', 1]]);
  });

  it('supports undefined as a legitimate key', () => {
    const cache = new Map<string | undefined, number>([[undefined, 1]]);

    setBoundedMapEntry(cache, 'replacement', 2, 1);

    expect([...cache.entries()]).toEqual([['replacement', 2]]);
  });
});
