import { describe, expect, it } from 'vitest';
import {
  D1_MAX_BOUND_PARAMETERS,
  chunkForBoundParameters,
  sqlPlaceholders,
} from '../bound-parameters';

describe('chunkForBoundParameters', () => {
  it('keeps every statement within D1 bound-parameter limit', () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    const chunks = chunkForBoundParameters(ids, 4);
    expect(chunks.map((chunk) => chunk.length)).toEqual([96, 96, 58]);
    for (const chunk of chunks) {
      expect(chunk.length + 4).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }
    expect(chunks.flat()).toEqual(ids);
  });

  it('sizes chunks by the parameters each value binds', () => {
    const rows = Array.from({ length: 30 }, (_, index) => index);
    expect(chunkForBoundParameters(rows, 0, 4).map((chunk) => chunk.length)).toEqual([25, 5]);
  });

  it('returns no chunks for no values', () => {
    expect(chunkForBoundParameters([], 3)).toEqual([]);
  });

  it('refuses a statement with no room for values', () => {
    expect(() => chunkForBoundParameters(['a'], 100)).toThrow(RangeError);
  });
});

describe('sqlPlaceholders', () => {
  it('lists one placeholder per value', () => {
    expect(sqlPlaceholders(3)).toBe('?, ?, ?');
    expect(sqlPlaceholders(0)).toBe('');
  });
});
