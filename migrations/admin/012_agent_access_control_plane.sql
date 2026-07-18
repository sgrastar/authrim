-- =============================================================================
-- Authrim Admin Migration 012: Agent Access Control Plane
-- =============================================================================
-- Admin Agent grants are intentionally stored in DB_ADMIN. They must not reuse
-- the legacy core.ai_grants table because admin users, machine principals,
-- consent, refresh-family indexes, recovery state, and admin audit are owned by
-- the admin database.

CREATE TABLE IF NOT EXISTS admin_agent_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  machine_principal_id TEXT,
  grantor_id TEXT NOT NULL,
  delegator_id TEXT NOT NULL,
  permissions TEXT NOT NULL,
  task_sets TEXT,
  scope_policy_id TEXT,
  scope_policy_version INTEGER,
  scope_overrides TEXT,
  resolved_scope_constraints TEXT,
  access_snapshot_hash TEXT,
  scopes TEXT NOT NULL,
  authorization_details TEXT,
  delegation_mode TEXT NOT NULL DEFAULT 'user_consent'
    CHECK (delegation_mode IN ('user_consent', 'admin_pre_authorized', 'task_approved')),
  purpose TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  consent_version INTEGER NOT NULL DEFAULT 1 CHECK (consent_version > 0),
  approval_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  active_uniqueness_key TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  client_metadata_url TEXT,
  client_metadata_hash TEXT,
  client_metadata_fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  -- CAS marker used by DatabaseAdapter.batch() guarded follow-up statements.
  last_mutation_id TEXT,
  FOREIGN KEY (machine_principal_id) REFERENCES admin_machine_principals(id),
  FOREIGN KEY (grantor_id) REFERENCES admin_users(id),
  FOREIGN KEY (delegator_id) REFERENCES admin_users(id),
  CHECK (
    (status = 'active' AND active_uniqueness_key = 'active')
    OR (status IN ('suspended', 'revoked') AND active_uniqueness_key = id)
  )
);

CREATE INDEX IF NOT EXISTS idx_admin_agent_grants_delegator
  ON admin_agent_grants(tenant_id, delegator_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_agent_grants_client
  ON admin_agent_grants(tenant_id, client_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_agent_grants_principal
  ON admin_agent_grants(machine_principal_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_agent_grants_active_unique
  ON admin_agent_grants(tenant_id, delegator_id, client_id, active_uniqueness_key);

CREATE TABLE IF NOT EXISTS agent_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  consent_type TEXT NOT NULL CHECK (consent_type IN ('delegation', 'oauth_client')),
  grant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  scopes TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
    CHECK (revoked_reason IS NULL OR revoked_reason IN ('user', 'grant_updated', 'grant_revoked', 'admin')),
  last_mutation_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES admin_users(id),
  UNIQUE (grant_id, client_id, consent_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_consents_user
  ON agent_consents(tenant_id, user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_agent_consents_grant
  ON agent_consents(grant_id, consent_type, revoked_at);

CREATE TABLE IF NOT EXISTS agent_elevation_challenges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  client_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_schema_version TEXT NOT NULL,
  args_envelope TEXT,
  args_hash TEXT NOT NULL,
  confirm_summary_redacted TEXT NOT NULL,
  target_resource_refs TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'approved', 'executing', 'consumed', 'failed',
      'indeterminate', 'expired', 'denied'
    )),
  active_args_key TEXT NOT NULL,
  elevation_grant_id TEXT,
  approver_type TEXT,
  approver_id TEXT,
  execution_result_envelope TEXT,
  execution_result_digest TEXT,
  execution_lease_expires_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  execution_attempt INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0),
  execution_owner_id TEXT,
  execution_fence INTEGER NOT NULL DEFAULT 0 CHECK (execution_fence >= 0),
  reconciled_by TEXT,
  reconciled_outcome TEXT
    CHECK (reconciled_outcome IS NULL OR reconciled_outcome IN ('executed', 'not_executed', 'unresolved')),
  reconciliation_evidence_envelope TEXT,
  reconciliation_evidence_digest TEXT,
  reconciled_at INTEGER,
  successor_challenge_id TEXT,
  payload_key_version TEXT NOT NULL,
  payload_purge_at INTEGER NOT NULL,
  payload_purged_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  executing_at INTEGER,
  consumed_at INTEGER,
  terminal_at INTEGER,
  -- Links a terminal reconciliation CAS to its audit row in one atomic batch.
  terminal_transition_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id),
  FOREIGN KEY (user_id) REFERENCES admin_users(id),
  FOREIGN KEY (successor_challenge_id) REFERENCES agent_elevation_challenges(id),
  CHECK (expires_at > created_at),
  CHECK (
    (status IN ('pending', 'approved', 'executing') AND active_args_key = 'active')
    OR (status IN ('consumed', 'failed', 'indeterminate', 'expired', 'denied') AND active_args_key = id)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_elevation_recovery
  ON agent_elevation_challenges(status, execution_lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_elevation_grant
  ON agent_elevation_challenges(tenant_id, grant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_elevation_args_active
  ON agent_elevation_challenges(
    tenant_id,
    grant_id,
    actor_sub,
    tool_name,
    args_hash,
    active_args_key
  );

-- Target-side durable execution ledger for Agent-triggered Management mutations.
-- This is intentionally separate from the generic core.idempotency_keys cache:
-- recovery must distinguish an unexpired in-progress lease from a terminal result,
-- and absence must never be interpreted as proof that a side effect did not run.
CREATE TABLE IF NOT EXISTS agent_management_executions (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
  execution_fence INTEGER NOT NULL CHECK (execution_fence > 0),
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'succeeded', 'failed')),
  lease_expires_at INTEGER NOT NULL,
  result_envelope TEXT,
  result_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Identifies the outbox snapshot which owns this family's revocation.
  revocation_outbox_id TEXT,
  PRIMARY KEY (tenant_id, idempotency_key, execution_attempt, execution_fence),
  CHECK (
    (status = 'in_progress' AND result_digest IS NULL)
    OR status IN ('succeeded', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_management_execution_lease
  ON agent_management_executions(status, lease_expires_at);

-- One-time replay fence for JIT Mode B delegation JWTs. The JWT remains short lived and this
-- table records consumption rather than storing the bearer value.
CREATE TABLE IF NOT EXISTS admin_agent_delegation_jtis (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  machine_principal_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id)
);
CREATE INDEX IF NOT EXISTS idx_admin_agent_delegation_jti_expiry
  ON admin_agent_delegation_jtis(expires_at);

CREATE TABLE IF NOT EXISTS admin_agent_token_families (
  family_id TEXT PRIMARY KEY,
  family_jti TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_generation INTEGER NOT NULL CHECK (grant_generation > 0),
  admin_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  status TEXT NOT NULL DEFAULT 'pending_finalization'
    CHECK (status IN (
      'pending_finalization', 'active', 'revocation_pending', 'revoked', 'expired'
    )),
  finalization_nonce TEXT NOT NULL,
  finalized_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id),
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_admin_agent_token_families_grant
  ON admin_agent_token_families(tenant_id, grant_id, grant_generation, status);
CREATE INDEX IF NOT EXISTS idx_admin_agent_token_families_client
  ON admin_agent_token_families(tenant_id, client_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_agent_token_families_finalization
  ON admin_agent_token_families(status, created_at);

CREATE TABLE IF NOT EXISTS admin_agent_token_revocation_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_id TEXT,
  grant_generation INTEGER,
  client_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('revoke_grant_families', 'revoke_client_families')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_fence INTEGER NOT NULL DEFAULT 0 CHECK (processing_fence >= 0),
  next_attempt_at INTEGER NOT NULL,
  processing_owner_id TEXT,
  processing_lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  -- CAS markers make completion/failure and their dependent writes batch-atomic on D1.
  completion_transition_id TEXT,
  failure_transition_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_agent_token_revocation_pending
  ON admin_agent_token_revocation_outbox(status, next_attempt_at, processing_lease_expires_at);

ALTER TABLE admin_audit_log ADD COLUMN actor_type TEXT;
ALTER TABLE admin_audit_log ADD COLUMN actor_sub TEXT;
ALTER TABLE admin_audit_log ADD COLUMN actor_mode TEXT;
ALTER TABLE admin_audit_log ADD COLUMN actor_assurance TEXT;
ALTER TABLE admin_audit_log ADD COLUMN token_binding TEXT;
ALTER TABLE admin_audit_log ADD COLUMN act_client_id TEXT;
ALTER TABLE admin_audit_log ADD COLUMN act_principal_id TEXT;
ALTER TABLE admin_audit_log ADD COLUMN grant_id TEXT;
ALTER TABLE admin_audit_log ADD COLUMN elevation_id TEXT;
ALTER TABLE admin_audit_log ADD COLUMN mcp_tool TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_audit_grant
  ON admin_audit_log(grant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor_type
  ON admin_audit_log(tenant_id, actor_type, created_at DESC);

-- Legacy AI Grant permissions are intentionally not aliases for Agent Access.
-- Remove them from persisted role definitions so deleted permissions cannot remain visible.
UPDATE admin_roles
SET permissions_json = COALESCE((
  SELECT json_group_array(value)
  FROM json_each(admin_roles.permissions_json)
  WHERE value NOT LIKE 'admin:ai_grants:%'
), '[]'),
updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE EXISTS (
  SELECT 1 FROM json_each(admin_roles.permissions_json)
  WHERE value LIKE 'admin:ai_grants:%'
);
