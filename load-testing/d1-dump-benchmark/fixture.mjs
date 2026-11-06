/**
 * Synthetic data only: no Authrim migrations, user records, or existing D1 tables are used.
 * Each call emits one bounded INSERT statement; callers control batch pacing and retries.
 * Random hexadecimal payloads avoid the unrealistic compression of repeated filler text.
 * Hex encoding still has only four bits of entropy per byte, so export compression must
 * be measured separately from the logical payload size.
 */
export const DEFAULT_PAYLOAD_BYTES = 1024;
export const MAX_PAYLOAD_BYTES = 65536;
export const MAX_SEED_ROWS = 2000;

export const schemaSql = `
CREATE TABLE IF NOT EXISTS bench_accounts (
  id INTEGER PRIMARY KEY,
  tenant TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (tenant, email)
);
CREATE INDEX IF NOT EXISTS bench_accounts_tenant_status_updated_at
  ON bench_accounts (tenant, status, updated_at);
CREATE TABLE IF NOT EXISTS bench_probe (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  writes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO bench_probe (id, writes, updated_at) VALUES (1, 0, 0);
`.trim();

/**
 * Seed consecutive IDs with stable account metadata and independently random payloads.
 * Retrying a batch preserves existing rows, including their payloads. Bounds prevent
 * accidental unbounded CTEs; they do not guarantee a particular remote execution time.
 * payloadBytes is the resulting ASCII TEXT byte length, not randomblob's input length.
 */
export function seedSql(startId, rowCount, payloadBytes = DEFAULT_PAYLOAD_BYTES) {
  requireInteger('startId', startId, 1, Number.MAX_SAFE_INTEGER);
  requireInteger('rowCount', rowCount, 1, MAX_SEED_ROWS);
  requireInteger('payloadBytes', payloadBytes, 1, MAX_PAYLOAD_BYTES);
  if (rowCount - 1 > Number.MAX_SAFE_INTEGER - startId) {
    throw new RangeError('The final account ID must be a safe integer.');
  }

  const endId = startId + rowCount - 1;
  const randomBytes = Math.ceil(payloadBytes / 2);

  return `
WITH RECURSIVE account_ids(id) AS (
  SELECT ${startId}
  UNION ALL
  SELECT id + 1 FROM account_ids WHERE id < ${endId}
)
INSERT OR IGNORE INTO bench_accounts (id, tenant, email, status, updated_at, payload)
SELECT
  id,
  'tenant-' || printf('%04d', (id - 1) % 100),
  'account-' || id || '@example.invalid',
  CASE WHEN id % 10 = 0 THEN 'disabled'
       WHEN id % 10 = 1 THEN 'pending'
       ELSE 'active' END,
  1704067200 + id,
  substr(hex(randomblob(${randomBytes})), 1, ${payloadBytes})
FROM account_ids;
`.trim();
}

/**
 * Compare this aggregate and the complete first/last three payload samples before
 * export and after restore. These are consistency checks, not a cryptographic checksum
 * of every row. Probe writes are deliberately excluded because they may run concurrently.
 */
export const verificationSql = `
SELECT
  COUNT(*) AS account_count,
  MIN(id) AS min_id,
  MAX(id) AS max_id,
  COALESCE(SUM(id), 0) AS id_sum,
  COALESCE(SUM(updated_at), 0) AS updated_at_sum,
  COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS payload_bytes,
  MIN(length(CAST(payload AS BLOB))) AS min_payload_bytes,
  MAX(length(CAST(payload AS BLOB))) AS max_payload_bytes,
  (
    SELECT json_group_array(json_object(
      'id', id, 'tenant', tenant, 'email', email, 'status', status,
      'updated_at', updated_at, 'payload', payload
    ))
    FROM (
      SELECT * FROM bench_accounts WHERE id IN (
        SELECT id FROM bench_accounts ORDER BY id LIMIT 3
      ) OR id IN (
        SELECT id FROM bench_accounts ORDER BY id DESC LIMIT 3
      )
      ORDER BY id
    )
  ) AS sample_rows
FROM bench_accounts;
`.trim();

function requireInteger(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}
