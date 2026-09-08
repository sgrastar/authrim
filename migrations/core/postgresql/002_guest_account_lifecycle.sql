-- Human guest lifecycle; device and agent identities are not enrolled here.
-- No account FK: the deletion fence must survive physical account removal for retries.
CREATE TABLE guest_account_lifecycle (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'active'
    CHECK (phase IN ('active', 'upgrading', 'registered', 'deleting', 'deleted')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  deletion_due_at BIGINT,
  policy_version TEXT NOT NULL,
  retention_application_id TEXT,
  upgrade_hold_until BIGINT,
  upgrade_operation_id TEXT,
  upgrade_admission_floor BIGINT NOT NULL DEFAULT 0,
  upgraded_at BIGINT,
  upgrade_finalized_at BIGINT,
  deletion_operation_id TEXT,
  deletion_route_json TEXT,
  deletion_started_at_ms BIGINT,
  deleted_at BIGINT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  CHECK (deletion_due_at IS NULL OR deletion_due_at >= created_at),
  CHECK (upgrade_hold_until IS NULL OR upgrade_hold_until >= created_at)
);
CREATE INDEX idx_guest_lifecycle_cleanup
  ON guest_account_lifecycle (tenant_id, phase, deletion_due_at, user_id);
CREATE INDEX idx_guest_lifecycle_created
  ON guest_account_lifecycle (tenant_id, created_at, user_id);
