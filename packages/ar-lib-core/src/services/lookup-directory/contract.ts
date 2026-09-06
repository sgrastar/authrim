export const LOOKUP_VIRTUAL_BUCKET_COUNT = 4096;
export const LOOKUP_MAX_VIRTUAL_BUCKET = LOOKUP_VIRTUAL_BUCKET_COUNT - 1;

export interface LookupBucketCounterSeedRow {
  virtual_bucket: number;
  estimated_active_identifier_count: number;
  estimated_active_alias_count: number;
  exact_count_checked_at: number;
  reconciliation_cursor: string;
  reconciliation_error_code: null;
  updated_at: number;
  successful_route_publication_count: number;
  publication_counter_updated_at: number;
}

export function assertCanonicalLookupBucketCounterSeed(input: {
  rows: readonly unknown[];
  bucketCount?: number;
  nowValue: number;
}): asserts input is {
  rows: readonly LookupBucketCounterSeedRow[];
  bucketCount?: number;
  nowValue: number;
} {
  const bucketCount = input.bucketCount ?? LOOKUP_VIRTUAL_BUCKET_COUNT;
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1) {
    throw new Error('lookup_bucket_seed_bucket_count_invalid');
  }
  if (!Number.isSafeInteger(input.nowValue) || input.nowValue < 0) {
    throw new Error('lookup_bucket_seed_now_invalid');
  }
  if (input.rows.length !== bucketCount) {
    throw new Error(
      `lookup_bucket_seed_row_count_invalid:expected=${bucketCount}:actual=${input.rows.length}`
    );
  }

  const buckets = new Set<number>();
  for (const value of input.rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('lookup_bucket_seed_row_invalid');
    }
    const row = value as Record<string, unknown>;
    if (!Number.isSafeInteger(row.virtual_bucket)) {
      throw new Error('lookup_bucket_seed_virtual_bucket_invalid');
    }
    const virtualBucket = row.virtual_bucket as number;
    if (virtualBucket < 0 || virtualBucket >= bucketCount) {
      throw new Error(`lookup_bucket_seed_virtual_bucket_out_of_range:${virtualBucket}`);
    }
    if (buckets.has(virtualBucket)) {
      throw new Error(`lookup_bucket_seed_virtual_bucket_duplicate:${virtualBucket}`);
    }
    buckets.add(virtualBucket);

    if (
      row.estimated_active_identifier_count !== 0 ||
      row.estimated_active_alias_count !== 0 ||
      row.exact_count_checked_at !== input.nowValue ||
      row.reconciliation_cursor !== 'bootstrap' ||
      row.reconciliation_error_code !== null ||
      row.updated_at !== input.nowValue ||
      row.successful_route_publication_count !== 0 ||
      row.publication_counter_updated_at !== input.nowValue
    ) {
      throw new Error(`lookup_bucket_seed_initial_value_invalid:${virtualBucket}`);
    }
  }

  const ordered = [...buckets].sort((left, right) => left - right);
  if (ordered[0] !== 0 || ordered.at(-1) !== bucketCount - 1) {
    throw new Error('lookup_bucket_seed_range_invalid');
  }
  for (let index = 0; index < bucketCount; index += 1) {
    if (ordered[index] !== index) {
      throw new Error(`lookup_bucket_seed_virtual_bucket_missing:${index}`);
    }
  }
}
