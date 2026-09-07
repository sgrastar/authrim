import { LOOKUP_VIRTUAL_BUCKET_COUNT } from './contract.js';

export type LookupBucketSeedSqlDialect = 'sqlite' | 'postgres';

export interface RenderLookupBucketCounterSeedInput {
  dialect: LookupBucketSeedSqlDialect;
  bucketCount?: number;
  nowExpression: string;
}

const COLUMNS = [
  'virtual_bucket',
  'estimated_active_identifier_count',
  'estimated_active_alias_count',
  'exact_count_checked_at',
  'reconciliation_cursor',
  'reconciliation_error_code',
  'updated_at',
  'successful_route_publication_count',
  'publication_counter_updated_at',
] as const;

function validateInput(input: RenderLookupBucketCounterSeedInput): {
  bucketCount: number;
  maximumBucket: number;
  nowExpression: string;
} {
  const bucketCount = input.bucketCount ?? LOOKUP_VIRTUAL_BUCKET_COUNT;
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1) {
    throw new Error('lookup_bucket_seed_bucket_count_invalid');
  }
  const nowExpression = input.nowExpression.trim();
  if (
    nowExpression.length === 0 ||
    nowExpression.includes('\0') ||
    nowExpression.includes(';') ||
    nowExpression.includes('--') ||
    nowExpression.includes('/*') ||
    nowExpression.includes('*/')
  ) {
    throw new Error('lookup_bucket_seed_now_expression_invalid');
  }
  return { bucketCount, maximumBucket: bucketCount - 1, nowExpression };
}

export function renderLookupBucketCounterSeed(input: RenderLookupBucketCounterSeedInput): string {
  const { maximumBucket, nowExpression } = validateInput(input);
  const table =
    input.dialect === 'postgres' ? 'public.lookup_bucket_counters' : 'lookup_bucket_counters';
  const insert = `INSERT INTO ${table} (\n  ${COLUMNS.join(',\n  ')}\n)`;
  const values = [
    'virtual_bucket',
    '0',
    '0',
    nowExpression,
    "'bootstrap'",
    'NULL',
    nowExpression,
    '0',
    nowExpression,
  ].join(', ');

  if (input.dialect === 'sqlite') {
    return [
      'WITH RECURSIVE lookup_bucket_seed(virtual_bucket) AS (',
      '  SELECT 0',
      '  UNION ALL',
      '  SELECT virtual_bucket + 1',
      '    FROM lookup_bucket_seed',
      `   WHERE virtual_bucket < ${maximumBucket}`,
      ')',
      insert,
      `SELECT ${values}`,
      '  FROM lookup_bucket_seed;',
    ].join('\n');
  }
  if (input.dialect === 'postgres') {
    return [
      insert,
      `SELECT ${values}`,
      `  FROM generate_series(0, ${maximumBucket}) AS lookup_bucket_seed(virtual_bucket);`,
    ].join('\n');
  }
  throw new Error(`lookup_bucket_seed_dialect_unsupported:${String(input.dialect)}`);
}
