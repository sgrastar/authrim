-- Durable reconciliation for guest deletion completion audits.
-- No account foreign key: the task must survive account deletion.
CREATE TABLE guest_deletion_audit_outbox (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 4096),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'succeeded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  UNIQUE (tenant_id, operation_id),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR
         (status <> 'succeeded' AND succeeded_at IS NULL))
);

CREATE INDEX idx_guest_deletion_audit_outbox_due
  ON guest_deletion_audit_outbox (tenant_id, status, next_attempt_at, created_at);
