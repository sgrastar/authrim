import { describe, expect, it } from 'vitest';
import { LOOKUP_MAX_VIRTUAL_BUCKET, LOOKUP_VIRTUAL_BUCKET_COUNT } from '../contract.js';
import { LOOKUP_VIRTUAL_BUCKET_COUNT as BLIND_INDEX_BUCKET_COUNT } from '../blind-index.js';
import { renderLookupBucketCounterSeed } from '../seed-sql.js';

describe('Lookup bucket contract and seed SQL', () => {
  it('preserves the blind-index bucket-count export', () => {
    expect(BLIND_INDEX_BUCKET_COUNT).toBe(LOOKUP_VIRTUAL_BUCKET_COUNT);
    expect(LOOKUP_MAX_VIRTUAL_BUCKET).toBe(LOOKUP_VIRTUAL_BUCKET_COUNT - 1);
  });

  it('renders byte-stable SQLite SQL as one bounded statement', () => {
    const input = {
      dialect: 'sqlite' as const,
      bucketCount: LOOKUP_VIRTUAL_BUCKET_COUNT,
      nowExpression: '{{AUTHRIM_NOW_EPOCH_SECONDS}}',
    };
    const first = renderLookupBucketCounterSeed(input);
    const second = renderLookupBucketCounterSeed(input);

    expect(first).toBe(second);
    expect(first).toContain(`WHERE virtual_bucket < ${LOOKUP_MAX_VIRTUAL_BUCKET}`);
    expect(first.match(/;(?=\s|$)/gu)).toHaveLength(1);
    expect(new TextEncoder().encode(first).byteLength).toBeLessThan(100_000);
  });

  it('renders PostgreSQL generate_series SQL with the same logical range', () => {
    const sql = renderLookupBucketCounterSeed({
      dialect: 'postgres',
      nowExpression: '{{AUTHRIM_NOW_EPOCH_SECONDS}}',
    });

    expect(sql).toContain('INSERT INTO public.lookup_bucket_counters');
    expect(sql).toContain(`generate_series(0, ${LOOKUP_MAX_VIRTUAL_BUCKET})`);
    expect(sql.match(/;(?=\s|$)/gu)).toHaveLength(1);
  });

  it('rejects unsupported dialects and unsafe expressions without fallback', () => {
    expect(() =>
      renderLookupBucketCounterSeed({
        dialect: 'mysql' as 'sqlite',
        nowExpression: 'CURRENT_TIMESTAMP',
      })
    ).toThrow('lookup_bucket_seed_dialect_unsupported:mysql');
    expect(() =>
      renderLookupBucketCounterSeed({
        dialect: 'sqlite',
        nowExpression: 'unixepoch(); DROP TABLE users',
      })
    ).toThrow('lookup_bucket_seed_now_expression_invalid');
  });
});
