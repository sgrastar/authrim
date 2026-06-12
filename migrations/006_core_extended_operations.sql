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
-- From 014: Field Usage Bindings
-- =============================================================================

CREATE TABLE IF NOT EXISTS field_usage_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  binding_type TEXT NOT NULL CHECK (
    binding_type IN (
      'authentication_method',
      'notification',
      'discovery',
      'consent',
      'policy',
      'protocol_output',
      'display',
      'ui',
      'custom'
    )
  ),
  binding_id TEXT NOT NULL,
  protection TEXT NOT NULL DEFAULT 'warn' CHECK (
    protection IN ('none', 'warn', 'delete_blocked')
  ),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'admin' CHECK (
    source IN ('system', 'admin', 'derived', 'migration')
  ),
  metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, field_key, binding_type, binding_id)
);

CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_tenant_field
  ON field_usage_bindings(tenant_id, field_key, is_active);
CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_binding
  ON field_usage_bindings(tenant_id, binding_type, binding_id, is_active);
CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_protection
  ON field_usage_bindings(tenant_id, protection, is_active);

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
      'identity_mapping_signal',
      'identity_mapping_manual_review',
      'identity_mapping_propagation_failure',
      'identity_mapping_bulk_impact',
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
