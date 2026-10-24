-- Internal source-execution evidence. Account shards need not have a tenants inventory row.
-- No FK: preserve the exact outcome even if the account is subsequently deleted or rerouted.
-- Unacknowledged results never expire. Only after Admin records the outcome may ACK start the TTL.
CREATE TABLE support_ops_account_result_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(receipt_id) = 64 AND receipt_id NOT GLOB '*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 512),
  action_id TEXT NOT NULL CHECK (length(action_id) BETWEEN 1 AND 512),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 512),
  legacy_user_id TEXT NOT NULL CHECK (length(legacy_user_id) BETWEEN 1 AND 512),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  source_version_ms INTEGER NOT NULL
    CHECK (typeof(source_version_ms) = 'integer' AND source_version_ms BETWEEN 1 AND 9007199254740991),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  attempt_token TEXT NOT NULL CHECK (length(attempt_token) = 36),
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  created_at_ms INTEGER NOT NULL
    CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
  acknowledged_at_ms INTEGER
    CHECK (acknowledged_at_ms IS NULL OR
      (typeof(acknowledged_at_ms) = 'integer' AND acknowledged_at_ms BETWEEN created_at_ms AND 9007199254740991)),
  delete_after_ms INTEGER
    CHECK (delete_after_ms IS NULL OR
      (typeof(delete_after_ms) = 'integer' AND delete_after_ms BETWEEN acknowledged_at_ms AND 9007199254740991)),
  CHECK ((acknowledged_at_ms IS NULL AND delete_after_ms IS NULL) OR
    (acknowledged_at_ms IS NOT NULL AND delete_after_ms IS NOT NULL)),
  UNIQUE (tenant_id, action_id, account_id, operation_id, source_version_ms)
);
CREATE INDEX idx_support_ops_account_result_receipts_cleanup
  ON support_ops_account_result_receipts (delete_after_ms, receipt_id)
  WHERE acknowledged_at_ms IS NOT NULL;
CREATE INDEX idx_support_ops_account_result_receipts_unacknowledged
  ON support_ops_account_result_receipts (tenant_id, created_at_ms, receipt_id)
  WHERE acknowledged_at_ms IS NULL;
