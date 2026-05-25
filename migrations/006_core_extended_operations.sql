-- =============================================================================
-- Authrim Core Baseline: Extended Operations
-- Consolidated baseline for fresh Authrim core database installs.
-- =============================================================================

CREATE TABLE custom_claim_schemas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  active_field_key TEXT,
  display_label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'string',
  is_pii INTEGER NOT NULL DEFAULT 0,
  is_required INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  validation_rules TEXT CHECK(validation_rules IS NULL OR json_valid(validation_rules)),
  include_in_id_token INTEGER NOT NULL DEFAULT 0,
  include_in_userinfo INTEGER NOT NULL DEFAULT 0,
  include_in_introspection INTEGER NOT NULL DEFAULT 0,
  required_scopes TEXT CHECK(required_scopes IS NULL OR json_valid(required_scopes)),
  scope_mode TEXT NOT NULL DEFAULT 'any' CHECK(scope_mode IN ('all', 'any')),
  is_searchable INTEGER NOT NULL DEFAULT 1,
  is_exportable INTEGER NOT NULL DEFAULT 1,
  is_vc_claim INTEGER NOT NULL DEFAULT 0,
  claim_namespace TEXT,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  operation_status TEXT NOT NULL DEFAULT 'active',
  operation_detail TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  show_on_registration    INTEGER NOT NULL DEFAULT 0,
  registration_required   INTEGER NOT NULL DEFAULT 0,
  registration_order      INTEGER NOT NULL DEFAULT 0,
  registration_placeholder TEXT
);

CREATE UNIQUE INDEX uniq_ccs_active_key
  ON custom_claim_schemas(tenant_id, active_field_key);
CREATE INDEX idx_ccs_tenant_active ON custom_claim_schemas(tenant_id, is_active, display_order);
CREATE INDEX idx_ccs_tenant_key ON custom_claim_schemas(tenant_id, field_key);
CREATE INDEX idx_ccs_operation ON custom_claim_schemas(operation_status);

-- =============================================================================
-- From 054: Custom Claim Schema History
-- =============================================================================

CREATE TABLE custom_claim_schema_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  schema_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete','rename','toggle_active')),
  snapshot TEXT NOT NULL,
  changes TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT CHECK(actor_type IN ('user','admin','system','api')),
  change_source TEXT CHECK(change_source IN ('admin_api','admin_ui','migration','rollback')),
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, schema_id, version)
);

CREATE INDEX idx_ccsh_schema ON custom_claim_schema_history(tenant_id, schema_id, version DESC);
CREATE INDEX idx_ccsh_cleanup ON custom_claim_schema_history(tenant_id, created_at);

-- =============================================================================
-- From 059: Tenant Invitations
-- =============================================================================

CREATE TABLE tenant_invitations (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,         -- 256-bit entropy token
  tenant_id      TEXT NOT NULL,
  invited_email  TEXT,                         -- NULL=anyone, NON-NULL=specific email only
  invited_by     TEXT NOT NULL,                -- Admin user ID who created the invitation
  role_id        TEXT,                         -- Optional: auto-assign this role on signup
  org_id         TEXT,                         -- Optional: auto-assign to this org on signup
  max_uses       INTEGER NOT NULL DEFAULT 1,   -- -1=unlimited
  use_count      INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_ti_token ON tenant_invitations(token, expires_at);
CREATE INDEX idx_ti_tenant ON tenant_invitations(tenant_id, created_at DESC);

-- =============================================================================
-- From 075: Privacy-Preserving Support Operations
-- =============================================================================

CREATE TABLE support_operation_cohorts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  intended_action TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  selector_hash TEXT NOT NULL,
  matched_count INTEGER NOT NULL,
  actionable_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  blocked_summary_json TEXT,
  snapshot_status TEXT NOT NULL DEFAULT 'completed' CHECK (
    snapshot_status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  snapshot_job_id TEXT,
  snapshot_error TEXT,
  risk_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  support_case_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE support_operation_cohort_targets (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_hash TEXT,
  block_reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE CASCADE,
  UNIQUE(cohort_id, target_id)
);

CREATE TABLE support_operation_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  cohort_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('approval_required', 'approved', 'running', 'completed', 'failed', 'cancelled')
  ),
  reason TEXT NOT NULL,
  support_case_id TEXT,
  approval_request_id TEXT,
  job_id TEXT,
  result_summary_json TEXT,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE CASCADE
);

CREATE TABLE support_operation_break_glass_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  cohort_id TEXT,
  action_id TEXT,
  target_id TEXT,
  target_hash TEXT,
  requested_detail_classes_json TEXT NOT NULL DEFAULT '[]',
  redaction_level TEXT NOT NULL DEFAULT 'masked' CHECK (
    redaction_level IN ('summary_only', 'masked', 'raw')
  ),
  reason TEXT NOT NULL,
  support_case_id TEXT,
  approval_request_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('approval_required', 'approved', 'revealed', 'expired', 'denied', 'cancelled')
  ),
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  revealed_by TEXT,
  revealed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE SET NULL,
  FOREIGN KEY (action_id) REFERENCES support_operation_actions(id) ON DELETE SET NULL
);

CREATE TABLE support_operation_break_glass_reveals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  break_glass_request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  detail_classes_json TEXT NOT NULL DEFAULT '[]',
  result_summary_json TEXT,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (break_glass_request_id)
    REFERENCES support_operation_break_glass_requests(id) ON DELETE CASCADE
);

CREATE INDEX idx_soc_tenant_created
  ON support_operation_cohorts(tenant_id, created_at DESC);
CREATE INDEX idx_soc_tenant_expires
  ON support_operation_cohorts(tenant_id, expires_at);
CREATE INDEX idx_soc_selector_hash
  ON support_operation_cohorts(tenant_id, resource, selector_hash);
CREATE INDEX idx_soc_snapshot_status
  ON support_operation_cohorts(tenant_id, snapshot_status, created_at DESC);

CREATE INDEX idx_soct_cohort
  ON support_operation_cohort_targets(tenant_id, cohort_id);
CREATE INDEX idx_soct_cohort_block
  ON support_operation_cohort_targets(tenant_id, cohort_id, block_reason);

CREATE INDEX idx_soa_tenant_created
  ON support_operation_actions(tenant_id, created_at DESC);
CREATE INDEX idx_soa_tenant_status
  ON support_operation_actions(tenant_id, status, updated_at DESC);
CREATE INDEX idx_soa_cohort
  ON support_operation_actions(tenant_id, cohort_id);
CREATE INDEX idx_soa_approval_request
  ON support_operation_actions(tenant_id, approval_request_id);

CREATE INDEX idx_sobgr_tenant_status
  ON support_operation_break_glass_requests(tenant_id, status, created_at DESC);
CREATE INDEX idx_sobgr_approval_request
  ON support_operation_break_glass_requests(tenant_id, approval_request_id);
CREATE INDEX idx_sobgr_cohort
  ON support_operation_break_glass_requests(tenant_id, cohort_id);
CREATE INDEX idx_sobgr_action
  ON support_operation_break_glass_requests(tenant_id, action_id);
CREATE INDEX idx_sobgr_reveals_request
  ON support_operation_break_glass_reveals(tenant_id, break_glass_request_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS internal_notification_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'storage_registry_security',
      'storage_registry_health',
      'tenant_database_stats',
      'tenant_database_health',
      'logging_destination_health',
      'logging_delivery_failure',
      'logging_fallback_used',
      'logging_dlq_backlog',
      'logging_quota_warning',
      'logging_repair_job_status',
      'notification_delivery_failure'
    )
  ),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'delivered', 'failed', 'dead_letter', 'suppressed')
  ),
  deduplication_key TEXT,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_notification_events_dedup
  ON internal_notification_events(deduplication_key);

CREATE INDEX IF NOT EXISTS idx_internal_notification_events_pending
  ON internal_notification_events(status, severity, created_at);

CREATE INDEX IF NOT EXISTS idx_internal_notification_events_tenant_created
  ON internal_notification_events(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS internal_notification_delivery_routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'platform' CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL DEFAULT 'global',
  provider TEXT NOT NULL CHECK (provider IN ('webhook', 'email', 'slack', 'custom')),
  destination_id TEXT,
  categories_json TEXT,
  severities_json TEXT,
  min_severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (min_severity IN ('critical', 'high', 'medium', 'low', 'info')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  failure_policy TEXT NOT NULL DEFAULT 'retry_until_dead_letter'
    CHECK (failure_policy IN ('best_effort', 'retry_until_dead_letter', 'fail_closed')),
  max_attempts INTEGER NOT NULL DEFAULT 5,
  retry_after_seconds INTEGER NOT NULL DEFAULT 300,
  suppression_key TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_internal_notification_delivery_routes_lookup
  ON internal_notification_delivery_routes(scope_type, scope_id, enabled, provider);

CREATE TABLE IF NOT EXISTS internal_notification_delivery_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  route_id TEXT,
  provider TEXT NOT NULL,
  destination_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed', 'dead_letter', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error_class TEXT,
  error_message TEXT,
  next_attempt_at INTEGER,
  payload_sha256 TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_internal_notification_delivery_attempts_event
  ON internal_notification_delivery_attempts(event_id, provider, status);

CREATE INDEX IF NOT EXISTS idx_internal_notification_delivery_attempts_retry
  ON internal_notification_delivery_attempts(status, next_attempt_at, updated_at);

CREATE TABLE IF NOT EXISTS logging_usage_aggregates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('hour', 'day')),
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  source_table TEXT NOT NULL,
  metadata_json TEXT,
  refreshed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logging_usage_aggregates_window
  ON logging_usage_aggregates(window_kind, window_start_at, metric_name);

CREATE TABLE IF NOT EXISTS logging_quota_policies (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL DEFAULT 'day' CHECK (window_kind IN ('hour', 'day')),
  soft_limit INTEGER,
  hard_limit INTEGER,
  warning_ratio REAL NOT NULL DEFAULT 0.8,
  enforcement_mode TEXT NOT NULL DEFAULT 'warn_only'
    CHECK (enforcement_mode IN ('disabled', 'observe', 'warn_only', 'soft_limit', 'hard_non_critical')),
  critical_behavior TEXT NOT NULL DEFAULT 'never_block' CHECK (critical_behavior IN ('never_block')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind);

CREATE TABLE IF NOT EXISTS logging_quota_evaluations (
  id TEXT PRIMARY KEY,
  quota_policy_id TEXT NOT NULL,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT,
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  value INTEGER NOT NULL,
  soft_limit INTEGER,
  hard_limit INTEGER,
  state TEXT NOT NULL CHECK (state IN ('ok', 'warning', 'soft_exceeded', 'hard_exceeded')),
  enforcement_action TEXT NOT NULL CHECK (
    enforcement_action IN ('none', 'notify', 'throttle_non_critical', 'block_non_critical')
  ),
  evaluated_at INTEGER NOT NULL,
  notification_event_id TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_database_probe_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  generation INTEGER,
  probe_kind TEXT NOT NULL CHECK (probe_kind IN ('dry_run', 'write_read_delete')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  latency_ms INTEGER,
  binding_ref TEXT,
  connection_ref TEXT,
  provider TEXT,
  schema_version INTEGER,
  error_class TEXT,
  error_message TEXT,
  metadata_json TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC);

CREATE TABLE IF NOT EXISTS logging_catalog_repair_jobs (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('scan', 'apply_safe', 'dangerous_preview', 'dangerous_apply')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled')
  ),
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  requested_action TEXT,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  preview_artifact_ref TEXT,
  result_json TEXT,
  error_class TEXT,
  last_error TEXT,
  requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancel_requested_at INTEGER,
  cancel_requested_by TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_catalog_repair_jobs_queue
  ON logging_catalog_repair_jobs(status, created_at);

-- -----------------------------------------------------------------------------
-- Seed default OIDC claim schemas
-- -----------------------------------------------------------------------------

-- Inserts standard OIDC claims as system schemas (is_system=1) for every tenant.
--
-- Uses WHERE NOT EXISTS to ensure idempotency without relying on partial unique indexes.
-- All claims default to include_in_id_token=0 (OIDC compliant: claims via UserInfo,
-- controlled by scope). System claims cannot be deleted or renamed via the admin API.
--
-- display_order ranges:
--   1-13  : profile scope claims (name, given_name, ...)
--   20-21 : email scope claims
--   30-31 : phone scope claims
--   40-45 : address scope claims (stored as individual fields, not JSON)
--
-- Custom claims created by admins default to display_order=100+.

-- ──────────────────────────────────────────────
-- Profile scope claims
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_name',
  t.id,
  'name',
  'name', 'Full Name', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 1, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_given_name',
  t.id,
  'given_name',
  'given_name', 'First Name', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 2, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'given_name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_family_name',
  t.id,
  'family_name',
  'family_name', 'Last Name', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 3, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'family_name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_middle_name',
  t.id,
  'middle_name',
  'middle_name', 'Middle Name', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 4, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'middle_name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_nickname',
  t.id,
  'nickname',
  'nickname', 'Nickname', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 5, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'nickname'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_preferred_username',
  t.id,
  'preferred_username',
  'preferred_username', 'Preferred Username', 'string',
  0, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 6, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'preferred_username'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_profile',
  t.id,
  'profile',
  'profile', 'Profile URL', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 7, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'profile'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_picture',
  t.id,
  'picture',
  'picture', 'Picture URL', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 8, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'picture'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_website',
  t.id,
  'website',
  'website', 'Website', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 9, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'website'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_birthdate',
  t.id,
  'birthdate',
  'birthdate', 'Birthdate', 'date',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 10, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'birthdate'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_zoneinfo',
  t.id,
  'zoneinfo',
  'zoneinfo', 'Time Zone', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 11, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'zoneinfo'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_locale',
  t.id,
  'locale',
  'locale', 'Locale', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 12, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'locale'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_updated_at',
  t.id,
  'updated_at',
  'updated_at', 'Last Updated', 'number',
  0, 0, 1, 1,
  0, 0, 0,
  0, 1, 0,
  'any', 13, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'updated_at'
);

-- ──────────────────────────────────────────────
-- Email scope claims
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_email',
  t.id,
  'email',
  'email', 'Email', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 20, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'email'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_email_verified',
  t.id,
  'email_verified',
  'email_verified', 'Email Verified', 'boolean',
  0, 0, 1, 1,
  0, 0, 0,
  0, 1, 0,
  'any', 21, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'email_verified'
);

-- ──────────────────────────────────────────────
-- Phone scope claims
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_phone_number',
  t.id,
  'phone_number',
  'phone_number', 'Phone Number', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 30, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'phone_number'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_phone_number_verified',
  t.id,
  'phone_number_verified',
  'phone_number_verified', 'Phone Number Verified', 'boolean',
  0, 0, 1, 1,
  0, 0, 0,
  0, 1, 0,
  'any', 31, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'phone_number_verified'
);

-- ──────────────────────────────────────────────
-- Address scope claims (individual fields, not JSON)
--
-- address_country is non-PII (is_pii=0) to support future country-based
-- regulatory separation and DB partitioning without cross-DB joins.
-- Other address sub-fields are PII (is_pii=1).
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_formatted',
  t.id,
  'address_formatted',
  'address_formatted', 'Address (Formatted)', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 40, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_formatted'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_street_address',
  t.id,
  'address_street_address',
  'address_street_address', 'Street Address', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 41, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_street_address'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_locality',
  t.id,
  'address_locality',
  'address_locality', 'City / Locality', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 42, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_locality'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_region',
  t.id,
  'address_region',
  'address_region', 'State / Region', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 43, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_region'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_postal_code',
  t.id,
  'address_postal_code',
  'address_postal_code', 'Postal Code', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 44, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_postal_code'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_country',
  t.id,
  'address_country',
  'address_country', 'Country', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 45, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_country'
);
