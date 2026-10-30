-- Authrim 0.5.0 semantic fresh-install baseline.
-- Logical stream: admin-d1.
-- Generated from the final database state; do not append historical migration SQL here.
-- Fresh-install baselines must never be applied to upgrade an existing database.
PRAGMA foreign_keys = OFF;

CREATE TABLE tenant_database_registry (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL DEFAULT 1,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL CHECK (
    provider IN ('d1', 'hyperdrive', 'postgres', 'mysql', 'custom')
  ),
  database_id TEXT,
  database_name TEXT,
  binding_ref TEXT,
  connection_ref TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (
    status IN (
      'requested',
      'provisioning',
      'ready',
      'active',
      'degraded',
      'degraded_pending_snapshot',
      'restored_pending',
      'failed',
      'disabled',
      'retired',
      'deleting',
      'deleted'
    )
  ),
  shard_count INTEGER NOT NULL DEFAULT 1,
  shard_key_strategy TEXT NOT NULL DEFAULT 'none',
  worker_shard TEXT,
  deployment_target TEXT,
  region_hint TEXT,
  jurisdiction TEXT,
  signature TEXT,
  signature_key_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT,
  PRIMARY KEY (tenant_id, role, generation, shard_group, shard_index)
);
CREATE TABLE tenant_database_active_pointers (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  shard_group TEXT NOT NULL DEFAULT 'default',
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL DEFAULT 1,
  shard_key_strategy TEXT NOT NULL DEFAULT 'none',
  runtime_generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'degraded_pending_snapshot', 'disabled')
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, role, shard_group)
);
CREATE TABLE tenant_database_stats (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  account_count INTEGER,
  active_user_count INTEGER,
  active_pending_user_count INTEGER,
  d1_file_size_bytes INTEGER,
  d1_file_size_checked_at TEXT,
  d1_file_size_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    d1_file_size_status IN ('fresh', 'stale', 'unknown', 'unavailable')
  ),
  table_size_estimate_json TEXT,
  row_count_estimate_json TEXT,
  warning_state TEXT NOT NULL DEFAULT 'ok' CHECK (
    warning_state IN ('ok', 'warning', 'strong_warning')
  ),
  warning_reasons_json TEXT,
  stats_checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, role, generation, shard_group, shard_index)
);
CREATE TABLE tenant_discovery_indexes (
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (
    index_kind IN (
      'email_domain',
      'email_exact',
      'external_subject',
      'global_subject'
    )
  ),
  index_value TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1,
  key_version INTEGER NOT NULL DEFAULT 1,
  source_updated_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'stale', 'rotating', 'disabled', 'deleted')
  ),
  metadata_json TEXT, mapping_snapshot_id TEXT, source_projection_version TEXT,
  PRIMARY KEY (
    index_kind,
    index_value,
    tenant_id,
    subject_id,
    index_version,
    key_version
  )
);
CREATE TABLE tenant_runtime_cache_generations (
  tenant_id TEXT NOT NULL,
  cache_namespace TEXT NOT NULL CHECK (
    cache_namespace IN (
      'settings',
      'policy',
      'runtime_registry',
      'identity_core',
      'identity_pii',
      'clients',
      'consent',
      'rebac',
      'flow_runtime'
    )
  ),
  generation INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, cache_namespace)
);
CREATE TABLE admin_destination_capabilities (
  destination_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider_default', 'platform_override')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (destination_id, capability)
);
CREATE TABLE log_chunk_record_index (
  record_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  line_number INTEGER,
  block_offset INTEGER,
  block_length INTEGER,
  record_offset INTEGER,
  record_length INTEGER,
  event_at INTEGER NOT NULL,
  index_profile TEXT NOT NULL,
  indexed_fields TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_key, log_type, plane, record_id)
);
CREATE TABLE logging_delivery_event_aggregates (
  bucket_start_at INTEGER NOT NULL,
  bucket_end_at INTEGER NOT NULL,
  bucket_shard TEXT NOT NULL DEFAULT 's0',
  tenant_key TEXT NOT NULL,
  destination_id TEXT NOT NULL DEFAULT '',
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'retrying', 'failed', 'dlq')),
  batch_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  attempt_count_sum INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    bucket_start_at, bucket_shard, tenant_key, destination_id, log_type, plane, lane, status
  )
);
CREATE TABLE logging_key_versions (
  key_registry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  backend_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'retired', 'rewrap_required', 'compromised')
  ),
  usage_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY (key_registry_id, version)
);
CREATE TABLE logging_message_idempotency_keys (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  message_job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('retry_delivery', 'export_build')),
  target_payload_hash TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  criticality TEXT NOT NULL CHECK (criticality IN ('standard', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  dedupe_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key)
);
CREATE TABLE agent_management_executions (
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
CREATE TABLE agent_configuration_templates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  source_tenant_id TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('task_set', 'scope_policy')),
  source_object_id TEXT NOT NULL,
  source_object_version INTEGER NOT NULL CHECK (source_object_version >= 1),
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY(id, version)
);
CREATE TABLE agent_baselines (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  control_tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('one_time', 'managed')),
  enforcement TEXT NOT NULL CHECK (enforcement IN ('report_only', 'standard_auto_remediation')),
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(id, version)
);
CREATE TABLE provider_reprojection_tenant_state (
  plugin_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  desired_revision TEXT NOT NULL,
  applied_revision TEXT,
  source_scope TEXT NOT NULL CHECK (source_scope IN ('inherited', 'override')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'skipped', 'failed')),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, tenant_id)
);
CREATE TABLE identifier_replacement_scheduler_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  after_shard_id TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO identifier_replacement_scheduler_state VALUES(1,NULL,NULL,NULL,0,NULL,NULL,NULL,0);
CREATE TABLE tenant_runtime_registry_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (
    snapshot_scope IN ('tenant', 'deployment_target')
  ),
  deployment_target TEXT NOT NULL DEFAULT 'default',
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 1),
  backend_provider TEXT NOT NULL CHECK (backend_provider = 'd1'),
  placement_policy TEXT NOT NULL CHECK (
    placement_policy IN ('shared_pool', 'tenant_exclusive')
  ),
  placement_policy_generation INTEGER NOT NULL CHECK (placement_policy_generation >= 1),
  snapshot_version INTEGER NOT NULL DEFAULT 3 CHECK (snapshot_version >= 3),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'superseded', 'expired', 'invalid')
  ),
  object_ref TEXT,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  signature TEXT,
  signature_key_id TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, snapshot_scope, deployment_target, runtime_generation)
);
CREATE TABLE admin_agent_delegation_jtis (
  jti TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  machine_principal_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id)
);
CREATE TABLE admin_agent_grants (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
  last_mutation_id TEXT, task_set_id TEXT, task_set_version INTEGER, resolved_tools TEXT, management_mode TEXT NOT NULL DEFAULT 'managed'
  CHECK (management_mode IN ('managed', 'system_managed')),
  FOREIGN KEY (machine_principal_id) REFERENCES admin_machine_principals(id),
  FOREIGN KEY (grantor_id) REFERENCES admin_users(id),
  FOREIGN KEY (delegator_id) REFERENCES admin_users(id),
  CHECK (
    (status = 'active' AND active_uniqueness_key = 'active')
    OR (status IN ('suspended', 'revoked') AND active_uniqueness_key = id)
  )
);
CREATE TABLE admin_agent_login_handoffs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  target_tenant_id TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  authorization_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'issued', 'consumed')),
  browser_binding_hash TEXT NOT NULL,
  source_session_id TEXT,
  source_session_hash TEXT,
  admin_user_id TEXT,
  code_hash TEXT UNIQUE,
  last_transition_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  issued_at INTEGER,
  consumed_at INTEGER,
  CHECK (target_origin LIKE 'https://%'),
  CHECK (authorization_path LIKE '/oauth/admin-agent/authorize%'),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending' AND source_session_id IS NULL AND code_hash IS NULL) OR
    (status = 'issued' AND source_session_id IS NOT NULL AND code_hash IS NOT NULL
      AND issued_at IS NOT NULL) OR
    (status = 'consumed' AND source_session_id IS NULL AND code_hash IS NOT NULL
      AND issued_at IS NOT NULL AND consumed_at IS NOT NULL)
  )
);
CREATE TABLE admin_agent_mcp_sessions (
  session_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (absolute_expires_at >= expires_at)
);
CREATE TABLE admin_agent_token_families (
  family_id TEXT PRIMARY KEY
 NOT NULL
,
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
  updated_at INTEGER NOT NULL, revocation_outbox_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id),
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),
  CHECK (expires_at > created_at)
);
CREATE TABLE admin_agent_token_revocation_outbox (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE admin_attribute_values (
  -- Value assignment ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- References
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  admin_attribute_id TEXT NOT NULL REFERENCES admin_attributes(id) ON DELETE CASCADE,

  -- The actual value (stored as text, parsed according to attribute_type)
  value TEXT NOT NULL,

  -- For multi-valued attributes, this is the index (0, 1, 2, ...)
  value_index INTEGER DEFAULT 0,

  -- Source of this value (manual, idp_sync, api, etc.)
  source TEXT DEFAULT 'manual',

  -- Expiration (for temporary attribute assignments)
  expires_at INTEGER,

  -- Audit fields
  assigned_by TEXT,  -- Admin user ID who assigned this value
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for single-valued attributes
  -- For multi-valued, use UNIQUE(admin_user_id, admin_attribute_id, value_index)
  UNIQUE(admin_user_id, admin_attribute_id, value_index)
);
CREATE TABLE admin_attributes (
  -- Attribute ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Attribute identification
  name TEXT NOT NULL,  -- Machine-readable name (e.g., 'department')
  display_name TEXT,   -- Human-readable name (e.g., 'Department')
  description TEXT,

  -- Attribute type (determines value validation)
  -- string: Free-form text
  -- enum: Must be one of allowed_values
  -- number: Numeric value (with optional min/max)
  -- boolean: true/false
  -- date: ISO 8601 date
  -- array: Multiple values allowed
  attribute_type TEXT NOT NULL DEFAULT 'string',

  -- For enum type: JSON array of allowed values
  -- e.g., ["engineering", "sales", "support"]
  allowed_values_json TEXT,

  -- Validation constraints
  min_value INTEGER,  -- For number type
  max_value INTEGER,  -- For number type
  regex_pattern TEXT, -- For string type

  -- Whether this attribute is required for all Admin users
  is_required INTEGER DEFAULT 0,

  -- Whether this attribute can have multiple values
  is_multi_valued INTEGER DEFAULT 0,

  -- System attribute flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for attribute name per tenant
  UNIQUE(tenant_id, name)
);
INSERT INTO admin_attributes VALUES('attr_department','default','department','Department','The department this admin belongs to','enum','["engineering", "security", "operations", "support", "management"]',NULL,NULL,NULL,0,0,1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
INSERT INTO admin_attributes VALUES('attr_clearance_level','default','clearance_level','Clearance Level','Security clearance level (1-5, higher = more access)','number',NULL,1,5,NULL,0,0,1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
INSERT INTO admin_attributes VALUES('attr_location','default','location','Location','Physical or regional location of the admin','string',NULL,NULL,NULL,NULL,0,0,1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
CREATE TABLE admin_audit_coverage_status (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  required_audit TEXT NOT NULL,
  criticality TEXT NOT NULL CHECK (criticality IN ('normal', 'critical')),
  status TEXT NOT NULL CHECK (
    status IN ('covered', 'gap_detected', 'acknowledged', 'ignored')
  ),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE admin_audit_log (
  -- Audit entry ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Who performed the action
  admin_user_id TEXT,  -- May be null for system actions or failed auth
  admin_email TEXT,  -- Denormalized for easier querying

  -- What action was performed
  action TEXT NOT NULL,  -- e.g., 'admin.login', 'user.create', 'client.update'

  -- Target resource
  resource_type TEXT,  -- e.g., 'admin_user', 'client', 'role', 'settings'
  resource_id TEXT,  -- ID of the affected resource

  -- Result
  result TEXT NOT NULL,  -- 'success' | 'failure' | 'error'
  error_code TEXT,  -- Error code if result is 'failure' or 'error'
  error_message TEXT,  -- Error details

  -- Severity level
  severity TEXT NOT NULL DEFAULT 'info',  -- debug | info | warn | error | critical

  -- Request context
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,  -- Correlation ID for request tracing
  session_id TEXT,  -- Admin session ID

  -- State changes
  before_json TEXT,  -- JSON snapshot before change (null for create/read)
  after_json TEXT,  -- JSON snapshot after change (null for delete/read)

  -- Additional metadata
  metadata_json TEXT,  -- Additional context (e.g., affected fields, reason)

  -- Timestamp
  created_at INTEGER NOT NULL
, detail_object_catalog_id TEXT, actor_type TEXT, actor_sub TEXT, actor_mode TEXT, actor_assurance TEXT, token_binding TEXT, act_client_id TEXT, act_principal_id TEXT, grant_id TEXT, elevation_id TEXT, mcp_tool TEXT);
CREATE TABLE admin_database_connection_usages (
  id TEXT PRIMARY KEY
 NOT NULL
,
  connection_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tenant_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (connection_id, purpose, resource_type, resource_id)
);
CREATE TABLE admin_database_connections (
  id TEXT PRIMARY KEY
 NOT NULL
,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('d1', 'hyperdrive', 'postgres', 'mysql', 'custom')),
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_encrypted TEXT,
  credential_key_version INTEGER,
  credential_updated_at INTEGER,
  credential_updated_by TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);
CREATE TABLE admin_destination_health_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  destination_id TEXT NOT NULL,
  check_type TEXT NOT NULL CHECK (check_type IN ('quick', 'deep', 'adaptive')),
  previous_health_status TEXT,
  next_health_status TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'partial')),
  error_class TEXT,
  latency_ms INTEGER,
  checked_at INTEGER NOT NULL,
  metadata TEXT
);
CREATE TABLE admin_destinations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant', 'shared')),
  scope_id TEXT NOT NULL,
  destination_kind TEXT NOT NULL CHECK (
    destination_kind IN ('object_storage', 'http_sink', 'external_collector', 'database', 'custom')
  ),
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'disabled', 'deleted')),
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'failing', 'unreachable')),
  rotation_status TEXT NOT NULL DEFAULT 'none'
    CHECK (rotation_status IN ('none', 'testing', 'ready', 'active', 'retiring', 'failed')),
  provider_config TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT,
  credential_version INTEGER NOT NULL DEFAULT 0,
  next_credential_ref TEXT,
  next_credential_version INTEGER,
  previous_credential_ref TEXT,
  previous_credential_retire_after INTEGER,
  allowed_tenant_ids TEXT,
  allowed_log_types TEXT,
  allowed_planes TEXT,
  region TEXT,
  critical_allowed INTEGER NOT NULL DEFAULT 0 CHECK (critical_allowed IN (0, 1)),
  default_fallback_eligible INTEGER NOT NULL DEFAULT 0 CHECK (default_fallback_eligible IN (0, 1)),
  retention_days INTEGER,
  encryption_mode TEXT NOT NULL DEFAULT 'platform_managed'
    CHECK (encryption_mode IN ('platform_managed', 'external_managed', 'none')),
  last_health_check_at INTEGER,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE admin_external_token_refresh_runs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_tenant_id TEXT,
  actor_type TEXT,
  actor_id TEXT,
  config_json TEXT NOT NULL,
  selected_tenants_count INTEGER NOT NULL DEFAULT 0,
  processed_tenants INTEGER NOT NULL DEFAULT 0,
  failed_tenants INTEGER NOT NULL DEFAULT 0,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  cursor_before TEXT,
  cursor_after TEXT,
  detail_object_catalog_id TEXT,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (trigger_type IN ('scheduled', 'manual_tenant')),
  CHECK (status IN ('running', 'completed', 'partial_failure', 'failed'))
);
CREATE TABLE admin_external_token_refresh_tenant_runs (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, tenant_id),
  FOREIGN KEY (run_id) REFERENCES admin_external_token_refresh_runs(id) ON DELETE CASCADE,
  CHECK (status IN ('completed', 'failed', 'skipped'))
);
CREATE TABLE admin_invitation_enrollments (
  token_hash TEXT PRIMARY KEY
 NOT NULL
,
  invitation_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(phase IN ('redeemed', 'registration', 'authentication'))
);
CREATE TABLE admin_invitations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  pending_email_key TEXT,
  name TEXT,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_role_id TEXT NOT NULL,
  admin_role_name TEXT NOT NULL,
  admin_role_display_name TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  role_expires_at INTEGER,
  ip_restriction_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_ip_ranges_json TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  last_delivery_status TEXT NOT NULL DEFAULT 'pending',
  last_delivery_error TEXT,
  accepted_at INTEGER,
  accepted_ip TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(admin_user_id),
  UNIQUE(tenant_id, pending_email_key),
  CHECK(status IN ('pending', 'accepted', 'revoked', 'expired')),
  CHECK(
    (status = 'pending' AND pending_email_key = email)
    OR (status IN ('accepted', 'revoked', 'expired') AND pending_email_key IS NULL)
  ),
  CHECK(last_delivery_status IN ('pending', 'sent', 'failed')),
  CHECK(scope_type IN ('global', 'tenant')),
  CHECK(ip_restriction_enabled IN (0, 1))
);
CREATE TABLE admin_ip_allowlist (
  -- Entry ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- IP address or CIDR range
  ip_range TEXT NOT NULL,

  -- IP version for easier filtering
  ip_version INTEGER NOT NULL DEFAULT 4,  -- 4 or 6

  -- Human-readable description
  description TEXT,  -- e.g., 'Office VPN', 'Home IP', 'CI/CD server'

  -- Enable/disable without deleting
  enabled INTEGER DEFAULT 1,

  -- Audit fields
  created_by TEXT,  -- Admin user ID who added this entry
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for IP range per tenant
  UNIQUE(tenant_id, ip_range)
);
CREATE TABLE admin_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT,
  config TEXT,
  input_r2_key TEXT,
  result_r2_key TEXT,
  object_catalog_id TEXT,
  result TEXT,
  error_code TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  estimated_completion INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  dead_lettered_at INTEGER
);
CREATE TABLE admin_logging_critical_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  policy_key TEXT NOT NULL UNIQUE,
  destination_id TEXT NOT NULL,
  critical_allowed INTEGER NOT NULL DEFAULT 1 CHECK (critical_allowed IN (0, 1)),
  default_fallback_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (default_fallback_eligible IN (0, 1)),
  failure_mode TEXT NOT NULL DEFAULT 'platform_default',
  change_protection TEXT NOT NULL DEFAULT 'confirm'
    CHECK (change_protection IN ('confirm', 'approval_required', 'config_only')),
  approval_policy_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE admin_logging_sensitive_detail_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL DEFAULT 'sensitive_detail',
  destination_id TEXT NOT NULL,
  chunking_enabled INTEGER NOT NULL DEFAULT 1 CHECK (chunking_enabled IN (0, 1)),
  encryption_required INTEGER NOT NULL DEFAULT 1 CHECK (encryption_required IN (0, 1)),
  read_audit_required INTEGER NOT NULL DEFAULT 1 CHECK (read_audit_required IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE admin_login_attempts (
  -- Attempt ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Target email (even if user doesn't exist)
  email TEXT NOT NULL,

  -- Request context
  ip_address TEXT NOT NULL,
  user_agent TEXT,

  -- Result
  success INTEGER NOT NULL DEFAULT 0,  -- 0 = failed, 1 = success
  failure_reason TEXT,  -- e.g., 'invalid_password', 'user_not_found', 'account_locked'

  -- Timestamp
  created_at INTEGER NOT NULL
);
CREATE TABLE admin_machine_assertion_jti (
  client_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, credential_id, jti),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
);
CREATE TABLE admin_machine_credential_permissions (
  credential_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (credential_id, permission),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
);
CREATE TABLE admin_machine_credential_tenant_scopes (
  credential_id TEXT NOT NULL,
  scope_mode TEXT NOT NULL,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE,
  CHECK (scope_mode IN ('none', 'all', 'allow')),
  CHECK (
    (scope_mode = 'allow' AND tenant_id IS NOT NULL)
    OR (scope_mode IN ('none', 'all') AND tenant_id IS NULL)
  )
);
CREATE TABLE admin_machine_credentials (
  id TEXT PRIMARY KEY
 NOT NULL
,
  principal_id TEXT NOT NULL,
  kid TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  alg TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  not_before INTEGER,
  expires_at INTEGER,
  last_used_at INTEGER,
  last_used_ip TEXT,
  last_used_user_agent TEXT,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_actor_type TEXT,
  revoked_by_actor_id TEXT,
  revoke_reason TEXT,
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE,
  UNIQUE (principal_id, kid),
  CHECK (status IN ('active', 'rotating', 'revoked', 'expired')),
  CHECK (alg IN ('ES256', 'PS256', 'RS256'))
);
CREATE TABLE admin_machine_principal_permissions (
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (principal_id, permission),
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE
);
CREATE TABLE admin_machine_principal_tenant_scopes (
  principal_id TEXT NOT NULL,
  scope_mode TEXT NOT NULL,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE,
  CHECK (scope_mode IN ('none', 'all', 'allow')),
  CHECK (
    (scope_mode = 'allow' AND tenant_id IS NOT NULL)
    OR (scope_mode IN ('none', 'all') AND tenant_id IS NULL)
  )
);
CREATE TABLE admin_machine_principals (
  id TEXT PRIMARY KEY
 NOT NULL
,
  client_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  principal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  default_audience TEXT NOT NULL DEFAULT 'authrim:admin-api',
  token_ttl_seconds INTEGER NOT NULL DEFAULT 600,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  disabled_by_actor_type TEXT,
  disabled_by_actor_id TEXT,
  CHECK (principal_type IN (
    'setup_tool',
    'admin_ui_bff',
    'automation',
    'ci',
    'mcp_server',
    'ai_agent',
    'internal_service',
    'integration'
  )),
  CHECK (status IN ('active', 'disabled', 'deleted')),
  CHECK (token_ttl_seconds > 0 AND token_ttl_seconds <= 900)
);
CREATE TABLE admin_machine_resource_scopes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  principal_id TEXT,
  credential_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  constraints_json TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE,
  CHECK (
    (principal_id IS NOT NULL AND credential_id IS NULL)
    OR (principal_id IS NULL AND credential_id IS NOT NULL)
  )
);
CREATE TABLE admin_passkeys (
  -- Passkey ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- WebAuthn credential data
  credential_id TEXT UNIQUE NOT NULL,  -- Base64url-encoded credential ID
  public_key TEXT NOT NULL,  -- COSE public key (Base64url-encoded)
  counter INTEGER DEFAULT 0,  -- Signature counter for replay protection

  -- User-friendly name for this passkey
  device_name TEXT,

  -- Transports (json array: usb, ble, nfc, internal, hybrid)
  transports_json TEXT,

  -- Attestation data (optional, for enterprise requirements)
  attestation_type TEXT,  -- none | indirect | direct | enterprise
  aaguid TEXT,  -- Authenticator Attestation GUID

  -- Lifecycle
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE admin_policies (
  -- Policy ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Policy identification
  name TEXT NOT NULL,  -- Machine-readable name
  display_name TEXT,   -- Human-readable name
  description TEXT,

  -- Policy effect: allow or deny
  effect TEXT NOT NULL DEFAULT 'allow',  -- allow, deny

  -- Priority (higher = evaluated first, useful for deny policies)
  priority INTEGER DEFAULT 0,

  -- Resource this policy applies to (supports wildcards)
  -- e.g., "admin:users:*", "admin:settings:security", "admin:*"
  resource_pattern TEXT NOT NULL,

  -- Actions this policy applies to (supports wildcards)
  -- e.g., ["read", "write"], ["*"]
  actions_json TEXT NOT NULL DEFAULT '["*"]',

  -- Conditions (JSON object with RBAC/ABAC/ReBAC conditions)
  -- Format:
  -- {
  --   "roles": ["admin", "security_admin"],  // RBAC: Any of these roles
  --   "attributes": {                         // ABAC: Attribute conditions
  --     "department": {"equals": "engineering"},
  --     "clearance_level": {"gte": 3}
  --   },
  --   "relationships": {                      // ReBAC: Relationship conditions
  --     "manager_of": {"target_type": "admin_user"}
  --   },
  --   "condition_type": "all"  // "all" (AND) or "any" (OR)
  -- }
  conditions_json TEXT NOT NULL DEFAULT '{}',

  -- Whether this policy is active
  is_active INTEGER DEFAULT 1,

  -- System policy flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for policy name per tenant
  UNIQUE(tenant_id, name)
);
CREATE TABLE admin_rebac_definitions (
  -- Definition ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Relationship name (e.g., 'admin_supervises', 'admin_team_member')
  relation_name TEXT NOT NULL,

  -- Human-readable display name
  display_name TEXT,

  -- Description of what this relationship means
  description TEXT,

  -- Priority for evaluation (higher = evaluated first)
  priority INTEGER DEFAULT 0,

  -- Whether this is a system-defined relationship (cannot be deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for relation name per tenant
  UNIQUE(tenant_id, relation_name)
);
INSERT INTO admin_rebac_definitions VALUES('rebac_def_supervises','default','admin_supervises','Supervises','Admin user supervises another admin user',100,1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
INSERT INTO admin_rebac_definitions VALUES('rebac_def_team_member','default','admin_team_member','Team Member','Admin user is a member of a team',50,1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
INSERT INTO admin_rebac_definitions VALUES('rebac_def_escalation','default','admin_escalation_chain','Escalation Chain','Admin user is in escalation chain for another admin user',75,1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
CREATE TABLE admin_relationships (
  -- Relationship ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Relationship type (e.g., 'manager_of', 'delegate_of', 'team_member')
  relationship_type TEXT NOT NULL,

  -- Source entity (from)
  from_type TEXT NOT NULL DEFAULT 'admin_user',  -- admin_user, admin_role, team
  from_id TEXT NOT NULL,

  -- Target entity (to)
  to_type TEXT NOT NULL DEFAULT 'admin_user',  -- admin_user, admin_role, team
  to_id TEXT NOT NULL,

  -- Permission level granted by this relationship
  -- full: All permissions of target
  -- limited: Subset of permissions
  -- read_only: Read-only access
  permission_level TEXT NOT NULL DEFAULT 'full',

  -- For hierarchical relationships (e.g., transitive manager relationship)
  is_transitive INTEGER DEFAULT 0,

  -- Expiration (for temporary relationships)
  expires_at INTEGER,

  -- Bidirectional flag (if true, relationship works both ways)
  is_bidirectional INTEGER DEFAULT 0,

  -- Additional metadata (JSON)
  metadata_json TEXT,

  -- Audit fields
  created_by TEXT,  -- Admin user ID who created this relationship
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE admin_role_assignments (
  -- Assignment ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- References
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  admin_role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,

  -- Scope of this assignment
  scope_type TEXT NOT NULL DEFAULT 'tenant',  -- global | tenant | org
  scope_id TEXT,  -- org_id if scope_type = 'org', null otherwise

  -- Expiration (for temporary assignments)
  expires_at INTEGER,  -- UNIX timestamp, null for permanent

  -- Audit fields
  assigned_by TEXT,  -- Admin user ID who made this assignment
  created_at INTEGER NOT NULL,

  -- Unique constraint: one role per user per scope
  UNIQUE(admin_user_id, admin_role_id, scope_type, scope_id)
);
CREATE TABLE admin_roles (
  -- Role ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Role identification
  name TEXT NOT NULL,  -- Machine-readable name (e.g., 'super_admin')
  display_name TEXT,  -- Human-readable name (e.g., 'Super Administrator')
  description TEXT,

  -- Permissions (JSON array of permission strings)
  -- Format: ["admin:users:read", "admin:users:write", "admin:clients:*"]
  permissions_json TEXT NOT NULL DEFAULT '[]',

  -- Hierarchy level (for permission inheritance and delegation)
  -- Higher level = more privilege
  -- Users can only assign roles with lower hierarchy level
  hierarchy_level INTEGER DEFAULT 0,

  -- Role type
  role_type TEXT NOT NULL DEFAULT 'custom',  -- system | builtin | custom

  -- System role flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, inherits_from TEXT DEFAULT NULL,

  -- Unique constraint for role name per tenant
  UNIQUE(tenant_id, name)
);
INSERT INTO admin_roles VALUES('role_storage_destination_viewer','default','storage_destination_viewer','Storage Destination Viewer','View tenant storage destinations and usage without credential management privileges.','["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:usage:read"]',32,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_storage_destination_admin','default','storage_destination_admin','Storage Destination Admin','Manage tenant storage destinations and allow feature owners to select approved destinations.','["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:create","admin:storage_destinations:update","admin:storage_destinations:delete","admin:storage_destinations:credentials:write","admin:storage_destinations:test","admin:storage_destinations:usage:read","admin:diagnostic_logging:destination:select","admin:jobs:destination:select","admin:dr_backup:destination:select"]',55,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_platform_database_viewer','default','platform_database_viewer','Platform Database Viewer','View platform database connections and routing state without changing runtime storage.','["admin:database_connections:list","admin:database_connections:read","admin:database_connections:test","admin:database_routing:read"]',60,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_platform_database_admin','default','platform_database_admin','Platform Database Admin','Manage platform database connections and perform controlled database routing changes.','["admin:database_connections:list","admin:database_connections:read","admin:database_connections:create","admin:database_connections:update","admin:database_connections:delete","admin:database_connections:credentials:write","admin:database_connections:test","admin:database_routing:read","admin:database_routing:write","admin:database_routing:switch","admin:database_routing:rollback"]',85,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_ar_super_admin','default','ar_super_admin','Super Administrator','Every tenant and the platform: all permissions','["*"]',100,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_ar_tenant_admin','default','ar_tenant_admin','Tenant Administrator','One tenant: settings, apps, users, support operations, and its admins and roles','["admin:users:*", "admin:sessions:*", "admin:account_support_context:*", "admin:account_legal_holds:*", "admin:account_assurance:*", "admin:clients:*", "admin:scopes:*", "admin:roles:*", "admin:settings:read", "admin:settings:write", "admin:policy:simulate", "admin:policy:rebac:write", "admin:flows:validate", "admin:flows:compile", "admin:flows:publish", "admin:security:*", "admin:ip_allowlist:*", "admin:external_providers:*", "admin:external_token_refresh:*", "admin:directory_auth:*", "admin:saml_attribute_presets:*", "admin:saml_providers:list", "admin:saml_providers:read", "admin:saml_providers:create", "admin:saml_providers:update", "admin:saml_providers:delete", "admin:saml_providers:metadata:import", "admin:saml_providers:metadata:refresh", "admin:saml_providers:signing:publish_next", "admin:saml_providers:signing:promote", "admin:saml_providers:signing:retire_backup", "admin:webhooks:*", "admin:vc:*", "admin:auth_config_plans:*", "admin:bulk_plans:*", "admin:machine_access:*", "admin:agent_grants:*", "admin:agent_settings:*", "admin:agent_elevation:reconcile", "admin:agent_task_sets:*", "admin:agent_scope_policies:*", "admin:agent_templates:publish", "admin:agent_baselines:*", "admin:jobs:read", "admin:jobs:write", "admin:jobs:artifact:read", "admin:audit:*", "admin:admin_audit:*", "admin:operational_logs:*", "admin:logging:overview:read", "admin:logging:delivery_events:read", "admin:logging:exports:create", "admin:logging:tenant_overrides:read", "admin:logging:tenant_overrides:update", "admin:admin_logging:overview:read", "admin:admin_logging:coverage:read", "admin:admin_logging:repair:read", "admin:email_deliveries:read", "admin:email_deliveries:recipient:masked:read", "admin:email_deliveries:recipient:full:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:cohorts:preview", "admin:support_ops:cohorts:create", "admin:support_ops:actions:request", "admin:support_ops:actions:read", "admin:support_ops:actions:approve", "admin:support_ops:actions:execute", "admin:approvals:read", "admin:approvals:detail:read", "admin:approvals:write", "admin:approvals:approve", "admin:approvals:grant:issue", "admin:admin_users:read", "admin:admin_users:write", "admin:admin_users:delete", "admin:admin_roles:read", "admin:admin_roles:write", "admin:admin_roles:delete"]',80,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_ar_support','default','ar_support','Support','Looks up users, unlocks accounts, ends sessions and asks for support operations','["admin:users:read", "admin:users:status:read", "admin:sessions:read", "admin:account_support_context:read", "admin:account_legal_holds:read", "admin:account_assurance:read", "admin:users:unlock", "admin:sessions:revoke", "admin:account_support_context:write", "admin:clients:read", "admin:audit:read", "admin:operational_logs:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:cohorts:preview", "admin:support_ops:cohorts:create", "admin:support_ops:actions:request", "admin:support_ops:actions:read", "admin:approvals:read"]',40,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_ar_viewer','default','ar_viewer','Viewer','Read-only access to the Admin console, without secrets','["admin:users:read", "admin:users:status:read", "admin:sessions:read", "admin:account_support_context:read", "admin:account_legal_holds:read", "admin:account_assurance:read", "admin:clients:read", "admin:scopes:read", "admin:roles:read", "admin:settings:read", "admin:security:read", "admin:ip_allowlist:read", "admin:external_providers:read", "admin:external_token_refresh:read", "admin:directory_auth:read", "admin:saml_attribute_presets:read", "admin:saml_providers:list", "admin:saml_providers:read", "admin:webhooks:read", "admin:vc:credential_profiles:read", "admin:auth_config_plans:read", "admin:bulk_plans:read", "admin:agent_grants:read", "admin:agent_settings:read", "admin:agent_task_sets:read", "admin:agent_scope_policies:read", "admin:agent_baselines:read", "admin:jobs:read", "admin:audit:read", "admin:admin_audit:read", "admin:operational_logs:read", "admin:logging:overview:read", "admin:logging:delivery_events:read", "admin:admin_logging:overview:read", "admin:email_deliveries:read", "admin:email_deliveries:recipient:masked:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:actions:read", "admin:approvals:read"]',20,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
CREATE TABLE admin_search_projections (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  projection_kind TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  indexed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE admin_sessions (
  -- Session ID (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- Client information
  ip_address TEXT,
  user_agent TEXT,

  -- Session lifecycle
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_activity_at INTEGER,

  -- MFA status for this session
  mfa_verified INTEGER DEFAULT 0,
  mfa_verified_at INTEGER
, parent_session_id TEXT, derived_target_tenant_id TEXT);
CREATE TABLE admin_setup_tokens (
  -- Token ID (the actual token value, UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- Token status
  -- pending: Created, waiting for use
  -- used: Successfully used for passkey registration
  -- expired: Expired without use
  -- revoked: Manually revoked
  status TEXT NOT NULL DEFAULT 'pending',

  -- Expiration (UNIX timestamp in milliseconds)
  expires_at INTEGER NOT NULL,

  -- Usage tracking
  used_at INTEGER,  -- When the token was used
  used_ip TEXT,     -- IP address that used the token

  -- Audit fields
  created_at INTEGER NOT NULL,
  created_by TEXT  -- 'initial_setup' | 'cli' | admin_user_id
);
CREATE TABLE admin_storage_destination_usages (
  id TEXT PRIMARY KEY
 NOT NULL
,
  destination_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (destination_id, feature, resource_type, resource_id)
);
CREATE TABLE admin_storage_destinations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'platform')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('r2', 'aws_s3', 'sftp', 'custom')),
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_encrypted TEXT,
  credential_key_version INTEGER,
  credential_updated_at INTEGER,
  credential_updated_by TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (scope_type, scope_id, name)
);
CREATE TABLE admin_users (
  -- Primary key (UUID v4)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Admin user profile
  email TEXT NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,

  -- Authentication
  password_hash TEXT,

  -- Account status
  is_active INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',  -- active | suspended | locked

  -- MFA settings
  mfa_enabled INTEGER DEFAULT 0,
  mfa_method TEXT,  -- totp | passkey | both | null
  totp_secret_encrypted TEXT,

  -- Login tracking
  last_login_at INTEGER,
  last_login_ip TEXT,
  failed_login_count INTEGER DEFAULT 0,
  locked_until INTEGER,  -- UNIX timestamp, null if not locked

  -- Audit fields
  created_by TEXT,  -- Admin user ID who created this account
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, passkey_setup_completed INTEGER DEFAULT 0,

  -- Unique constraint for email per tenant
  UNIQUE(tenant_id, email)
);
CREATE TABLE agent_baseline_assignments (
  id TEXT PRIMARY KEY
 NOT NULL
,
  baseline_id TEXT NOT NULL,
  baseline_version INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  source_bulk_plan_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  last_evaluated_at INTEGER,
  drift_status TEXT CHECK (drift_status IN ('in_sync', 'drifted', 'unknown')),
  drift_digest TEXT,
  remediation_bulk_plan_id TEXT,
  remediation_bulk_plan_version INTEGER,
  remediation_drift_digest TEXT,
  remediation_requested_at INTEGER,
  last_transition_id TEXT, source_bulk_plan_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(baseline_id, baseline_version, tenant_id)
);
CREATE TABLE agent_baseline_exceptions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  assignment_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(assignment_id) REFERENCES agent_baseline_assignments(id)
);
CREATE TABLE agent_bulk_plans (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  control_tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  client_id TEXT NOT NULL,
  definition_json TEXT,
  definition_digest TEXT NOT NULL,
  target_snapshot_json TEXT,
  target_snapshot_digest TEXT NOT NULL,
  canary_tenant_ids_json TEXT,
  canary_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'running', 'paused', 'completed')),
  stage TEXT NOT NULL CHECK (stage IN ('validate', 'apply', 'verify')),
  canary_size INTEGER NOT NULL CHECK (canary_size >= 1),
  wave_size INTEGER NOT NULL CHECK (wave_size >= 1),
  wave_failure_threshold_bps INTEGER NOT NULL CHECK (
    wave_failure_threshold_bps >= 0 AND wave_failure_threshold_bps <= 500
  ),
  current_wave INTEGER NOT NULL DEFAULT 0 CHECK (current_wave >= 0),
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  indeterminate_count INTEGER NOT NULL DEFAULT 0 CHECK (indeterminate_count >= 0),
  pause_reason TEXT,
  last_transition_id TEXT,
  expires_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT,
  payload_purge_at INTEGER NOT NULL,
  payload_purged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, delegator_id TEXT, actor_mode TEXT, actor_assurance TEXT, token_binding TEXT, machine_principal_id TEXT, machine_credential_id TEXT, grant_generation INTEGER NOT NULL DEFAULT 1, consent_version INTEGER NOT NULL DEFAULT 1, approved_by TEXT, approved_at INTEGER, approval_digest TEXT,
  PRIMARY KEY(id, version),
  FOREIGN KEY(grant_id) REFERENCES admin_agent_grants(id)
);
CREATE TABLE agent_bulk_tenant_executions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  bulk_plan_id TEXT NOT NULL,
  bulk_plan_version INTEGER NOT NULL,
  target_tenant_id TEXT NOT NULL,
  target_sequence INTEGER NOT NULL CHECK (target_sequence >= 0),
  is_canary INTEGER NOT NULL CHECK (is_canary IN (0, 1)),
  wave_number INTEGER CHECK (wave_number IS NULL OR wave_number >= 1),
  stage TEXT NOT NULL CHECK (stage IN ('validate', 'apply', 'verify')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'indeterminate')),
  plan_digest TEXT NOT NULL,
  child_capability_digest TEXT,
  precondition_snapshot_digest TEXT,
  execution_attempt INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0),
  execution_fence INTEGER NOT NULL DEFAULT 0 CHECK (execution_fence >= 0),
  execution_owner_id TEXT,
  execution_lease_expires_at INTEGER,
  idempotency_key TEXT NOT NULL,
  result_json TEXT,
  result_digest TEXT,
  failure_kind TEXT,
  last_transition_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL, child_capability_expires_at INTEGER,
  UNIQUE(bulk_plan_id, bulk_plan_version, target_tenant_id),
  UNIQUE(bulk_plan_id, bulk_plan_version, target_sequence),
  FOREIGN KEY(bulk_plan_id, bulk_plan_version) REFERENCES agent_bulk_plans(id, version)
);
CREATE TABLE agent_configuration_plan_steps (
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  operation TEXT NOT NULL,
  tool_contract_version TEXT NOT NULL,
  input_json TEXT,
  input_digest TEXT NOT NULL,
  resource_precondition TEXT,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'standard', 'high')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'indeterminate')),
  result_json TEXT,
  result_digest TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  PRIMARY KEY(plan_id, plan_version, step_id),
  FOREIGN KEY(plan_id, plan_version) REFERENCES agent_configuration_plans(id, version),
  UNIQUE(plan_id, plan_version, sequence)
);
CREATE TABLE agent_configuration_plans (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_generation INTEGER NOT NULL CHECK (grant_generation >= 1),
  consent_version INTEGER NOT NULL CHECK (consent_version >= 1),
  actor_sub TEXT NOT NULL,
  client_id TEXT NOT NULL,
  definition_json TEXT,
  snapshot_json TEXT,
  diff_json TEXT,
  validation_json TEXT,
  result_json TEXT,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'running', 'completed', 'failed')),
  stage TEXT NOT NULL CHECK (stage IN ('validate', 'apply', 'verify')),
  applied_step_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_step_count >= 0),
  failed_step_id TEXT,
  failure_kind TEXT,
  confirmation_id TEXT,
  last_transition_id TEXT,
  expires_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT,
  payload_purge_at INTEGER NOT NULL,
  payload_purged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(id, version),
  FOREIGN KEY(grant_id) REFERENCES admin_agent_grants(id)
);
CREATE TABLE agent_consents (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE agent_elevation_challenges (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
  terminal_transition_id TEXT, approval_request_id TEXT, approval_artifact_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id),
  FOREIGN KEY (user_id) REFERENCES admin_users(id),
  FOREIGN KEY (successor_challenge_id) REFERENCES agent_elevation_challenges(id),
  CHECK (expires_at > created_at),
  CHECK (
    (status IN ('pending', 'approved', 'executing') AND active_args_key = 'active')
    OR (status IN ('consumed', 'failed', 'indeterminate', 'expired', 'denied') AND active_args_key = id)
  )
);
CREATE TABLE agent_plan_confirmations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  confirmed_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'consumed', 'denied')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  consumed_at INTEGER,
  last_transition_id TEXT,
  UNIQUE(plan_id, plan_version, plan_digest)
);
CREATE TABLE agent_scope_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'custom', 'template_copy')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  source_template_id TEXT,
  source_template_version INTEGER,
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, management_mode TEXT NOT NULL DEFAULT 'managed'
  CHECK (management_mode IN ('managed', 'system_managed')),
  UNIQUE(tenant_id, name)
);
CREATE TABLE agent_scope_policy_versions (
  scope_policy_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  selector_catalog_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_policy_id, version),
  FOREIGN KEY(scope_policy_id) REFERENCES agent_scope_policies(id)
);
CREATE TABLE agent_secret_refs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  purpose TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  last_transition_id TEXT,
  UNIQUE(tenant_id, provider_key)
);
CREATE TABLE agent_task_set_versions (
  task_set_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  tool_entries_json TEXT NOT NULL,
  resolved_permissions_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(task_set_id, version),
  FOREIGN KEY(task_set_id) REFERENCES agent_task_sets(id)
);
CREATE TABLE agent_task_sets (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'custom', 'template_copy')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  source_template_id TEXT,
  source_template_version INTEGER,
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, management_mode TEXT NOT NULL DEFAULT 'managed'
  CHECK (management_mode IN ('managed', 'system_managed')),
  UNIQUE(tenant_id, name)
);
CREATE TABLE agent_template_copies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  target_tenant_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  target_object_version INTEGER NOT NULL,
  target_object_status TEXT NOT NULL CHECK (target_object_status = 'inactive'),
  bulk_plan_id TEXT NOT NULL,
  copied_by TEXT NOT NULL,
  copied_at INTEGER NOT NULL, bulk_plan_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(template_id, template_version, target_tenant_id)
);
CREATE TABLE IF NOT EXISTS "approval_request_approvals" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  approval_request_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  side TEXT NOT NULL CHECK (
    side IN ('admin_operator', 'customer_data_owner', 'guardian_delegate')
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  subject_id TEXT,
  relation_type TEXT,
  relation_source TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')
  ),
  method TEXT CHECK (
    method IN ('ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth')
  ),
  transport_channel TEXT,
  reason_code TEXT,
  reason_note TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_notification_action TEXT CHECK (
    last_notification_action IN ('initial', 'resend', 'remind')
  ),
  last_notified_at INTEGER,
  notification_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "approval_requests" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  public_request_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  investigation_id TEXT NOT NULL,
  requester_subject_type TEXT NOT NULL CHECK (
    requester_subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  requester_subject_id TEXT NOT NULL,
  target_subject_type TEXT NOT NULL CHECK (
    target_subject_type IN ('user', 'artifact', 'service_resource', 'tenant_resource')
  ),
  target_subject_id TEXT NOT NULL,
  request_surface TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  redaction_level TEXT NOT NULL CHECK (redaction_level IN ('summary_only', 'masked', 'raw')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'partially_approved', 'approved', 'denied', 'expired', 'cancelled')
  ),
  scope_canonical TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_note TEXT,
  reference_system TEXT,
  reference_value TEXT,
  reference_url TEXT,
  ticket_reference_system TEXT,
  ticket_reference_value TEXT,
  ticket_reference_url TEXT,
  reuse_scope TEXT NOT NULL DEFAULT 'request' CHECK (reuse_scope IN ('request', 'case')),
  policy_preset TEXT NOT NULL,
  partial_access_allowed INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  detail_object_catalog_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (detail_object_catalog_id) REFERENCES object_catalog(id) ON DELETE SET NULL
);
CREATE TABLE attribute_field_registry (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  protocol TEXT NOT NULL,
  field_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  classification TEXT NOT NULL DEFAULT 'internal',
  surfaces_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, protocol, field_key)
);
CREATE TABLE attribute_group_registry (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  protocol TEXT NOT NULL,
  group_type TEXT NOT NULL,
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  field_keys_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, protocol, group_type, group_key)
);
CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
CREATE TABLE blind_index_rotation_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE compiled_mapping_snapshots (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_version_id TEXT NOT NULL,
  catalog_version_id TEXT,
  snapshot_hash TEXT NOT NULL,
  compatibility_range TEXT,
  artifact_ref TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  compiled_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  metadata_json TEXT,
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
);
CREATE TABLE credential_profile_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  credential_profile_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  lifecycle_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_state IN ('draft', 'published', 'retired')),
  credential_configuration_id TEXT NOT NULL,
  issuance_flow_id TEXT NOT NULL,
  issuance_flow_version_id TEXT,
  verification_flow_id TEXT,
  verification_flow_version_id TEXT,
  issuance_mapping_set_id TEXT NOT NULL,
  issuance_mapping_version_id TEXT,
  issuance_mapping_snapshot_hash TEXT,
  verification_mapping_set_id TEXT,
  verification_mapping_version_id TEXT,
  verification_mapping_snapshot_hash TEXT,
  claim_allowlist_json TEXT NOT NULL,
  offer_ttl_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (offer_ttl_seconds BETWEEN 60 AND 900),
  maximum_attribute_age_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (maximum_attribute_age_seconds BETWEEN 60 AND 2592000),
  transaction_code_required INTEGER NOT NULL DEFAULT 0
    CHECK (transaction_code_required IN (0, 1)),
  snapshot_hash TEXT,
  published_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, credential_profile_id, version_number),
  FOREIGN KEY (credential_profile_id) REFERENCES credential_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (issuance_mapping_set_id) REFERENCES field_mapping_sets(id),
  FOREIGN KEY (issuance_mapping_version_id) REFERENCES field_mapping_versions(id),
  FOREIGN KEY (verification_mapping_set_id) REFERENCES field_mapping_sets(id),
  FOREIGN KEY (verification_mapping_version_id) REFERENCES field_mapping_versions(id)
);
CREATE TABLE credential_profiles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_state IN ('draft', 'published', 'disabled')),
  current_published_version_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);
CREATE TABLE credential_secret_bodies (
  credential_ref TEXT PRIMARY KEY
 NOT NULL
,
  destination_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE credential_secret_metadata (
  credential_ref TEXT PRIMARY KEY
 NOT NULL
,
  destination_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (
    backend IN ('r2_encrypted_object', 'd1_encrypted_table', 'external_secret_manager')
  ),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'next', 'retiring', 'retired', 'deleted')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  metadata TEXT
);
CREATE TABLE custom_field_catalog_entries (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_entry_id TEXT,
  custom_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  value_type TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, custom_key)
);
CREATE TABLE dependency_graph_snapshots (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_version_id TEXT,
  snapshot_hash TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE destination_profile_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  validation_summary_json TEXT NOT NULL,
  warning_summary_json TEXT NOT NULL,
  release_impact_json TEXT NOT NULL,
  reviewed_at INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_id, version_label),
  FOREIGN KEY (profile_id) REFERENCES destination_profiles(id) ON DELETE CASCADE
);
CREATE TABLE destination_profiles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  destination_type TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  base_profile_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, destination_type, profile_key)
);
CREATE TABLE IF NOT EXISTS "elevation_grants" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  public_grant_id TEXT NOT NULL UNIQUE,
  approval_request_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  target_audience TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  redaction_level TEXT NOT NULL CHECK (redaction_level IN ('summary_only', 'masked', 'raw')),
  scope_canonical TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  authorization_details_json TEXT,
  requester_subject_type TEXT NOT NULL CHECK (
    requester_subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  requester_subject_id TEXT NOT NULL,
  actor_subject_type TEXT NOT NULL CHECK (
    actor_subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  actor_subject_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE CASCADE
);
CREATE TABLE external_schema_catalogs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_entity_statements (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  statement_hash TEXT NOT NULL,
  statement_ref TEXT,
  expires_at INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_metadata_documents (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  source_url TEXT,
  document_hash TEXT NOT NULL,
  document_ref TEXT,
  fetched_at INTEGER,
  validated_at INTEGER,
  validation_state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE
);
CREATE TABLE federation_metadata_entity_summaries (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  metadata_document_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_role TEXT NOT NULL,
  display_name TEXT,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, metadata_document_id, entity_id, entity_role)
);
CREATE TABLE federation_metadata_refresh_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  refresh_mode TEXT NOT NULL DEFAULT 'manual',
  scheduled_for INTEGER,
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_metadata_validation_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  metadata_document_id TEXT,
  validation_state TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE federation_saml_runtime_entities (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  trust_context_snapshot_hash TEXT NOT NULL,
  metadata_document_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_role TEXT NOT NULL,
  metadata_xml TEXT NOT NULL,
  entity_categories_json TEXT,
  entity_category_support_json TEXT,
  registration_authority TEXT,
  valid_until TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, metadata_document_id, entity_id, entity_role),
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (metadata_document_id) REFERENCES federation_metadata_documents(id) ON DELETE CASCADE
);
CREATE TABLE federation_selected_entity_import_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  metadata_entity_summary_id TEXT,
  provider_id TEXT,
  import_action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE federation_trust_anchors (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  anchor_type TEXT NOT NULL,
  anchor_hash TEXT NOT NULL,
  anchor_ref TEXT,
  not_before INTEGER,
  not_after INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE
);
CREATE TABLE federation_trust_chains (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  subject TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  chain_json TEXT,
  validation_state TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_trust_context_snapshots (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  trust_context_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE TABLE federation_trust_scope_bindings (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_trust_sources (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  protocol_payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, refresh_operation_token TEXT, refresh_operation_expires_at INTEGER, active_metadata_document_id TEXT,
  UNIQUE (tenant_id, source_type, source_key)
);
CREATE TABLE field_catalog_entries (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_version_id TEXT NOT NULL,
  stable_field_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  path TEXT NOT NULL,
  target_taxonomy TEXT NOT NULL,
  value_type TEXT NOT NULL,
  cardinality TEXT NOT NULL DEFAULT 'single',
  classification TEXT NOT NULL DEFAULT 'internal',
  aliases_json TEXT,
  validation_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, ui_group_key TEXT, ui_group_label TEXT, ui_group_order INTEGER NOT NULL DEFAULT 0, ui_field_order INTEGER NOT NULL DEFAULT 0, examples_json TEXT, note TEXT,
  UNIQUE (tenant_id, catalog_version_id, stable_field_id),
  FOREIGN KEY (catalog_version_id) REFERENCES field_catalog_versions(id) ON DELETE CASCADE
);
INSERT INTO field_catalog_entries VALUES('platform_canonical_name','platform','platform_default_canonical_catalog_v1','field.canonical.name','authrim.canonical','name','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'name','Name',10,10,'["John Doe","山田 太郎","김민준"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_given_name','platform','platform_default_canonical_catalog_v1','field.canonical.given_name','authrim.canonical','given_name','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'name','Name',10,20,'["John","太郎","민준"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_family_name','platform','platform_default_canonical_catalog_v1','field.canonical.family_name','authrim.canonical','family_name','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'name','Name',10,30,'["Doe","山田","김"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_middle_name','platform','platform_default_canonical_catalog_v1','field.canonical.middle_name','authrim.canonical','middle_name','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'name','Name',10,40,'["Quincy"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_nickname','platform','platform_default_canonical_catalog_v1','field.canonical.nickname','authrim.canonical','nickname','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'name','Name',10,50,'["Johnny","たろう"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_preferred_username','platform','platform_default_canonical_catalog_v1','field.canonical.preferred_username','authrim.canonical','preferred_username','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'name','Name',10,60,'["jdoe","taro.yamada"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_email','platform','platform_default_canonical_catalog_v1','field.canonical.email','authrim.canonical','email','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'contact','Contact',20,10,'["john@example.edu"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_email_verified','platform','platform_default_canonical_catalog_v1','field.canonical.email_verified','authrim.canonical','email_verified','canonical','boolean','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'contact','Contact',20,20,'[true]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_phone_number','platform','platform_default_canonical_catalog_v1','field.canonical.phone_number','authrim.canonical','phone_number','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'contact','Contact',20,30,'["+1 415 555 0100"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_phone_number_verified','platform','platform_default_canonical_catalog_v1','field.canonical.phone_number_verified','authrim.canonical','phone_number_verified','canonical','boolean','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'contact','Contact',20,40,'[false]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_address','platform','platform_default_canonical_catalog_v1','field.canonical.address','authrim.canonical','address','canonical','json','multi','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'address','Address',30,10,'[{"formatted":"1-1 Chiyoda, Chiyoda-ku, Tokyo 100-8111, JP","streetAddress":"1-1 Chiyoda","locality":"Chiyoda-ku","region":"Tokyo","postalCode":"100-8111","country":"JP"}]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_address_street_address','platform','platform_default_canonical_catalog_v1','field.canonical.address_street_address','authrim.canonical','address_street_address','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'address','Address',30,20,'["1-1 Chiyoda"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_address_locality','platform','platform_default_canonical_catalog_v1','field.canonical.address_locality','authrim.canonical','address_locality','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'address','Address',30,30,'["Chiyoda-ku"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_address_region','platform','platform_default_canonical_catalog_v1','field.canonical.address_region','authrim.canonical','address_region','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'address','Address',30,40,'["Tokyo"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_address_postal_code','platform','platform_default_canonical_catalog_v1','field.canonical.address_postal_code','authrim.canonical','address_postal_code','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'address','Address',30,50,'["100-8111"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_address_country','platform','platform_default_canonical_catalog_v1','field.canonical.address_country','authrim.canonical','address_country','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'address','Address',30,60,'["JP"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_profile','platform','platform_default_canonical_catalog_v1','field.canonical.profile','authrim.canonical','profile','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'profile','Profile',40,10,'["https://example.edu/users/jdoe"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_picture','platform','platform_default_canonical_catalog_v1','field.canonical.picture','authrim.canonical','picture','canonical','string','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'profile','Profile',40,20,'["https://example.edu/users/jdoe/photo.jpg"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_website','platform','platform_default_canonical_catalog_v1','field.canonical.website','authrim.canonical','website','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'profile','Profile',40,30,'["https://jdoe.example.edu"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_birthdate','platform','platform_default_canonical_catalog_v1','field.canonical.birthdate','authrim.canonical','birthdate','canonical','date','single','pii','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'profile','Profile',40,40,'["1990-04-12"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_zoneinfo','platform','platform_default_canonical_catalog_v1','field.canonical.zoneinfo','authrim.canonical','zoneinfo','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'profile','Profile',40,50,'["Asia/Tokyo"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_locale','platform','platform_default_canonical_catalog_v1','field.canonical.locale','authrim.canonical','locale','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'profile','Profile',40,60,'["ja-JP"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_group_membership','platform','platform_default_canonical_catalog_v1','field.canonical.group_membership','authrim.canonical','group_membership','canonical','array','multi','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'access','Access',50,10,'["library-staff","researcher"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_entitlements','platform','platform_default_canonical_catalog_v1','field.canonical.entitlements','authrim.canonical','entitlements','canonical','array','multi','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'access','Access',50,20,'["publisher:journal:read"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_subject_id','platform','platform_default_canonical_catalog_v1','field.canonical.subject_id','authrim.canonical','subject_id','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'identity','Identity',60,10,'["user_01HZY9G3V3W0M7K9D2B1N6A8CQ"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_linked_identity','platform','platform_default_canonical_catalog_v1','field.canonical.linked_identity','authrim.canonical','linked_identity','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'identity','Identity',60,20,'["saml:urn:example:idp:00u123"]',NULL);
INSERT INTO field_catalog_entries VALUES('platform_canonical_lifecycle_state','platform','platform_default_canonical_catalog_v1','field.canonical.lifecycle_state','authrim.canonical','lifecycle_state','canonical','string','single','internal','[]','{}',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,'identity','Identity',60,30,'["active"]',NULL);
CREATE TABLE field_catalog_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  compatibility_range TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_id, version_label),
  FOREIGN KEY (catalog_id) REFERENCES field_catalogs(id) ON DELETE CASCADE
);
INSERT INTO field_catalog_versions VALUES('platform_default_canonical_catalog_v1','platform','platform_default_canonical_catalog','2026-05-30','0000000000000000000000000000000000000000000000000000000000000001','*','active',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
CREATE TABLE field_catalogs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_key)
);
INSERT INTO field_catalogs VALUES('platform_default_canonical_catalog','platform','authrim.platform_default_canonical','Authrim Platform Default Canonical Catalog','active',__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__);
CREATE TABLE field_mapping_activations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_set_id TEXT NOT NULL,
  field_mapping_version_id TEXT NOT NULL,
  activation_scope_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'scheduled',
  active_from INTEGER,
  active_until INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (field_mapping_set_id) REFERENCES field_mapping_sets(id) ON DELETE CASCADE,
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
);
CREATE TABLE field_mapping_sets (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, field_mapping_key)
);
CREATE TABLE field_mapping_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_set_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  field_mapping_hash TEXT NOT NULL,
  compatibility_range TEXT,
  author_id TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, field_mapping_set_id, version_label),
  FOREIGN KEY (field_mapping_set_id) REFERENCES field_mapping_sets(id) ON DELETE CASCADE
);
CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  idempotency_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_ref TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, operation_key, idempotency_key)
);
CREATE TABLE internal_notification_delivery_attempts (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE internal_notification_delivery_routes (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE IF NOT EXISTS "internal_notification_events" (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
      'control_plane_drift',
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
CREATE TABLE key_access_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  key_version_id TEXT,
  actor_id TEXT,
  access_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE key_material_refs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_version_id TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  material_ref TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (key_version_id) REFERENCES key_versions(id) ON DELETE CASCADE
);
CREATE TABLE key_registries (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_purpose TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  active_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE key_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  algorithm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  UNIQUE (tenant_id, key_registry_id, version),
  FOREIGN KEY (key_registry_id) REFERENCES key_registries(id) ON DELETE CASCADE
);
CREATE TABLE log_chunk_manifests (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  bucket_start_at INTEGER NOT NULL,
  bucket_end_at INTEGER NOT NULL,
  shard TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE log_object_catalog (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('chunk', 'manifest', 'dlq_payload', 'export_artifact')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'orphan_candidate', 'deleted')),
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  compression TEXT CHECK (compression IN ('none', 'gzip_block')),
  encryption_scope TEXT,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  deleted_at INTEGER
, source_table TEXT, chunk_id TEXT, first_event_at INTEGER, last_event_at INTEGER, max_expires_at INTEGER, never_expires INTEGER CHECK (never_expires IN (0, 1)));
CREATE TABLE logging_catalog_repair_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE logging_delivery_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT NOT NULL,
  destination_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'retrying', 'failed', 'dlq')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  object_catalog_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_retry_at INTEGER,
  metadata TEXT
);
CREATE TABLE logging_destination_override_history (
  id TEXT PRIMARY KEY
 NOT NULL
,
  override_id TEXT NOT NULL,
  tenant_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  previous_destination_id TEXT,
  next_destination_id TEXT,
  previous_fallback_policy_id TEXT,
  next_fallback_policy_id TEXT,
  previous_enabled INTEGER CHECK (previous_enabled IN (0, 1)),
  next_enabled INTEGER CHECK (next_enabled IN (0, 1)),
  previous_change_protection TEXT,
  next_change_protection TEXT,
  previous_approval_policy_id TEXT,
  next_approval_policy_id TEXT,
  previous_policy_hash TEXT,
  next_policy_hash TEXT,
  previous_version INTEGER,
  next_version INTEGER NOT NULL,
  changed_by TEXT,
  changed_at INTEGER NOT NULL,
  change_reason TEXT,
  metadata TEXT
);
CREATE TABLE logging_destination_overrides (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  fallback_policy_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  managed_by TEXT NOT NULL CHECK (managed_by IN ('platform', 'tenant')),
  change_protection TEXT NOT NULL DEFAULT 'confirm'
    CHECK (change_protection IN ('confirm', 'approval_required', 'config_only')),
  approval_policy_id TEXT,
  policy_hash TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE logging_dlq_items (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  destination_id TEXT,
  payload_object_ref TEXT NOT NULL,
  error_class TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'replayed', 'deleted', 'purged')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE logging_export_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  format TEXT NOT NULL CHECK (format IN ('jsonl', 'csv', 'zip')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired')),
  artifact_object_ref TEXT,
  manifest_object_ref TEXT,
  checksum_sha256 TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  error_class TEXT,
  filter_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE logging_fallback_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  fallback_destination_id TEXT,
  failure_mode TEXT NOT NULL DEFAULT 'platform_default',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE logging_key_material_bodies (
  backend_ref TEXT PRIMARY KEY
 NOT NULL
,
  scope_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  surface TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE logging_key_registry (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT NOT NULL,
  surface TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  active_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'rotating', 'stale', 'compromised', 'disabled')),
  last_rotated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE logging_message_export_builds (
  id TEXT PRIMARY KEY
 NOT NULL
,
  message_job_id TEXT NOT NULL,
  export_job_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN ('plan', 'build_partition', 'finalize', 'verify_manifest', 'cleanup')
  ),
  partition_strategy TEXT NOT NULL CHECK (
    partition_strategy IN ('time_bucket_shard', 'query_page', 'chunk_index', 'manifest_shard')
  ),
  partition_key TEXT,
  partition_index INTEGER NOT NULL DEFAULT 0,
  partition_count INTEGER NOT NULL DEFAULT 1,
  snapshot_cutoff_at INTEGER NOT NULL,

  part_object_ref TEXT,
  part_checksum_sha256 TEXT,
  part_record_count INTEGER NOT NULL DEFAULT 0,
  part_byte_count INTEGER NOT NULL DEFAULT 0,

  manifest_object_ref TEXT,
  final_checksum_sha256 TEXT,
  final_record_count INTEGER NOT NULL DEFAULT 0,
  final_byte_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  late_arriving_count INTEGER NOT NULL DEFAULT 0,

  cleanup_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
    cleanup_status IN ('not_required', 'queued', 'running', 'completed', 'failed')
  ),
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE logging_message_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  kind TEXT NOT NULL CHECK (kind IN ('retry_delivery', 'export_build')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'claimed',
      'running',
      'retrying',
      'completed',
      'failed',
      'dlq',
      'cancelled',
      'expired',
      'blocked'
    )
  ),
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  criticality TEXT NOT NULL CHECK (criticality IN ('standard', 'critical')),
  priority INTEGER NOT NULL DEFAULT 0,

  tenant_id TEXT,
  tenant_key TEXT,
  topology_type TEXT NOT NULL CHECK (
    topology_type IN ('platform', 'control_plane_d1', 'external_db', 'unknown')
  ),
  database_binding_ref TEXT,
  connection_ref TEXT,
  topology_snapshot_version INTEGER,
  topology_resolved_at INTEGER,

  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant', 'shared')),
  scope_id TEXT,
  scope_key TEXT NOT NULL,

  source_type TEXT CHECK (source_type IN ('dlq_item', 'delivery_event', 'payload_object')),
  source_id TEXT,
  root_job_id TEXT,
  parent_job_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,

  payload_object_ref TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  payload_schema_version INTEGER NOT NULL,
  redacted_summary_json TEXT,
  validation_summary_json TEXT,

  idempotency_key TEXT,
  dedupe_until INTEGER NOT NULL,
  not_before INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  attempt_policy_json TEXT,

  claim_token TEXT,
  claimed_at INTEGER,
  claimed_until INTEGER,

  requested_by TEXT,
  reason TEXT,
  error_class TEXT,
  last_error TEXT,
  blocked_reason TEXT,

  cancel_requested_at INTEGER,
  cancelled_by TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE logging_message_repair_findings (
  id TEXT PRIMARY KEY
 NOT NULL
,
  message_job_id TEXT,
  finding_type TEXT NOT NULL CHECK (
    finding_type IN (
      'stuck_claim',
      'expired_queued',
      'expired_retrying',
      'missing_payload_object',
      'missing_export_part',
      'orphan_staging_object',
      'event_job_mismatch',
      'blocked_configuration'
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  status TEXT NOT NULL CHECK (
    status IN ('open', 'safe_repaired', 'dangerous_previewed', 'dangerous_applied', 'ignored')
  ),
  safe_action TEXT,
  dangerous_action TEXT,
  impact_json TEXT,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER,
  applied_by TEXT
);
CREATE TABLE logging_policy_snapshots (
  id TEXT PRIMARY KEY
 NOT NULL
,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  policy_hash TEXT NOT NULL,
  object_ref TEXT,
  snapshot_json TEXT,
  published_by TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE TABLE logging_quota_evaluations (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE logging_quota_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL CHECK (
    metric_name IN (
      'delivery_records',
      'delivery_bytes',
      'delivery_batches',
      'dlq_items',
      'catalog_objects',
      'catalog_bytes',
      'sensitive_detail_bytes',
      'message_jobs'
    )
  ),
  window_kind TEXT NOT NULL DEFAULT 'day' CHECK (window_kind IN ('hour', 'day')),
  soft_limit INTEGER,
  hard_limit INTEGER,
  warning_ratio REAL NOT NULL DEFAULT 0.8,
  enforcement_mode TEXT NOT NULL DEFAULT 'warn_only'
    CHECK (enforcement_mode IN ('disabled', 'observe', 'warn_only', 'soft_limit', 'hard_non_critical')),
  critical_behavior TEXT NOT NULL DEFAULT 'never_block'
    CHECK (critical_behavior IN ('never_block')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE logging_rewrap_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  key_registry_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  metadata TEXT
);
CREATE TABLE logging_usage_aggregates (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL CHECK (
    metric_name IN (
      'delivery_records',
      'delivery_bytes',
      'delivery_batches',
      'dlq_items',
      'catalog_objects',
      'catalog_bytes',
      'sensitive_detail_bytes',
      'message_jobs'
    )
  ),
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
CREATE TABLE mapping_activation_leases (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  lease_key TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lease_key)
);
CREATE TABLE mapping_conflict_rules (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_version_id TEXT NOT NULL,
  target_ref_json TEXT NOT NULL,
  conflict_strategy TEXT NOT NULL,
  source_priority_json TEXT,
  condition_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
);
CREATE TABLE mapping_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  field_mapping_version_id TEXT,
  subject_id TEXT,
  source_id TEXT,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE mapping_release_rules (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_version_id TEXT NOT NULL,
  destination_type TEXT NOT NULL,
  destination_id TEXT,
  source_ref_json TEXT NOT NULL,
  release_action TEXT NOT NULL,
  legal_basis TEXT,
  purpose TEXT,
  condition_json TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
);
CREATE TABLE mapping_rule_edges (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  target_ref_json TEXT NOT NULL,
  edge_kind TEXT NOT NULL DEFAULT 'direct',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE
);
CREATE TABLE mapping_rules (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_version_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  scope_json TEXT,
  condition_json TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, field_mapping_version_id, rule_key),
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
);
CREATE TABLE mapping_templates (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  template_key TEXT NOT NULL,
  template_scope TEXT NOT NULL DEFAULT 'system',
  display_name TEXT NOT NULL,
  template_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, template_key)
);
CREATE TABLE mapping_transform_steps (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT NOT NULL,
  edge_id TEXT,
  step_order INTEGER NOT NULL,
  operation TEXT NOT NULL,
  parameters_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, rule_id, edge_id, step_order),
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE,
  FOREIGN KEY (edge_id) REFERENCES mapping_rule_edges(id) ON DELETE CASCADE
);
CREATE TABLE mapping_validation_rules (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT,
  target_ref_json TEXT NOT NULL,
  validation_kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  parameters_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE
);
CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global'
 NOT NULL
,
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);
CREATE TABLE IF NOT EXISTS "object_catalog" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  public_artifact_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  object_class TEXT NOT NULL CHECK (
    object_class IN (
      'admin_audit_detail',
      'event_log_detail',
      'pii_log_values',
      'webhook_delivery_payload',
      'operational_log_detail',
      'user_export',
      'user_import_input',
      'user_import_result',
      'admin_job_result',
      'directory_auth_evidence_export',
      'directory_auth_support_bundle',
      'approval_transport_detail',
      'dr_bundle'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE object_catalog_objects (
  id TEXT PRIMARY KEY
 NOT NULL
,
  catalog_id TEXT NOT NULL,
  representation TEXT NOT NULL CHECK (
    representation IN (
      'canonical_json',
      'csv_projection',
      'ndjson_projection',
      'zip_bundle'
    )
  ),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('single', 'manifest', 'chunk')),
  object_index INTEGER NOT NULL DEFAULT 0,
  bucket_binding TEXT NOT NULL CHECK (
    bucket_binding IN ('IMPORT_ARTIFACTS', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS')
  ),
  object_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  total_bytes INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE,
  UNIQUE(catalog_id, representation, object_index)
);
CREATE TABLE operational_notification_states (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  notification_event_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE persistent_identifier_profiles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  mode TEXT NOT NULL DEFAULT 'computed',
  algorithm TEXT NOT NULL DEFAULT 'authrim_sha256_base64url',
  protocol_scope TEXT NOT NULL DEFAULT 'any',
  usage_json TEXT NOT NULL DEFAULT '[]',
  source_ref_json TEXT,
  secret_ref TEXT,
  issuer_entity_id TEXT,
  audience_mode TEXT NOT NULL DEFAULT 'runtime',
  format_json TEXT NOT NULL DEFAULT '{}',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);
CREATE TABLE projection_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  job_type TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE projection_outbox (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  subject_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE protocol_schema_catalogs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  protocol TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  schema_version TEXT,
  schema_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, protocol, schema_key, schema_version)
);
CREATE TABLE provider_reprojection_jobs (
  job_id TEXT PRIMARY KEY
 NOT NULL
,
  plugin_id TEXT NOT NULL,
  desired_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'superseded')),
  cursor_tenant_id TEXT,
  total_tenants INTEGER NOT NULL DEFAULT 0 CHECK (total_tenants >= 0),
  processed_tenants INTEGER NOT NULL DEFAULT 0 CHECK (processed_tenants >= 0),
  succeeded_tenants INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_tenants >= 0),
  skipped_tenants INTEGER NOT NULL DEFAULT 0 CHECK (skipped_tenants >= 0),
  failed_tenants INTEGER NOT NULL DEFAULT 0 CHECK (failed_tenants >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 100),
  next_run_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (plugin_id, desired_revision),
  CHECK ((status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL))
);
CREATE TABLE replay_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  replay_type TEXT NOT NULL,
  impact_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  result_summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE review_task_groups (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
);
CREATE TABLE review_tasks (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_type TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  payload_json TEXT NOT NULL,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE rewrap_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT NOT NULL,
  artifact_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE scheduled_task_leases (
  task_id TEXT PRIMARY KEY
 NOT NULL
,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sensitive_detail_chunk_index (
  catalog_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  object_class TEXT NOT NULL,
  bucket_binding TEXT NOT NULL CHECK (bucket_binding IN ('SENSITIVE_DETAILS')),
  object_key TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT 'gzip' CHECK (content_encoding IN ('gzip', 'none')),
  line_number INTEGER NOT NULL,
  byte_offset INTEGER,
  byte_length INTEGER,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE source_authority_contracts (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  field_ref_json TEXT NOT NULL,
  authority_actions_json TEXT NOT NULL,
  condition_json TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE source_profile_parse_drafts (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  parser_options_json TEXT,
  warning_summary_json TEXT,
  source_metadata_json TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE source_profile_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  parser_options_json TEXT,
  warning_summary_json TEXT,
  source_metadata_json TEXT,
  reviewed_at INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_id, version_label),
  FOREIGN KEY (profile_id) REFERENCES source_profiles(id) ON DELETE CASCADE
);
CREATE TABLE source_profiles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);
CREATE TABLE storage_destination_assignments (
  id TEXT PRIMARY KEY
 NOT NULL
,
  destination_id TEXT NOT NULL,
  tenant_id TEXT,
  log_type TEXT,
  plane TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tenant_database_probe_results (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE tenant_placement_migration_jobs (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  control_operation_id TEXT NOT NULL,
  target_isolation_policy TEXT NOT NULL DEFAULT 'tenant_exclusive'
    CHECK (target_isolation_policy = 'tenant_exclusive'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_retry', 'blocked', 'succeeded', 'canceled')),
  active_job_key TEXT DEFAULT 'active'
    CHECK (active_job_key IS NULL OR active_job_key = 'active'),
  current_step TEXT NOT NULL DEFAULT 'wait_control' CHECK (current_step IN (
    'wait_control',
    'begin_route_cutover',
    'prepare_lookup',
    'prepare_alias',
    'commit_control',
    'publish_registry',
    'activate_alias',
    'activate_lookup',
    'verify_routes',
    'finalize_source',
    'complete'
  )),
  lookup_cursor_json TEXT CHECK (
    lookup_cursor_json IS NULL OR
    (json_valid(lookup_cursor_json) AND length(lookup_cursor_json) <= 2048)
  ),
  lookup_prepared_row_count INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_prepared_row_count >= 0),
  lookup_activated_row_count INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_activated_row_count >= 0),
  lookup_verified_row_count INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_verified_row_count >= 0),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_budget_started_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (environment_id, tenant_id, active_job_key),
  UNIQUE (environment_id, control_operation_id),
  CHECK ((status IN ('succeeded', 'canceled') AND completed_at IS NOT NULL)
         OR status NOT IN ('succeeded', 'canceled')),
  CHECK ((status = 'succeeded' AND current_step = 'complete') OR status <> 'succeeded'),
  CHECK ((status IN ('succeeded', 'canceled') AND active_job_key IS NULL)
          OR (status NOT IN ('succeeded', 'canceled') AND active_job_key = 'active'))
);
CREATE TABLE tenant_provisioning_operation_steps (
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
CREATE TABLE tenant_provisioning_operations (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
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
  updated_at INTEGER NOT NULL, isolation_policy TEXT NOT NULL DEFAULT 'tenant_exclusive'
  CHECK (isolation_policy IN ('shared_pool', 'tenant_exclusive')),
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (environment_id, tenant_id),
  CHECK ((operation_kind = 'create' AND source_tenant_id IS NULL AND preparation_payload_json IS NULL) OR
         (operation_kind = 'clone' AND source_tenant_id IS NOT NULL AND preparation_payload_json IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'canceled') AND completed_at IS NOT NULL) OR
         status NOT IN ('succeeded', 'canceled'))
);
CREATE TABLE tenant_backup_operations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'import')),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'waiting', 'ready', 'completed', 'failed', 'cancelling', 'cancelled')),
  phase TEXT NOT NULL DEFAULT 'prepare',
  cursor_json TEXT CHECK (cursor_json IS NULL OR (length(cursor_json) <= 16384 AND json_valid(cursor_json))),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER, request_json TEXT
  CHECK (request_json IS NULL OR (length(request_json) <= 32768 AND json_valid(request_json))), active_key_challenge_id TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0), failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0), last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code='backup_operation_slice_failed'), active_input_key_challenges_json TEXT
  CHECK(active_input_key_challenges_json IS NULL OR
    (json_valid(active_input_key_challenges_json) AND json_type(active_input_key_challenges_json)='array'
      AND json_array_length(active_input_key_challenges_json) BETWEEN 1 AND 32
      AND length(CAST(active_input_key_challenges_json AS BLOB))<=16384)), failure_reason TEXT CHECK (
  failure_reason IS NULL OR failure_reason IN (
    'backup_export_too_large',
    'backup_artifact_too_large',
    'backup_sqlite_row_too_large'
  )
),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > updated_at)),
  CHECK (lease_owner IS NULL OR state IN ('running', 'cancelling')),
  CHECK (state <> 'running' OR lease_owner IS NOT NULL)
);
CREATE TABLE tenant_backup_validation_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'sealed', 'deleting')),
  created_at INTEGER NOT NULL,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (operation_id, tenant_id) REFERENCES tenant_backup_operations(id, tenant_id)
);
CREATE TABLE tenant_backup_validation_records (
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  module TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL, source_id TEXT
  CHECK(source_id IS NULL OR (length(source_id)>0 AND length(source_id)<=128)),
  PRIMARY KEY (session_id, module, collection, record_id),
  FOREIGN KEY (session_id, tenant_id) REFERENCES tenant_backup_validation_sessions(id, tenant_id)
);
CREATE TABLE tenant_backup_validation_references (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  dependency_json TEXT NOT NULL CHECK (json_valid(dependency_json) AND length(dependency_json) <= 20000),
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id, tenant_id) REFERENCES tenant_backup_validation_sessions(id, tenant_id)
);
CREATE TABLE tenant_backup_key_handoffs (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_upload_id TEXT,
  request_digest TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  private_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  submit_expires_at INTEGER NOT NULL CHECK (submit_expires_at > created_at),
  key_expires_at INTEGER NOT NULL CHECK (key_expires_at >= submit_expires_at),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted')),
  envelope TEXT,
  handoff TEXT,
  accepted_at INTEGER,
  FOREIGN KEY (operation_id, tenant_id) REFERENCES tenant_backup_operations(id, tenant_id),
  CHECK ((state='pending' AND envelope IS NULL AND handoff IS NULL AND accepted_at IS NULL) OR
    (state='accepted' AND envelope IS NOT NULL AND handoff IS NOT NULL AND accepted_at >= created_at AND accepted_at < submit_expires_at))
);
CREATE TABLE tenant_backup_artifact_attempts (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN ('writing','sealed','deleting')),
  created_at INTEGER NOT NULL,
  part_count INTEGER,
  byte_count INTEGER,
  UNIQUE (id,tenant_id),
  FOREIGN KEY (operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  CHECK ((state='writing' AND part_count IS NULL AND byte_count IS NULL) OR
    (state='sealed' AND part_count>0 AND byte_count>0) OR state='deleting')
);
CREATE TABLE tenant_backup_execution_inventories (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building','sealed')),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count>=0 AND item_count<=4096),
  chain_digest TEXT NOT NULL CHECK (length(chain_digest)=64 AND chain_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  UNIQUE(operation_id,tenant_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE tenant_backup_execution_inventory_items (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal>=0 AND ordinal<4096),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=262144),
  chain_digest TEXT NOT NULL CHECK (length(chain_digest)=64 AND chain_digest NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(operation_id,ordinal),
  UNIQUE(operation_id,item_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_execution_inventories(operation_id,tenant_id)
);
CREATE TABLE tenant_backup_snapshot_resources (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE,
  cleaned INTEGER NOT NULL DEFAULT 0 CHECK(cleaned IN (0,1)),
  PRIMARY KEY(operation_id,resource_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE tenant_backup_cipher_streams (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  header_hex TEXT NOT NULL UNIQUE CHECK(length(header_hex)=250 AND header_hex NOT GLOB '*[^0-9a-f]*'),
  next_sequence INTEGER NOT NULL DEFAULT 0 CHECK(next_sequence>=0 AND next_sequence<=1000000),
  plain_bytes INTEGER NOT NULL DEFAULT 0 CHECK(plain_bytes>=0),
  finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN (0,1)),
  checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR (json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB))<=16384)),
  FOREIGN KEY(attempt_id,tenant_id) REFERENCES tenant_backup_artifact_attempts(id,tenant_id)
);
CREATE TABLE tenant_backup_cipher_frames (
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<1000000),
  frame_type INTEGER NOT NULL CHECK(frame_type IN (1,2)),
  plain_sha256 TEXT NOT NULL CHECK(length(plain_sha256)=64 AND plain_sha256 NOT GLOB '*[^0-9a-f]*'),
  plain_length INTEGER NOT NULL CHECK(plain_length>0 AND plain_length<=1048576),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB))<=16384),
  PRIMARY KEY(attempt_id,sequence),
  FOREIGN KEY(attempt_id) REFERENCES tenant_backup_cipher_streams(attempt_id)
);
CREATE TABLE tenant_backup_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('capturing', 'sealed', 'invalid')),
  tenant_key TEXT CHECK (tenant_key IS NULL OR length(tenant_key) > 0)
);
CREATE TABLE tenant_backup_preimages (
  snapshot_id TEXT NOT NULL REFERENCES tenant_backup_snapshots(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  record_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  row_json TEXT, row_partition TEXT
  CHECK (
    row_partition IS NULL OR (
      typeof(row_partition) = 'text'
      AND length(row_partition) BETWEEN 1 AND 64
    )
  ),
  PRIMARY KEY (snapshot_id, source_table, record_key),
  CHECK ((present = 0 AND row_json IS NULL) OR (present = 1 AND row_json IS NOT NULL))
);
CREATE TABLE tenant_backup_restore_targets (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
  seed_fingerprint TEXT NOT NULL CHECK(length(seed_fingerprint)=64),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  lease_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('loading','sealed','invalid'))
);
CREATE TABLE tenant_backup_input_receipts (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL CHECK(length(bundle_id)=32 AND bundle_id NOT GLOB '*[^0-9a-f]*'),
  sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=1000001),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB))<=16384),
  event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(operation_id,bundle_id,sequence),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE tenant_backup_dataset_inspections (
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  PRIMARY KEY(session_id,bundle_id,dataset_id),
  FOREIGN KEY(session_id,tenant_id) REFERENCES tenant_backup_validation_sessions(id,tenant_id) ON DELETE CASCADE
);
CREATE TABLE tenant_backup_input_validations (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  input_inventory_digest TEXT NOT NULL,
  examined_references INTEGER NOT NULL CHECK(examined_references>=0),
  unresolved_provenance INTEGER NOT NULL CHECK(unresolved_provenance>=0 AND unresolved_provenance<=examined_references),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(session_id,tenant_id) REFERENCES tenant_backup_validation_sessions(id,tenant_id) ON DELETE CASCADE
);
CREATE TABLE tenant_backup_publications (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  inventory_digest TEXT NOT NULL CHECK(length(inventory_digest)=64),
  published_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at=published_at+604800000),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(attempt_id,tenant_id) REFERENCES tenant_backup_artifact_attempts(id,tenant_id)
);
CREATE TABLE tenant_backup_export_manifests (
  attempt_id TEXT NOT NULL PRIMARY KEY REFERENCES tenant_backup_artifact_attempts(id) ON DELETE CASCADE,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=262144),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')
);
CREATE TABLE tenant_backup_uploads (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 174 AND 83886080000),
  expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL UNIQUE,
  multipart_id TEXT,
  object_version TEXT,
  object_etag TEXT,
  verified_sha256 TEXT CHECK(verified_sha256 IS NULL OR (length(verified_sha256)=64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*')),
  completed_at INTEGER,
  completion_lease_owner TEXT,
  completion_lease_until INTEGER,
  state TEXT NOT NULL DEFAULT 'allocating' CHECK(state IN ('allocating','uploading','completing','uploaded','cancelling','deleted')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  UNIQUE(tenant_id,idempotency_key),
  CHECK(state NOT IN ('uploading','completing','uploaded') OR multipart_id IS NOT NULL),
  CHECK((completion_lease_owner IS NULL)=(completion_lease_until IS NULL)),
  CHECK(state!='uploaded' OR (object_version IS NOT NULL AND object_etag IS NOT NULL
    AND verified_sha256=expected_sha256 AND completed_at IS NOT NULL))
);
CREATE TABLE tenant_backup_upload_parts (
  upload_id TEXT NOT NULL REFERENCES tenant_backup_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  etag TEXT,
  PRIMARY KEY(upload_id,part_number)
);
CREATE TABLE tenant_backup_operation_inputs (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
  upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 174 AND 83886080000),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  bound_at INTEGER NOT NULL CHECK(bound_at>=0),
  PRIMARY KEY(operation_id,ordinal),
  UNIQUE(operation_id,upload_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(upload_id) REFERENCES tenant_backup_uploads(id)
);
CREATE TABLE tenant_backup_restore_plan_inventories (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  input_inventory_digest TEXT NOT NULL CHECK(length(input_inventory_digest)=64 AND input_inventory_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0 AND item_count<=4096),
  chain_digest TEXT NOT NULL CHECK(length(chain_digest)=64 AND chain_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(operation_id,tenant_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE tenant_backup_restore_plan_inventory_items (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<4096),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=262144),
  chain_digest TEXT NOT NULL CHECK(length(chain_digest)=64 AND chain_digest NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(operation_id,ordinal),
  UNIQUE(operation_id,item_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_restore_plan_inventories(operation_id,tenant_id)
);
CREATE TABLE tenant_backup_restore_cleanup_receipts (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  item_ordinal INTEGER NOT NULL CHECK(item_ordinal>=0 AND item_ordinal<4096),
  item_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  cleaned_at INTEGER NOT NULL CHECK(cleaned_at>=0),
  PRIMARY KEY(operation_id,item_ordinal),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(operation_id,item_ordinal) REFERENCES tenant_backup_restore_plan_inventory_items(operation_id,ordinal)
);
CREATE TABLE tenant_settings_documents (
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 128),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('tenant','client')),
  scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 128),
  category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 128),
  document_json TEXT NOT NULL CHECK(
    json_valid(document_json) AND
    json_type(document_json)='object' AND
    length(CAST(document_json AS BLOB))<=1048576
  ),
  version TEXT NOT NULL CHECK(
    length(version)=23 AND
    version LIKE 'sha256:%' AND
    substr(version,8) NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK(revision>0),
  projection_state TEXT NOT NULL CHECK(projection_state IN ('pending','applied')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  projected_at INTEGER CHECK(projected_at IS NULL OR projected_at>=updated_at), reconciled_at INTEGER NOT NULL DEFAULT 0 CHECK(reconciled_at>=0),
  PRIMARY KEY(tenant_id,scope_type,scope_id,category),
  CHECK(scope_type='client' OR tenant_id=scope_id),
  CHECK((projection_state='pending' AND projected_at IS NULL) OR
    (projection_state='applied' AND projected_at IS NOT NULL))
) STRICT;
CREATE TABLE tenant_backup_admin_mapping_heads (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','frozen')),
  sealed_digest TEXT CHECK(sealed_digest IS NULL OR
    (length(sealed_digest)=64 AND sealed_digest NOT GLOB '*[^0-9a-f]*')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  approved_by TEXT,
  approved_at INTEGER,
  approval_operation_revision INTEGER CHECK(
    approval_operation_revision IS NULL OR approval_operation_revision>=0
  ),
  UNIQUE(operation_id,tenant_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  CHECK(
    (state='open' AND sealed_digest IS NULL AND approved_by IS NULL AND approved_at IS NULL
      AND approval_operation_revision IS NULL)
    OR
    (state='frozen' AND sealed_digest IS NOT NULL AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL AND approval_operation_revision IS NOT NULL)
  )
);
CREATE TABLE tenant_backup_admin_mappings (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  source_admin_id TEXT NOT NULL CHECK(length(source_admin_id) BETWEEN 1 AND 256),
  target_admin_id TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(operation_id,source_admin_id),
  UNIQUE(operation_id,target_admin_id),
  FOREIGN KEY(operation_id,tenant_id)
    REFERENCES tenant_backup_admin_mapping_heads(operation_id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY(target_admin_id) REFERENCES admin_users(id)
);
CREATE TABLE tenant_backup_restored_holds (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL CHECK(
    length(dataset_id) BETWEEN 1 AND 256 AND dataset_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
  ),
  record_id TEXT NOT NULL CHECK(json_valid(record_id) AND length(record_id) BETWEEN 1 AND 4096),
  reason TEXT NOT NULL CHECK(
    length(reason) BETWEEN 1 AND 128 AND reason NOT GLOB '*[^a-z0-9_.:-]*'
  ),
  source_row_sha256 TEXT NOT NULL CHECK(
    length(source_row_sha256)=64 AND source_row_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_encrypted TEXT NOT NULL CHECK(
    payload_encrypted GLOB 'enc:v[1-9]*:gcm:*' AND length(payload_encrypted)<=2097152
  ),
  payload_key_version INTEGER NOT NULL CHECK(payload_key_version>=1),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(operation_id,dataset_id,record_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE tenant_backup_r2_restore_objects (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL CHECK(dataset_id IN ('artifacts.object_catalog_bodies','logs.archive_object_bodies')),
  object_id TEXT NOT NULL CHECK(length(object_id) BETWEEN 1 AND 512),
  source_object_key TEXT NOT NULL CHECK(length(source_object_key) BETWEEN 1 AND 1024),
  source_encoding TEXT NOT NULL CHECK(source_encoding IN ('plaintext','object_artifact_v1','log_chunk_v1','log_chunk_records_v1','sensitive_detail_record_v1')),
  write_mode TEXT NOT NULL CHECK(write_mode IN ('multipart','staged')),
  target_bucket_binding TEXT NOT NULL CHECK(target_bucket_binding IN ('AUDIT_ARCHIVE','DIAGNOSTIC_LOGS','EXPORT_ARTIFACTS','IMPORT_ARTIFACTS','SENSITIVE_DETAILS')),
  target_object_key TEXT NOT NULL CHECK(length(target_object_key) BETWEEN 1 AND 1024),
  object_sha256 TEXT NOT NULL CHECK(length(object_sha256)=64 AND object_sha256 NOT GLOB '*[^0-9a-f]*'),
  total_bytes INTEGER NOT NULL CHECK(total_bytes>=0 AND total_bytes<=21474836480),
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 4096),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(context_json)<=8192),
  http_metadata_json TEXT CHECK(http_metadata_json IS NULL OR (json_valid(http_metadata_json) AND length(http_metadata_json)<=8192)),
  custom_metadata_json TEXT CHECK(custom_metadata_json IS NULL OR (json_valid(custom_metadata_json) AND length(custom_metadata_json)<=8192)),
  multipart_id TEXT,
  state TEXT NOT NULL DEFAULT 'allocating' CHECK(state IN ('allocating','uploading','completing','completed','cancelling','deleted')),
  object_version TEXT,
  object_etag TEXT,
  stored_sha256 TEXT CHECK(stored_sha256 IS NULL OR (length(stored_sha256)=64 AND stored_sha256 NOT GLOB '*[^0-9a-f]*')),
  target_key_version INTEGER CHECK(target_key_version IS NULL OR target_key_version>=1),
  target_encryption_scope TEXT CHECK(target_encryption_scope IS NULL OR length(target_encryption_scope) BETWEEN 1 AND 256),
  completed_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at), log_records_json TEXT
  CHECK(log_records_json IS NULL OR (
    json_valid(log_records_json)
    AND json_type(log_records_json)='array'
    AND length(log_records_json) BETWEEN 2 AND 2097152
  )),
  PRIMARY KEY(operation_id,dataset_id,object_id),
  UNIQUE(target_bucket_binding,target_object_key),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  CHECK(source_object_key<>target_object_key),
  CHECK((write_mode='multipart' AND (state='allocating' OR multipart_id IS NOT NULL))
    OR (write_mode='staged' AND multipart_id IS NULL)),
  CHECK(state!='completed' OR (object_version IS NOT NULL AND object_etag IS NOT NULL
    AND stored_sha256 IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK(state!='completed' OR
    (source_encoding='plaintext' AND target_key_version IS NULL AND target_encryption_scope IS NULL) OR
    (source_encoding IN ('object_artifact_v1','sensitive_detail_record_v1') AND target_key_version IS NOT NULL AND target_encryption_scope IS NULL) OR
    (source_encoding IN ('log_chunk_v1','log_chunk_records_v1') AND target_key_version IS NOT NULL AND target_encryption_scope IS NOT NULL))
);
CREATE TABLE tenant_backup_r2_restore_parts (
  operation_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 4095),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 5242880),
  chunk_sha256 TEXT NOT NULL CHECK(length(chunk_sha256)=64 AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_part_etag TEXT,
  staging_object_key TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  PRIMARY KEY(operation_id,dataset_id,object_id,chunk_index),
  FOREIGN KEY(operation_id,dataset_id,object_id)
    REFERENCES tenant_backup_r2_restore_objects(operation_id,dataset_id,object_id) ON DELETE CASCADE,
  CHECK(NOT (target_part_etag IS NOT NULL AND staging_object_key IS NOT NULL))
);
CREATE TABLE tenant_backup_r2_retired_generations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_key TEXT NOT NULL,
  bucket_binding TEXT NOT NULL CHECK (bucket_binding IN (
    'AUDIT_ARCHIVE', 'DIAGNOSTIC_LOGS', 'SENSITIVE_DETAILS',
    'EXPORT_ARTIFACTS', 'IMPORT_ARTIFACTS'
  )),
  object_catalog_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  replacement_object_key TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('rewrap', 'catalog_delete')),
  key_registry_id TEXT,
  previous_key_version INTEGER,
  replacement_key_version INTEGER,
  record_count INTEGER,
  accounting_applied INTEGER NOT NULL DEFAULT 0 CHECK (accounting_applied IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK (
    (reason = 'rewrap' AND replacement_object_key IS NOT NULL
      AND key_registry_id IS NOT NULL
      AND previous_key_version IS NOT NULL AND previous_key_version > 0
      AND replacement_key_version IS NOT NULL AND replacement_key_version > 0
      AND previous_key_version <> replacement_key_version
      AND record_count IS NOT NULL AND record_count >= 0)
    OR
    (reason = 'catalog_delete' AND replacement_object_key IS NULL
      AND key_registry_id IS NULL AND previous_key_version IS NULL
      AND replacement_key_version IS NULL AND record_count IS NULL
      AND accounting_applied = 1)
  ),
  UNIQUE (bucket_binding, object_key, object_catalog_id)
);
CREATE TABLE tenant_backup_restored_hold_objects (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  source_bucket_binding TEXT NOT NULL CHECK (source_bucket_binding IN (
    'AUDIT_ARCHIVE', 'DIAGNOSTIC_LOGS', 'EXPORT_ARTIFACTS', 'IMPORT_ARTIFACTS',
    'SENSITIVE_DETAILS'
  )),
  source_object_ref TEXT NOT NULL,
  target_bucket_binding TEXT NOT NULL CHECK (target_bucket_binding IN (
    'AUDIT_ARCHIVE', 'DIAGNOSTIC_LOGS', 'EXPORT_ARTIFACTS', 'IMPORT_ARTIFACTS',
    'SENSITIVE_DETAILS'
  )),
  target_object_ref TEXT NOT NULL,
  target_object_version TEXT NOT NULL,
  target_object_etag TEXT NOT NULL,
  target_plaintext_sha256 TEXT NOT NULL CHECK (
    length(target_plaintext_sha256) = 64 AND target_plaintext_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  target_stored_sha256 TEXT NOT NULL CHECK (
    length(target_stored_sha256) = 64 AND target_stored_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  target_stored_byte_count INTEGER NOT NULL CHECK (target_stored_byte_count > 0),
  target_key_version INTEGER NOT NULL CHECK (target_key_version > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, dataset_id, record_id, source_field),
  UNIQUE (operation_id, target_bucket_binding, target_object_ref),
  FOREIGN KEY (operation_id) REFERENCES tenant_backup_operations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "tenant_backup_artifact_parts" (
  attempt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal>=0),
  object_key TEXT NOT NULL UNIQUE,
  byte_count INTEGER NOT NULL CHECK (byte_count>0 AND byte_count<=16777216),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  uploaded INTEGER NOT NULL DEFAULT 0 CHECK (uploaded IN (0,1)),
  PRIMARY KEY (attempt_id,ordinal),
  FOREIGN KEY (attempt_id,tenant_id) REFERENCES tenant_backup_artifact_attempts(id,tenant_id)
);
CREATE TABLE tenant_backup_container_inputs (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL CHECK (length(bundle_id)=32 AND bundle_id NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  object_size INTEGER NOT NULL CHECK (object_size>0),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  dataset_stats_json TEXT NOT NULL CHECK (json_valid(dataset_stats_json)),
  verified_at INTEGER NOT NULL CHECK (verified_at>=0),
  PRIMARY KEY (operation_id,bundle_id),
  FOREIGN KEY (operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE platform_settings_documents (
  category TEXT NOT NULL PRIMARY KEY CHECK(length(category) BETWEEN 1 AND 128),
  document_json TEXT NOT NULL CHECK(
    json_valid(document_json) AND
    json_type(document_json)='object' AND
    length(CAST(document_json AS BLOB))<=1048576
  ),
  version TEXT NOT NULL CHECK(
    length(version)=23 AND
    version LIKE 'sha256:%' AND
    substr(version,8) NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK(revision>0),
  projection_state TEXT NOT NULL CHECK(projection_state IN ('pending','applied')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  projected_at INTEGER CHECK(projected_at IS NULL OR projected_at>=updated_at),
  reconciled_at INTEGER NOT NULL DEFAULT 0 CHECK(reconciled_at>=0),
  CHECK((projection_state='pending' AND projected_at IS NULL) OR
    (projection_state='applied' AND projected_at IS NOT NULL))
) STRICT;
CREATE TABLE settings_legacy_import_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK(id=1),
  state_json TEXT NOT NULL CHECK(
    json_valid(state_json) AND
    json_type(state_json)='object' AND
    length(CAST(state_json AS BLOB))<=262144
  ),
  revision INTEGER NOT NULL CHECK(revision>0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
) STRICT;
CREATE TABLE tenant_backup_export_datasets (
  attempt_id TEXT NOT NULL REFERENCES tenant_backup_artifact_attempts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<=65535),
  dataset_id TEXT NOT NULL CHECK(length(dataset_id) BETWEEN 1 AND 256),
  row_count INTEGER NOT NULL CHECK(row_count>0),
  byte_count INTEGER NOT NULL CHECK(byte_count>0),
  byte_offset INTEGER NOT NULL CHECK(byte_offset>=0),
  sealed_sha256 TEXT NOT NULL CHECK(length(sealed_sha256) BETWEEN 56 AND 512
    AND length(sealed_sha256)%2=0 AND sealed_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(attempt_id,ordinal)
);
CREATE TABLE tenant_backup_export_spills (
  attempt_id TEXT NOT NULL REFERENCES tenant_backup_artifact_attempts(id) ON DELETE CASCADE,
  spill_id TEXT NOT NULL CHECK(length(spill_id)=36),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<=1000000),
  chunk INTEGER NOT NULL CHECK(chunk>=0 AND chunk<64),
  sealed TEXT NOT NULL CHECK(length(sealed) BETWEEN 56 AND 1200000
    AND length(sealed)%2=0 AND sealed NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(attempt_id,spill_id,chunk)
);
CREATE TABLE tenant_backup_input_frames (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL CHECK (length(bundle_id)=32 AND bundle_id NOT GLOB '*[^0-9a-f]*'),
  sequence INTEGER NOT NULL CHECK (sequence>=0),
  object_offset INTEGER NOT NULL CHECK (object_offset>=133),
  frame_bytes INTEGER NOT NULL CHECK (frame_bytes>=25),
  plain_offset INTEGER NOT NULL CHECK (plain_offset>=0),
  plain_bytes INTEGER NOT NULL CHECK (plain_bytes=frame_bytes-25),
  PRIMARY KEY (operation_id,bundle_id,sequence),
  FOREIGN KEY (operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE log_archive_batches (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Binding of the D1 database the rows are in (core rows can be in several).
  source_store TEXT NOT NULL,
  -- Dataset id of the source table, e.g. core.audit_log.
  source_table TEXT NOT NULL,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  row_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE tenant_backup_import_discards (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  decision TEXT CHECK (decision IS NULL OR decision IN ('none', 'discard')),
  decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= first_seen_at),
  schema_digests_json TEXT CHECK (
    schema_digests_json IS NULL OR (json_valid(schema_digests_json) AND length(schema_digests_json) <= 16384)
  ),
  -- When the discarded tenant's settings documents were deleted: a projection that read one
  -- before may still write its KV key until the longest scheduled run has ended.
  settings_deleted_at INTEGER CHECK (settings_deleted_at IS NULL OR settings_deleted_at >= first_seen_at),
  -- Progress of the final KV sweep per key prefix: where the listing continues, how many keys
  -- the current pass deleted, and whether one complete pass found nothing left.
  kv_sweep_json TEXT CHECK (
    kv_sweep_json IS NULL OR (json_valid(kv_sweep_json) AND length(kv_sweep_json) <= 8192)
  ),
  blocker_kind TEXT CHECK (
    blocker_kind IS NULL OR blocker_kind IN ('legal_hold', 'blocked_rows', 'schema_changed')
  ),
  blocker_json TEXT CHECK (
    blocker_json IS NULL OR (json_valid(blocker_json) AND length(blocker_json) <= 8192)
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= first_seen_at),
  FOREIGN KEY (operation_id, tenant_id) REFERENCES tenant_backup_operations(id, tenant_id),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (decision = 'discard' OR (
    schema_digests_json IS NULL AND settings_deleted_at IS NULL AND kv_sweep_json IS NULL
  )),
  CHECK ((blocker_kind IS NULL) = (blocker_json IS NULL)),
  CHECK (blocker_kind IS NULL OR decision = 'discard')
);
CREATE TABLE identity_mapping_test_users (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 4 AND 64 AND substr(id, 1, 3) = 'tu_'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  attributes_json TEXT NOT NULL CHECK (
    json_valid(attributes_json)
    AND json_type(attributes_json) = 'object'
    AND length(attributes_json) <= 8192
  ),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE identity_mapping_level_history (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('tenant_default', 'client')),
  client_id TEXT,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('settings', 'client', 'bulk_apply', 'restore')),
  bulk_id TEXT,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'aborted')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  committed_at INTEGER,
  last_reconciled_at INTEGER NOT NULL DEFAULT 0 CHECK (last_reconciled_at >= 0),
  receipt_acknowledged_at INTEGER CHECK (receipt_acknowledged_at >= 0),
  CHECK ((tier = 'tenant_default' AND client_id IS NULL) OR
         (tier = 'client' AND client_id IS NOT NULL AND length(client_id) > 0)),
  CHECK ((status = 'committed' AND committed_at IS NOT NULL AND committed_at >= created_at) OR
         (status <> 'committed' AND committed_at IS NULL)),
  CHECK ((tier = 'tenant_default' AND json_type(before_json) IN ('text', 'null') AND
           json_type(after_json) IN ('text', 'null')) OR
         (tier = 'client' AND json_type(before_json) IN ('object', 'null') AND
           json_type(after_json) IN ('object', 'null')))
);
CREATE TABLE identity_mapping_failures (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 256),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
  tier TEXT CHECK (tier IN ('client', 'tenant_default', 'platform_default')),
  set_id TEXT CHECK (length(set_id) BETWEEN 1 AND 200),
  first_at INTEGER NOT NULL CHECK (first_at BETWEEN 0 AND 9007199254740991),
  last_at INTEGER NOT NULL CHECK (last_at BETWEEN first_at AND 9007199254740991),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 9007199254740991)
) STRICT;
CREATE TABLE tenant_backup_replication_grants (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  credential_sha256 TEXT NOT NULL UNIQUE CHECK(length(credential_sha256)=64 AND credential_sha256 NOT GLOB '*[^0-9a-f]*'),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND length(CAST(scope_json AS BLOB))<=8192),
  scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=2592000000),
  creation_audit_id TEXT NOT NULL,
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at),
  revoked_by TEXT,
  revocation_audit_id TEXT,
  UNIQUE(id,tenant_id),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_audit_id IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_audit_id IS NOT NULL))
);
CREATE TABLE admin_audit_receipts (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at>=0)
) STRICT;
CREATE TABLE log_sign_in_attempt_receipts (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  failed_at INTEGER NOT NULL CHECK(failed_at>=0),
  logical_hmac TEXT NOT NULL CHECK(length(logical_hmac)=64),
  payload_hmac TEXT CHECK(length(payload_hmac)=64),
  state TEXT NOT NULL CHECK(state IN ('reserved','committed')),
  PRIMARY KEY(tenant_id,event_id),
  CHECK(state!='committed' OR payload_hmac IS NOT NULL)
) STRICT;
CREATE TABLE log_iceberg_event_receipts (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  expires_at INTEGER CHECK(expires_at>=0),
  state TEXT NOT NULL CHECK(state IN ('staged','published','erased')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE log_iceberg_subject_erasures (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sweeping','completed')),
  snapshot_id TEXT,
  scan_cursor_json TEXT,
  mutation_receipt_json TEXT,
  mutation_history_json TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(mutation_history_json AS BLOB))<=262144),
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK(removed_count>=0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id,source_dataset,subject_id)
) STRICT;
CREATE TABLE log_iceberg_erasure_artifacts (
  erasure_id TEXT NOT NULL REFERENCES log_iceberg_subject_erasures(id) ON DELETE CASCADE,
  table_uuid TEXT NOT NULL,
  path_digest TEXT NOT NULL CHECK(length(path_digest)=64),
  path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 2048),
  origin TEXT NOT NULL CHECK(origin IN ('committed','root_uncommitted')),
  owner_identity TEXT,
  operation_id TEXT,
  witness_snapshot_id TEXT,
  state TEXT NOT NULL DEFAULT 'found' CHECK(state IN ('found','live_output','removed')),
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(erasure_id,table_uuid,path_digest),
  CHECK((origin='committed' AND witness_snapshot_id IS NOT NULL) OR
    (origin='root_uncommitted' AND owner_identity IS NOT NULL AND operation_id IS NOT NULL))
) STRICT;
CREATE TABLE log_iceberg_retention_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  table_uuid TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  cutoff INTEGER NOT NULL CHECK(cutoff>=0),
  state TEXT NOT NULL CHECK(state IN ('pending','sweeping','completed')),
  snapshot_id TEXT,
  scan_cursor_json TEXT,
  mutation_receipt_json TEXT,
  mutation_history_json TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(mutation_history_json AS BLOB))<=262144),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(table_uuid,storage_generation,tenant_key,source_dataset)
) STRICT;
CREATE TABLE log_iceberg_retention_artifacts (
  retention_id TEXT NOT NULL REFERENCES log_iceberg_retention_jobs(id) ON DELETE CASCADE,
  table_uuid TEXT NOT NULL,
  path_digest TEXT NOT NULL CHECK(length(path_digest)=64),
  path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 2048),
  origin TEXT NOT NULL CHECK(origin IN ('committed','root_uncommitted')),
  owner_identity TEXT,
  operation_id TEXT,
  witness_snapshot_id TEXT,
  state TEXT NOT NULL DEFAULT 'found' CHECK(state IN ('found','live_output','removed')),
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(retention_id,table_uuid,path_digest),
  CHECK((origin='committed' AND witness_snapshot_id IS NOT NULL) OR
    (origin='root_uncommitted' AND owner_identity IS NOT NULL AND operation_id IS NOT NULL))
) STRICT;
CREATE TABLE log_iceberg_publications (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  record_id TEXT NOT NULL UNIQUE CHECK(length(record_id)=64),
  source_dataset TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  mode TEXT NOT NULL CHECK(mode IN ('pipeline','scheduled')),
  source_json TEXT NOT NULL CHECK(length(CAST(source_json AS BLOB))<=4096),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  source_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','published','aborted')),
  finalized INTEGER NOT NULL DEFAULT 0 CHECK(finalized IN (0,1)),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE log_iceberg_restore_activations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  plan_digest TEXT CHECK(plan_digest IS NULL OR (length(plan_digest)=64 AND plan_digest NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('pending','active','aborted')),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  activated_at INTEGER CHECK(activated_at>=0),
  CHECK(state='aborted' OR plan_digest IS NOT NULL),
  CHECK((state='active')=(activated_at IS NOT NULL))
) STRICT;
CREATE TABLE log_iceberg_restore_holds (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=64),
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  storage_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('holding','aborted')),
  expires_at INTEGER CHECK(expires_at>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  cleanup_completed_at INTEGER CHECK(cleanup_completed_at>=0),
  CHECK(cleanup_completed_at IS NULL OR state='aborted')
) STRICT;
CREATE TABLE log_iceberg_records (
  id TEXT NOT NULL PRIMARY KEY,
  publication_id TEXT REFERENCES log_iceberg_publications(id),
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  event_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  event_at INTEGER NOT NULL CHECK(event_at >= 0),
  ingested_at INTEGER NOT NULL CHECK(ingested_at >= 0),
  expires_at INTEGER CHECK(expires_at >= 0),
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac) = 64),
  envelope_digest TEXT NOT NULL CHECK(length(envelope_digest) = 64),
  header_json TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK(body_bytes BETWEEN 1 AND 4194304),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 64),
  batch_id TEXT,
  UNIQUE(tenant_key, source_dataset, event_id),
  UNIQUE(id, tenant_id)
) STRICT;
CREATE TABLE log_iceberg_record_parts (
  id TEXT NOT NULL PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES log_iceberg_records(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 63),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 65536),
  UNIQUE(record_id, part_index),
  FOREIGN KEY(record_id,tenant_id) REFERENCES log_iceberg_records(id,tenant_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE log_iceberg_export_batches (
  id TEXT NOT NULL PRIMARY KEY,
  storage_generation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  record_ids_json TEXT NOT NULL,
  checkpoint_json TEXT,
  receipt_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('selected','committed','verified','done')),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE log_iceberg_read_watermarks (
  id TEXT NOT NULL PRIMARY KEY,
  table_uuid TEXT NOT NULL,
  minimum_sequence_number INTEGER NOT NULL CHECK(minimum_sequence_number >= 0),
  snapshot_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE log_iceberg_outbox (
  id TEXT NOT NULL PRIMARY KEY,
  publication_id TEXT REFERENCES log_iceberg_publications(id),
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  subject_id TEXT,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  payload_key TEXT NOT NULL,
  payload_digest TEXT CHECK(payload_digest IS NULL OR length(payload_digest)=64),
  payload_bytes INTEGER CHECK(payload_bytes IS NULL OR payload_bytes BETWEEN 1 AND 4194304),
  expires_at INTEGER CHECK(expires_at>=0),
  state TEXT NOT NULL CHECK(state IN ('preparing','pending','queued','ingested','erased')),
  payload_erased_at INTEGER CHECK(payload_erased_at>=0),
  stream_obligation_at INTEGER CHECK(stream_obligation_at>=0),
  stream_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(stream_attempt_count>=0),
  stream_observed_count INTEGER NOT NULL DEFAULT 0 CHECK(stream_observed_count>=0),
  stream_acknowledged_at INTEGER CHECK(stream_acknowledged_at>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((payload_digest IS NULL) = (payload_bytes IS NULL)),
  CHECK(state IN ('preparing','erased') OR payload_digest IS NOT NULL),
  CHECK(payload_erased_at IS NULL OR state='erased'),
  CHECK((stream_attempt_count=0 AND stream_obligation_at IS NULL AND stream_acknowledged_at IS NULL)
    OR (stream_attempt_count>0 AND stream_obligation_at IS NOT NULL
      AND (stream_acknowledged_at IS NULL OR stream_acknowledged_at>=stream_obligation_at)))
) STRICT;
CREATE TABLE log_iceberg_backup_seen (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  record_id TEXT NOT NULL CHECK(length(record_id)=64),
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  page_ordinal INTEGER NOT NULL CHECK(page_ordinal>=0),
  PRIMARY KEY(operation_id,resource_id,record_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
) STRICT;
CREATE TRIGGER trg_admin_agent_grants_expiry_insert
BEFORE INSERT ON admin_agent_grants
WHEN NEW.status = 'active' AND (
  NEW.expires_at IS NULL
  OR NEW.expires_at < NEW.created_at + 3600000
  OR NEW.expires_at > NEW.created_at + 7776000000
)
BEGIN
  SELECT RAISE(ABORT, 'active Agent Grant expiry must be between 1 hour and 90 days');
END;
CREATE TRIGGER trg_admin_agent_grants_expiry_update
BEFORE UPDATE OF status, expires_at, updated_at ON admin_agent_grants
WHEN NEW.status = 'active' AND (
  NEW.expires_at IS NULL
  OR NEW.expires_at < NEW.updated_at + 3600000
  OR NEW.expires_at > NEW.updated_at + 7776000000
)
BEGIN
  SELECT RAISE(ABORT, 'active Agent Grant expiry must be between 1 hour and 90 days');
END;
CREATE TRIGGER trg_admin_agent_grants_require_snapshot_active_update
BEFORE UPDATE ON admin_agent_grants
FOR EACH ROW
WHEN NEW.status = 'active' AND CASE
  WHEN NEW.task_set_id IS NULL OR length(trim(NEW.task_set_id)) = 0 THEN 1
  WHEN NEW.task_set_version IS NULL OR NEW.task_set_version < 1 THEN 1
  WHEN NEW.scope_policy_id IS NULL OR length(trim(NEW.scope_policy_id)) = 0 THEN 1
  WHEN NEW.scope_policy_version IS NULL OR NEW.scope_policy_version < 1 THEN 1
  WHEN NEW.resolved_tools IS NULL OR json_valid(NEW.resolved_tools) = 0 THEN 1
  WHEN json_type(NEW.resolved_tools) <> 'array' OR json_array_length(NEW.resolved_tools) < 1 THEN 1
  WHEN NEW.resolved_scope_constraints IS NULL OR json_valid(NEW.resolved_scope_constraints) = 0 THEN 1
  WHEN json_type(NEW.resolved_scope_constraints) <> 'object' THEN 1
  WHEN NEW.access_snapshot_hash IS NULL OR length(NEW.access_snapshot_hash) <> 43 THEN 1
  WHEN NEW.access_snapshot_hash GLOB '*[^A-Za-z0-9_-]*' THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'agent_grant_versioned_snapshot_required');
END;
CREATE TRIGGER trg_admin_agent_grants_require_snapshot_insert
BEFORE INSERT ON admin_agent_grants
FOR EACH ROW
WHEN CASE
  WHEN NEW.task_set_id IS NULL OR length(trim(NEW.task_set_id)) = 0 THEN 1
  WHEN NEW.task_set_version IS NULL OR NEW.task_set_version < 1 THEN 1
  WHEN NEW.scope_policy_id IS NULL OR length(trim(NEW.scope_policy_id)) = 0 THEN 1
  WHEN NEW.scope_policy_version IS NULL OR NEW.scope_policy_version < 1 THEN 1
  WHEN NEW.resolved_tools IS NULL OR json_valid(NEW.resolved_tools) = 0 THEN 1
  WHEN json_type(NEW.resolved_tools) <> 'array' OR json_array_length(NEW.resolved_tools) < 1 THEN 1
  WHEN NEW.resolved_scope_constraints IS NULL OR json_valid(NEW.resolved_scope_constraints) = 0 THEN 1
  WHEN json_type(NEW.resolved_scope_constraints) <> 'object' THEN 1
  WHEN NEW.access_snapshot_hash IS NULL OR length(NEW.access_snapshot_hash) <> 43 THEN 1
  WHEN NEW.access_snapshot_hash GLOB '*[^A-Za-z0-9_-]*' THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'agent_grant_versioned_snapshot_required');
END;
CREATE TRIGGER trg_tenant_placement_migration_job_fencing
BEFORE UPDATE ON tenant_placement_migration_jobs
WHEN OLD.lease_owner IS NOT NULL AND (
  NEW.lease_owner IS NULL OR
  NEW.lease_owner <> OLD.lease_owner OR
  NEW.fencing_token <> OLD.fencing_token
)
AND NEW.status NOT IN ('waiting_retry', 'blocked', 'succeeded', 'canceled')
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_stale_lease');
END;
CREATE TRIGGER trg_tenant_placement_migration_job_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, control_operation_id,
                 target_isolation_policy, request_hash, idempotency_key,
                 retry_budget_started_at, requested_by, created_at
ON tenant_placement_migration_jobs
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_identity_immutable');
END;
CREATE TRIGGER trg_tenant_placement_migration_job_status_transition
BEFORE UPDATE OF status ON tenant_placement_migration_jobs
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('running', 'blocked', 'canceled')) OR
  (OLD.status = 'running' AND NEW.status IN ('waiting_retry', 'blocked', 'succeeded', 'canceled')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('running', 'blocked', 'canceled')) OR
  (OLD.status = 'blocked' AND NEW.status IN ('running', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_status_transition_invalid');
END;
CREATE TRIGGER trg_tenant_placement_migration_job_step_transition
BEFORE UPDATE OF current_step ON tenant_placement_migration_jobs
WHEN OLD.current_step <> NEW.current_step AND NOT (
  (OLD.current_step = 'wait_control' AND NEW.current_step = 'begin_route_cutover') OR
  (OLD.current_step = 'begin_route_cutover' AND NEW.current_step = 'prepare_lookup') OR
  (OLD.current_step = 'prepare_lookup' AND NEW.current_step = 'prepare_alias') OR
  (OLD.current_step = 'prepare_alias' AND NEW.current_step = 'commit_control') OR
  (OLD.current_step = 'commit_control' AND NEW.current_step = 'publish_registry') OR
  (OLD.current_step = 'publish_registry' AND NEW.current_step = 'activate_alias') OR
  (OLD.current_step = 'activate_alias' AND NEW.current_step = 'activate_lookup') OR
  (OLD.current_step = 'activate_lookup' AND NEW.current_step = 'verify_routes') OR
  (OLD.current_step = 'verify_routes' AND NEW.current_step = 'finalize_source') OR
  (OLD.current_step = 'finalize_source' AND NEW.current_step = 'complete')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_step_transition_invalid');
END;
CREATE TRIGGER trg_tenant_provisioning_placement_policy_immutable
BEFORE UPDATE OF isolation_policy ON tenant_provisioning_operations
BEGIN
  SELECT RAISE(ABORT, 'tenant_provisioning_placement_policy_immutable');
END;
CREATE TRIGGER tenant_backup_request_immutable
BEFORE UPDATE OF request_json, request_digest, tenant_id, kind, created_by, idempotency_key
ON tenant_backup_operations
WHEN OLD.request_json IS NOT NEW.request_json OR OLD.request_digest IS NOT NEW.request_digest
  OR OLD.tenant_id IS NOT NEW.tenant_id OR OLD.kind IS NOT NEW.kind
  OR OLD.created_by IS NOT NEW.created_by OR OLD.idempotency_key IS NOT NEW.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'backup request intent is immutable');
END;
CREATE TRIGGER tenant_backup_inventory_item_immutable
BEFORE UPDATE ON tenant_backup_execution_inventory_items
BEGIN SELECT RAISE(ABORT,'backup_inventory_item_immutable'); END;
CREATE TRIGGER tenant_backup_inventory_sealed_immutable
BEFORE UPDATE ON tenant_backup_execution_inventories WHEN OLD.state='sealed'
BEGIN SELECT RAISE(ABORT,'backup_inventory_sealed_immutable'); END;
CREATE TRIGGER tenant_backup_inventory_append_guard
BEFORE INSERT ON tenant_backup_execution_inventory_items
WHEN NOT EXISTS (SELECT 1 FROM tenant_backup_execution_inventories p
  WHERE p.operation_id=NEW.operation_id AND p.tenant_id=NEW.tenant_id
  AND p.state='building' AND p.item_count=NEW.ordinal)
BEGIN SELECT RAISE(ABORT,'backup_inventory_append_conflict'); END;
CREATE TRIGGER tenant_backup_inventory_append_progress
AFTER INSERT ON tenant_backup_execution_inventory_items
BEGIN
  UPDATE tenant_backup_execution_inventories SET item_count=item_count+1,chain_digest=NEW.chain_digest
  WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id;
END;
CREATE TRIGGER tenant_backup_inventory_identity_immutable
BEFORE UPDATE OF operation_id,tenant_id,request_digest,created_at ON tenant_backup_execution_inventories
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.request_digest IS NOT OLD.request_digest OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'backup_inventory_identity_immutable'); END;
CREATE TRIGGER tenant_backup_snapshot_resource_identity
BEFORE UPDATE OF operation_id,tenant_id,resource_id,snapshot_id ON tenant_backup_snapshot_resources
BEGIN SELECT RAISE(ABORT,'backup_snapshot_resource_immutable'); END;
CREATE TRIGGER tenant_backup_snapshot_resource_monotonic
BEFORE UPDATE OF cleaned ON tenant_backup_snapshot_resources WHEN OLD.cleaned=1 AND NEW.cleaned!=1
BEGIN SELECT RAISE(ABORT,'backup_snapshot_resource_regression'); END;
CREATE TRIGGER tenant_backup_cipher_header_immutable
BEFORE UPDATE OF attempt_id,tenant_id,header_hex ON tenant_backup_cipher_streams
BEGIN SELECT RAISE(ABORT,'backup_cipher_header_immutable'); END;
CREATE TRIGGER tenant_backup_cipher_reservation_immutable
BEFORE UPDATE ON tenant_backup_cipher_frames
BEGIN SELECT RAISE(ABORT,'backup_cipher_reservation_immutable'); END;
CREATE TRIGGER tenant_backup_snapshot_identity_immutable
BEFORE UPDATE OF id, tenant_id, tenant_key ON tenant_backup_snapshots
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.tenant_key IS NOT OLD.tenant_key
BEGIN SELECT RAISE(ABORT, 'snapshot_identity_immutable'); END;
CREATE TRIGGER tenant_backup_snapshot_state_monotonic
BEFORE UPDATE OF state ON tenant_backup_snapshots
WHEN (OLD.state='invalid' AND NEW.state!='invalid') OR (OLD.state='sealed' AND NEW.state='capturing')
BEGIN SELECT RAISE(ABORT,'snapshot_state_regression'); END;
CREATE TRIGGER tenant_backup_restore_target_identity
BEFORE UPDATE OF id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint ON tenant_backup_restore_targets
BEGIN SELECT RAISE(ABORT,'backup_restore_target_identity'); END;
CREATE TRIGGER tenant_backup_input_receipt_immutable
BEFORE UPDATE ON tenant_backup_input_receipts
BEGIN SELECT RAISE(ABORT,'backup_input_receipt_immutable'); END;
CREATE TRIGGER tenant_backup_dataset_inspection_immutable
BEFORE UPDATE ON tenant_backup_dataset_inspections
BEGIN SELECT RAISE(ABORT,'backup_dataset_inspection_immutable'); END;
CREATE TRIGGER tenant_backup_input_validation_immutable
BEFORE UPDATE ON tenant_backup_input_validations
BEGIN SELECT RAISE(ABORT,'backup_input_validation_immutable'); END;
CREATE TRIGGER tenant_backup_publication_immutable
BEFORE UPDATE ON tenant_backup_publications
BEGIN SELECT RAISE(ABORT,'backup_publication_immutable'); END;
CREATE TRIGGER tenant_backup_export_manifest_immutable
BEFORE UPDATE ON tenant_backup_export_manifests
BEGIN SELECT RAISE(ABORT,'backup_export_manifest_immutable'); END;
CREATE TRIGGER tenant_backup_upload_identity_immutable BEFORE UPDATE ON tenant_backup_uploads
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.created_by IS NOT OLD.created_by
 OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.expected_bytes IS NOT OLD.expected_bytes
 OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR NEW.object_key IS NOT OLD.object_key
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.multipart_id IS NOT NULL AND NEW.multipart_id IS NOT OLD.multipart_id)
 OR (OLD.object_version IS NOT NULL AND NEW.object_version IS NOT OLD.object_version)
 OR (OLD.object_etag IS NOT NULL AND NEW.object_etag IS NOT OLD.object_etag)
 OR (OLD.verified_sha256 IS NOT NULL AND NEW.verified_sha256 IS NOT OLD.verified_sha256)
 OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'backup_upload_immutable'); END;
CREATE TRIGGER tenant_backup_upload_state_transition BEFORE UPDATE OF state ON tenant_backup_uploads
WHEN NOT (
  NEW.state=OLD.state OR
  (OLD.state='allocating' AND NEW.state IN ('uploading','cancelling')) OR
  (OLD.state='uploading' AND NEW.state IN ('completing','cancelling')) OR
  (OLD.state='completing' AND NEW.state IN ('uploaded','cancelling')) OR
  (OLD.state='uploaded' AND NEW.state='cancelling') OR
  (OLD.state='cancelling' AND NEW.state='deleted')
)
BEGIN SELECT RAISE(ABORT,'backup_upload_state_transition'); END;
CREATE TRIGGER tenant_backup_upload_part_immutable BEFORE UPDATE ON tenant_backup_upload_parts
WHEN NEW.upload_id IS NOT OLD.upload_id OR NEW.part_number IS NOT OLD.part_number
 OR NEW.byte_count IS NOT OLD.byte_count OR NEW.sha256 IS NOT OLD.sha256
 OR (OLD.etag IS NOT NULL AND NEW.etag IS NOT OLD.etag)
BEGIN SELECT RAISE(ABORT,'backup_upload_part_immutable'); END;
CREATE TRIGGER tenant_backup_operation_input_authorized
BEFORE INSERT ON tenant_backup_operation_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_uploads u
  JOIN tenant_backup_operations o ON o.id=NEW.operation_id AND o.tenant_id=NEW.tenant_id
  WHERE u.id=NEW.upload_id AND u.tenant_id=NEW.tenant_id AND u.created_by=o.created_by
    AND o.kind='import' AND o.created_at=NEW.bound_at
    AND u.state='uploaded' AND u.object_key=NEW.object_key
    AND u.object_version=NEW.object_version AND u.object_etag=NEW.object_etag
    AND u.expected_bytes=NEW.size_bytes AND u.verified_sha256=NEW.digest_sha256
    AND u.completed_at IS NOT NULL AND u.completed_at<=NEW.bound_at
    AND u.created_at<=NEW.bound_at AND u.expires_at>NEW.bound_at
)
BEGIN SELECT RAISE(ABORT,'backup_operation_input_unauthorized'); END;
CREATE TRIGGER tenant_backup_operation_input_immutable
BEFORE UPDATE ON tenant_backup_operation_inputs
BEGIN SELECT RAISE(ABORT,'backup_operation_input_immutable'); END;
CREATE TRIGGER tenant_backup_active_input_keys_immutable
BEFORE UPDATE OF active_input_key_challenges_json ON tenant_backup_operations
WHEN OLD.active_input_key_challenges_json IS NOT NULL
  OR NEW.active_input_key_challenges_json IS NULL
BEGIN SELECT RAISE(ABORT,'backup_active_input_keys_immutable'); END;
CREATE TRIGGER tenant_backup_key_handoff_input_authorized
BEFORE INSERT ON tenant_backup_key_handoffs
WHEN NOT (
  (NEW.input_upload_id IS NULL AND EXISTS (
    SELECT 1 FROM tenant_backup_operations o
    WHERE o.id=NEW.operation_id AND o.tenant_id=NEW.tenant_id AND o.kind='export'
  )) OR
  (NEW.input_upload_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tenant_backup_operation_inputs i
    JOIN tenant_backup_operations o ON o.id=i.operation_id AND o.tenant_id=i.tenant_id
    WHERE i.operation_id=NEW.operation_id AND i.tenant_id=NEW.tenant_id
      AND i.upload_id=NEW.input_upload_id AND o.kind='import'
  ))
)
BEGIN SELECT RAISE(ABORT,'backup_key_handoff_input_unauthorized'); END;
CREATE TRIGGER tenant_backup_restore_plan_item_immutable
BEFORE UPDATE ON tenant_backup_restore_plan_inventory_items
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_item_immutable'); END;
CREATE TRIGGER tenant_backup_restore_plan_sealed_immutable
BEFORE UPDATE ON tenant_backup_restore_plan_inventories WHEN OLD.state='sealed'
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_sealed_immutable'); END;
CREATE TRIGGER tenant_backup_restore_plan_append_guard
BEFORE INSERT ON tenant_backup_restore_plan_inventory_items
WHEN NOT EXISTS (SELECT 1 FROM tenant_backup_restore_plan_inventories p
  WHERE p.operation_id=NEW.operation_id AND p.tenant_id=NEW.tenant_id
  AND p.state='building' AND p.item_count=NEW.ordinal)
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_append_conflict'); END;
CREATE TRIGGER tenant_backup_restore_plan_append_progress
AFTER INSERT ON tenant_backup_restore_plan_inventory_items
BEGIN
  UPDATE tenant_backup_restore_plan_inventories SET item_count=item_count+1,chain_digest=NEW.chain_digest
  WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id;
END;
CREATE TRIGGER tenant_backup_restore_plan_identity_immutable
BEFORE UPDATE OF operation_id,tenant_id,input_inventory_digest,created_at ON tenant_backup_restore_plan_inventories
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.input_inventory_digest IS NOT OLD.input_inventory_digest OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_identity_immutable'); END;
CREATE TRIGGER tenant_backup_restore_target_monotonic
BEFORE UPDATE ON tenant_backup_restore_targets
WHEN NEW.fencing_token<OLD.fencing_token
  OR (NEW.fencing_token=OLD.fencing_token AND NEW.owner!=OLD.owner)
  OR (OLD.state='invalid' AND NEW.state!='invalid')
  OR (OLD.state='sealed' AND NEW.state='loading')
BEGIN SELECT RAISE(ABORT,'backup_restore_target_regression'); END;
CREATE TRIGGER tenant_backup_restore_cleanup_receipt_immutable
BEFORE UPDATE ON tenant_backup_restore_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'backup_restore_cleanup_receipt_immutable'); END;
CREATE TRIGGER tenant_backup_admin_mapping_head_authorized
BEFORE INSERT ON tenant_backup_admin_mapping_heads
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_operations o
  WHERE o.id=NEW.operation_id AND o.tenant_id=NEW.tenant_id AND o.kind='import'
    AND o.state='waiting' AND o.phase='await_restore_approval'
    AND o.lease_owner IS NULL AND o.lease_expires_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_not_waiting'); END;
CREATE TRIGGER tenant_backup_admin_mapping_insert_authorized
BEFORE INSERT ON tenant_backup_admin_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_admin_mapping_heads h
  JOIN tenant_backup_operations o ON o.id=h.operation_id AND o.tenant_id=h.tenant_id
  WHERE h.operation_id=NEW.operation_id AND h.tenant_id=NEW.tenant_id AND h.state='open'
    AND o.kind='import' AND o.state='waiting' AND o.phase='await_restore_approval'
) OR NOT EXISTS (
  SELECT 1 FROM tenant_backup_validation_records r
  JOIN tenant_backup_input_validations v
    ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
  WHERE v.operation_id=NEW.operation_id AND v.tenant_id=NEW.tenant_id
    AND r.collection='admin.admin_users'
    AND r.record_id=json_array(json_array('text',NEW.source_admin_id))
) OR NOT EXISTS (
  SELECT 1 FROM admin_users u
  WHERE u.id=NEW.target_admin_id AND u.tenant_id=NEW.tenant_id
    AND u.is_active=1 AND u.status='active'
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_invalid'); END;
CREATE TRIGGER tenant_backup_admin_mapping_update_authorized
BEFORE UPDATE ON tenant_backup_admin_mappings
WHEN OLD.operation_id<>NEW.operation_id OR OLD.tenant_id<>NEW.tenant_id
  OR OLD.source_admin_id<>NEW.source_admin_id
  OR NOT EXISTS (
    SELECT 1 FROM tenant_backup_admin_mapping_heads h
    JOIN tenant_backup_operations o ON o.id=h.operation_id AND o.tenant_id=h.tenant_id
    WHERE h.operation_id=OLD.operation_id AND h.tenant_id=OLD.tenant_id AND h.state='open'
      AND o.kind='import' AND o.state='waiting' AND o.phase='await_restore_approval'
  ) OR NOT EXISTS (
    SELECT 1 FROM admin_users u
    WHERE u.id=NEW.target_admin_id AND u.tenant_id=NEW.tenant_id
      AND u.is_active=1 AND u.status='active'
  )
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_invalid'); END;
CREATE TRIGGER tenant_backup_admin_mapping_delete_authorized
BEFORE DELETE ON tenant_backup_admin_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_admin_mapping_heads h
  JOIN tenant_backup_operations o ON o.id=h.operation_id AND o.tenant_id=h.tenant_id
  WHERE h.operation_id=OLD.operation_id AND h.tenant_id=OLD.tenant_id AND h.state='open'
    AND o.kind='import' AND o.state='waiting' AND o.phase='await_restore_approval'
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_invalid'); END;
CREATE TRIGGER tenant_backup_admin_mapping_insert_revision
AFTER INSERT ON tenant_backup_admin_mappings
BEGIN
  UPDATE tenant_backup_admin_mapping_heads
  SET revision=revision+1,updated_by=NEW.updated_by,updated_at=NEW.updated_at
  WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND state='open';
END;
CREATE TRIGGER tenant_backup_admin_mapping_update_revision
AFTER UPDATE OF target_admin_id ON tenant_backup_admin_mappings
BEGIN
  UPDATE tenant_backup_admin_mapping_heads
  SET revision=revision+1,updated_by=NEW.updated_by,updated_at=NEW.updated_at
  WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND state='open';
END;
CREATE TRIGGER tenant_backup_admin_mapping_delete_revision
AFTER DELETE ON tenant_backup_admin_mappings
BEGIN
  UPDATE tenant_backup_admin_mapping_heads
  SET revision=revision+1,updated_by=OLD.updated_by,updated_at=OLD.updated_at
  WHERE operation_id=OLD.operation_id AND tenant_id=OLD.tenant_id AND state='open';
END;
CREATE TRIGGER tenant_backup_admin_mapping_freeze_resume
AFTER UPDATE OF state ON tenant_backup_admin_mapping_heads
WHEN OLD.state='open' AND NEW.state='frozen'
BEGIN
  UPDATE tenant_backup_operations
  SET state='queued',revision=revision+1,fencing_token=fencing_token+1,updated_at=NEW.approved_at,
    next_attempt_at=0,failure_count=0,last_error_code=NULL
  WHERE id=NEW.operation_id AND tenant_id=NEW.tenant_id AND kind='import'
    AND state='waiting' AND phase='await_restore_approval'
    AND revision=NEW.approval_operation_revision
    AND lease_owner IS NULL AND lease_expires_at IS NULL AND updated_at<=NEW.approved_at;
  SELECT RAISE(ABORT,'backup_admin_mapping_approval_stale') WHERE changes()<>1;
END;
CREATE TRIGGER tenant_backup_admin_mapping_head_immutable
BEFORE UPDATE ON tenant_backup_admin_mapping_heads
WHEN OLD.state='frozen'
  OR NEW.operation_id<>OLD.operation_id OR NEW.tenant_id<>OLD.tenant_id
  OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_immutable'); END;
CREATE TRIGGER tenant_backup_restored_holds_immutable_update
BEFORE UPDATE ON tenant_backup_restored_holds
BEGIN SELECT RAISE(ABORT,'backup_restored_hold_immutable'); END;
CREATE TRIGGER tenant_backup_restored_holds_immutable_delete
BEFORE DELETE ON tenant_backup_restored_holds
BEGIN SELECT RAISE(ABORT,'backup_restored_hold_immutable'); END;
CREATE TRIGGER tenant_backup_r2_restore_identity_immutable
BEFORE UPDATE ON tenant_backup_r2_restore_objects
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.dataset_id IS NOT OLD.dataset_id
  OR NEW.object_id IS NOT OLD.object_id
  OR NEW.source_object_key IS NOT OLD.source_object_key
  OR NEW.source_encoding IS NOT OLD.source_encoding
  OR NEW.write_mode IS NOT OLD.write_mode
  OR NEW.target_bucket_binding IS NOT OLD.target_bucket_binding
  OR NEW.target_object_key IS NOT OLD.target_object_key
  OR NEW.object_sha256 IS NOT OLD.object_sha256
  OR NEW.total_bytes IS NOT OLD.total_bytes
  OR NEW.chunk_count IS NOT OLD.chunk_count
  OR NEW.context_json IS NOT OLD.context_json
  OR NEW.http_metadata_json IS NOT OLD.http_metadata_json
  OR NEW.custom_metadata_json IS NOT OLD.custom_metadata_json
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.multipart_id IS NOT NULL AND NEW.multipart_id IS NOT OLD.multipart_id)
  OR (OLD.object_version IS NOT NULL AND NEW.object_version IS NOT OLD.object_version)
  OR (OLD.object_etag IS NOT NULL AND NEW.object_etag IS NOT OLD.object_etag)
  OR (OLD.stored_sha256 IS NOT NULL AND NEW.stored_sha256 IS NOT OLD.stored_sha256)
  OR (OLD.target_key_version IS NOT NULL AND NEW.target_key_version IS NOT OLD.target_key_version)
  OR (OLD.target_encryption_scope IS NOT NULL AND NEW.target_encryption_scope IS NOT OLD.target_encryption_scope)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_identity'); END;
CREATE TRIGGER tenant_backup_r2_restore_state_transition
BEFORE UPDATE OF state ON tenant_backup_r2_restore_objects
WHEN NOT (
  NEW.state=OLD.state
  OR (OLD.state='allocating' AND NEW.state IN ('uploading','cancelling'))
  OR (OLD.state='uploading' AND NEW.state IN ('completing','cancelling'))
  OR (OLD.state='completing' AND NEW.state IN ('completed','cancelling'))
  OR (OLD.state='completed' AND NEW.state='cancelling')
  OR (OLD.state='cancelling' AND NEW.state='deleted')
)
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_state_transition'); END;
CREATE TRIGGER tenant_backup_r2_restore_part_immutable
BEFORE UPDATE ON tenant_backup_r2_restore_parts
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.dataset_id IS NOT OLD.dataset_id
  OR NEW.object_id IS NOT OLD.object_id
  OR NEW.chunk_index IS NOT OLD.chunk_index
  OR NEW.byte_count IS NOT OLD.byte_count
  OR NEW.chunk_sha256 IS NOT OLD.chunk_sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.target_part_etag IS NOT NULL AND NEW.target_part_etag IS NOT OLD.target_part_etag)
  OR (OLD.staging_object_key IS NOT NULL AND NEW.staging_object_key IS NOT OLD.staging_object_key)
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_part_identity'); END;
CREATE TRIGGER tenant_backup_r2_restore_log_records_immutable
BEFORE UPDATE OF log_records_json ON tenant_backup_r2_restore_objects
WHEN OLD.log_records_json IS NOT NULL AND NEW.log_records_json IS NOT OLD.log_records_json
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_identity'); END;
CREATE TRIGGER tenant_backup_r2_restore_log_records_encoding_insert
BEFORE INSERT ON tenant_backup_r2_restore_objects
WHEN NEW.log_records_json IS NOT NULL
  AND NEW.source_encoding<>'log_chunk_records_v1'
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_encoding'); END;
CREATE TRIGGER tenant_backup_r2_restore_log_records_encoding_update
BEFORE UPDATE OF log_records_json ON tenant_backup_r2_restore_objects
WHEN NEW.log_records_json IS NOT NULL
  AND NEW.source_encoding<>'log_chunk_records_v1'
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_encoding'); END;
CREATE TRIGGER tenant_backup_r2_restore_log_records_completed
BEFORE UPDATE OF state ON tenant_backup_r2_restore_objects
WHEN NEW.state='completed'
  AND NEW.source_encoding='log_chunk_records_v1'
  AND NEW.log_records_json IS NULL
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_required'); END;
CREATE TRIGGER tenant_backup_r2_retired_generations_identity_immutable
BEFORE UPDATE OF id, tenant_key, bucket_binding, object_catalog_id, object_key,
  replacement_object_key, reason, key_registry_id, previous_key_version,
  replacement_key_version, record_count, created_at
ON tenant_backup_r2_retired_generations
BEGIN
  SELECT RAISE(ABORT, 'tenant_backup_r2_retired_generation_immutable');
END;
CREATE TRIGGER tenant_backup_r2_retired_generations_accounting_monotonic
BEFORE UPDATE OF accounting_applied ON tenant_backup_r2_retired_generations
WHEN NOT (OLD.accounting_applied = 0 AND NEW.accounting_applied = 1)
BEGIN
  SELECT RAISE(ABORT, 'tenant_backup_r2_retired_generation_accounting');
END;
CREATE TRIGGER trg_tenant_backup_restored_hold_objects_immutable
BEFORE UPDATE ON tenant_backup_restored_hold_objects
BEGIN
  SELECT RAISE(ABORT, 'tenant_backup_restored_hold_object_immutable');
END;
CREATE TRIGGER tenant_backup_admin_mapping_freeze_complete
BEFORE UPDATE OF state ON tenant_backup_admin_mapping_heads
WHEN OLD.state='open' AND NEW.state='frozen' AND (
  NEW.revision<>OLD.revision OR NEW.tenant_id<>OLD.tenant_id
  OR EXISTS (
    SELECT 1 FROM tenant_backup_validation_records r
    JOIN tenant_backup_input_validations v
      ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
    WHERE v.operation_id=OLD.operation_id AND v.tenant_id=OLD.tenant_id
      AND r.collection='admin.admin_users'
      AND NOT EXISTS (
        SELECT 1 FROM tenant_backup_admin_mappings m
        WHERE m.operation_id=OLD.operation_id AND m.tenant_id=OLD.tenant_id
          AND json_array(json_array('text',m.source_admin_id))=r.record_id
      )
  ) OR EXISTS (
    SELECT 1 FROM tenant_backup_admin_mappings m
    LEFT JOIN admin_users u
      ON u.id=m.target_admin_id AND u.tenant_id=m.tenant_id
      AND u.is_active=1 AND u.status='active'
    WHERE m.operation_id=OLD.operation_id AND m.tenant_id=OLD.tenant_id
      AND (
        u.id IS NULL OR NOT EXISTS (
          SELECT 1 FROM tenant_backup_validation_records r
          JOIN tenant_backup_input_validations v
            ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
          WHERE v.operation_id=m.operation_id AND v.tenant_id=m.tenant_id
            AND r.collection='admin.admin_users'
            AND r.record_id=json_array(json_array('text',m.source_admin_id))
        )
      )
  )
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_incomplete'); END;
CREATE TRIGGER tenant_backup_container_inputs_immutable
BEFORE UPDATE ON tenant_backup_container_inputs
BEGIN SELECT RAISE(ABORT,'tenant_backup_container_input_immutable'); END;
CREATE TRIGGER tenant_backup_export_dataset_immutable
BEFORE UPDATE ON tenant_backup_export_datasets
BEGIN SELECT RAISE(ABORT,'backup_export_dataset_immutable'); END;
CREATE TRIGGER tenant_backup_export_spill_immutable
BEFORE UPDATE ON tenant_backup_export_spills
BEGIN SELECT RAISE(ABORT,'backup_export_spill_immutable'); END;
CREATE TRIGGER tenant_backup_input_frames_immutable
BEFORE UPDATE ON tenant_backup_input_frames
BEGIN SELECT RAISE(ABORT,'tenant_backup_input_frame_immutable'); END;
CREATE TRIGGER tenant_backup_import_discard_decision_final
BEFORE UPDATE OF operation_id, tenant_id, first_seen_at, decision, decided_at, schema_digests_json
ON tenant_backup_import_discards
WHEN OLD.decision IS NOT NULL OR NEW.operation_id <> OLD.operation_id
  OR NEW.tenant_id <> OLD.tenant_id OR NEW.first_seen_at <> OLD.first_seen_at
BEGIN SELECT RAISE(ABORT, 'backup_import_discard_final'); END;
CREATE TRIGGER tenant_backup_replication_grant_immutable
BEFORE UPDATE ON tenant_backup_replication_grants
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.created_by IS NOT OLD.created_by
  OR NEW.credential_sha256 IS NOT OLD.credential_sha256 OR NEW.scope_json IS NOT OLD.scope_json
  OR NEW.scope_sha256 IS NOT OLD.scope_sha256 OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.creation_audit_id IS NOT OLD.creation_audit_id
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at
    OR NEW.revoked_by IS NOT OLD.revoked_by OR NEW.revocation_audit_id IS NOT OLD.revocation_audit_id))
BEGIN SELECT RAISE(ABORT,'backup_replication_grant_immutable'); END;
CREATE INDEX idx_tenant_database_registry_status
  ON tenant_database_registry(status, provider, role);
CREATE INDEX idx_tenant_database_registry_binding_ref
  ON tenant_database_registry(binding_ref);
CREATE INDEX idx_tenant_database_registry_deployment_target
  ON tenant_database_registry(deployment_target, worker_shard);
CREATE INDEX idx_tenant_database_active_pointers_generation
  ON tenant_database_active_pointers(tenant_id, generation);
CREATE INDEX idx_tenant_database_stats_warning
  ON tenant_database_stats(warning_state, role);
CREATE INDEX idx_tenant_database_stats_checked_at
  ON tenant_database_stats(stats_checked_at);
CREATE INDEX idx_tenant_discovery_indexes_subject
  ON tenant_discovery_indexes(tenant_id, subject_id, index_kind);
CREATE INDEX idx_tenant_discovery_indexes_freshness
  ON tenant_discovery_indexes(status, indexed_at, source_updated_at);
CREATE INDEX idx_admin_destination_capabilities_lookup
  ON admin_destination_capabilities(capability, enabled);
CREATE INDEX idx_log_chunk_record_index_time
  ON log_chunk_record_index(tenant_key, log_type, plane, event_at);
CREATE INDEX idx_log_chunk_record_index_object
  ON log_chunk_record_index(object_catalog_id);
CREATE INDEX idx_log_chunk_record_index_status
  ON log_chunk_record_index(status, created_at);
CREATE INDEX idx_logging_delivery_event_aggregates_summary
  ON logging_delivery_event_aggregates(bucket_start_at, bucket_shard, lane, status);
CREATE INDEX idx_logging_delivery_event_aggregates_tenant
  ON logging_delivery_event_aggregates(tenant_key, bucket_start_at, bucket_shard, lane, status);
CREATE INDEX idx_logging_key_versions_status
  ON logging_key_versions(status, created_at);
CREATE INDEX idx_logging_message_idempotency_expiry
  ON logging_message_idempotency_keys(status, dedupe_until);
CREATE INDEX idx_logging_message_idempotency_job
  ON logging_message_idempotency_keys(message_job_id);
CREATE INDEX idx_agent_management_execution_lease
  ON agent_management_executions(status, lease_expires_at);
CREATE INDEX idx_provider_reprojection_tenant_status
  ON provider_reprojection_tenant_state(plugin_id, desired_revision, status, tenant_id);
CREATE INDEX idx_tenant_runtime_registry_snapshots_active
  ON tenant_runtime_registry_snapshots(
    status,
    expires_at,
    backend_provider,
    placement_policy
  );
CREATE INDEX idx_admin_agent_delegation_jti_expiry
  ON admin_agent_delegation_jtis(expires_at);
CREATE UNIQUE INDEX idx_admin_agent_grants_active_unique
  ON admin_agent_grants(tenant_id, delegator_id, client_id, active_uniqueness_key);
CREATE INDEX idx_admin_agent_grants_client
  ON admin_agent_grants(tenant_id, client_id, status);
CREATE INDEX idx_admin_agent_grants_delegator
  ON admin_agent_grants(tenant_id, delegator_id, status);
CREATE INDEX idx_admin_agent_grants_management_mode
  ON admin_agent_grants(tenant_id, management_mode, status);
CREATE INDEX idx_admin_agent_grants_principal
  ON admin_agent_grants(machine_principal_id, status);
CREATE INDEX idx_admin_agent_login_handoffs_pending
  ON admin_agent_login_handoffs(status, expires_at);
CREATE INDEX idx_admin_agent_login_handoffs_target
  ON admin_agent_login_handoffs(target_tenant_id, created_at DESC);
CREATE INDEX idx_admin_agent_mcp_sessions_admission
  ON admin_agent_mcp_sessions(tenant_id, grant_id, client_id, expires_at);
CREATE INDEX idx_admin_agent_mcp_sessions_expiration
  ON admin_agent_mcp_sessions(expires_at, absolute_expires_at);
CREATE INDEX idx_admin_agent_token_families_client
  ON admin_agent_token_families(tenant_id, client_id, status);
CREATE INDEX idx_admin_agent_token_families_finalization
  ON admin_agent_token_families(status, created_at);
CREATE INDEX idx_admin_agent_token_families_grant
  ON admin_agent_token_families(tenant_id, grant_id, grant_generation, status);
CREATE INDEX idx_admin_agent_token_families_revocation_outbox
  ON admin_agent_token_families(tenant_id, revocation_outbox_id, family_id);
CREATE INDEX idx_admin_agent_token_revocation_pending
  ON admin_agent_token_revocation_outbox(status, next_attempt_at, processing_lease_expires_at);
CREATE INDEX idx_admin_attr_values_attr ON admin_attribute_values(admin_attribute_id);
CREATE INDEX idx_admin_attr_values_expires ON admin_attribute_values(expires_at);
CREATE INDEX idx_admin_attr_values_lookup
  ON admin_attribute_values(admin_user_id, admin_attribute_id, value);
CREATE INDEX idx_admin_attr_values_user ON admin_attribute_values(admin_user_id);
CREATE INDEX idx_admin_attributes_name ON admin_attributes(tenant_id, name);
CREATE INDEX idx_admin_attributes_type ON admin_attributes(attribute_type);
CREATE INDEX idx_admin_audit_actor_type
  ON admin_audit_log(tenant_id, actor_type, created_at DESC);
CREATE INDEX idx_admin_audit_coverage_status_state
  ON admin_audit_coverage_status(status, criticality, updated_at);
CREATE INDEX idx_admin_audit_grant
  ON admin_audit_log(grant_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_action ON admin_audit_log(action, created_at DESC);
CREATE INDEX idx_admin_audit_log_detail_object_catalog
  ON admin_audit_log(detail_object_catalog_id);
CREATE INDEX idx_admin_audit_log_request ON admin_audit_log(request_id);
CREATE INDEX idx_admin_audit_log_resource ON admin_audit_log(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_tenant_time ON admin_audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_user ON admin_audit_log(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_database_connection_usages_connection
  ON admin_database_connection_usages(connection_id, is_active);
CREATE INDEX idx_admin_database_connections_provider
  ON admin_database_connections(provider, status, is_active);
CREATE INDEX idx_admin_destination_health_events_destination
  ON admin_destination_health_events(destination_id, checked_at);
CREATE INDEX idx_admin_destination_health_events_status
  ON admin_destination_health_events(next_health_status, checked_at);
CREATE INDEX idx_admin_destinations_health
  ON admin_destinations(health_status, last_health_check_at);
CREATE INDEX idx_admin_destinations_kind_provider
  ON admin_destinations(destination_kind, provider);
CREATE INDEX idx_admin_destinations_scope_name_active
  ON admin_destinations(scope_type, scope_id, name, deleted_at);
CREATE INDEX idx_admin_destinations_scope_status
  ON admin_destinations(scope_type, scope_id, lifecycle_status);
CREATE INDEX idx_admin_invitation_enrollments_expiry
  ON admin_invitation_enrollments(expires_at);
CREATE INDEX idx_admin_invitation_enrollments_invitation
  ON admin_invitation_enrollments(invitation_id, expires_at);
CREATE INDEX idx_admin_invitations_code_hash
  ON admin_invitations(code_hash, status, expires_at);
CREATE INDEX idx_admin_invitations_email
  ON admin_invitations(tenant_id, email, status);
CREATE INDEX idx_admin_invitations_tenant_status
  ON admin_invitations(tenant_id, status, created_at DESC);
CREATE INDEX idx_admin_ip_allowlist_enabled ON admin_ip_allowlist(enabled, tenant_id);
CREATE INDEX idx_admin_ip_allowlist_tenant ON admin_ip_allowlist(tenant_id, enabled);
CREATE INDEX idx_admin_ip_allowlist_version ON admin_ip_allowlist(tenant_id, ip_version, enabled);
CREATE INDEX idx_admin_jobs_cleanup
  ON admin_jobs(status, completed_at);
CREATE INDEX idx_admin_jobs_next_run
  ON admin_jobs(status, next_run_at, updated_at);
CREATE INDEX idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);
CREATE INDEX idx_admin_jobs_status
  ON admin_jobs(tenant_id, status, created_at DESC);
CREATE INDEX idx_admin_jobs_tenant
  ON admin_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_admin_jobs_type
  ON admin_jobs(tenant_id, job_type, created_at DESC);
CREATE INDEX idx_admin_logging_critical_policies_destination
  ON admin_logging_critical_policies(destination_id, status);
CREATE INDEX idx_admin_logging_critical_policies_status
  ON admin_logging_critical_policies(status, updated_at);
CREATE INDEX idx_admin_logging_sensitive_detail_policy_scope
  ON admin_logging_sensitive_detail_policies(log_type, plane, deleted_at);
CREATE INDEX idx_admin_logging_sensitive_detail_policy_status
  ON admin_logging_sensitive_detail_policies(status, updated_at);
CREATE INDEX idx_admin_login_attempts_email ON admin_login_attempts(tenant_id, email, created_at DESC);
CREATE INDEX idx_admin_login_attempts_ip ON admin_login_attempts(ip_address, created_at DESC);
CREATE INDEX idx_admin_login_attempts_success ON admin_login_attempts(success, created_at DESC);
CREATE INDEX idx_admin_login_attempts_time ON admin_login_attempts(created_at);
CREATE INDEX idx_admin_machine_assertion_jti_expires
  ON admin_machine_assertion_jti(expires_at);
CREATE INDEX idx_admin_machine_credential_tenant_scopes_credential
  ON admin_machine_credential_tenant_scopes(credential_id);
CREATE INDEX idx_admin_machine_credentials_principal
  ON admin_machine_credentials(principal_id);
CREATE INDEX idx_admin_machine_credentials_status
  ON admin_machine_credentials(status);
CREATE INDEX idx_admin_machine_principal_tenant_scopes_principal
  ON admin_machine_principal_tenant_scopes(principal_id);
CREATE INDEX idx_admin_machine_principals_status
  ON admin_machine_principals(status);
CREATE INDEX idx_admin_machine_resource_scopes_credential
  ON admin_machine_resource_scopes(credential_id);
CREATE INDEX idx_admin_machine_resource_scopes_principal
  ON admin_machine_resource_scopes(principal_id);
CREATE INDEX idx_admin_passkeys_credential ON admin_passkeys(credential_id);
CREATE INDEX idx_admin_passkeys_user ON admin_passkeys(admin_user_id);
CREATE INDEX idx_admin_policies_active ON admin_policies(is_active);
CREATE INDEX idx_admin_policies_name ON admin_policies(tenant_id, name);
CREATE INDEX idx_admin_policies_priority ON admin_policies(priority DESC);
CREATE INDEX idx_admin_policies_resource ON admin_policies(resource_pattern);
CREATE INDEX idx_admin_rebac_def_name ON admin_rebac_definitions(tenant_id, relation_name);
CREATE INDEX idx_admin_rel_expires ON admin_relationships(expires_at);
CREATE INDEX idx_admin_rel_from ON admin_relationships(from_type, from_id);
CREATE INDEX idx_admin_rel_to ON admin_relationships(to_type, to_id);
CREATE INDEX idx_admin_rel_type ON admin_relationships(relationship_type);
CREATE UNIQUE INDEX idx_admin_rel_unique
  ON admin_relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);
CREATE INDEX idx_admin_role_assignments_expires ON admin_role_assignments(expires_at);
CREATE INDEX idx_admin_role_assignments_role ON admin_role_assignments(admin_role_id);
CREATE INDEX idx_admin_role_assignments_scope ON admin_role_assignments(scope_type, scope_id);
CREATE INDEX idx_admin_role_assignments_user ON admin_role_assignments(admin_user_id);
CREATE INDEX idx_admin_roles_hierarchy ON admin_roles(hierarchy_level);
CREATE INDEX idx_admin_roles_inherits ON admin_roles(inherits_from);
CREATE INDEX idx_admin_roles_name ON admin_roles(tenant_id, name);
CREATE INDEX idx_admin_roles_type ON admin_roles(role_type);
CREATE INDEX idx_admin_sessions_activity ON admin_sessions(last_activity_at);
CREATE INDEX idx_admin_sessions_derived_target
  ON admin_sessions(derived_target_tenant_id, expires_at);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX idx_admin_sessions_parent
  ON admin_sessions(parent_session_id, expires_at);
CREATE INDEX idx_admin_sessions_tenant ON admin_sessions(tenant_id);
CREATE INDEX idx_admin_sessions_user ON admin_sessions(admin_user_id);
CREATE INDEX idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at);
CREATE INDEX idx_admin_setup_tokens_status ON admin_setup_tokens(status);
CREATE INDEX idx_admin_setup_tokens_tenant ON admin_setup_tokens(tenant_id);
CREATE INDEX idx_admin_setup_tokens_user ON admin_setup_tokens(admin_user_id);
CREATE INDEX idx_admin_storage_destination_usages_destination
  ON admin_storage_destination_usages(destination_id, is_active);
CREATE INDEX idx_admin_storage_destination_usages_feature
  ON admin_storage_destination_usages(tenant_id, feature, is_active);
CREATE INDEX idx_admin_storage_destinations_provider
  ON admin_storage_destinations(provider, status);
CREATE INDEX idx_admin_storage_destinations_scope
  ON admin_storage_destinations(scope_type, scope_id, is_active, name);
CREATE INDEX idx_admin_users_active ON admin_users(tenant_id, is_active);
CREATE INDEX idx_admin_users_last_login ON admin_users(last_login_at);
CREATE INDEX idx_admin_users_status ON admin_users(tenant_id, status);
CREATE INDEX idx_admin_users_tenant_email ON admin_users(tenant_id, email);
CREATE UNIQUE INDEX idx_agent_baseline_assignments_remediation_plan
  ON agent_baseline_assignments(remediation_bulk_plan_id, remediation_bulk_plan_version);
CREATE UNIQUE INDEX idx_agent_baseline_assignments_transition
  ON agent_baseline_assignments(last_transition_id);
CREATE INDEX idx_agent_bulk_children_capability
  ON agent_bulk_tenant_executions(
    bulk_plan_id, bulk_plan_version, target_tenant_id,
    execution_attempt, execution_fence, child_capability_digest
  );
CREATE INDEX idx_agent_bulk_plans_actor
  ON agent_bulk_plans(control_tenant_id, grant_id, actor_sub, status);
CREATE INDEX idx_agent_bulk_plans_control
  ON agent_bulk_plans(control_tenant_id, status, created_at);
CREATE INDEX idx_agent_bulk_plans_retention
  ON agent_bulk_plans(payload_purge_at, payload_purged_at);
CREATE UNIQUE INDEX idx_agent_bulk_plans_transition
  ON agent_bulk_plans(last_transition_id);
CREATE INDEX idx_agent_bulk_tenant_claim
  ON agent_bulk_tenant_executions(bulk_plan_id, bulk_plan_version, status, is_canary, wave_number);
CREATE INDEX idx_agent_bulk_tenant_lease
  ON agent_bulk_tenant_executions(status, execution_lease_expires_at);
CREATE UNIQUE INDEX idx_agent_bulk_tenant_transition
  ON agent_bulk_tenant_executions(last_transition_id);
CREATE INDEX idx_agent_configuration_plans_context
  ON agent_configuration_plans(tenant_id, grant_id, actor_sub, created_at);
CREATE INDEX idx_agent_configuration_plans_retention
  ON agent_configuration_plans(payload_purge_at, payload_purged_at);
CREATE UNIQUE INDEX idx_agent_configuration_plans_transition
  ON agent_configuration_plans(last_transition_id);
CREATE INDEX idx_agent_consents_grant
  ON agent_consents(grant_id, consent_type, revoked_at);
CREATE INDEX idx_agent_consents_user
  ON agent_consents(tenant_id, user_id, revoked_at);
CREATE UNIQUE INDEX idx_agent_elevation_approval_artifact
  ON agent_elevation_challenges(approval_artifact_id);
CREATE UNIQUE INDEX idx_agent_elevation_approval_request
  ON agent_elevation_challenges(approval_request_id);
CREATE UNIQUE INDEX idx_agent_elevation_args_active
  ON agent_elevation_challenges(
    tenant_id,
    grant_id,
    actor_sub,
    tool_name,
    args_hash,
    active_args_key
  );
CREATE INDEX idx_agent_elevation_grant
  ON agent_elevation_challenges(tenant_id, grant_id, created_at);
CREATE INDEX idx_agent_elevation_recovery
  ON agent_elevation_challenges(status, execution_lease_expires_at);
CREATE UNIQUE INDEX idx_agent_plan_confirmations_transition
  ON agent_plan_confirmations(last_transition_id);
CREATE INDEX idx_agent_scope_policies_management_mode
  ON agent_scope_policies(tenant_id, management_mode, status);
CREATE UNIQUE INDEX idx_agent_scope_policies_transition
  ON agent_scope_policies(last_transition_id);
CREATE UNIQUE INDEX idx_agent_scope_policy_versions_transition
  ON agent_scope_policy_versions(last_transition_id);
CREATE UNIQUE INDEX idx_agent_secret_refs_transition
  ON agent_secret_refs(last_transition_id);
CREATE UNIQUE INDEX idx_agent_task_set_versions_transition
  ON agent_task_set_versions(last_transition_id);
CREATE INDEX idx_agent_task_sets_management_mode
  ON agent_task_sets(tenant_id, management_mode, status);
CREATE UNIQUE INDEX idx_agent_task_sets_transition
  ON agent_task_sets(last_transition_id);
CREATE INDEX idx_approval_request_approvals_expires
  ON approval_request_approvals(expires_at);
CREATE INDEX idx_approval_request_approvals_request_status
  ON approval_request_approvals(approval_request_id, status, created_at ASC);
CREATE INDEX idx_approval_request_approvals_subject
  ON approval_request_approvals(subject_type, subject_id, created_at DESC);
CREATE UNIQUE INDEX idx_approval_request_approvals_unique_subject
  ON approval_request_approvals(
    approval_request_id,
    step_key,
    subject_type,
    COALESCE(subject_id, '')
  );
CREATE INDEX idx_approval_requests_detail_object_catalog
  ON approval_requests(detail_object_catalog_id);
CREATE INDEX idx_approval_requests_expires
  ON approval_requests(expires_at);
CREATE INDEX idx_approval_requests_investigation
  ON approval_requests(investigation_id, created_at DESC);
CREATE INDEX idx_approval_requests_requester
  ON approval_requests(requester_subject_type, requester_subject_id, created_at DESC);
CREATE INDEX idx_approval_requests_target
  ON approval_requests(target_subject_type, target_subject_id, created_at DESC);
CREATE INDEX idx_approval_requests_tenant_status_requested
  ON approval_requests(tenant_id, status, requested_at DESC);
CREATE INDEX idx_compiled_mapping_snapshots_state
  ON compiled_mapping_snapshots(tenant_id, lifecycle_state, activated_at);
CREATE INDEX idx_credential_profile_versions_state
  ON credential_profile_versions(tenant_id, credential_profile_id, lifecycle_state, version_number);
CREATE INDEX idx_credential_profiles_state
  ON credential_profiles(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_credential_secret_bodies_destination
  ON credential_secret_bodies(destination_id, version);
CREATE INDEX idx_credential_secret_metadata_destination
  ON credential_secret_metadata(destination_id, status, version);
CREATE INDEX idx_destination_profile_versions_state
  ON destination_profile_versions(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_destination_profiles_owner
  ON destination_profiles(owner_scope_type, owner_scope_id, destination_type);
CREATE INDEX idx_destination_profiles_type_state
  ON destination_profiles(tenant_id, destination_type, lifecycle_state, updated_at);
CREATE INDEX idx_elevation_grants_actor
  ON elevation_grants(actor_subject_type, actor_subject_id, issued_at DESC);
CREATE INDEX idx_elevation_grants_expires
  ON elevation_grants(expires_at);
CREATE INDEX idx_elevation_grants_request
  ON elevation_grants(approval_request_id, issued_at DESC);
CREATE INDEX idx_elevation_grants_tenant_status_issued
  ON elevation_grants(tenant_id, status, issued_at DESC);
CREATE INDEX idx_external_token_refresh_runs_requested_tenant
  ON admin_external_token_refresh_runs(requested_tenant_id, started_at DESC);
CREATE INDEX idx_external_token_refresh_runs_started
  ON admin_external_token_refresh_runs(started_at DESC);
CREATE INDEX idx_external_token_refresh_tenant_runs_tenant
  ON admin_external_token_refresh_tenant_runs(tenant_id, completed_at DESC);
CREATE INDEX idx_federation_metadata_documents_latest_valid
  ON federation_metadata_documents(
    tenant_id,
    trust_source_id,
    document_type,
    validation_state,
    validated_at DESC,
    created_at DESC,
    id DESC
  );
CREATE INDEX idx_federation_metadata_entity_summaries_document
  ON federation_metadata_entity_summaries(tenant_id, metadata_document_id);
CREATE INDEX idx_federation_metadata_refresh_jobs_source_created
  ON federation_metadata_refresh_jobs(tenant_id, trust_source_id, created_at DESC);
CREATE INDEX idx_federation_metadata_validation_events_document
  ON federation_metadata_validation_events(tenant_id, metadata_document_id);
CREATE INDEX idx_federation_metadata_validation_events_source_created
  ON federation_metadata_validation_events(tenant_id, trust_source_id, created_at DESC);
CREATE INDEX idx_federation_saml_runtime_entities_document
  ON federation_saml_runtime_entities(tenant_id, metadata_document_id);
CREATE INDEX idx_federation_saml_runtime_entities_lookup
  ON federation_saml_runtime_entities(tenant_id, entity_id, entity_role, trust_source_id);
CREATE INDEX idx_field_mapping_versions_state
  ON field_mapping_versions(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_internal_notification_delivery_attempts_event
  ON internal_notification_delivery_attempts(event_id, provider, status);
CREATE INDEX idx_internal_notification_delivery_attempts_retry
  ON internal_notification_delivery_attempts(status, next_attempt_at, updated_at);
CREATE INDEX idx_internal_notification_delivery_routes_lookup
  ON internal_notification_delivery_routes(scope_type, scope_id, enabled, provider);
CREATE UNIQUE INDEX idx_internal_notification_events_dedup
  ON internal_notification_events(deduplication_key);
CREATE INDEX idx_internal_notification_events_pending
  ON internal_notification_events(status, severity, created_at);
CREATE INDEX idx_internal_notification_events_tenant_created
  ON internal_notification_events(tenant_id, created_at DESC);
CREATE UNIQUE INDEX idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);
CREATE UNIQUE INDEX idx_log_object_catalog_object_key
  ON log_object_catalog(object_key);
CREATE INDEX idx_log_object_catalog_status
  ON log_object_catalog(status, created_at);
CREATE INDEX idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at);
CREATE INDEX idx_logging_catalog_repair_jobs_queue
  ON logging_catalog_repair_jobs(status, created_at);
CREATE INDEX idx_logging_catalog_repair_jobs_scope
  ON logging_catalog_repair_jobs(COALESCE(tenant_key, ''), COALESCE(log_type, ''), COALESCE(plane, ''), created_at DESC);
CREATE INDEX idx_logging_delivery_events_destination
  ON logging_delivery_events(destination_id, status, created_at);
CREATE INDEX idx_logging_delivery_events_tenant_status
  ON logging_delivery_events(tenant_key, status, created_at);
CREATE INDEX idx_logging_destination_override_history_override
  ON logging_destination_override_history(override_id, changed_at);
CREATE INDEX idx_logging_destination_override_history_scope
  ON logging_destination_override_history(COALESCE(tenant_id, 'platform'), log_type, plane, changed_at);
CREATE INDEX idx_logging_destination_overrides_destination
  ON logging_destination_overrides(destination_id, enabled, updated_at);
CREATE INDEX idx_logging_destination_overrides_effective
  ON logging_destination_overrides(COALESCE(tenant_id, 'platform'), log_type, plane, enabled);
CREATE INDEX idx_logging_dlq_items_lane_status
  ON logging_dlq_items(lane, status, created_at);
CREATE INDEX idx_logging_dlq_items_tenant_status
  ON logging_dlq_items(tenant_key, status, created_at);
CREATE INDEX idx_logging_export_jobs_status
  ON logging_export_jobs(status, created_at);
CREATE INDEX idx_logging_export_jobs_tenant
  ON logging_export_jobs(tenant_key, created_at);
CREATE UNIQUE INDEX idx_logging_fallback_policies_scope
  ON logging_fallback_policies(scope_type, scope_id, log_type, plane);
CREATE INDEX idx_logging_key_material_bodies_scope
  ON logging_key_material_bodies(tenant_key, COALESCE(surface, ''), log_type, plane, version);
CREATE UNIQUE INDEX idx_logging_key_registry_scope
  ON logging_key_registry(tenant_key, COALESCE(surface, ''), log_type, plane);
CREATE INDEX idx_logging_key_registry_status
  ON logging_key_registry(status, updated_at);
CREATE INDEX idx_logging_message_export_builds_export
  ON logging_message_export_builds(export_job_id, phase, partition_index);
CREATE INDEX idx_logging_message_export_builds_job
  ON logging_message_export_builds(message_job_id, phase, partition_index);
CREATE INDEX idx_logging_message_jobs_chain
  ON logging_message_jobs(root_job_id, parent_job_id, depth);
CREATE INDEX idx_logging_message_jobs_claimed
  ON logging_message_jobs(status, claimed_until, lane, priority);
CREATE INDEX idx_logging_message_jobs_due
  ON logging_message_jobs(status, not_before, priority, created_at);
CREATE INDEX idx_logging_message_jobs_scope_status
  ON logging_message_jobs(scope_key, status, created_at);
CREATE INDEX idx_logging_message_jobs_source
  ON logging_message_jobs(source_type, source_id);
CREATE INDEX idx_logging_message_jobs_tenant
  ON logging_message_jobs(tenant_key, kind, status, created_at);
CREATE INDEX idx_logging_message_repair_findings_job
  ON logging_message_repair_findings(message_job_id, status);
CREATE INDEX idx_logging_message_repair_findings_status
  ON logging_message_repair_findings(status, severity, detected_at);
CREATE UNIQUE INDEX idx_logging_policy_snapshots_scope_version
  ON logging_policy_snapshots(scope_type, scope_id, version);
CREATE INDEX idx_logging_policy_snapshots_status
  ON logging_policy_snapshots(scope_type, scope_id, status, version);
CREATE INDEX idx_logging_quota_evaluations_policy_time
  ON logging_quota_evaluations(quota_policy_id, evaluated_at DESC);
CREATE INDEX idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC);
CREATE INDEX idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind);
CREATE INDEX idx_logging_quota_policies_scope
  ON logging_quota_policies(
    scope_type,
    scope_id,
    COALESCE(log_type, ''),
    COALESCE(plane, ''),
    COALESCE(lane, ''),
    metric_name,
    window_kind,
    deleted_at
  );
CREATE INDEX idx_logging_rewrap_jobs_queue
  ON logging_rewrap_jobs(status, priority, created_at);
CREATE INDEX idx_logging_rewrap_jobs_registry
  ON logging_rewrap_jobs(key_registry_id, status);
CREATE UNIQUE INDEX idx_logging_usage_aggregates_scope
  ON logging_usage_aggregates(
    COALESCE(tenant_id, ''),
    COALESCE(tenant_key, ''),
    COALESCE(log_type, ''),
    COALESCE(plane, ''),
    COALESCE(lane, ''),
    metric_name,
    window_kind,
    window_start_at
  );
CREATE INDEX idx_logging_usage_aggregates_window
  ON logging_usage_aggregates(window_kind, window_start_at, metric_name);
CREATE INDEX idx_object_catalog_deleted_at
  ON object_catalog(deleted_at);
CREATE INDEX idx_object_catalog_objects_bucket_key
  ON object_catalog_objects(bucket_binding, object_key);
CREATE INDEX idx_object_catalog_objects_catalog_repr
  ON object_catalog_objects(catalog_id, representation, object_index);
CREATE INDEX idx_object_catalog_objects_deleted_at
  ON object_catalog_objects(deleted_at);
CREATE INDEX idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC);
CREATE INDEX idx_persistent_identifier_profiles_tenant_state
  ON persistent_identifier_profiles(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_provider_reprojection_jobs_due
  ON provider_reprojection_jobs(status, next_run_at, updated_at);
CREATE INDEX idx_provider_reprojection_jobs_plugin
  ON provider_reprojection_jobs(plugin_id, created_at DESC);
CREATE INDEX idx_sensitive_detail_chunk_index_object
  ON sensitive_detail_chunk_index(object_key, line_number);
CREATE INDEX idx_sensitive_detail_chunk_index_tenant_class
  ON sensitive_detail_chunk_index(tenant_id, object_class, created_at);
CREATE INDEX idx_source_profile_parse_drafts_expiry
  ON source_profile_parse_drafts(tenant_id, expires_at);
CREATE INDEX idx_source_profile_versions_state
  ON source_profile_versions(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_source_profiles_type_state
  ON source_profiles(tenant_id, source_type, lifecycle_state, updated_at);
CREATE INDEX idx_storage_destination_assignments_scope
  ON storage_destination_assignments(
    destination_id,
    COALESCE(tenant_id, '*'),
    COALESCE(log_type, '*'),
    COALESCE(plane, '*'),
    enabled
  );
CREATE INDEX idx_storage_destination_assignments_tenant
  ON storage_destination_assignments(tenant_id, log_type, plane, enabled);
CREATE INDEX idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC);
CREATE INDEX idx_tenant_database_probe_results_status
  ON tenant_database_probe_results(status, created_at DESC);
CREATE INDEX idx_tenant_placement_migration_jobs_runnable
  ON tenant_placement_migration_jobs(status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX idx_tenant_provisioning_operations_runnable
  ON tenant_provisioning_operations(status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX idx_tenant_provisioning_steps_status
  ON tenant_provisioning_operation_steps(status, next_attempt_at, updated_at);
CREATE UNIQUE INDEX ux_attribute_field_registry_key
  ON attribute_field_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    protocol,
    field_key
  );
CREATE UNIQUE INDEX ux_attribute_group_registry_key
  ON attribute_group_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    protocol,
    group_type,
    group_key
  );
CREATE UNIQUE INDEX ux_destination_profile_versions_label
  ON destination_profile_versions(tenant_id, profile_id, version_label);
CREATE UNIQUE INDEX ux_destination_profiles_active_resource_server_client
  ON destination_profiles(
    CASE
      WHEN destination_type = 'resource_server'
        AND owner_scope_type = 'client'
        AND lifecycle_state = 'active'
      THEN tenant_id
      ELSE NULL
    END,
    CASE
      WHEN destination_type = 'resource_server'
        AND owner_scope_type = 'client'
        AND lifecycle_state = 'active'
      THEN COALESCE(owner_scope_id, '')
      ELSE NULL
    END
  );
CREATE UNIQUE INDEX ux_destination_profiles_scope_key
  ON destination_profiles(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    destination_type,
    profile_key
  );
CREATE INDEX idx_tenant_backup_operations_queue
  ON tenant_backup_operations(state, lease_expires_at, created_at);
CREATE INDEX idx_tenant_backup_operations_tenant
  ON tenant_backup_operations(tenant_id, created_at, id);
CREATE UNIQUE INDEX idx_tenant_backup_operations_identity
  ON tenant_backup_operations(id, tenant_id);
CREATE INDEX idx_tenant_backup_validation_cleanup ON tenant_backup_validation_sessions(state, created_at, id);
CREATE INDEX idx_tenant_backup_key_handoffs_operation ON tenant_backup_key_handoffs(tenant_id, operation_id);
CREATE INDEX idx_tenant_backup_key_handoffs_expiry ON tenant_backup_key_handoffs(key_expires_at);
CREATE INDEX idx_tenant_backup_operations_due ON tenant_backup_operations(state, next_attempt_at, updated_at, id);
CREATE INDEX idx_tenant_backup_artifact_attempts_operation ON tenant_backup_artifact_attempts(tenant_id,operation_id);
CREATE INDEX tenant_backup_snapshots_capture
  ON tenant_backup_snapshots(state, tenant_id, id);
CREATE INDEX idx_tenant_backup_input_dataset_boundary
ON tenant_backup_input_receipts(operation_id,bundle_id,json_extract(checkpoint_json,'$.content.datasetIndex'),sequence)
WHERE json_extract(checkpoint_json,'$.content.phase')='datasets'
  AND json_extract(checkpoint_json,'$.content.chunks')=0;
CREATE UNIQUE INDEX idx_tenant_backup_validation_record_source
  ON tenant_backup_validation_records(session_id,bundle_id,source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX idx_tenant_backup_publications_expiry ON tenant_backup_publications(expires_at,operation_id);
CREATE INDEX tenant_backup_upload_expiry ON tenant_backup_uploads(state,expires_at);
CREATE INDEX tenant_backup_upload_completion ON tenant_backup_uploads(state,completion_lease_until,created_at,id);
CREATE INDEX tenant_backup_operation_inputs_upload ON tenant_backup_operation_inputs(upload_id);
CREATE INDEX idx_tenant_settings_documents_projection
  ON tenant_settings_documents(projection_state,updated_at,tenant_id,scope_type,scope_id,category);
CREATE INDEX tenant_backup_admin_mappings_target
  ON tenant_backup_admin_mappings(tenant_id,target_admin_id,operation_id);
CREATE INDEX tenant_backup_restored_holds_tenant_operation
  ON tenant_backup_restored_holds(tenant_id,operation_id,dataset_id);
CREATE INDEX tenant_backup_r2_restore_state
  ON tenant_backup_r2_restore_objects(state,updated_at,operation_id,dataset_id,object_id);
CREATE INDEX idx_tenant_backup_r2_retired_generations_created
  ON tenant_backup_r2_retired_generations(created_at, id);
CREATE INDEX idx_tenant_backup_restored_hold_objects_tenant_operation
  ON tenant_backup_restored_hold_objects(tenant_id, operation_id, dataset_id);
CREATE INDEX idx_tenant_settings_documents_reconciled
  ON tenant_settings_documents(reconciled_at,tenant_id,scope_type,scope_id,category);
CREATE INDEX idx_platform_settings_documents_projection
  ON platform_settings_documents(projection_state,updated_at,category);
CREATE INDEX idx_platform_settings_documents_reconciled
  ON platform_settings_documents(reconciled_at,category);
CREATE INDEX tenant_backup_preimages_native_order
  ON tenant_backup_preimages(snapshot_id, source_table, present,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[0][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[0][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[0][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[0][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[0][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[1][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[1][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[1][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[1][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[1][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[2][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[2][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[2][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[2][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[2][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[3][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[3][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[3][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[3][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[3][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[4][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[4][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[4][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[4][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[4][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[5][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[5][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[5][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[5][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[5][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[6][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[6][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[6][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[6][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[6][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[7][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[7][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[7][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[7][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[7][1]')) END);
CREATE INDEX idx_admin_attr_values_tenant ON admin_attribute_values(tenant_id, id);
CREATE INDEX idx_admin_attributes_tenant ON admin_attributes(tenant_id, id);
CREATE INDEX idx_admin_policies_tenant ON admin_policies(tenant_id, id);
CREATE INDEX idx_admin_rebac_def_tenant ON admin_rebac_definitions(tenant_id, id);
CREATE INDEX idx_admin_rel_tenant ON admin_relationships(tenant_id, id);
CREATE INDEX idx_admin_role_assignments_tenant ON admin_role_assignments(tenant_id, id);
CREATE INDEX idx_admin_roles_tenant ON admin_roles(tenant_id, id);
CREATE INDEX idx_tenant_backup_export_spills_ordinal
  ON tenant_backup_export_spills(attempt_id,ordinal);
CREATE INDEX idx_log_object_catalog_source_range
  ON log_object_catalog (tenant_key, source_table, last_event_at)
  WHERE source_table IS NOT NULL;
CREATE INDEX idx_log_archive_batches_pending
  ON log_archive_batches (tenant_id, source_table, state);
CREATE INDEX idx_federation_selected_entity_import_events_tenant_created
  ON federation_selected_entity_import_events(tenant_id, created_at, id);
CREATE INDEX idx_key_access_events_tenant_created
  ON key_access_events(tenant_id, created_at, id);
CREATE INDEX idx_mapping_events_tenant_created
  ON mapping_events(tenant_id, created_at, id);
CREATE UNIQUE INDEX tenant_backup_restore_target_exclusive
  ON tenant_backup_restore_targets(tenant_id);
CREATE INDEX idx_identity_mapping_test_users_tenant_position
  ON identity_mapping_test_users (tenant_id, position);
CREATE INDEX idx_identity_mapping_level_history_level
  ON identity_mapping_level_history(tenant_id, tier, client_id, status, created_at DESC, id DESC);
CREATE INDEX idx_identity_mapping_level_history_pending
  ON identity_mapping_level_history(status, tier, last_reconciled_at, created_at, id);
CREATE INDEX idx_identity_mapping_level_history_order
  ON identity_mapping_level_history(tenant_id, tier, client_id, created_at DESC);
CREATE INDEX idx_identity_mapping_failures_tenant_time
  ON identity_mapping_failures(tenant_id, last_at DESC, id DESC);
CREATE INDEX idx_identity_mapping_failures_client_time
  ON identity_mapping_failures(tenant_id, client_id, last_at DESC, id DESC);
CREATE INDEX idx_tenant_backup_replication_grants_tenant ON tenant_backup_replication_grants(tenant_id,created_at,id);
CREATE INDEX idx_admin_audit_receipts_tenant ON admin_audit_receipts(tenant_id,id);
CREATE INDEX idx_log_iceberg_event_receipts_tenant ON log_iceberg_event_receipts(tenant_id,id);
CREATE INDEX idx_log_iceberg_event_receipts_expiry ON log_iceberg_event_receipts(expires_at,id);
CREATE INDEX idx_log_iceberg_erasure_artifacts_pending
  ON log_iceberg_erasure_artifacts(erasure_id,table_uuid,state,path_digest);
CREATE INDEX idx_log_iceberg_retention_pending ON log_iceberg_retention_jobs(table_uuid,state,updated_at,id);
CREATE INDEX idx_log_iceberg_retention_scopes ON log_iceberg_retention_jobs(table_uuid,storage_generation,id);
CREATE INDEX idx_log_iceberg_retention_artifacts_pending
  ON log_iceberg_retention_artifacts(retention_id,table_uuid,state,path_digest);
CREATE INDEX idx_log_iceberg_publications_recovery
  ON log_iceberg_publications(finalized,next_attempt_at,updated_at,id);
CREATE INDEX idx_log_iceberg_restore_holds_operation ON log_iceberg_restore_holds(operation_id,tenant_id,state,cleanup_completed_at,id);
CREATE INDEX idx_log_iceberg_restore_holds_cleanup ON log_iceberg_restore_holds(operation_id,tenant_id,id) WHERE cleanup_completed_at IS NULL;
CREATE INDEX idx_log_iceberg_restore_holds_expiry ON log_iceberg_restore_holds(state,expires_at,id);
CREATE INDEX idx_log_iceberg_records_export
  ON log_iceberg_records(storage_generation, batch_id, ingested_at, id);
CREATE INDEX idx_log_iceberg_records_read
  ON log_iceberg_records(tenant_id, source_dataset, event_at DESC, id DESC);
CREATE INDEX idx_log_iceberg_record_parts_tenant ON log_iceberg_record_parts(tenant_id,record_id,part_index);
CREATE INDEX idx_log_iceberg_export_batches_pending
  ON log_iceberg_export_batches(storage_generation, state, next_attempt_at, created_at, id);
CREATE UNIQUE INDEX idx_log_iceberg_export_scope_active
  ON log_iceberg_export_batches(storage_generation, tenant_key, source_dataset)
  WHERE state != 'done';
CREATE INDEX idx_log_iceberg_outbox_delivery
  ON log_iceberg_outbox(storage_generation, state, next_attempt_at, created_at, id);
CREATE INDEX idx_log_iceberg_outbox_subject ON log_iceberg_outbox(tenant_id,source_dataset,subject_id,state,id);
CREATE INDEX idx_log_iceberg_retention_source_scope ON log_iceberg_retention_jobs(table_uuid,storage_generation,source_dataset,id);

PRAGMA foreign_keys = ON;
