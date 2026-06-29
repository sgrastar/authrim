-- Directory Authentication M14-M16: migration, compliance evidence, and managed connector metadata.

CREATE TABLE IF NOT EXISTS directory_auth_migration_campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled', 'draft', 'active', 'paused', 'archived')),
  mode TEXT NOT NULL DEFAULT 'directory_login_allowed'
    CHECK (mode IN (
      'directory_login_allowed',
      'prompt_passkey',
      'grace_then_require_passkey',
      'require_passkey_after_directory',
      'disabled'
    )),
  passkey_prompt_mode TEXT NOT NULL DEFAULT 'campaign_only'
    CHECK (passkey_prompt_mode IN ('none', 'optional', 'campaign_only')),
  email_code_fallback_mode TEXT NOT NULL DEFAULT 'migration_recovery'
    CHECK (email_code_fallback_mode IN (
      'tenant_default',
      'migration_recovery',
      'directory_unavailable_recovery',
      'admin_invitation_only',
      'login_method',
      'disabled'
    )),
  grace_period_days INTEGER NOT NULL DEFAULT 30,
  transaction_ttl_seconds INTEGER NOT NULL DEFAULT 600,
  enforcement_start_mode TEXT NOT NULL DEFAULT 'first_directory_login'
    CHECK (enforcement_start_mode IN ('first_directory_login')),
  target_policy_json TEXT NOT NULL DEFAULT '{}',
  is_template INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_campaigns_status
  ON directory_auth_migration_campaigns (tenant_id, status, updated_at);

CREATE TABLE IF NOT EXISTS directory_auth_migration_user_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  user_id TEXT,
  connector_id TEXT,
  directory_subject TEXT,
  cohort_key TEXT,
  state TEXT NOT NULL DEFAULT 'eligible'
    CHECK (state IN (
      'not_applicable',
      'eligible',
      'prompted',
      'deferred',
      'passkey_required',
      'enrolled',
      'blocked',
      'recovered'
    )),
  first_directory_login_at INTEGER,
  prompted_at INTEGER,
  deferred_until INTEGER,
  passkey_required_at INTEGER,
  enrolled_at INTEGER,
  blocked_reason TEXT,
  recovery_reason TEXT,
  reset_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at INTEGER,
  last_reset_by TEXT,
  last_reset_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, campaign_id, user_id),
  UNIQUE (tenant_id, campaign_id, connector_id, directory_subject)
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_user_states_status
  ON directory_auth_migration_user_states (tenant_id, state, updated_at);

CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_user_states_user
  ON directory_auth_migration_user_states (tenant_id, user_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_user_states_cohort
  ON directory_auth_migration_user_states (tenant_id, campaign_id, cohort_key, updated_at);

CREATE TABLE IF NOT EXISTS directory_auth_migration_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT,
  user_id TEXT,
  connector_id TEXT,
  directory_subject TEXT,
  token_hash TEXT NOT NULL,
  scope TEXT NOT NULL
    CHECK (scope IN ('passkey_enrollment', 'email_code_fallback', 'recovery', 'status_display')),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'completed', 'expired', 'blocked')),
  request_id TEXT,
  authorization_challenge_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  blocked_reason TEXT,
  UNIQUE (tenant_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_transactions_state
  ON directory_auth_migration_transactions (tenant_id, state, expires_at);

CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_transactions_user
  ON directory_auth_migration_transactions (tenant_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS directory_auth_migration_transaction_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  campaign_id TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  event_payload_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_transaction_events_txn
  ON directory_auth_migration_transaction_events (tenant_id, transaction_id, created_at);

CREATE TABLE IF NOT EXISTS directory_auth_tenant_policies (
  tenant_id TEXT PRIMARY KEY,
  email_code_fallback_mode TEXT NOT NULL DEFAULT 'migration_recovery'
    CHECK (email_code_fallback_mode IN (
      'migration_recovery',
      'directory_unavailable_recovery',
      'admin_invitation_only',
      'login_method',
      'disabled'
    )),
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_auth_retention_policies (
  tenant_id TEXT PRIMARY KEY,
  authrim_audit_retention_days INTEGER NOT NULL DEFAULT 365,
  wordwarden_local_retention_days INTEGER,
  artifact_delete_grace_hours INTEGER NOT NULL DEFAULT 72,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_auth_evidence_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed', 'deleted', 'expired')),
  requested_by TEXT NOT NULL,
  period_start_at INTEGER NOT NULL,
  period_end_at INTEGER NOT NULL,
  size_estimate_bytes INTEGER,
  artifact_key TEXT,
  artifact_sha256 TEXT,
  object_catalog_id TEXT,
  manifest_signature_key_id TEXT,
  manifest_signature_alg TEXT,
  signed_url_expires_at INTEGER,
  retention_expires_at INTEGER NOT NULL,
  download_after_delete INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_evidence_exports_status
  ON directory_auth_evidence_exports (tenant_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_directory_auth_evidence_exports_retention
  ON directory_auth_evidence_exports (tenant_id, retention_expires_at);

CREATE INDEX IF NOT EXISTS idx_directory_auth_evidence_exports_object_catalog
  ON directory_auth_evidence_exports (object_catalog_id);

CREATE TABLE IF NOT EXISTS directory_auth_config_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_redacted_json TEXT NOT NULL DEFAULT '{}',
  after_redacted_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_config_history_tenant_time
  ON directory_auth_config_history (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS directory_auth_release_advisories (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'stable',
  severity TEXT NOT NULL
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  affected_versions_json TEXT NOT NULL DEFAULT '[]',
  fixed_version TEXT,
  summary TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  release_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_release_advisories_channel_time
  ON directory_auth_release_advisories (channel, updated_at);

CREATE TABLE IF NOT EXISTS directory_auth_support_bundles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  redaction_level TEXT NOT NULL DEFAULT 'standard'
    CHECK (redaction_level IN ('minimal', 'standard', 'detailed')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed', 'deleted', 'expired')),
  scope_json TEXT NOT NULL DEFAULT '{}',
  consent_summary_json TEXT NOT NULL DEFAULT '{}',
  artifact_key TEXT,
  artifact_sha256 TEXT,
  object_catalog_id TEXT,
  retention_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_directory_auth_support_bundles_status
  ON directory_auth_support_bundles (tenant_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_directory_auth_support_bundles_retention
  ON directory_auth_support_bundles (tenant_id, retention_expires_at);

CREATE INDEX IF NOT EXISTS idx_directory_auth_support_bundles_object_catalog
  ON directory_auth_support_bundles (object_catalog_id);
