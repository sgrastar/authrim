-- Management-owned tenant creation saga state. Provider tokens and provider response bodies
-- must never be persisted in these tables.

CREATE TABLE IF NOT EXISTS tenant_provisioning_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_code TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_description TEXT,
  operation_kind TEXT NOT NULL DEFAULT 'create'
    CHECK (operation_kind IN ('create', 'clone')),
  source_tenant_id TEXT,
  preparation_payload_json TEXT,
  preparation_result_json TEXT,
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_retry', 'blocked', 'succeeded', 'canceled')),
  current_step TEXT NOT NULL DEFAULT 'request_accepted',
  capacity_operation_ids_json TEXT NOT NULL DEFAULT '{}',
  default_route_allocation_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_budget_started_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (environment_id, tenant_id),
  CHECK ((operation_kind = 'create' AND source_tenant_id IS NULL AND preparation_payload_json IS NULL) OR
         (operation_kind = 'clone' AND source_tenant_id IS NOT NULL AND preparation_payload_json IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'canceled') AND completed_at IS NOT NULL) OR
         status NOT IN ('succeeded', 'canceled'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_provisioning_operations_runnable
  ON tenant_provisioning_operations(status, next_attempt_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS tenant_provisioning_operation_steps (
  operation_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_retry', 'blocked', 'succeeded', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error_code TEXT,
  observed_resource_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, step_key),
  FOREIGN KEY (operation_id) REFERENCES tenant_provisioning_operations(operation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_provisioning_steps_status
  ON tenant_provisioning_operation_steps(status, next_attempt_at, updated_at);
