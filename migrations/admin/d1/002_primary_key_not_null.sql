CREATE TABLE IF NOT EXISTS authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
);

CREATE TABLE IF NOT EXISTS authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT 'global',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);

-- Apply this entire migration and its history record as one atomic D1 batch.

-- NULL identities are not repaired, removed or assigned automatically.

CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_agent_delegation_jtis', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_agent_delegation_jtis' AND sql IN ('CREATE TABLE admin_agent_delegation_jtis (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  machine_principal_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_agent_delegation_jtis', (SELECT count(*) FROM "admin_agent_delegation_jtis" WHERE "jti" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_agent_grants', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_agent_grants' AND sql IN ('CREATE TABLE admin_agent_grants (
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
  delegation_mode TEXT NOT NULL DEFAULT ''user_consent''
    CHECK (delegation_mode IN (''user_consent'', ''admin_pre_authorized'', ''task_approved'')),
  purpose TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  consent_version INTEGER NOT NULL DEFAULT 1 CHECK (consent_version > 0),
  approval_id TEXT,
  status TEXT NOT NULL DEFAULT ''active''
    CHECK (status IN (''active'', ''suspended'', ''revoked'')),
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
  last_mutation_id TEXT, task_set_id TEXT, task_set_version INTEGER, resolved_tools TEXT, management_mode TEXT NOT NULL DEFAULT ''managed''
  CHECK (management_mode IN (''managed'', ''system_managed'')),
  FOREIGN KEY (machine_principal_id) REFERENCES admin_machine_principals(id),
  FOREIGN KEY (grantor_id) REFERENCES admin_users(id),
  FOREIGN KEY (delegator_id) REFERENCES admin_users(id),
  CHECK (
    (status = ''active'' AND active_uniqueness_key = ''active'')
    OR (status IN (''suspended'', ''revoked'') AND active_uniqueness_key = id)
  )
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_agent_grants', (SELECT count(*) FROM "admin_agent_grants" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_agent_login_handoffs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_agent_login_handoffs' AND sql IN ('CREATE TABLE admin_agent_login_handoffs (
  id TEXT PRIMARY KEY,
  target_tenant_id TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  authorization_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''issued'', ''consumed'')),
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
  CHECK (target_origin LIKE ''https://%''),
  CHECK (authorization_path LIKE ''/oauth/admin-agent/authorize%''),
  CHECK (expires_at > created_at),
  CHECK (
    (status = ''pending'' AND source_session_id IS NULL AND code_hash IS NULL) OR
    (status = ''issued'' AND source_session_id IS NOT NULL AND code_hash IS NOT NULL
      AND issued_at IS NOT NULL) OR
    (status = ''consumed'' AND source_session_id IS NULL AND code_hash IS NOT NULL
      AND issued_at IS NOT NULL AND consumed_at IS NOT NULL)
  )
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_agent_login_handoffs', (SELECT count(*) FROM "admin_agent_login_handoffs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_agent_mcp_sessions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_agent_mcp_sessions' AND sql IN ('CREATE TABLE admin_agent_mcp_sessions (
  session_id TEXT PRIMARY KEY,
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_agent_mcp_sessions', (SELECT count(*) FROM "admin_agent_mcp_sessions" WHERE "session_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_agent_token_families', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_agent_token_families' AND sql IN ('CREATE TABLE admin_agent_token_families (
  family_id TEXT PRIMARY KEY,
  family_jti TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_generation INTEGER NOT NULL CHECK (grant_generation > 0),
  admin_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  status TEXT NOT NULL DEFAULT ''pending_finalization''
    CHECK (status IN (
      ''pending_finalization'', ''active'', ''revocation_pending'', ''revoked'', ''expired''
    )),
  finalization_nonce TEXT NOT NULL,
  finalized_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, revocation_outbox_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id),
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),
  CHECK (expires_at > created_at)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_agent_token_families', (SELECT count(*) FROM "admin_agent_token_families" WHERE "family_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_agent_token_revocation_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_agent_token_revocation_outbox' AND sql IN ('CREATE TABLE admin_agent_token_revocation_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_id TEXT,
  grant_generation INTEGER,
  client_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN (''revoke_grant_families'', ''revoke_client_families'')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''processing'', ''completed'', ''dead_letter'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_agent_token_revocation_outbox', (SELECT count(*) FROM "admin_agent_token_revocation_outbox" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_attribute_values', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_attribute_values' AND sql IN ('CREATE TABLE admin_attribute_values (
  -- Value assignment ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- References
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  admin_attribute_id TEXT NOT NULL REFERENCES admin_attributes(id) ON DELETE CASCADE,

  -- The actual value (stored as text, parsed according to attribute_type)
  value TEXT NOT NULL,

  -- For multi-valued attributes, this is the index (0, 1, 2, ...)
  value_index INTEGER DEFAULT 0,

  -- Source of this value (manual, idp_sync, api, etc.)
  source TEXT DEFAULT ''manual'',

  -- Expiration (for temporary attribute assignments)
  expires_at INTEGER,

  -- Audit fields
  assigned_by TEXT,  -- Admin user ID who assigned this value
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for single-valued attributes
  -- For multi-valued, use UNIQUE(admin_user_id, admin_attribute_id, value_index)
  UNIQUE(admin_user_id, admin_attribute_id, value_index)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_attribute_values', (SELECT count(*) FROM "admin_attribute_values" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_attributes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_attributes' AND sql IN ('CREATE TABLE admin_attributes (
  -- Attribute ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Attribute identification
  name TEXT NOT NULL,  -- Machine-readable name (e.g., ''department'')
  display_name TEXT,   -- Human-readable name (e.g., ''Department'')
  description TEXT,

  -- Attribute type (determines value validation)
  -- string: Free-form text
  -- enum: Must be one of allowed_values
  -- number: Numeric value (with optional min/max)
  -- boolean: true/false
  -- date: ISO 8601 date
  -- array: Multiple values allowed
  attribute_type TEXT NOT NULL DEFAULT ''string'',

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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_attributes', (SELECT count(*) FROM "admin_attributes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_audit_coverage_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_audit_coverage_status' AND sql IN ('CREATE TABLE admin_audit_coverage_status (
  operation_id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  required_audit TEXT NOT NULL,
  criticality TEXT NOT NULL CHECK (criticality IN (''normal'', ''critical'')),
  status TEXT NOT NULL CHECK (
    status IN (''covered'', ''gap_detected'', ''acknowledged'', ''ignored'')
  ),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_audit_coverage_status', (SELECT count(*) FROM "admin_audit_coverage_status" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_audit_log', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_audit_log' AND sql IN ('CREATE TABLE admin_audit_log (
  -- Audit entry ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Who performed the action
  admin_user_id TEXT,  -- May be null for system actions or failed auth
  admin_email TEXT,  -- Denormalized for easier querying

  -- What action was performed
  action TEXT NOT NULL,  -- e.g., ''admin.login'', ''user.create'', ''client.update''

  -- Target resource
  resource_type TEXT,  -- e.g., ''admin_user'', ''client'', ''role'', ''settings''
  resource_id TEXT,  -- ID of the affected resource

  -- Result
  result TEXT NOT NULL,  -- ''success'' | ''failure'' | ''error''
  error_code TEXT,  -- Error code if result is ''failure'' or ''error''
  error_message TEXT,  -- Error details

  -- Severity level
  severity TEXT NOT NULL DEFAULT ''info'',  -- debug | info | warn | error | critical

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
, detail_object_catalog_id TEXT, actor_type TEXT, actor_sub TEXT, actor_mode TEXT, actor_assurance TEXT, token_binding TEXT, act_client_id TEXT, act_principal_id TEXT, grant_id TEXT, elevation_id TEXT, mcp_tool TEXT)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_audit_log', (SELECT count(*) FROM "admin_audit_log" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_database_connection_usages', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_database_connection_usages' AND sql IN ('CREATE TABLE admin_database_connection_usages (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tenant_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT ''{}'',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (connection_id, purpose, resource_type, resource_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_database_connection_usages', (SELECT count(*) FROM "admin_database_connection_usages" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_database_connections', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_database_connections' AND sql IN ('CREATE TABLE admin_database_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL CHECK (provider IN (''d1'', ''hyperdrive'', ''postgres'', ''mysql'', ''custom'')),
  config_json TEXT NOT NULL DEFAULT ''{}'',
  credential_encrypted TEXT,
  credential_key_version INTEGER,
  credential_updated_at INTEGER,
  credential_updated_by TEXT,
  status TEXT NOT NULL DEFAULT ''active'' CHECK (status IN (''active'', ''disabled'')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_database_connections', (SELECT count(*) FROM "admin_database_connections" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_destination_health_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_destination_health_events' AND sql IN ('CREATE TABLE admin_destination_health_events (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  check_type TEXT NOT NULL CHECK (check_type IN (''quick'', ''deep'', ''adaptive'')),
  previous_health_status TEXT,
  next_health_status TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN (''success'', ''failure'', ''partial'')),
  error_class TEXT,
  latency_ms INTEGER,
  checked_at INTEGER NOT NULL,
  metadata TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_destination_health_events', (SELECT count(*) FROM "admin_destination_health_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_destinations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_destinations' AND sql IN ('CREATE TABLE admin_destinations (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN (''platform'', ''tenant'', ''shared'')),
  scope_id TEXT NOT NULL,
  destination_kind TEXT NOT NULL CHECK (
    destination_kind IN (''object_storage'', ''http_sink'', ''external_collector'', ''database'', ''custom'')
  ),
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT ''active''
    CHECK (lifecycle_status IN (''active'', ''disabled'', ''deleted'')),
  health_status TEXT NOT NULL DEFAULT ''unknown''
    CHECK (health_status IN (''unknown'', ''healthy'', ''degraded'', ''failing'', ''unreachable'')),
  rotation_status TEXT NOT NULL DEFAULT ''none''
    CHECK (rotation_status IN (''none'', ''testing'', ''ready'', ''active'', ''retiring'', ''failed'')),
  provider_config TEXT NOT NULL DEFAULT ''{}'',
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
  encryption_mode TEXT NOT NULL DEFAULT ''platform_managed''
    CHECK (encryption_mode IN (''platform_managed'', ''external_managed'', ''none'')),
  last_health_check_at INTEGER,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_destinations', (SELECT count(*) FROM "admin_destinations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_external_token_refresh_runs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_external_token_refresh_runs' AND sql IN ('CREATE TABLE admin_external_token_refresh_runs (
  id TEXT PRIMARY KEY,
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
  CHECK (trigger_type IN (''scheduled'', ''manual_tenant'')),
  CHECK (status IN (''running'', ''completed'', ''partial_failure'', ''failed''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_external_token_refresh_runs', (SELECT count(*) FROM "admin_external_token_refresh_runs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_external_token_refresh_tenant_runs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_external_token_refresh_tenant_runs' AND sql IN ('CREATE TABLE admin_external_token_refresh_tenant_runs (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, tenant_id),
  FOREIGN KEY (run_id) REFERENCES admin_external_token_refresh_runs(id) ON DELETE CASCADE,
  CHECK (status IN (''completed'', ''failed'', ''skipped''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_invitation_enrollments', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_invitation_enrollments' AND sql IN ('CREATE TABLE admin_invitation_enrollments (
  token_hash TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(phase IN (''redeemed'', ''registration'', ''authentication''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_invitation_enrollments', (SELECT count(*) FROM "admin_invitation_enrollments" WHERE "token_hash" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_invitations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_invitations' AND sql IN ('CREATE TABLE admin_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  pending_email_key TEXT,
  name TEXT,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending'',
  admin_role_id TEXT NOT NULL,
  admin_role_name TEXT NOT NULL,
  admin_role_display_name TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  role_expires_at INTEGER,
  ip_restriction_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_ip_ranges_json TEXT NOT NULL DEFAULT ''[]'',
  expires_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  last_delivery_status TEXT NOT NULL DEFAULT ''pending'',
  last_delivery_error TEXT,
  accepted_at INTEGER,
  accepted_ip TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(admin_user_id),
  UNIQUE(tenant_id, pending_email_key),
  CHECK(status IN (''pending'', ''accepted'', ''revoked'', ''expired'')),
  CHECK(
    (status = ''pending'' AND pending_email_key = email)
    OR (status IN (''accepted'', ''revoked'', ''expired'') AND pending_email_key IS NULL)
  ),
  CHECK(last_delivery_status IN (''pending'', ''sent'', ''failed'')),
  CHECK(scope_type IN (''global'', ''tenant'')),
  CHECK(ip_restriction_enabled IN (0, 1))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_invitations', (SELECT count(*) FROM "admin_invitations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_ip_allowlist', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_ip_allowlist' AND sql IN ('CREATE TABLE admin_ip_allowlist (
  -- Entry ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- IP address or CIDR range
  ip_range TEXT NOT NULL,

  -- IP version for easier filtering
  ip_version INTEGER NOT NULL DEFAULT 4,  -- 4 or 6

  -- Human-readable description
  description TEXT,  -- e.g., ''Office VPN'', ''Home IP'', ''CI/CD server''

  -- Enable/disable without deleting
  enabled INTEGER DEFAULT 1,

  -- Audit fields
  created_by TEXT,  -- Admin user ID who added this entry
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for IP range per tenant
  UNIQUE(tenant_id, ip_range)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_ip_allowlist', (SELECT count(*) FROM "admin_ip_allowlist" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_jobs' AND sql IN ('CREATE TABLE admin_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending'',
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_jobs', (SELECT count(*) FROM "admin_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_logging_critical_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_logging_critical_policies' AND sql IN ('CREATE TABLE admin_logging_critical_policies (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL UNIQUE,
  destination_id TEXT NOT NULL,
  critical_allowed INTEGER NOT NULL DEFAULT 1 CHECK (critical_allowed IN (0, 1)),
  default_fallback_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (default_fallback_eligible IN (0, 1)),
  failure_mode TEXT NOT NULL DEFAULT ''platform_default'',
  change_protection TEXT NOT NULL DEFAULT ''confirm''
    CHECK (change_protection IN (''confirm'', ''approval_required'', ''config_only'')),
  approval_policy_id TEXT,
  status TEXT NOT NULL DEFAULT ''active'' CHECK (status IN (''active'', ''disabled'', ''deleted'')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_logging_critical_policies', (SELECT count(*) FROM "admin_logging_critical_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_logging_sensitive_detail_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_logging_sensitive_detail_policies' AND sql IN ('CREATE TABLE admin_logging_sensitive_detail_policies (
  id TEXT PRIMARY KEY,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL DEFAULT ''sensitive_detail'',
  destination_id TEXT NOT NULL,
  chunking_enabled INTEGER NOT NULL DEFAULT 1 CHECK (chunking_enabled IN (0, 1)),
  encryption_required INTEGER NOT NULL DEFAULT 1 CHECK (encryption_required IN (0, 1)),
  read_audit_required INTEGER NOT NULL DEFAULT 1 CHECK (read_audit_required IN (0, 1)),
  status TEXT NOT NULL DEFAULT ''active'' CHECK (status IN (''active'', ''disabled'', ''deleted'')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_logging_sensitive_detail_policies', (SELECT count(*) FROM "admin_logging_sensitive_detail_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_login_attempts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_login_attempts' AND sql IN ('CREATE TABLE admin_login_attempts (
  -- Attempt ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Target email (even if user doesn''t exist)
  email TEXT NOT NULL,

  -- Request context
  ip_address TEXT NOT NULL,
  user_agent TEXT,

  -- Result
  success INTEGER NOT NULL DEFAULT 0,  -- 0 = failed, 1 = success
  failure_reason TEXT,  -- e.g., ''invalid_password'', ''user_not_found'', ''account_locked''

  -- Timestamp
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_login_attempts', (SELECT count(*) FROM "admin_login_attempts" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_assertion_jti', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_assertion_jti' AND sql IN ('CREATE TABLE admin_machine_assertion_jti (
  client_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, credential_id, jti),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_credential_permissions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_credential_permissions' AND sql IN ('CREATE TABLE admin_machine_credential_permissions (
  credential_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (credential_id, permission),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_credential_tenant_scopes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_credential_tenant_scopes' AND sql IN ('CREATE TABLE admin_machine_credential_tenant_scopes (
  credential_id TEXT NOT NULL,
  scope_mode TEXT NOT NULL,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE,
  CHECK (scope_mode IN (''none'', ''all'', ''allow'')),
  CHECK (
    (scope_mode = ''allow'' AND tenant_id IS NOT NULL)
    OR (scope_mode IN (''none'', ''all'') AND tenant_id IS NULL)
  )
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_credentials', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_credentials' AND sql IN ('CREATE TABLE admin_machine_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  kid TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  alg TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT ''active'',
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
  CHECK (status IN (''active'', ''rotating'', ''revoked'', ''expired'')),
  CHECK (alg IN (''ES256'', ''PS256'', ''RS256''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_machine_credentials', (SELECT count(*) FROM "admin_machine_credentials" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_principal_permissions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_principal_permissions' AND sql IN ('CREATE TABLE admin_machine_principal_permissions (
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (principal_id, permission),
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_principal_tenant_scopes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_principal_tenant_scopes' AND sql IN ('CREATE TABLE admin_machine_principal_tenant_scopes (
  principal_id TEXT NOT NULL,
  scope_mode TEXT NOT NULL,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE,
  CHECK (scope_mode IN (''none'', ''all'', ''allow'')),
  CHECK (
    (scope_mode = ''allow'' AND tenant_id IS NOT NULL)
    OR (scope_mode IN (''none'', ''all'') AND tenant_id IS NULL)
  )
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_principals', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_principals' AND sql IN ('CREATE TABLE admin_machine_principals (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  principal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''active'',
  default_audience TEXT NOT NULL DEFAULT ''authrim:admin-api'',
  token_ttl_seconds INTEGER NOT NULL DEFAULT 600,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  disabled_by_actor_type TEXT,
  disabled_by_actor_id TEXT,
  CHECK (principal_type IN (
    ''setup_tool'',
    ''admin_ui_bff'',
    ''automation'',
    ''ci'',
    ''mcp_server'',
    ''ai_agent'',
    ''internal_service'',
    ''integration''
  )),
  CHECK (status IN (''active'', ''disabled'', ''deleted'')),
  CHECK (token_ttl_seconds > 0 AND token_ttl_seconds <= 900)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_machine_principals', (SELECT count(*) FROM "admin_machine_principals" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_machine_resource_scopes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_machine_resource_scopes' AND sql IN ('CREATE TABLE admin_machine_resource_scopes (
  id TEXT PRIMARY KEY,
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_machine_resource_scopes', (SELECT count(*) FROM "admin_machine_resource_scopes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_passkeys', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_passkeys' AND sql IN ('CREATE TABLE admin_passkeys (
  -- Passkey ID (UUID v4)
  id TEXT PRIMARY KEY,

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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_passkeys', (SELECT count(*) FROM "admin_passkeys" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_policies' AND sql IN ('CREATE TABLE admin_policies (
  -- Policy ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Policy identification
  name TEXT NOT NULL,  -- Machine-readable name
  display_name TEXT,   -- Human-readable name
  description TEXT,

  -- Policy effect: allow or deny
  effect TEXT NOT NULL DEFAULT ''allow'',  -- allow, deny

  -- Priority (higher = evaluated first, useful for deny policies)
  priority INTEGER DEFAULT 0,

  -- Resource this policy applies to (supports wildcards)
  -- e.g., "admin:users:*", "admin:settings:security", "admin:*"
  resource_pattern TEXT NOT NULL,

  -- Actions this policy applies to (supports wildcards)
  -- e.g., ["read", "write"], ["*"]
  actions_json TEXT NOT NULL DEFAULT ''["*"]'',

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
  conditions_json TEXT NOT NULL DEFAULT ''{}'',

  -- Whether this policy is active
  is_active INTEGER DEFAULT 1,

  -- System policy flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for policy name per tenant
  UNIQUE(tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_policies', (SELECT count(*) FROM "admin_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_rebac_definitions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_rebac_definitions' AND sql IN ('CREATE TABLE admin_rebac_definitions (
  -- Definition ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Relationship name (e.g., ''admin_supervises'', ''admin_team_member'')
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_rebac_definitions', (SELECT count(*) FROM "admin_rebac_definitions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_relationships', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_relationships' AND sql IN ('CREATE TABLE admin_relationships (
  -- Relationship ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Relationship type (e.g., ''manager_of'', ''delegate_of'', ''team_member'')
  relationship_type TEXT NOT NULL,

  -- Source entity (from)
  from_type TEXT NOT NULL DEFAULT ''admin_user'',  -- admin_user, admin_role, team
  from_id TEXT NOT NULL,

  -- Target entity (to)
  to_type TEXT NOT NULL DEFAULT ''admin_user'',  -- admin_user, admin_role, team
  to_id TEXT NOT NULL,

  -- Permission level granted by this relationship
  -- full: All permissions of target
  -- limited: Subset of permissions
  -- read_only: Read-only access
  permission_level TEXT NOT NULL DEFAULT ''full'',

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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_relationships', (SELECT count(*) FROM "admin_relationships" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_role_assignments', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_role_assignments' AND sql IN ('CREATE TABLE admin_role_assignments (
  -- Assignment ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- References
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  admin_role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,

  -- Scope of this assignment
  scope_type TEXT NOT NULL DEFAULT ''tenant'',  -- global | tenant | org
  scope_id TEXT,  -- org_id if scope_type = ''org'', null otherwise

  -- Expiration (for temporary assignments)
  expires_at INTEGER,  -- UNIX timestamp, null for permanent

  -- Audit fields
  assigned_by TEXT,  -- Admin user ID who made this assignment
  created_at INTEGER NOT NULL,

  -- Unique constraint: one role per user per scope
  UNIQUE(admin_user_id, admin_role_id, scope_type, scope_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_role_assignments', (SELECT count(*) FROM "admin_role_assignments" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_roles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_roles' AND sql IN ('CREATE TABLE admin_roles (
  -- Role ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Role identification
  name TEXT NOT NULL,  -- Machine-readable name (e.g., ''super_admin'')
  display_name TEXT,  -- Human-readable name (e.g., ''Super Administrator'')
  description TEXT,

  -- Permissions (JSON array of permission strings)
  -- Format: ["admin:users:read", "admin:users:write", "admin:clients:*"]
  permissions_json TEXT NOT NULL DEFAULT ''[]'',

  -- Hierarchy level (for permission inheritance and delegation)
  -- Higher level = more privilege
  -- Users can only assign roles with lower hierarchy level
  hierarchy_level INTEGER DEFAULT 0,

  -- Role type
  role_type TEXT NOT NULL DEFAULT ''custom'',  -- system | builtin | custom

  -- System role flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, inherits_from TEXT DEFAULT NULL,

  -- Unique constraint for role name per tenant
  UNIQUE(tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_roles', (SELECT count(*) FROM "admin_roles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_search_projections', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_search_projections' AND sql IN ('CREATE TABLE admin_search_projections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT,
  account_id TEXT,
  projection_kind TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT ''internal'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  indexed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_search_projections', (SELECT count(*) FROM "admin_search_projections" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_sessions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_sessions' AND sql IN ('CREATE TABLE admin_sessions (
  -- Session ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

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
, parent_session_id TEXT, derived_target_tenant_id TEXT)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_sessions', (SELECT count(*) FROM "admin_sessions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_setup_tokens', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_setup_tokens' AND sql IN ('CREATE TABLE admin_setup_tokens (
  -- Token ID (the actual token value, UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- Token status
  -- pending: Created, waiting for use
  -- used: Successfully used for passkey registration
  -- expired: Expired without use
  -- revoked: Manually revoked
  status TEXT NOT NULL DEFAULT ''pending'',

  -- Expiration (UNIX timestamp in milliseconds)
  expires_at INTEGER NOT NULL,

  -- Usage tracking
  used_at INTEGER,  -- When the token was used
  used_ip TEXT,     -- IP address that used the token

  -- Audit fields
  created_at INTEGER NOT NULL,
  created_by TEXT  -- ''initial_setup'' | ''cli'' | admin_user_id
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_setup_tokens', (SELECT count(*) FROM "admin_setup_tokens" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_storage_destination_usages', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_storage_destination_usages' AND sql IN ('CREATE TABLE admin_storage_destination_usages (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT ''{}'',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (destination_id, feature, resource_type, resource_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_storage_destination_usages', (SELECT count(*) FROM "admin_storage_destination_usages" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_storage_destinations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_storage_destinations' AND sql IN ('CREATE TABLE admin_storage_destinations (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN (''tenant'', ''platform'')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL CHECK (provider IN (''r2'', ''aws_s3'', ''sftp'', ''custom'')),
  config_json TEXT NOT NULL DEFAULT ''{}'',
  credential_encrypted TEXT,
  credential_key_version INTEGER,
  credential_updated_at INTEGER,
  credential_updated_by TEXT,
  status TEXT NOT NULL DEFAULT ''active'' CHECK (status IN (''active'', ''disabled'')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (scope_type, scope_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_storage_destinations', (SELECT count(*) FROM "admin_storage_destinations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_users', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_users' AND sql IN ('CREATE TABLE admin_users (
  -- Primary key (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Admin user profile
  email TEXT NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,

  -- Authentication
  password_hash TEXT,

  -- Account status
  is_active INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT ''active'',  -- active | suspended | locked

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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_users', (SELECT count(*) FROM "admin_users" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_baseline_assignments', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_baseline_assignments' AND sql IN ('CREATE TABLE agent_baseline_assignments (
  id TEXT PRIMARY KEY,
  baseline_id TEXT NOT NULL,
  baseline_version INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  source_bulk_plan_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  last_evaluated_at INTEGER,
  drift_status TEXT CHECK (drift_status IN (''in_sync'', ''drifted'', ''unknown'')),
  drift_digest TEXT,
  remediation_bulk_plan_id TEXT,
  remediation_bulk_plan_version INTEGER,
  remediation_drift_digest TEXT,
  remediation_requested_at INTEGER,
  last_transition_id TEXT, source_bulk_plan_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(baseline_id, baseline_version, tenant_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_baseline_assignments', (SELECT count(*) FROM "agent_baseline_assignments" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_baseline_exceptions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_baseline_exceptions' AND sql IN ('CREATE TABLE agent_baseline_exceptions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(assignment_id) REFERENCES agent_baseline_assignments(id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_baseline_exceptions', (SELECT count(*) FROM "agent_baseline_exceptions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_bulk_plans', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_bulk_plans' AND sql IN ('CREATE TABLE agent_bulk_plans (
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
  status TEXT NOT NULL CHECK (status IN (''draft'', ''ready'', ''running'', ''paused'', ''completed'')),
  stage TEXT NOT NULL CHECK (stage IN (''validate'', ''apply'', ''verify'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_bulk_tenant_executions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_bulk_tenant_executions' AND sql IN ('CREATE TABLE agent_bulk_tenant_executions (
  id TEXT PRIMARY KEY,
  bulk_plan_id TEXT NOT NULL,
  bulk_plan_version INTEGER NOT NULL,
  target_tenant_id TEXT NOT NULL,
  target_sequence INTEGER NOT NULL CHECK (target_sequence >= 0),
  is_canary INTEGER NOT NULL CHECK (is_canary IN (0, 1)),
  wave_number INTEGER CHECK (wave_number IS NULL OR wave_number >= 1),
  stage TEXT NOT NULL CHECK (stage IN (''validate'', ''apply'', ''verify'')),
  status TEXT NOT NULL CHECK (status IN (''pending'', ''running'', ''succeeded'', ''failed'', ''indeterminate'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_bulk_tenant_executions', (SELECT count(*) FROM "agent_bulk_tenant_executions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_configuration_plan_steps', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_configuration_plan_steps' AND sql IN ('CREATE TABLE agent_configuration_plan_steps (
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  operation TEXT NOT NULL,
  tool_contract_version TEXT NOT NULL,
  input_json TEXT,
  input_digest TEXT NOT NULL,
  resource_precondition TEXT,
  risk_level TEXT NOT NULL CHECK (risk_level IN (''low'', ''standard'', ''high'')),
  status TEXT NOT NULL CHECK (status IN (''pending'', ''succeeded'', ''failed'', ''indeterminate'')),
  result_json TEXT,
  result_digest TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  PRIMARY KEY(plan_id, plan_version, step_id),
  FOREIGN KEY(plan_id, plan_version) REFERENCES agent_configuration_plans(id, version),
  UNIQUE(plan_id, plan_version, sequence)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_configuration_plans', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_configuration_plans' AND sql IN ('CREATE TABLE agent_configuration_plans (
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
  status TEXT NOT NULL CHECK (status IN (''draft'', ''ready'', ''running'', ''completed'', ''failed'')),
  stage TEXT NOT NULL CHECK (stage IN (''validate'', ''apply'', ''verify'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_consents', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_consents' AND sql IN ('CREATE TABLE agent_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  consent_type TEXT NOT NULL CHECK (consent_type IN (''delegation'', ''oauth_client'')),
  grant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  scopes TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
    CHECK (revoked_reason IS NULL OR revoked_reason IN (''user'', ''grant_updated'', ''grant_revoked'', ''admin'')),
  last_mutation_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES admin_users(id),
  UNIQUE (grant_id, client_id, consent_type)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_consents', (SELECT count(*) FROM "agent_consents" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_elevation_challenges', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_elevation_challenges' AND sql IN ('CREATE TABLE agent_elevation_challenges (
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
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (
      ''pending'', ''approved'', ''executing'', ''consumed'', ''failed'',
      ''indeterminate'', ''expired'', ''denied''
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
    CHECK (reconciled_outcome IS NULL OR reconciled_outcome IN (''executed'', ''not_executed'', ''unresolved'')),
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
    (status IN (''pending'', ''approved'', ''executing'') AND active_args_key = ''active'')
    OR (status IN (''consumed'', ''failed'', ''indeterminate'', ''expired'', ''denied'') AND active_args_key = id)
  )
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_elevation_challenges', (SELECT count(*) FROM "agent_elevation_challenges" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_plan_confirmations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_plan_confirmations' AND sql IN ('CREATE TABLE agent_plan_confirmations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  confirmed_by TEXT,
  status TEXT NOT NULL CHECK (status IN (''pending'', ''confirmed'', ''consumed'', ''denied'')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  consumed_at INTEGER,
  last_transition_id TEXT,
  UNIQUE(plan_id, plan_version, plan_digest)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_plan_confirmations', (SELECT count(*) FROM "agent_plan_confirmations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_scope_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_scope_policies' AND sql IN ('CREATE TABLE agent_scope_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN (''builtin'', ''custom'', ''template_copy'')),
  status TEXT NOT NULL CHECK (status IN (''active'', ''archived'')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  source_template_id TEXT,
  source_template_version INTEGER,
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, management_mode TEXT NOT NULL DEFAULT ''managed''
  CHECK (management_mode IN (''managed'', ''system_managed'')),
  UNIQUE(tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_scope_policies', (SELECT count(*) FROM "agent_scope_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_scope_policy_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_scope_policy_versions' AND sql IN ('CREATE TABLE agent_scope_policy_versions (
  scope_policy_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  selector_catalog_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''active'', ''suspended'', ''archived'')),
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_policy_id, version),
  FOREIGN KEY(scope_policy_id) REFERENCES agent_scope_policies(id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_secret_refs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_secret_refs' AND sql IN ('CREATE TABLE agent_secret_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  purpose TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''active'', ''revoked'', ''expired'')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  last_transition_id TEXT,
  UNIQUE(tenant_id, provider_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_secret_refs', (SELECT count(*) FROM "agent_secret_refs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_task_set_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_task_set_versions' AND sql IN ('CREATE TABLE agent_task_set_versions (
  task_set_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  tool_entries_json TEXT NOT NULL,
  resolved_permissions_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''active'', ''suspended'', ''archived'')),
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(task_set_id, version),
  FOREIGN KEY(task_set_id) REFERENCES agent_task_sets(id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_task_sets', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_task_sets' AND sql IN ('CREATE TABLE agent_task_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN (''builtin'', ''custom'', ''template_copy'')),
  status TEXT NOT NULL CHECK (status IN (''active'', ''archived'')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  source_template_id TEXT,
  source_template_version INTEGER,
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, management_mode TEXT NOT NULL DEFAULT ''managed''
  CHECK (management_mode IN (''managed'', ''system_managed'')),
  UNIQUE(tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_task_sets', (SELECT count(*) FROM "agent_task_sets" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:agent_template_copies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_template_copies' AND sql IN ('CREATE TABLE agent_template_copies (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  target_tenant_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  target_object_version INTEGER NOT NULL,
  target_object_status TEXT NOT NULL CHECK (target_object_status = ''inactive''),
  bulk_plan_id TEXT NOT NULL,
  copied_by TEXT NOT NULL,
  copied_at INTEGER NOT NULL, bulk_plan_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(template_id, template_version, target_tenant_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:agent_template_copies', (SELECT count(*) FROM "agent_template_copies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:approval_request_approvals', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='approval_request_approvals' AND sql IN ('CREATE TABLE "approval_request_approvals" (
  id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  side TEXT NOT NULL CHECK (
    side IN (''admin_operator'', ''customer_data_owner'', ''guardian_delegate'')
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN (''admin_user'', ''end_user'', ''customer_delegate'', ''service_principal'')
  ),
  subject_id TEXT,
  relation_type TEXT,
  relation_source TEXT,
  status TEXT NOT NULL CHECK (
    status IN (''pending'', ''approved'', ''denied'', ''expired'', ''cancelled'')
  ),
  method TEXT CHECK (
    method IN (''ciba'', ''passkey'', ''portal_confirm'', ''email_otp'', ''sms_otp'', ''reauth'')
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
    last_notification_action IN (''initial'', ''resend'', ''remind'')
  ),
  last_notified_at INTEGER,
  notification_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:approval_request_approvals', (SELECT count(*) FROM "approval_request_approvals" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:approval_requests', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='approval_requests' AND sql IN ('CREATE TABLE "approval_requests" (
  id TEXT PRIMARY KEY,
  public_request_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  investigation_id TEXT NOT NULL,
  requester_subject_type TEXT NOT NULL CHECK (
    requester_subject_type IN (''admin_user'', ''end_user'', ''customer_delegate'', ''service_principal'')
  ),
  requester_subject_id TEXT NOT NULL,
  target_subject_type TEXT NOT NULL CHECK (
    target_subject_type IN (''user'', ''artifact'', ''service_resource'', ''tenant_resource'')
  ),
  target_subject_id TEXT NOT NULL,
  request_surface TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  redaction_level TEXT NOT NULL CHECK (redaction_level IN (''summary_only'', ''masked'', ''raw'')),
  status TEXT NOT NULL CHECK (
    status IN (''pending'', ''partially_approved'', ''approved'', ''denied'', ''expired'', ''cancelled'')
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
  reuse_scope TEXT NOT NULL DEFAULT ''request'' CHECK (reuse_scope IN (''request'', ''case'')),
  policy_preset TEXT NOT NULL,
  partial_access_allowed INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  detail_object_catalog_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (detail_object_catalog_id) REFERENCES object_catalog(id) ON DELETE SET NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:approval_requests', (SELECT count(*) FROM "approval_requests" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:attribute_field_registry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='attribute_field_registry' AND sql IN ('CREATE TABLE attribute_field_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  owner_scope_type TEXT NOT NULL DEFAULT ''tenant'',
  owner_scope_id TEXT,
  protocol TEXT NOT NULL,
  field_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT ''string'',
  classification TEXT NOT NULL DEFAULT ''internal'',
  surfaces_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, protocol, field_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:attribute_field_registry', (SELECT count(*) FROM "attribute_field_registry" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:attribute_group_registry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='attribute_group_registry' AND sql IN ('CREATE TABLE attribute_group_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  owner_scope_type TEXT NOT NULL DEFAULT ''tenant'',
  owner_scope_id TEXT,
  protocol TEXT NOT NULL,
  group_type TEXT NOT NULL,
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  field_keys_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, protocol, group_type, group_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:attribute_group_registry', (SELECT count(*) FROM "attribute_group_registry" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_migrations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_migrations' AND sql IN ('CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)','CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_migrations', (SELECT count(*) FROM "authrim_migrations" WHERE "filename" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_runtime_probes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_runtime_probes' AND sql IN ('CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )','CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_runtime_probes', (SELECT count(*) FROM "authrim_runtime_probes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:blind_index_rotation_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='blind_index_rotation_jobs' AND sql IN ('CREATE TABLE blind_index_rotation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  key_registry_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''queued'',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:blind_index_rotation_jobs', (SELECT count(*) FROM "blind_index_rotation_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:compiled_mapping_snapshots', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='compiled_mapping_snapshots' AND sql IN ('CREATE TABLE compiled_mapping_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_mapping_version_id TEXT NOT NULL,
  catalog_version_id TEXT,
  snapshot_hash TEXT NOT NULL,
  compatibility_range TEXT,
  artifact_ref TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  compiled_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  metadata_json TEXT,
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:compiled_mapping_snapshots', (SELECT count(*) FROM "compiled_mapping_snapshots" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:credential_profile_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='credential_profile_versions' AND sql IN ('CREATE TABLE credential_profile_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  credential_profile_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  lifecycle_state TEXT NOT NULL DEFAULT ''draft''
    CHECK (lifecycle_state IN (''draft'', ''published'', ''retired'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:credential_profile_versions', (SELECT count(*) FROM "credential_profile_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:credential_profiles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='credential_profiles' AND sql IN ('CREATE TABLE credential_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft''
    CHECK (lifecycle_state IN (''draft'', ''published'', ''disabled'')),
  current_published_version_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:credential_profiles', (SELECT count(*) FROM "credential_profiles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:credential_secret_bodies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='credential_secret_bodies' AND sql IN ('CREATE TABLE credential_secret_bodies (
  credential_ref TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:credential_secret_bodies', (SELECT count(*) FROM "credential_secret_bodies" WHERE "credential_ref" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:credential_secret_metadata', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='credential_secret_metadata' AND sql IN ('CREATE TABLE credential_secret_metadata (
  credential_ref TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (
    backend IN (''r2_encrypted_object'', ''d1_encrypted_table'', ''external_secret_manager'')
  ),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''active'', ''next'', ''retiring'', ''retired'', ''deleted'')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  metadata TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:credential_secret_metadata', (SELECT count(*) FROM "credential_secret_metadata" WHERE "credential_ref" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:custom_field_catalog_entries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='custom_field_catalog_entries' AND sql IN ('CREATE TABLE custom_field_catalog_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  catalog_entry_id TEXT,
  custom_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  value_type TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT ''internal'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, custom_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:custom_field_catalog_entries', (SELECT count(*) FROM "custom_field_catalog_entries" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:dependency_graph_snapshots', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='dependency_graph_snapshots' AND sql IN ('CREATE TABLE dependency_graph_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_mapping_version_id TEXT,
  snapshot_hash TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:dependency_graph_snapshots', (SELECT count(*) FROM "dependency_graph_snapshots" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:destination_profile_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='destination_profile_versions' AND sql IN ('CREATE TABLE destination_profile_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  profile_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:destination_profile_versions', (SELECT count(*) FROM "destination_profile_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:destination_profiles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='destination_profiles' AND sql IN ('CREATE TABLE destination_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  destination_type TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL DEFAULT ''tenant'',
  owner_scope_id TEXT,
  base_profile_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, destination_type, profile_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:destination_profiles', (SELECT count(*) FROM "destination_profiles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:elevation_grants', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='elevation_grants' AND sql IN ('CREATE TABLE "elevation_grants" (
  id TEXT PRIMARY KEY,
  public_grant_id TEXT NOT NULL UNIQUE,
  approval_request_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  status TEXT NOT NULL CHECK (status IN (''active'', ''expired'', ''revoked'')),
  target_audience TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  redaction_level TEXT NOT NULL CHECK (redaction_level IN (''summary_only'', ''masked'', ''raw'')),
  scope_canonical TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  authorization_details_json TEXT,
  requester_subject_type TEXT NOT NULL CHECK (
    requester_subject_type IN (''admin_user'', ''end_user'', ''customer_delegate'', ''service_principal'')
  ),
  requester_subject_id TEXT NOT NULL,
  actor_subject_type TEXT NOT NULL CHECK (
    actor_subject_type IN (''admin_user'', ''end_user'', ''customer_delegate'', ''service_principal'')
  ),
  actor_subject_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:elevation_grants', (SELECT count(*) FROM "elevation_grants" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:external_schema_catalogs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='external_schema_catalogs' AND sql IN ('CREATE TABLE external_schema_catalogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:external_schema_catalogs', (SELECT count(*) FROM "external_schema_catalogs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_entity_statements', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_entity_statements' AND sql IN ('CREATE TABLE federation_entity_statements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  statement_hash TEXT NOT NULL,
  statement_ref TEXT,
  expires_at INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT ''reserved'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_entity_statements', (SELECT count(*) FROM "federation_entity_statements" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_metadata_documents', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_metadata_documents' AND sql IN ('CREATE TABLE federation_metadata_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  source_url TEXT,
  document_hash TEXT NOT NULL,
  document_ref TEXT,
  fetched_at INTEGER,
  validated_at INTEGER,
  validation_state TEXT NOT NULL DEFAULT ''pending'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_metadata_documents', (SELECT count(*) FROM "federation_metadata_documents" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_metadata_entity_summaries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_metadata_entity_summaries' AND sql IN ('CREATE TABLE federation_metadata_entity_summaries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  metadata_document_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_role TEXT NOT NULL,
  display_name TEXT,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, metadata_document_id, entity_id, entity_role)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_metadata_entity_summaries', (SELECT count(*) FROM "federation_metadata_entity_summaries" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_metadata_refresh_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_metadata_refresh_jobs' AND sql IN ('CREATE TABLE federation_metadata_refresh_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''queued'',
  refresh_mode TEXT NOT NULL DEFAULT ''manual'',
  scheduled_for INTEGER,
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_metadata_refresh_jobs', (SELECT count(*) FROM "federation_metadata_refresh_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_metadata_validation_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_metadata_validation_events' AND sql IN ('CREATE TABLE federation_metadata_validation_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT,
  metadata_document_id TEXT,
  validation_state TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_metadata_validation_events', (SELECT count(*) FROM "federation_metadata_validation_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_saml_runtime_entities', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_saml_runtime_entities' AND sql IN ('CREATE TABLE federation_saml_runtime_entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_saml_runtime_entities', (SELECT count(*) FROM "federation_saml_runtime_entities" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_selected_entity_import_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_selected_entity_import_events' AND sql IN ('CREATE TABLE federation_selected_entity_import_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT NOT NULL,
  metadata_entity_summary_id TEXT,
  provider_id TEXT,
  import_action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_selected_entity_import_events', (SELECT count(*) FROM "federation_selected_entity_import_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_trust_anchors', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_trust_anchors' AND sql IN ('CREATE TABLE federation_trust_anchors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT NOT NULL,
  anchor_type TEXT NOT NULL,
  anchor_hash TEXT NOT NULL,
  anchor_ref TEXT,
  not_before INTEGER,
  not_after INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_trust_anchors', (SELECT count(*) FROM "federation_trust_anchors" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_trust_chains', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_trust_chains' AND sql IN ('CREATE TABLE federation_trust_chains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT,
  subject TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  chain_json TEXT,
  validation_state TEXT NOT NULL DEFAULT ''reserved'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_trust_chains', (SELECT count(*) FROM "federation_trust_chains" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_trust_context_snapshots', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_trust_context_snapshots' AND sql IN ('CREATE TABLE federation_trust_context_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  trust_context_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  created_at INTEGER NOT NULL,
  activated_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_trust_context_snapshots', (SELECT count(*) FROM "federation_trust_context_snapshots" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_trust_scope_bindings', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_trust_scope_bindings' AND sql IN ('CREATE TABLE federation_trust_scope_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  trust_source_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_trust_scope_bindings', (SELECT count(*) FROM "federation_trust_scope_bindings" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:federation_trust_sources', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='federation_trust_sources' AND sql IN ('CREATE TABLE federation_trust_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  protocol_payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, refresh_operation_token TEXT, refresh_operation_expires_at INTEGER, active_metadata_document_id TEXT,
  UNIQUE (tenant_id, source_type, source_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:federation_trust_sources', (SELECT count(*) FROM "federation_trust_sources" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:field_catalog_entries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='field_catalog_entries' AND sql IN ('CREATE TABLE field_catalog_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  catalog_version_id TEXT NOT NULL,
  stable_field_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  path TEXT NOT NULL,
  target_taxonomy TEXT NOT NULL,
  value_type TEXT NOT NULL,
  cardinality TEXT NOT NULL DEFAULT ''single'',
  classification TEXT NOT NULL DEFAULT ''internal'',
  aliases_json TEXT,
  validation_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, ui_group_key TEXT, ui_group_label TEXT, ui_group_order INTEGER NOT NULL DEFAULT 0, ui_field_order INTEGER NOT NULL DEFAULT 0, examples_json TEXT, note TEXT,
  UNIQUE (tenant_id, catalog_version_id, stable_field_id),
  FOREIGN KEY (catalog_version_id) REFERENCES field_catalog_versions(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:field_catalog_entries', (SELECT count(*) FROM "field_catalog_entries" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:field_catalog_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='field_catalog_versions' AND sql IN ('CREATE TABLE field_catalog_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  catalog_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  compatibility_range TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_id, version_label),
  FOREIGN KEY (catalog_id) REFERENCES field_catalogs(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:field_catalog_versions', (SELECT count(*) FROM "field_catalog_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:field_catalogs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='field_catalogs' AND sql IN ('CREATE TABLE field_catalogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  catalog_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:field_catalogs', (SELECT count(*) FROM "field_catalogs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:field_mapping_activations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='field_mapping_activations' AND sql IN ('CREATE TABLE field_mapping_activations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_mapping_set_id TEXT NOT NULL,
  field_mapping_version_id TEXT NOT NULL,
  activation_scope_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''scheduled'',
  active_from INTEGER,
  active_until INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (field_mapping_set_id) REFERENCES field_mapping_sets(id) ON DELETE CASCADE,
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:field_mapping_activations', (SELECT count(*) FROM "field_mapping_activations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:field_mapping_sets', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='field_mapping_sets' AND sql IN ('CREATE TABLE field_mapping_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_mapping_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  owner_scope_type TEXT NOT NULL DEFAULT ''tenant'',
  owner_scope_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, field_mapping_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:field_mapping_sets', (SELECT count(*) FROM "field_mapping_sets" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:field_mapping_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='field_mapping_versions' AND sql IN ('CREATE TABLE field_mapping_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_mapping_set_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  field_mapping_hash TEXT NOT NULL,
  compatibility_range TEXT,
  author_id TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, field_mapping_set_id, version_label),
  FOREIGN KEY (field_mapping_set_id) REFERENCES field_mapping_sets(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:field_mapping_versions', (SELECT count(*) FROM "field_mapping_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:idempotency_records', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='idempotency_records' AND sql IN ('CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  idempotency_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_ref TEXT,
  status TEXT NOT NULL DEFAULT ''in_progress'',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, operation_key, idempotency_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:idempotency_records', (SELECT count(*) FROM "idempotency_records" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:internal_notification_delivery_attempts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='internal_notification_delivery_attempts' AND sql IN ('CREATE TABLE internal_notification_delivery_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  route_id TEXT,
  provider TEXT NOT NULL,
  destination_id TEXT,
  status TEXT NOT NULL CHECK (status IN (''queued'', ''delivered'', ''failed'', ''dead_letter'', ''suppressed'')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error_class TEXT,
  error_message TEXT,
  next_attempt_at INTEGER,
  payload_sha256 TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:internal_notification_delivery_attempts', (SELECT count(*) FROM "internal_notification_delivery_attempts" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:internal_notification_delivery_routes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='internal_notification_delivery_routes' AND sql IN ('CREATE TABLE internal_notification_delivery_routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT ''platform'' CHECK (scope_type IN (''platform'', ''tenant'')),
  scope_id TEXT NOT NULL DEFAULT ''global'',
  provider TEXT NOT NULL CHECK (provider IN (''webhook'', ''email'', ''slack'', ''custom'')),
  destination_id TEXT,
  categories_json TEXT,
  severities_json TEXT,
  min_severity TEXT NOT NULL DEFAULT ''medium''
    CHECK (min_severity IN (''critical'', ''high'', ''medium'', ''low'', ''info'')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  failure_policy TEXT NOT NULL DEFAULT ''retry_until_dead_letter''
    CHECK (failure_policy IN (''best_effort'', ''retry_until_dead_letter'', ''fail_closed'')),
  max_attempts INTEGER NOT NULL DEFAULT 5,
  retry_after_seconds INTEGER NOT NULL DEFAULT 300,
  suppression_key TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:internal_notification_delivery_routes', (SELECT count(*) FROM "internal_notification_delivery_routes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:internal_notification_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='internal_notification_events' AND sql IN ('CREATE TABLE "internal_notification_events" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      ''identity_mapping_signal'',
      ''identity_mapping_manual_review'',
      ''identity_mapping_propagation_failure'',
      ''identity_mapping_bulk_impact'',
      ''storage_registry_security'',
      ''storage_registry_health'',
      ''tenant_database_stats'',
      ''tenant_database_health'',
      ''control_plane_drift'',
      ''logging_destination_health'',
      ''logging_delivery_failure'',
      ''logging_fallback_used'',
      ''logging_dlq_backlog'',
      ''logging_quota_warning'',
      ''logging_repair_job_status'',
      ''notification_delivery_failure''
    )
  ),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN (''critical'', ''high'', ''medium'', ''low'', ''info'')),
  status TEXT NOT NULL DEFAULT ''pending'' CHECK (
    status IN (''pending'', ''delivered'', ''failed'', ''dead_letter'', ''suppressed'')
  ),
  deduplication_key TEXT,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:internal_notification_events', (SELECT count(*) FROM "internal_notification_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:key_access_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='key_access_events' AND sql IN ('CREATE TABLE key_access_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  key_registry_id TEXT NOT NULL,
  key_version_id TEXT,
  actor_id TEXT,
  access_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:key_access_events', (SELECT count(*) FROM "key_access_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:key_material_refs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='key_material_refs' AND sql IN ('CREATE TABLE key_material_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  key_version_id TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  material_ref TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (key_version_id) REFERENCES key_versions(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:key_material_refs', (SELECT count(*) FROM "key_material_refs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:key_registries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='key_registries' AND sql IN ('CREATE TABLE key_registries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  key_purpose TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  active_version_id TEXT,
  status TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:key_registries', (SELECT count(*) FROM "key_registries" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:key_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='key_versions' AND sql IN ('CREATE TABLE key_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  key_registry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending'',
  algorithm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  UNIQUE (tenant_id, key_registry_id, version),
  FOREIGN KEY (key_registry_id) REFERENCES key_registries(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:key_versions', (SELECT count(*) FROM "key_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:log_chunk_manifests', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='log_chunk_manifests' AND sql IN ('CREATE TABLE log_chunk_manifests (
  id TEXT PRIMARY KEY,
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
  status TEXT NOT NULL CHECK (status IN (''pending'', ''committed'', ''repair_needed'')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:log_chunk_manifests', (SELECT count(*) FROM "log_chunk_manifests" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:log_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='log_object_catalog' AND sql IN ('CREATE TABLE log_object_catalog (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN (''chunk'', ''manifest'', ''dlq_payload'', ''export_artifact'')),
  status TEXT NOT NULL CHECK (status IN (''pending'', ''committed'', ''orphan_candidate'', ''deleted'')),
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  compression TEXT CHECK (compression IN (''none'', ''gzip_block'')),
  encryption_scope TEXT,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  deleted_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:log_object_catalog', (SELECT count(*) FROM "log_object_catalog" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_catalog_repair_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_catalog_repair_jobs' AND sql IN ('CREATE TABLE logging_catalog_repair_jobs (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL CHECK (job_kind IN (''scan'', ''apply_safe'', ''dangerous_preview'', ''dangerous_apply'')),
  status TEXT NOT NULL CHECK (
    status IN (''queued'', ''running'', ''completed'', ''failed'', ''cancel_requested'', ''cancelled'')
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_catalog_repair_jobs', (SELECT count(*) FROM "logging_catalog_repair_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_delivery_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_delivery_events' AND sql IN ('CREATE TABLE logging_delivery_events (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  destination_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN (''critical'', ''default'', ''bulk'')),
  status TEXT NOT NULL CHECK (status IN (''queued'', ''delivered'', ''retrying'', ''failed'', ''dlq'')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  object_catalog_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_retry_at INTEGER,
  metadata TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_delivery_events', (SELECT count(*) FROM "logging_delivery_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_destination_override_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_destination_override_history' AND sql IN ('CREATE TABLE logging_destination_override_history (
  id TEXT PRIMARY KEY,
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_destination_override_history', (SELECT count(*) FROM "logging_destination_override_history" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_destination_overrides', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_destination_overrides' AND sql IN ('CREATE TABLE logging_destination_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  fallback_policy_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  managed_by TEXT NOT NULL CHECK (managed_by IN (''platform'', ''tenant'')),
  change_protection TEXT NOT NULL DEFAULT ''confirm''
    CHECK (change_protection IN (''confirm'', ''approval_required'', ''config_only'')),
  approval_policy_id TEXT,
  policy_hash TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_destination_overrides', (SELECT count(*) FROM "logging_destination_overrides" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_dlq_items', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_dlq_items' AND sql IN ('CREATE TABLE logging_dlq_items (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN (''critical'', ''default'', ''bulk'')),
  destination_id TEXT,
  payload_object_ref TEXT NOT NULL,
  error_class TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''open'', ''replayed'', ''deleted'', ''purged'')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_dlq_items', (SELECT count(*) FROM "logging_dlq_items" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_export_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_export_jobs' AND sql IN ('CREATE TABLE logging_export_jobs (
  id TEXT PRIMARY KEY,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  format TEXT NOT NULL CHECK (format IN (''jsonl'', ''csv'', ''zip'')),
  status TEXT NOT NULL CHECK (status IN (''queued'', ''running'', ''completed'', ''failed'', ''expired'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_export_jobs', (SELECT count(*) FROM "logging_export_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_fallback_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_fallback_policies' AND sql IN ('CREATE TABLE logging_fallback_policies (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN (''platform'', ''tenant'')),
  scope_id TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  fallback_destination_id TEXT,
  failure_mode TEXT NOT NULL DEFAULT ''platform_default'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_fallback_policies', (SELECT count(*) FROM "logging_fallback_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_key_material_bodies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_key_material_bodies' AND sql IN ('CREATE TABLE logging_key_material_bodies (
  backend_ref TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  surface TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_key_material_bodies', (SELECT count(*) FROM "logging_key_material_bodies" WHERE "backend_ref" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_key_registry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_key_registry' AND sql IN ('CREATE TABLE logging_key_registry (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  surface TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  active_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''active'', ''rotating'', ''stale'', ''compromised'', ''disabled'')),
  last_rotated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_key_registry', (SELECT count(*) FROM "logging_key_registry" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_message_export_builds', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_message_export_builds' AND sql IN ('CREATE TABLE logging_message_export_builds (
  id TEXT PRIMARY KEY,
  message_job_id TEXT NOT NULL,
  export_job_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN (''plan'', ''build_partition'', ''finalize'', ''verify_manifest'', ''cleanup'')
  ),
  partition_strategy TEXT NOT NULL CHECK (
    partition_strategy IN (''time_bucket_shard'', ''query_page'', ''chunk_index'', ''manifest_shard'')
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

  cleanup_status TEXT NOT NULL DEFAULT ''not_required'' CHECK (
    cleanup_status IN (''not_required'', ''queued'', ''running'', ''completed'', ''failed'')
  ),
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_message_export_builds', (SELECT count(*) FROM "logging_message_export_builds" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_message_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_message_jobs' AND sql IN ('CREATE TABLE logging_message_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (''retry_delivery'', ''export_build'')),
  status TEXT NOT NULL CHECK (
    status IN (
      ''queued'',
      ''claimed'',
      ''running'',
      ''retrying'',
      ''completed'',
      ''failed'',
      ''dlq'',
      ''cancelled'',
      ''expired'',
      ''blocked''
    )
  ),
  lane TEXT NOT NULL CHECK (lane IN (''critical'', ''default'', ''bulk'')),
  criticality TEXT NOT NULL CHECK (criticality IN (''standard'', ''critical'')),
  priority INTEGER NOT NULL DEFAULT 0,

  tenant_id TEXT,
  tenant_key TEXT,
  topology_type TEXT NOT NULL CHECK (
    topology_type IN (''platform'', ''control_plane_d1'', ''external_db'', ''unknown'')
  ),
  database_binding_ref TEXT,
  connection_ref TEXT,
  topology_snapshot_version INTEGER,
  topology_resolved_at INTEGER,

  scope_type TEXT NOT NULL CHECK (scope_type IN (''platform'', ''tenant'', ''shared'')),
  scope_id TEXT,
  scope_key TEXT NOT NULL,

  source_type TEXT CHECK (source_type IN (''dlq_item'', ''delivery_event'', ''payload_object'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_message_jobs', (SELECT count(*) FROM "logging_message_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_message_repair_findings', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_message_repair_findings' AND sql IN ('CREATE TABLE logging_message_repair_findings (
  id TEXT PRIMARY KEY,
  message_job_id TEXT,
  finding_type TEXT NOT NULL CHECK (
    finding_type IN (
      ''stuck_claim'',
      ''expired_queued'',
      ''expired_retrying'',
      ''missing_payload_object'',
      ''missing_export_part'',
      ''orphan_staging_object'',
      ''event_job_mismatch'',
      ''blocked_configuration''
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN (''info'', ''warning'', ''error'', ''critical'')),
  status TEXT NOT NULL CHECK (
    status IN (''open'', ''safe_repaired'', ''dangerous_previewed'', ''dangerous_applied'', ''ignored'')
  ),
  safe_action TEXT,
  dangerous_action TEXT,
  impact_json TEXT,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER,
  applied_by TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_message_repair_findings', (SELECT count(*) FROM "logging_message_repair_findings" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_policy_snapshots', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_policy_snapshots' AND sql IN ('CREATE TABLE logging_policy_snapshots (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN (''platform'', ''tenant'')),
  scope_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''draft'', ''published'', ''retired'')),
  policy_hash TEXT NOT NULL,
  object_ref TEXT,
  snapshot_json TEXT,
  published_by TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_policy_snapshots', (SELECT count(*) FROM "logging_policy_snapshots" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_quota_evaluations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_quota_evaluations' AND sql IN ('CREATE TABLE logging_quota_evaluations (
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
  state TEXT NOT NULL CHECK (state IN (''ok'', ''warning'', ''soft_exceeded'', ''hard_exceeded'')),
  enforcement_action TEXT NOT NULL CHECK (
    enforcement_action IN (''none'', ''notify'', ''throttle_non_critical'', ''block_non_critical'')
  ),
  evaluated_at INTEGER NOT NULL,
  notification_event_id TEXT,
  metadata_json TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_quota_evaluations', (SELECT count(*) FROM "logging_quota_evaluations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_quota_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_quota_policies' AND sql IN ('CREATE TABLE logging_quota_policies (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN (''platform'', ''tenant'')),
  scope_id TEXT NOT NULL,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN (''critical'', ''default'', ''bulk'')),
  metric_name TEXT NOT NULL CHECK (
    metric_name IN (
      ''delivery_records'',
      ''delivery_bytes'',
      ''delivery_batches'',
      ''dlq_items'',
      ''catalog_objects'',
      ''catalog_bytes'',
      ''sensitive_detail_bytes'',
      ''message_jobs''
    )
  ),
  window_kind TEXT NOT NULL DEFAULT ''day'' CHECK (window_kind IN (''hour'', ''day'')),
  soft_limit INTEGER,
  hard_limit INTEGER,
  warning_ratio REAL NOT NULL DEFAULT 0.8,
  enforcement_mode TEXT NOT NULL DEFAULT ''warn_only''
    CHECK (enforcement_mode IN (''disabled'', ''observe'', ''warn_only'', ''soft_limit'', ''hard_non_critical'')),
  critical_behavior TEXT NOT NULL DEFAULT ''never_block''
    CHECK (critical_behavior IN (''never_block'')),
  status TEXT NOT NULL DEFAULT ''active'' CHECK (status IN (''active'', ''disabled'', ''deleted'')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_quota_policies', (SELECT count(*) FROM "logging_quota_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_rewrap_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_rewrap_jobs' AND sql IN ('CREATE TABLE logging_rewrap_jobs (
  id TEXT PRIMARY KEY,
  key_registry_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''queued'', ''running'', ''succeeded'', ''failed'', ''skipped'')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  metadata TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_rewrap_jobs', (SELECT count(*) FROM "logging_rewrap_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_usage_aggregates', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_usage_aggregates' AND sql IN ('CREATE TABLE logging_usage_aggregates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN (''critical'', ''default'', ''bulk'')),
  metric_name TEXT NOT NULL CHECK (
    metric_name IN (
      ''delivery_records'',
      ''delivery_bytes'',
      ''delivery_batches'',
      ''dlq_items'',
      ''catalog_objects'',
      ''catalog_bytes'',
      ''sensitive_detail_bytes'',
      ''message_jobs''
    )
  ),
  window_kind TEXT NOT NULL CHECK (window_kind IN (''hour'', ''day'')),
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  source_table TEXT NOT NULL,
  metadata_json TEXT,
  refreshed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_usage_aggregates', (SELECT count(*) FROM "logging_usage_aggregates" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_activation_leases', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_activation_leases' AND sql IN ('CREATE TABLE mapping_activation_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  lease_key TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lease_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_activation_leases', (SELECT count(*) FROM "mapping_activation_leases" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_conflict_rules', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_conflict_rules' AND sql IN ('CREATE TABLE mapping_conflict_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_mapping_version_id TEXT NOT NULL,
  target_ref_json TEXT NOT NULL,
  conflict_strategy TEXT NOT NULL,
  source_priority_json TEXT,
  condition_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (field_mapping_version_id) REFERENCES field_mapping_versions(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_conflict_rules', (SELECT count(*) FROM "mapping_conflict_rules" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_events' AND sql IN ('CREATE TABLE mapping_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  event_type TEXT NOT NULL,
  field_mapping_version_id TEXT,
  subject_id TEXT,
  source_id TEXT,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_events', (SELECT count(*) FROM "mapping_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_release_rules', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_release_rules' AND sql IN ('CREATE TABLE mapping_release_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_release_rules', (SELECT count(*) FROM "mapping_release_rules" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_rule_edges', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_rule_edges' AND sql IN ('CREATE TABLE mapping_rule_edges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  rule_id TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  target_ref_json TEXT NOT NULL,
  edge_kind TEXT NOT NULL DEFAULT ''direct'',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_rule_edges', (SELECT count(*) FROM "mapping_rule_edges" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_rules', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_rules' AND sql IN ('CREATE TABLE mapping_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_rules', (SELECT count(*) FROM "mapping_rules" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_templates', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_templates' AND sql IN ('CREATE TABLE mapping_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  template_key TEXT NOT NULL,
  template_scope TEXT NOT NULL DEFAULT ''system'',
  display_name TEXT NOT NULL,
  template_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, template_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_templates', (SELECT count(*) FROM "mapping_templates" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_transform_steps', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_transform_steps' AND sql IN ('CREATE TABLE mapping_transform_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_transform_steps', (SELECT count(*) FROM "mapping_transform_steps" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:mapping_validation_rules', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapping_validation_rules' AND sql IN ('CREATE TABLE mapping_validation_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  rule_id TEXT,
  target_ref_json TEXT NOT NULL,
  validation_kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT ''error'',
  parameters_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:mapping_validation_rules', (SELECT count(*) FROM "mapping_validation_rules" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:migration_metadata', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migration_metadata' AND sql IN ('CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)','CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:migration_metadata', (SELECT count(*) FROM "migration_metadata" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='object_catalog' AND sql IN ('CREATE TABLE "object_catalog" (
  id TEXT PRIMARY KEY,
  public_artifact_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  object_class TEXT NOT NULL CHECK (
    object_class IN (
      ''admin_audit_detail'',
      ''event_log_detail'',
      ''pii_log_values'',
      ''webhook_delivery_payload'',
      ''operational_log_detail'',
      ''user_export'',
      ''user_import_input'',
      ''user_import_result'',
      ''admin_job_result'',
      ''directory_auth_evidence_export'',
      ''directory_auth_support_bundle'',
      ''approval_transport_detail'',
      ''dr_bundle''
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:object_catalog', (SELECT count(*) FROM "object_catalog" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:object_catalog_objects', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='object_catalog_objects' AND sql IN ('CREATE TABLE object_catalog_objects (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  representation TEXT NOT NULL CHECK (
    representation IN (
      ''canonical_json'',
      ''csv_projection'',
      ''ndjson_projection'',
      ''zip_bundle''
    )
  ),
  object_kind TEXT NOT NULL CHECK (object_kind IN (''single'', ''manifest'', ''chunk'')),
  object_index INTEGER NOT NULL DEFAULT 0,
  bucket_binding TEXT NOT NULL CHECK (
    bucket_binding IN (''IMPORT_ARTIFACTS'', ''EXPORT_ARTIFACTS'', ''SENSITIVE_DETAILS'')
  ),
  object_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  total_bytes INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE,
  UNIQUE(catalog_id, representation, object_index)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:object_catalog_objects', (SELECT count(*) FROM "object_catalog_objects" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:operational_notification_states', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='operational_notification_states' AND sql IN ('CREATE TABLE operational_notification_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  notification_event_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT ''open'',
  assigned_to TEXT,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:operational_notification_states', (SELECT count(*) FROM "operational_notification_states" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:persistent_identifier_profiles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='persistent_identifier_profiles' AND sql IN ('CREATE TABLE persistent_identifier_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  mode TEXT NOT NULL DEFAULT ''computed'',
  algorithm TEXT NOT NULL DEFAULT ''authrim_sha256_base64url'',
  protocol_scope TEXT NOT NULL DEFAULT ''any'',
  usage_json TEXT NOT NULL DEFAULT ''[]'',
  source_ref_json TEXT,
  secret_ref TEXT,
  issuer_entity_id TEXT,
  audience_mode TEXT NOT NULL DEFAULT ''runtime'',
  format_json TEXT NOT NULL DEFAULT ''{}'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:persistent_identifier_profiles', (SELECT count(*) FROM "persistent_identifier_profiles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:projection_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='projection_jobs' AND sql IN ('CREATE TABLE projection_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  job_type TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''queued'',
  cursor_json TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:projection_jobs', (SELECT count(*) FROM "projection_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:projection_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='projection_outbox' AND sql IN ('CREATE TABLE projection_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  event_type TEXT NOT NULL,
  subject_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT ''pending'',
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:projection_outbox', (SELECT count(*) FROM "projection_outbox" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:protocol_schema_catalogs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='protocol_schema_catalogs' AND sql IN ('CREATE TABLE protocol_schema_catalogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  protocol TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  schema_version TEXT,
  schema_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, protocol, schema_key, schema_version)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:protocol_schema_catalogs', (SELECT count(*) FROM "protocol_schema_catalogs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:provider_reprojection_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='provider_reprojection_jobs' AND sql IN ('CREATE TABLE provider_reprojection_jobs (
  job_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  desired_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''processing'', ''completed'', ''failed'', ''superseded'')),
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
  CHECK ((status = ''processing'' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (status <> ''processing'' AND lease_owner IS NULL AND lease_expires_at IS NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:provider_reprojection_jobs', (SELECT count(*) FROM "provider_reprojection_jobs" WHERE "job_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:replay_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='replay_jobs' AND sql IN ('CREATE TABLE replay_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  replay_type TEXT NOT NULL,
  impact_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''queued'',
  cursor_json TEXT,
  result_summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:replay_jobs', (SELECT count(*) FROM "replay_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:review_task_groups', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='review_task_groups' AND sql IN ('CREATE TABLE review_task_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  group_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''open'',
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:review_task_groups', (SELECT count(*) FROM "review_task_groups" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:review_tasks', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='review_tasks' AND sql IN ('CREATE TABLE review_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  task_type TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT ''open'',
  priority INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  payload_json TEXT NOT NULL,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:review_tasks', (SELECT count(*) FROM "review_tasks" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:rewrap_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='rewrap_jobs' AND sql IN ('CREATE TABLE rewrap_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  key_registry_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT NOT NULL,
  artifact_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''queued'',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:rewrap_jobs', (SELECT count(*) FROM "rewrap_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:scheduled_task_leases', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scheduled_task_leases' AND sql IN ('CREATE TABLE scheduled_task_leases (
  task_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:scheduled_task_leases', (SELECT count(*) FROM "scheduled_task_leases" WHERE "task_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:sensitive_detail_chunk_index', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sensitive_detail_chunk_index' AND sql IN ('CREATE TABLE sensitive_detail_chunk_index (
  catalog_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  object_class TEXT NOT NULL,
  bucket_binding TEXT NOT NULL CHECK (bucket_binding IN (''SENSITIVE_DETAILS'')),
  object_key TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT ''gzip'' CHECK (content_encoding IN (''gzip'', ''none'')),
  line_number INTEGER NOT NULL,
  byte_offset INTEGER,
  byte_length INTEGER,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:sensitive_detail_chunk_index', (SELECT count(*) FROM "sensitive_detail_chunk_index" WHERE "catalog_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:source_authority_contracts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_authority_contracts' AND sql IN ('CREATE TABLE source_authority_contracts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  field_ref_json TEXT NOT NULL,
  authority_actions_json TEXT NOT NULL,
  condition_json TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:source_authority_contracts', (SELECT count(*) FROM "source_authority_contracts" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:source_profile_parse_drafts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_profile_parse_drafts' AND sql IN ('CREATE TABLE source_profile_parse_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  source_type TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  parser_options_json TEXT,
  warning_summary_json TEXT,
  source_metadata_json TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:source_profile_parse_drafts', (SELECT count(*) FROM "source_profile_parse_drafts" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:source_profile_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_profile_versions' AND sql IN ('CREATE TABLE source_profile_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  profile_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:source_profile_versions', (SELECT count(*) FROM "source_profile_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:source_profiles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_profiles' AND sql IN ('CREATE TABLE source_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  source_type TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:source_profiles', (SELECT count(*) FROM "source_profiles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:storage_destination_assignments', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_destination_assignments' AND sql IN ('CREATE TABLE storage_destination_assignments (
  id TEXT PRIMARY KEY,
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:storage_destination_assignments', (SELECT count(*) FROM "storage_destination_assignments" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_database_probe_results', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_database_probe_results' AND sql IN ('CREATE TABLE tenant_database_probe_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  shard_group TEXT NOT NULL DEFAULT ''default'',
  shard_index INTEGER NOT NULL DEFAULT 0,
  generation INTEGER,
  probe_kind TEXT NOT NULL CHECK (probe_kind IN (''dry_run'', ''write_read_delete'')),
  status TEXT NOT NULL CHECK (status IN (''succeeded'', ''failed'', ''skipped'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_database_probe_results', (SELECT count(*) FROM "tenant_database_probe_results" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_placement_migration_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_placement_migration_jobs' AND sql IN ('CREATE TABLE tenant_placement_migration_jobs (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  control_operation_id TEXT NOT NULL,
  target_isolation_policy TEXT NOT NULL DEFAULT ''tenant_exclusive''
    CHECK (target_isolation_policy = ''tenant_exclusive''),
  status TEXT NOT NULL DEFAULT ''queued''
    CHECK (status IN (''queued'', ''running'', ''waiting_retry'', ''blocked'', ''succeeded'', ''canceled'')),
  active_job_key TEXT DEFAULT ''active''
    CHECK (active_job_key IS NULL OR active_job_key = ''active''),
  current_step TEXT NOT NULL DEFAULT ''wait_control'' CHECK (current_step IN (
    ''wait_control'',
    ''begin_route_cutover'',
    ''prepare_lookup'',
    ''prepare_alias'',
    ''commit_control'',
    ''publish_registry'',
    ''activate_alias'',
    ''activate_lookup'',
    ''verify_routes'',
    ''finalize_source'',
    ''complete''
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
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB ''*[^0-9a-f]*''),
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
  CHECK ((status IN (''succeeded'', ''canceled'') AND completed_at IS NOT NULL)
         OR status NOT IN (''succeeded'', ''canceled'')),
  CHECK ((status = ''succeeded'' AND current_step = ''complete'') OR status <> ''succeeded''),
  CHECK ((status IN (''succeeded'', ''canceled'') AND active_job_key IS NULL)
          OR (status NOT IN (''succeeded'', ''canceled'') AND active_job_key = ''active''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_placement_migration_jobs', (SELECT count(*) FROM "tenant_placement_migration_jobs" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_provisioning_operation_steps', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_provisioning_operation_steps' AND sql IN ('CREATE TABLE tenant_provisioning_operation_steps (
  operation_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT ''queued''
    CHECK (status IN (''queued'', ''running'', ''waiting_retry'', ''blocked'', ''succeeded'', ''skipped'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error_code TEXT,
  observed_resource_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, step_key),
  FOREIGN KEY (operation_id) REFERENCES tenant_provisioning_operations(operation_id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_provisioning_operations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_provisioning_operations' AND sql IN ('CREATE TABLE tenant_provisioning_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_code TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_description TEXT,
  operation_kind TEXT NOT NULL DEFAULT ''create''
    CHECK (operation_kind IN (''create'', ''clone'')),
  source_tenant_id TEXT,
  preparation_payload_json TEXT,
  preparation_result_json TEXT,
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''queued''
    CHECK (status IN (''queued'', ''running'', ''waiting_retry'', ''blocked'', ''succeeded'', ''canceled'')),
  current_step TEXT NOT NULL DEFAULT ''request_accepted'',
  capacity_operation_ids_json TEXT NOT NULL DEFAULT ''{}'',
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
  updated_at INTEGER NOT NULL, isolation_policy TEXT NOT NULL DEFAULT ''tenant_exclusive''
  CHECK (isolation_policy IN (''shared_pool'', ''tenant_exclusive'')),
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (environment_id, tenant_id),
  CHECK ((operation_kind = ''create'' AND source_tenant_id IS NULL AND preparation_payload_json IS NULL) OR
         (operation_kind = ''clone'' AND source_tenant_id IS NOT NULL AND preparation_payload_json IS NOT NULL)),
  CHECK ((status IN (''succeeded'', ''canceled'') AND completed_at IS NOT NULL) OR
         status NOT IN (''succeeded'', ''canceled''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_provisioning_operations', (SELECT count(*) FROM "tenant_provisioning_operations" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_delegation_jti_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_delegation_jti_expiry' AND sql='CREATE INDEX idx_admin_agent_delegation_jti_expiry
  ON admin_agent_delegation_jtis(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_grants_active_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_grants_active_unique' AND sql='CREATE UNIQUE INDEX idx_admin_agent_grants_active_unique
  ON admin_agent_grants(tenant_id, delegator_id, client_id, active_uniqueness_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_grants_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_grants_client' AND sql='CREATE INDEX idx_admin_agent_grants_client
  ON admin_agent_grants(tenant_id, client_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_grants_delegator', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_grants_delegator' AND sql='CREATE INDEX idx_admin_agent_grants_delegator
  ON admin_agent_grants(tenant_id, delegator_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_grants_management_mode', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_grants_management_mode' AND sql='CREATE INDEX idx_admin_agent_grants_management_mode
  ON admin_agent_grants(tenant_id, management_mode, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_grants_principal', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_grants_principal' AND sql='CREATE INDEX idx_admin_agent_grants_principal
  ON admin_agent_grants(machine_principal_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_login_handoffs_pending', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_login_handoffs_pending' AND sql='CREATE INDEX idx_admin_agent_login_handoffs_pending
  ON admin_agent_login_handoffs(status, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_login_handoffs_target', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_login_handoffs_target' AND sql='CREATE INDEX idx_admin_agent_login_handoffs_target
  ON admin_agent_login_handoffs(target_tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_mcp_sessions_admission', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_mcp_sessions_admission' AND sql='CREATE INDEX idx_admin_agent_mcp_sessions_admission
  ON admin_agent_mcp_sessions(tenant_id, grant_id, client_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_mcp_sessions_expiration', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_mcp_sessions_expiration' AND sql='CREATE INDEX idx_admin_agent_mcp_sessions_expiration
  ON admin_agent_mcp_sessions(expires_at, absolute_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_token_families_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_token_families_client' AND sql='CREATE INDEX idx_admin_agent_token_families_client
  ON admin_agent_token_families(tenant_id, client_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_token_families_finalization', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_token_families_finalization' AND sql='CREATE INDEX idx_admin_agent_token_families_finalization
  ON admin_agent_token_families(status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_token_families_grant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_token_families_grant' AND sql='CREATE INDEX idx_admin_agent_token_families_grant
  ON admin_agent_token_families(tenant_id, grant_id, grant_generation, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_token_families_revocation_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_token_families_revocation_outbox' AND sql='CREATE INDEX idx_admin_agent_token_families_revocation_outbox
  ON admin_agent_token_families(tenant_id, revocation_outbox_id, family_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_agent_token_revocation_pending', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_agent_token_revocation_pending' AND sql='CREATE INDEX idx_admin_agent_token_revocation_pending
  ON admin_agent_token_revocation_outbox(status, next_attempt_at, processing_lease_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attr_values_attr', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attr_values_attr' AND sql='CREATE INDEX idx_admin_attr_values_attr ON admin_attribute_values(admin_attribute_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attr_values_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attr_values_expires' AND sql='CREATE INDEX idx_admin_attr_values_expires ON admin_attribute_values(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attr_values_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attr_values_lookup' AND sql='CREATE INDEX idx_admin_attr_values_lookup
  ON admin_attribute_values(admin_user_id, admin_attribute_id, value)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attr_values_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attr_values_tenant' AND sql='CREATE INDEX idx_admin_attr_values_tenant ON admin_attribute_values(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attr_values_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attr_values_user' AND sql='CREATE INDEX idx_admin_attr_values_user ON admin_attribute_values(admin_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attributes_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attributes_name' AND sql='CREATE INDEX idx_admin_attributes_name ON admin_attributes(tenant_id, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attributes_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attributes_tenant' AND sql='CREATE INDEX idx_admin_attributes_tenant ON admin_attributes(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_attributes_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_attributes_type' AND sql='CREATE INDEX idx_admin_attributes_type ON admin_attributes(attribute_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_actor_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_actor_type' AND sql='CREATE INDEX idx_admin_audit_actor_type
  ON admin_audit_log(tenant_id, actor_type, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_coverage_status_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_coverage_status_state' AND sql='CREATE INDEX idx_admin_audit_coverage_status_state
  ON admin_audit_coverage_status(status, criticality, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_grant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_grant' AND sql='CREATE INDEX idx_admin_audit_grant
  ON admin_audit_log(grant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_log_action', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_log_action' AND sql='CREATE INDEX idx_admin_audit_log_action ON admin_audit_log(action, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_log_detail_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_log_detail_object_catalog' AND sql='CREATE INDEX idx_admin_audit_log_detail_object_catalog
  ON admin_audit_log(detail_object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_log_request', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_log_request' AND sql='CREATE INDEX idx_admin_audit_log_request ON admin_audit_log(request_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_log_resource', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_log_resource' AND sql='CREATE INDEX idx_admin_audit_log_resource ON admin_audit_log(resource_type, resource_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_log_tenant_time', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_log_tenant_time' AND sql='CREATE INDEX idx_admin_audit_log_tenant_time ON admin_audit_log(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_audit_log_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_audit_log_user' AND sql='CREATE INDEX idx_admin_audit_log_user ON admin_audit_log(admin_user_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_database_connection_usages_connection', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_database_connection_usages_connection' AND sql='CREATE INDEX idx_admin_database_connection_usages_connection
  ON admin_database_connection_usages(connection_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_database_connections_provider', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_database_connections_provider' AND sql='CREATE INDEX idx_admin_database_connections_provider
  ON admin_database_connections(provider, status, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_destination_health_events_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_destination_health_events_destination' AND sql='CREATE INDEX idx_admin_destination_health_events_destination
  ON admin_destination_health_events(destination_id, checked_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_destination_health_events_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_destination_health_events_status' AND sql='CREATE INDEX idx_admin_destination_health_events_status
  ON admin_destination_health_events(next_health_status, checked_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_destinations_health', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_destinations_health' AND sql='CREATE INDEX idx_admin_destinations_health
  ON admin_destinations(health_status, last_health_check_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_destinations_kind_provider', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_destinations_kind_provider' AND sql='CREATE INDEX idx_admin_destinations_kind_provider
  ON admin_destinations(destination_kind, provider)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_destinations_scope_name_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_destinations_scope_name_active' AND sql='CREATE INDEX idx_admin_destinations_scope_name_active
  ON admin_destinations(scope_type, scope_id, name, deleted_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_destinations_scope_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_destinations_scope_status' AND sql='CREATE INDEX idx_admin_destinations_scope_status
  ON admin_destinations(scope_type, scope_id, lifecycle_status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_invitation_enrollments_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_invitation_enrollments_expiry' AND sql='CREATE INDEX idx_admin_invitation_enrollments_expiry
  ON admin_invitation_enrollments(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_invitation_enrollments_invitation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_invitation_enrollments_invitation' AND sql='CREATE INDEX idx_admin_invitation_enrollments_invitation
  ON admin_invitation_enrollments(invitation_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_invitations_code_hash', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_invitations_code_hash' AND sql='CREATE INDEX idx_admin_invitations_code_hash
  ON admin_invitations(code_hash, status, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_invitations_email', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_invitations_email' AND sql='CREATE INDEX idx_admin_invitations_email
  ON admin_invitations(tenant_id, email, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_invitations_tenant_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_invitations_tenant_status' AND sql='CREATE INDEX idx_admin_invitations_tenant_status
  ON admin_invitations(tenant_id, status, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_ip_allowlist_enabled', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_ip_allowlist_enabled' AND sql='CREATE INDEX idx_admin_ip_allowlist_enabled ON admin_ip_allowlist(enabled, tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_ip_allowlist_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_ip_allowlist_tenant' AND sql='CREATE INDEX idx_admin_ip_allowlist_tenant ON admin_ip_allowlist(tenant_id, enabled)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_ip_allowlist_version', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_ip_allowlist_version' AND sql='CREATE INDEX idx_admin_ip_allowlist_version ON admin_ip_allowlist(tenant_id, ip_version, enabled)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_cleanup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_cleanup' AND sql='CREATE INDEX idx_admin_jobs_cleanup
  ON admin_jobs(status, completed_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_next_run', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_next_run' AND sql='CREATE INDEX idx_admin_jobs_next_run
  ON admin_jobs(status, next_run_at, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_object_catalog' AND sql='CREATE INDEX idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_status' AND sql='CREATE INDEX idx_admin_jobs_status
  ON admin_jobs(tenant_id, status, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_tenant' AND sql='CREATE INDEX idx_admin_jobs_tenant
  ON admin_jobs(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_type' AND sql='CREATE INDEX idx_admin_jobs_type
  ON admin_jobs(tenant_id, job_type, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_logging_critical_policies_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_logging_critical_policies_destination' AND sql='CREATE INDEX idx_admin_logging_critical_policies_destination
  ON admin_logging_critical_policies(destination_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_logging_critical_policies_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_logging_critical_policies_status' AND sql='CREATE INDEX idx_admin_logging_critical_policies_status
  ON admin_logging_critical_policies(status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_logging_sensitive_detail_policy_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_logging_sensitive_detail_policy_scope' AND sql='CREATE INDEX idx_admin_logging_sensitive_detail_policy_scope
  ON admin_logging_sensitive_detail_policies(log_type, plane, deleted_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_logging_sensitive_detail_policy_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_logging_sensitive_detail_policy_status' AND sql='CREATE INDEX idx_admin_logging_sensitive_detail_policy_status
  ON admin_logging_sensitive_detail_policies(status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_login_attempts_email', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_login_attempts_email' AND sql='CREATE INDEX idx_admin_login_attempts_email ON admin_login_attempts(tenant_id, email, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_login_attempts_ip', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_login_attempts_ip' AND sql='CREATE INDEX idx_admin_login_attempts_ip ON admin_login_attempts(ip_address, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_login_attempts_success', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_login_attempts_success' AND sql='CREATE INDEX idx_admin_login_attempts_success ON admin_login_attempts(success, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_login_attempts_time', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_login_attempts_time' AND sql='CREATE INDEX idx_admin_login_attempts_time ON admin_login_attempts(created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_assertion_jti_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_assertion_jti_expires' AND sql='CREATE INDEX idx_admin_machine_assertion_jti_expires
  ON admin_machine_assertion_jti(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_credential_tenant_scopes_credential', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_credential_tenant_scopes_credential' AND sql='CREATE INDEX idx_admin_machine_credential_tenant_scopes_credential
  ON admin_machine_credential_tenant_scopes(credential_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_credentials_principal', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_credentials_principal' AND sql='CREATE INDEX idx_admin_machine_credentials_principal
  ON admin_machine_credentials(principal_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_credentials_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_credentials_status' AND sql='CREATE INDEX idx_admin_machine_credentials_status
  ON admin_machine_credentials(status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_principal_tenant_scopes_principal', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_principal_tenant_scopes_principal' AND sql='CREATE INDEX idx_admin_machine_principal_tenant_scopes_principal
  ON admin_machine_principal_tenant_scopes(principal_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_principals_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_principals_status' AND sql='CREATE INDEX idx_admin_machine_principals_status
  ON admin_machine_principals(status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_resource_scopes_credential', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_resource_scopes_credential' AND sql='CREATE INDEX idx_admin_machine_resource_scopes_credential
  ON admin_machine_resource_scopes(credential_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_machine_resource_scopes_principal', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_machine_resource_scopes_principal' AND sql='CREATE INDEX idx_admin_machine_resource_scopes_principal
  ON admin_machine_resource_scopes(principal_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_passkeys_credential', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_passkeys_credential' AND sql='CREATE INDEX idx_admin_passkeys_credential ON admin_passkeys(credential_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_passkeys_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_passkeys_user' AND sql='CREATE INDEX idx_admin_passkeys_user ON admin_passkeys(admin_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_policies_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_policies_active' AND sql='CREATE INDEX idx_admin_policies_active ON admin_policies(is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_policies_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_policies_name' AND sql='CREATE INDEX idx_admin_policies_name ON admin_policies(tenant_id, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_policies_priority', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_policies_priority' AND sql='CREATE INDEX idx_admin_policies_priority ON admin_policies(priority DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_policies_resource', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_policies_resource' AND sql='CREATE INDEX idx_admin_policies_resource ON admin_policies(resource_pattern)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_policies_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_policies_tenant' AND sql='CREATE INDEX idx_admin_policies_tenant ON admin_policies(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rebac_def_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rebac_def_name' AND sql='CREATE INDEX idx_admin_rebac_def_name ON admin_rebac_definitions(tenant_id, relation_name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rebac_def_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rebac_def_tenant' AND sql='CREATE INDEX idx_admin_rebac_def_tenant ON admin_rebac_definitions(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rel_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rel_expires' AND sql='CREATE INDEX idx_admin_rel_expires ON admin_relationships(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rel_from', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rel_from' AND sql='CREATE INDEX idx_admin_rel_from ON admin_relationships(from_type, from_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rel_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rel_tenant' AND sql='CREATE INDEX idx_admin_rel_tenant ON admin_relationships(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rel_to', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rel_to' AND sql='CREATE INDEX idx_admin_rel_to ON admin_relationships(to_type, to_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rel_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rel_type' AND sql='CREATE INDEX idx_admin_rel_type ON admin_relationships(relationship_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_rel_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_rel_unique' AND sql='CREATE UNIQUE INDEX idx_admin_rel_unique
  ON admin_relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_role_assignments_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_role_assignments_expires' AND sql='CREATE INDEX idx_admin_role_assignments_expires ON admin_role_assignments(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_role_assignments_role', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_role_assignments_role' AND sql='CREATE INDEX idx_admin_role_assignments_role ON admin_role_assignments(admin_role_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_role_assignments_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_role_assignments_scope' AND sql='CREATE INDEX idx_admin_role_assignments_scope ON admin_role_assignments(scope_type, scope_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_role_assignments_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_role_assignments_tenant' AND sql='CREATE INDEX idx_admin_role_assignments_tenant ON admin_role_assignments(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_role_assignments_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_role_assignments_user' AND sql='CREATE INDEX idx_admin_role_assignments_user ON admin_role_assignments(admin_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_roles_hierarchy', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_roles_hierarchy' AND sql='CREATE INDEX idx_admin_roles_hierarchy ON admin_roles(hierarchy_level)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_roles_inherits', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_roles_inherits' AND sql='CREATE INDEX idx_admin_roles_inherits ON admin_roles(inherits_from)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_roles_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_roles_name' AND sql='CREATE INDEX idx_admin_roles_name ON admin_roles(tenant_id, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_roles_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_roles_tenant' AND sql='CREATE INDEX idx_admin_roles_tenant ON admin_roles(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_roles_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_roles_type' AND sql='CREATE INDEX idx_admin_roles_type ON admin_roles(role_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_sessions_activity', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_sessions_activity' AND sql='CREATE INDEX idx_admin_sessions_activity ON admin_sessions(last_activity_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_sessions_derived_target', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_sessions_derived_target' AND sql='CREATE INDEX idx_admin_sessions_derived_target
  ON admin_sessions(derived_target_tenant_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_sessions_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_sessions_expires' AND sql='CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_sessions_parent', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_sessions_parent' AND sql='CREATE INDEX idx_admin_sessions_parent
  ON admin_sessions(parent_session_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_sessions_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_sessions_tenant' AND sql='CREATE INDEX idx_admin_sessions_tenant ON admin_sessions(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_sessions_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_sessions_user' AND sql='CREATE INDEX idx_admin_sessions_user ON admin_sessions(admin_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_setup_tokens_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_setup_tokens_expires' AND sql='CREATE INDEX idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_setup_tokens_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_setup_tokens_status' AND sql='CREATE INDEX idx_admin_setup_tokens_status ON admin_setup_tokens(status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_setup_tokens_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_setup_tokens_tenant' AND sql='CREATE INDEX idx_admin_setup_tokens_tenant ON admin_setup_tokens(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_setup_tokens_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_setup_tokens_user' AND sql='CREATE INDEX idx_admin_setup_tokens_user ON admin_setup_tokens(admin_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_storage_destination_usages_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_storage_destination_usages_destination' AND sql='CREATE INDEX idx_admin_storage_destination_usages_destination
  ON admin_storage_destination_usages(destination_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_storage_destination_usages_feature', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_storage_destination_usages_feature' AND sql='CREATE INDEX idx_admin_storage_destination_usages_feature
  ON admin_storage_destination_usages(tenant_id, feature, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_storage_destinations_provider', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_storage_destinations_provider' AND sql='CREATE INDEX idx_admin_storage_destinations_provider
  ON admin_storage_destinations(provider, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_storage_destinations_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_storage_destinations_scope' AND sql='CREATE INDEX idx_admin_storage_destinations_scope
  ON admin_storage_destinations(scope_type, scope_id, is_active, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_users_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_users_active' AND sql='CREATE INDEX idx_admin_users_active ON admin_users(tenant_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_users_last_login', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_users_last_login' AND sql='CREATE INDEX idx_admin_users_last_login ON admin_users(last_login_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_users_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_users_status' AND sql='CREATE INDEX idx_admin_users_status ON admin_users(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_users_tenant_email', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_users_tenant_email' AND sql='CREATE INDEX idx_admin_users_tenant_email ON admin_users(tenant_id, email)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_baseline_assignments_remediation_plan', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_baseline_assignments_remediation_plan' AND sql='CREATE UNIQUE INDEX idx_agent_baseline_assignments_remediation_plan
  ON agent_baseline_assignments(remediation_bulk_plan_id, remediation_bulk_plan_version)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_baseline_assignments_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_baseline_assignments_transition' AND sql='CREATE UNIQUE INDEX idx_agent_baseline_assignments_transition
  ON agent_baseline_assignments(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_children_capability', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_children_capability' AND sql='CREATE INDEX idx_agent_bulk_children_capability
  ON agent_bulk_tenant_executions(
    bulk_plan_id, bulk_plan_version, target_tenant_id,
    execution_attempt, execution_fence, child_capability_digest
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_plans_actor', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_plans_actor' AND sql='CREATE INDEX idx_agent_bulk_plans_actor
  ON agent_bulk_plans(control_tenant_id, grant_id, actor_sub, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_plans_control', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_plans_control' AND sql='CREATE INDEX idx_agent_bulk_plans_control
  ON agent_bulk_plans(control_tenant_id, status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_plans_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_plans_retention' AND sql='CREATE INDEX idx_agent_bulk_plans_retention
  ON agent_bulk_plans(payload_purge_at, payload_purged_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_plans_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_plans_transition' AND sql='CREATE UNIQUE INDEX idx_agent_bulk_plans_transition
  ON agent_bulk_plans(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_tenant_claim', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_tenant_claim' AND sql='CREATE INDEX idx_agent_bulk_tenant_claim
  ON agent_bulk_tenant_executions(bulk_plan_id, bulk_plan_version, status, is_canary, wave_number)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_tenant_lease', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_tenant_lease' AND sql='CREATE INDEX idx_agent_bulk_tenant_lease
  ON agent_bulk_tenant_executions(status, execution_lease_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_bulk_tenant_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_bulk_tenant_transition' AND sql='CREATE UNIQUE INDEX idx_agent_bulk_tenant_transition
  ON agent_bulk_tenant_executions(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_configuration_plans_context', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_configuration_plans_context' AND sql='CREATE INDEX idx_agent_configuration_plans_context
  ON agent_configuration_plans(tenant_id, grant_id, actor_sub, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_configuration_plans_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_configuration_plans_retention' AND sql='CREATE INDEX idx_agent_configuration_plans_retention
  ON agent_configuration_plans(payload_purge_at, payload_purged_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_configuration_plans_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_configuration_plans_transition' AND sql='CREATE UNIQUE INDEX idx_agent_configuration_plans_transition
  ON agent_configuration_plans(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_consents_grant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_consents_grant' AND sql='CREATE INDEX idx_agent_consents_grant
  ON agent_consents(grant_id, consent_type, revoked_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_consents_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_consents_user' AND sql='CREATE INDEX idx_agent_consents_user
  ON agent_consents(tenant_id, user_id, revoked_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_elevation_approval_artifact', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_elevation_approval_artifact' AND sql='CREATE UNIQUE INDEX idx_agent_elevation_approval_artifact
  ON agent_elevation_challenges(approval_artifact_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_elevation_approval_request', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_elevation_approval_request' AND sql='CREATE UNIQUE INDEX idx_agent_elevation_approval_request
  ON agent_elevation_challenges(approval_request_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_elevation_args_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_elevation_args_active' AND sql='CREATE UNIQUE INDEX idx_agent_elevation_args_active
  ON agent_elevation_challenges(
    tenant_id,
    grant_id,
    actor_sub,
    tool_name,
    args_hash,
    active_args_key
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_elevation_grant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_elevation_grant' AND sql='CREATE INDEX idx_agent_elevation_grant
  ON agent_elevation_challenges(tenant_id, grant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_elevation_recovery', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_elevation_recovery' AND sql='CREATE INDEX idx_agent_elevation_recovery
  ON agent_elevation_challenges(status, execution_lease_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_plan_confirmations_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_plan_confirmations_transition' AND sql='CREATE UNIQUE INDEX idx_agent_plan_confirmations_transition
  ON agent_plan_confirmations(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_scope_policies_management_mode', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_scope_policies_management_mode' AND sql='CREATE INDEX idx_agent_scope_policies_management_mode
  ON agent_scope_policies(tenant_id, management_mode, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_scope_policies_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_scope_policies_transition' AND sql='CREATE UNIQUE INDEX idx_agent_scope_policies_transition
  ON agent_scope_policies(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_scope_policy_versions_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_scope_policy_versions_transition' AND sql='CREATE UNIQUE INDEX idx_agent_scope_policy_versions_transition
  ON agent_scope_policy_versions(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_secret_refs_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_secret_refs_transition' AND sql='CREATE UNIQUE INDEX idx_agent_secret_refs_transition
  ON agent_secret_refs(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_task_set_versions_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_task_set_versions_transition' AND sql='CREATE UNIQUE INDEX idx_agent_task_set_versions_transition
  ON agent_task_set_versions(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_task_sets_management_mode', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_task_sets_management_mode' AND sql='CREATE INDEX idx_agent_task_sets_management_mode
  ON agent_task_sets(tenant_id, management_mode, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_agent_task_sets_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_agent_task_sets_transition' AND sql='CREATE UNIQUE INDEX idx_agent_task_sets_transition
  ON agent_task_sets(last_transition_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_request_approvals_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_request_approvals_expires' AND sql='CREATE INDEX idx_approval_request_approvals_expires
  ON approval_request_approvals(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_request_approvals_request_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_request_approvals_request_status' AND sql='CREATE INDEX idx_approval_request_approvals_request_status
  ON approval_request_approvals(approval_request_id, status, created_at ASC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_request_approvals_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_request_approvals_subject' AND sql='CREATE INDEX idx_approval_request_approvals_subject
  ON approval_request_approvals(subject_type, subject_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_request_approvals_unique_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_request_approvals_unique_subject' AND sql='CREATE UNIQUE INDEX idx_approval_request_approvals_unique_subject
  ON approval_request_approvals(
    approval_request_id,
    step_key,
    subject_type,
    COALESCE(subject_id, '''')
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_requests_detail_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_requests_detail_object_catalog' AND sql='CREATE INDEX idx_approval_requests_detail_object_catalog
  ON approval_requests(detail_object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_requests_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_requests_expires' AND sql='CREATE INDEX idx_approval_requests_expires
  ON approval_requests(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_requests_investigation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_requests_investigation' AND sql='CREATE INDEX idx_approval_requests_investigation
  ON approval_requests(investigation_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_requests_requester', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_requests_requester' AND sql='CREATE INDEX idx_approval_requests_requester
  ON approval_requests(requester_subject_type, requester_subject_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_requests_target', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_requests_target' AND sql='CREATE INDEX idx_approval_requests_target
  ON approval_requests(target_subject_type, target_subject_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_approval_requests_tenant_status_requested', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_approval_requests_tenant_status_requested' AND sql='CREATE INDEX idx_approval_requests_tenant_status_requested
  ON approval_requests(tenant_id, status, requested_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_compiled_mapping_snapshots_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_compiled_mapping_snapshots_state' AND sql='CREATE INDEX idx_compiled_mapping_snapshots_state
  ON compiled_mapping_snapshots(tenant_id, lifecycle_state, activated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_credential_profile_versions_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_credential_profile_versions_state' AND sql='CREATE INDEX idx_credential_profile_versions_state
  ON credential_profile_versions(tenant_id, credential_profile_id, lifecycle_state, version_number)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_credential_profiles_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_credential_profiles_state' AND sql='CREATE INDEX idx_credential_profiles_state
  ON credential_profiles(tenant_id, lifecycle_state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_credential_secret_bodies_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_credential_secret_bodies_destination' AND sql='CREATE INDEX idx_credential_secret_bodies_destination
  ON credential_secret_bodies(destination_id, version)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_credential_secret_metadata_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_credential_secret_metadata_destination' AND sql='CREATE INDEX idx_credential_secret_metadata_destination
  ON credential_secret_metadata(destination_id, status, version)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_destination_profile_versions_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_destination_profile_versions_state' AND sql='CREATE INDEX idx_destination_profile_versions_state
  ON destination_profile_versions(tenant_id, lifecycle_state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_destination_profiles_owner', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_destination_profiles_owner' AND sql='CREATE INDEX idx_destination_profiles_owner
  ON destination_profiles(owner_scope_type, owner_scope_id, destination_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_destination_profiles_type_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_destination_profiles_type_state' AND sql='CREATE INDEX idx_destination_profiles_type_state
  ON destination_profiles(tenant_id, destination_type, lifecycle_state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_elevation_grants_actor', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_elevation_grants_actor' AND sql='CREATE INDEX idx_elevation_grants_actor
  ON elevation_grants(actor_subject_type, actor_subject_id, issued_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_elevation_grants_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_elevation_grants_expires' AND sql='CREATE INDEX idx_elevation_grants_expires
  ON elevation_grants(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_elevation_grants_request', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_elevation_grants_request' AND sql='CREATE INDEX idx_elevation_grants_request
  ON elevation_grants(approval_request_id, issued_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_elevation_grants_tenant_status_issued', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_elevation_grants_tenant_status_issued' AND sql='CREATE INDEX idx_elevation_grants_tenant_status_issued
  ON elevation_grants(tenant_id, status, issued_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_external_token_refresh_runs_requested_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_external_token_refresh_runs_requested_tenant' AND sql='CREATE INDEX idx_external_token_refresh_runs_requested_tenant
  ON admin_external_token_refresh_runs(requested_tenant_id, started_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_external_token_refresh_runs_started', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_external_token_refresh_runs_started' AND sql='CREATE INDEX idx_external_token_refresh_runs_started
  ON admin_external_token_refresh_runs(started_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_external_token_refresh_tenant_runs_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_external_token_refresh_tenant_runs_tenant' AND sql='CREATE INDEX idx_external_token_refresh_tenant_runs_tenant
  ON admin_external_token_refresh_tenant_runs(tenant_id, completed_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_federation_metadata_documents_latest_valid', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_federation_metadata_documents_latest_valid' AND sql='CREATE INDEX idx_federation_metadata_documents_latest_valid
  ON federation_metadata_documents(
    tenant_id,
    trust_source_id,
    document_type,
    validation_state,
    validated_at DESC,
    created_at DESC,
    id DESC
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_federation_metadata_entity_summaries_document', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_federation_metadata_entity_summaries_document' AND sql='CREATE INDEX idx_federation_metadata_entity_summaries_document
  ON federation_metadata_entity_summaries(tenant_id, metadata_document_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_federation_metadata_refresh_jobs_source_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_federation_metadata_refresh_jobs_source_created' AND sql='CREATE INDEX idx_federation_metadata_refresh_jobs_source_created
  ON federation_metadata_refresh_jobs(tenant_id, trust_source_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_federation_metadata_validation_events_document', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_federation_metadata_validation_events_document' AND sql='CREATE INDEX idx_federation_metadata_validation_events_document
  ON federation_metadata_validation_events(tenant_id, metadata_document_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_federation_metadata_validation_events_source_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_federation_metadata_validation_events_source_created' AND sql='CREATE INDEX idx_federation_metadata_validation_events_source_created
  ON federation_metadata_validation_events(tenant_id, trust_source_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_federation_saml_runtime_entities_document', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_federation_saml_runtime_entities_document' AND sql='CREATE INDEX idx_federation_saml_runtime_entities_document
  ON federation_saml_runtime_entities(tenant_id, metadata_document_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_federation_saml_runtime_entities_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_federation_saml_runtime_entities_lookup' AND sql='CREATE INDEX idx_federation_saml_runtime_entities_lookup
  ON federation_saml_runtime_entities(tenant_id, entity_id, entity_role, trust_source_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_field_mapping_versions_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_field_mapping_versions_state' AND sql='CREATE INDEX idx_field_mapping_versions_state
  ON field_mapping_versions(tenant_id, lifecycle_state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_internal_notification_delivery_attempts_event', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_internal_notification_delivery_attempts_event' AND sql='CREATE INDEX idx_internal_notification_delivery_attempts_event
  ON internal_notification_delivery_attempts(event_id, provider, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_internal_notification_delivery_attempts_retry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_internal_notification_delivery_attempts_retry' AND sql='CREATE INDEX idx_internal_notification_delivery_attempts_retry
  ON internal_notification_delivery_attempts(status, next_attempt_at, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_internal_notification_delivery_routes_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_internal_notification_delivery_routes_lookup' AND sql='CREATE INDEX idx_internal_notification_delivery_routes_lookup
  ON internal_notification_delivery_routes(scope_type, scope_id, enabled, provider)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_internal_notification_events_dedup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_internal_notification_events_dedup' AND sql='CREATE UNIQUE INDEX idx_internal_notification_events_dedup
  ON internal_notification_events(deduplication_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_internal_notification_events_pending', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_internal_notification_events_pending' AND sql='CREATE INDEX idx_internal_notification_events_pending
  ON internal_notification_events(status, severity, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_internal_notification_events_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_internal_notification_events_tenant_created' AND sql='CREATE INDEX idx_internal_notification_events_tenant_created
  ON internal_notification_events(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_log_chunk_manifests_bucket', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_log_chunk_manifests_bucket' AND sql='CREATE UNIQUE INDEX idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_log_object_catalog_object_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_log_object_catalog_object_key' AND sql='CREATE UNIQUE INDEX idx_log_object_catalog_object_key
  ON log_object_catalog(object_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_log_object_catalog_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_log_object_catalog_status' AND sql='CREATE INDEX idx_log_object_catalog_status
  ON log_object_catalog(status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_log_object_catalog_tenant_type_time', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_log_object_catalog_tenant_type_time' AND sql='CREATE INDEX idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_catalog_repair_jobs_queue', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_catalog_repair_jobs_queue' AND sql='CREATE INDEX idx_logging_catalog_repair_jobs_queue
  ON logging_catalog_repair_jobs(status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_catalog_repair_jobs_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_catalog_repair_jobs_scope' AND sql='CREATE INDEX idx_logging_catalog_repair_jobs_scope
  ON logging_catalog_repair_jobs(COALESCE(tenant_key, ''''), COALESCE(log_type, ''''), COALESCE(plane, ''''), created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_delivery_events_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_delivery_events_destination' AND sql='CREATE INDEX idx_logging_delivery_events_destination
  ON logging_delivery_events(destination_id, status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_delivery_events_tenant_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_delivery_events_tenant_status' AND sql='CREATE INDEX idx_logging_delivery_events_tenant_status
  ON logging_delivery_events(tenant_key, status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_destination_override_history_override', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_destination_override_history_override' AND sql='CREATE INDEX idx_logging_destination_override_history_override
  ON logging_destination_override_history(override_id, changed_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_destination_override_history_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_destination_override_history_scope' AND sql='CREATE INDEX idx_logging_destination_override_history_scope
  ON logging_destination_override_history(COALESCE(tenant_id, ''platform''), log_type, plane, changed_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_destination_overrides_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_destination_overrides_destination' AND sql='CREATE INDEX idx_logging_destination_overrides_destination
  ON logging_destination_overrides(destination_id, enabled, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_destination_overrides_effective', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_destination_overrides_effective' AND sql='CREATE INDEX idx_logging_destination_overrides_effective
  ON logging_destination_overrides(COALESCE(tenant_id, ''platform''), log_type, plane, enabled)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_dlq_items_lane_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_dlq_items_lane_status' AND sql='CREATE INDEX idx_logging_dlq_items_lane_status
  ON logging_dlq_items(lane, status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_dlq_items_tenant_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_dlq_items_tenant_status' AND sql='CREATE INDEX idx_logging_dlq_items_tenant_status
  ON logging_dlq_items(tenant_key, status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_export_jobs_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_export_jobs_status' AND sql='CREATE INDEX idx_logging_export_jobs_status
  ON logging_export_jobs(status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_export_jobs_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_export_jobs_tenant' AND sql='CREATE INDEX idx_logging_export_jobs_tenant
  ON logging_export_jobs(tenant_key, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_fallback_policies_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_fallback_policies_scope' AND sql='CREATE UNIQUE INDEX idx_logging_fallback_policies_scope
  ON logging_fallback_policies(scope_type, scope_id, log_type, plane)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_key_material_bodies_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_key_material_bodies_scope' AND sql='CREATE INDEX idx_logging_key_material_bodies_scope
  ON logging_key_material_bodies(tenant_key, COALESCE(surface, ''''), log_type, plane, version)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_key_registry_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_key_registry_scope' AND sql='CREATE UNIQUE INDEX idx_logging_key_registry_scope
  ON logging_key_registry(tenant_key, COALESCE(surface, ''''), log_type, plane)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_key_registry_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_key_registry_status' AND sql='CREATE INDEX idx_logging_key_registry_status
  ON logging_key_registry(status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_export_builds_export', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_export_builds_export' AND sql='CREATE INDEX idx_logging_message_export_builds_export
  ON logging_message_export_builds(export_job_id, phase, partition_index)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_export_builds_job', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_export_builds_job' AND sql='CREATE INDEX idx_logging_message_export_builds_job
  ON logging_message_export_builds(message_job_id, phase, partition_index)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_jobs_chain', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_jobs_chain' AND sql='CREATE INDEX idx_logging_message_jobs_chain
  ON logging_message_jobs(root_job_id, parent_job_id, depth)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_jobs_claimed', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_jobs_claimed' AND sql='CREATE INDEX idx_logging_message_jobs_claimed
  ON logging_message_jobs(status, claimed_until, lane, priority)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_jobs_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_jobs_due' AND sql='CREATE INDEX idx_logging_message_jobs_due
  ON logging_message_jobs(status, not_before, priority, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_jobs_scope_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_jobs_scope_status' AND sql='CREATE INDEX idx_logging_message_jobs_scope_status
  ON logging_message_jobs(scope_key, status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_jobs_source', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_jobs_source' AND sql='CREATE INDEX idx_logging_message_jobs_source
  ON logging_message_jobs(source_type, source_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_jobs_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_jobs_tenant' AND sql='CREATE INDEX idx_logging_message_jobs_tenant
  ON logging_message_jobs(tenant_key, kind, status, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_repair_findings_job', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_repair_findings_job' AND sql='CREATE INDEX idx_logging_message_repair_findings_job
  ON logging_message_repair_findings(message_job_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_message_repair_findings_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_message_repair_findings_status' AND sql='CREATE INDEX idx_logging_message_repair_findings_status
  ON logging_message_repair_findings(status, severity, detected_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_policy_snapshots_scope_version', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_policy_snapshots_scope_version' AND sql='CREATE UNIQUE INDEX idx_logging_policy_snapshots_scope_version
  ON logging_policy_snapshots(scope_type, scope_id, version)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_policy_snapshots_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_policy_snapshots_status' AND sql='CREATE INDEX idx_logging_policy_snapshots_status
  ON logging_policy_snapshots(scope_type, scope_id, status, version)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_quota_evaluations_policy_time', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_quota_evaluations_policy_time' AND sql='CREATE INDEX idx_logging_quota_evaluations_policy_time
  ON logging_quota_evaluations(quota_policy_id, evaluated_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_quota_evaluations_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_quota_evaluations_state' AND sql='CREATE INDEX idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_quota_policies_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_quota_policies_lookup' AND sql='CREATE INDEX idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_quota_policies_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_quota_policies_scope' AND sql='CREATE INDEX idx_logging_quota_policies_scope
  ON logging_quota_policies(
    scope_type,
    scope_id,
    COALESCE(log_type, ''''),
    COALESCE(plane, ''''),
    COALESCE(lane, ''''),
    metric_name,
    window_kind,
    deleted_at
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_rewrap_jobs_queue', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_rewrap_jobs_queue' AND sql='CREATE INDEX idx_logging_rewrap_jobs_queue
  ON logging_rewrap_jobs(status, priority, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_rewrap_jobs_registry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_rewrap_jobs_registry' AND sql='CREATE INDEX idx_logging_rewrap_jobs_registry
  ON logging_rewrap_jobs(key_registry_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_usage_aggregates_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_usage_aggregates_scope' AND sql='CREATE UNIQUE INDEX idx_logging_usage_aggregates_scope
  ON logging_usage_aggregates(
    COALESCE(tenant_id, ''''),
    COALESCE(tenant_key, ''''),
    COALESCE(log_type, ''''),
    COALESCE(plane, ''''),
    COALESCE(lane, ''''),
    metric_name,
    window_kind,
    window_start_at
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_usage_aggregates_window', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_usage_aggregates_window' AND sql='CREATE INDEX idx_logging_usage_aggregates_window
  ON logging_usage_aggregates(window_kind, window_start_at, metric_name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_object_catalog_deleted_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_object_catalog_deleted_at' AND sql='CREATE INDEX idx_object_catalog_deleted_at
  ON object_catalog(deleted_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_object_catalog_objects_bucket_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_object_catalog_objects_bucket_key' AND sql='CREATE INDEX idx_object_catalog_objects_bucket_key
  ON object_catalog_objects(bucket_binding, object_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_object_catalog_objects_catalog_repr', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_object_catalog_objects_catalog_repr' AND sql='CREATE INDEX idx_object_catalog_objects_catalog_repr
  ON object_catalog_objects(catalog_id, representation, object_index)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_object_catalog_objects_deleted_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_object_catalog_objects_deleted_at' AND sql='CREATE INDEX idx_object_catalog_objects_deleted_at
  ON object_catalog_objects(deleted_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_object_catalog_tenant_class_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_object_catalog_tenant_class_created' AND sql='CREATE INDEX idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_persistent_identifier_profiles_tenant_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_persistent_identifier_profiles_tenant_state' AND sql='CREATE INDEX idx_persistent_identifier_profiles_tenant_state
  ON persistent_identifier_profiles(tenant_id, lifecycle_state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_provider_reprojection_jobs_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_provider_reprojection_jobs_due' AND sql='CREATE INDEX idx_provider_reprojection_jobs_due
  ON provider_reprojection_jobs(status, next_run_at, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_provider_reprojection_jobs_plugin', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_provider_reprojection_jobs_plugin' AND sql='CREATE INDEX idx_provider_reprojection_jobs_plugin
  ON provider_reprojection_jobs(plugin_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_sensitive_detail_chunk_index_object', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_sensitive_detail_chunk_index_object' AND sql='CREATE INDEX idx_sensitive_detail_chunk_index_object
  ON sensitive_detail_chunk_index(object_key, line_number)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_sensitive_detail_chunk_index_tenant_class', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_sensitive_detail_chunk_index_tenant_class' AND sql='CREATE INDEX idx_sensitive_detail_chunk_index_tenant_class
  ON sensitive_detail_chunk_index(tenant_id, object_class, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_source_profile_parse_drafts_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_source_profile_parse_drafts_expiry' AND sql='CREATE INDEX idx_source_profile_parse_drafts_expiry
  ON source_profile_parse_drafts(tenant_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_source_profile_versions_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_source_profile_versions_state' AND sql='CREATE INDEX idx_source_profile_versions_state
  ON source_profile_versions(tenant_id, lifecycle_state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_source_profiles_type_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_source_profiles_type_state' AND sql='CREATE INDEX idx_source_profiles_type_state
  ON source_profiles(tenant_id, source_type, lifecycle_state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_storage_destination_assignments_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_storage_destination_assignments_scope' AND sql='CREATE INDEX idx_storage_destination_assignments_scope
  ON storage_destination_assignments(
    destination_id,
    COALESCE(tenant_id, ''*''),
    COALESCE(log_type, ''*''),
    COALESCE(plane, ''*''),
    enabled
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_storage_destination_assignments_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_storage_destination_assignments_tenant' AND sql='CREATE INDEX idx_storage_destination_assignments_tenant
  ON storage_destination_assignments(tenant_id, log_type, plane, enabled)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_database_probe_results_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_database_probe_results_scope' AND sql='CREATE INDEX idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_database_probe_results_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_database_probe_results_status' AND sql='CREATE INDEX idx_tenant_database_probe_results_status
  ON tenant_database_probe_results(status, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_placement_migration_jobs_runnable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_placement_migration_jobs_runnable' AND sql='CREATE INDEX idx_tenant_placement_migration_jobs_runnable
  ON tenant_placement_migration_jobs(status, next_attempt_at, lease_expires_at, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_provisioning_operations_runnable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_provisioning_operations_runnable' AND sql='CREATE INDEX idx_tenant_provisioning_operations_runnable
  ON tenant_provisioning_operations(status, next_attempt_at, lease_expires_at, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_provisioning_steps_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_provisioning_steps_status' AND sql='CREATE INDEX idx_tenant_provisioning_steps_status
  ON tenant_provisioning_operation_steps(status, next_attempt_at, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:ux_attribute_field_registry_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='ux_attribute_field_registry_key' AND sql='CREATE UNIQUE INDEX ux_attribute_field_registry_key
  ON attribute_field_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''''),
    protocol,
    field_key
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:ux_attribute_group_registry_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='ux_attribute_group_registry_key' AND sql='CREATE UNIQUE INDEX ux_attribute_group_registry_key
  ON attribute_group_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''''),
    protocol,
    group_type,
    group_key
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:ux_destination_profile_versions_label', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='ux_destination_profile_versions_label' AND sql='CREATE UNIQUE INDEX ux_destination_profile_versions_label
  ON destination_profile_versions(tenant_id, profile_id, version_label)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:ux_destination_profiles_active_resource_server_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='ux_destination_profiles_active_resource_server_client' AND sql='CREATE UNIQUE INDEX ux_destination_profiles_active_resource_server_client
  ON destination_profiles(
    CASE
      WHEN destination_type = ''resource_server''
        AND owner_scope_type = ''client''
        AND lifecycle_state = ''active''
      THEN tenant_id
      ELSE NULL
    END,
    CASE
      WHEN destination_type = ''resource_server''
        AND owner_scope_type = ''client''
        AND lifecycle_state = ''active''
      THEN COALESCE(owner_scope_id, '''')
      ELSE NULL
    END
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:ux_destination_profiles_scope_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='ux_destination_profiles_scope_key' AND sql='CREATE UNIQUE INDEX ux_destination_profiles_scope_key
  ON destination_profiles(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''''),
    destination_type,
    profile_key
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_admin_agent_grants_expiry_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_admin_agent_grants_expiry_insert' AND sql='CREATE TRIGGER trg_admin_agent_grants_expiry_insert
BEFORE INSERT ON admin_agent_grants
WHEN NEW.status = ''active'' AND (
  NEW.expires_at IS NULL
  OR NEW.expires_at < NEW.created_at + 3600000
  OR NEW.expires_at > NEW.created_at + 7776000000
)
BEGIN
  SELECT RAISE(ABORT, ''active Agent Grant expiry must be between 1 hour and 90 days'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_admin_agent_grants_expiry_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_admin_agent_grants_expiry_update' AND sql='CREATE TRIGGER trg_admin_agent_grants_expiry_update
BEFORE UPDATE OF status, expires_at, updated_at ON admin_agent_grants
WHEN NEW.status = ''active'' AND (
  NEW.expires_at IS NULL
  OR NEW.expires_at < NEW.updated_at + 3600000
  OR NEW.expires_at > NEW.updated_at + 7776000000
)
BEGIN
  SELECT RAISE(ABORT, ''active Agent Grant expiry must be between 1 hour and 90 days'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_admin_agent_grants_require_snapshot_active_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_admin_agent_grants_require_snapshot_active_update' AND sql='CREATE TRIGGER trg_admin_agent_grants_require_snapshot_active_update
BEFORE UPDATE ON admin_agent_grants
FOR EACH ROW
WHEN NEW.status = ''active'' AND CASE
  WHEN NEW.task_set_id IS NULL OR length(trim(NEW.task_set_id)) = 0 THEN 1
  WHEN NEW.task_set_version IS NULL OR NEW.task_set_version < 1 THEN 1
  WHEN NEW.scope_policy_id IS NULL OR length(trim(NEW.scope_policy_id)) = 0 THEN 1
  WHEN NEW.scope_policy_version IS NULL OR NEW.scope_policy_version < 1 THEN 1
  WHEN NEW.resolved_tools IS NULL OR json_valid(NEW.resolved_tools) = 0 THEN 1
  WHEN json_type(NEW.resolved_tools) <> ''array'' OR json_array_length(NEW.resolved_tools) < 1 THEN 1
  WHEN NEW.resolved_scope_constraints IS NULL OR json_valid(NEW.resolved_scope_constraints) = 0 THEN 1
  WHEN json_type(NEW.resolved_scope_constraints) <> ''object'' THEN 1
  WHEN NEW.access_snapshot_hash IS NULL OR length(NEW.access_snapshot_hash) <> 43 THEN 1
  WHEN NEW.access_snapshot_hash GLOB ''*[^A-Za-z0-9_-]*'' THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, ''agent_grant_versioned_snapshot_required'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_admin_agent_grants_require_snapshot_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_admin_agent_grants_require_snapshot_insert' AND sql='CREATE TRIGGER trg_admin_agent_grants_require_snapshot_insert
BEFORE INSERT ON admin_agent_grants
FOR EACH ROW
WHEN CASE
  WHEN NEW.task_set_id IS NULL OR length(trim(NEW.task_set_id)) = 0 THEN 1
  WHEN NEW.task_set_version IS NULL OR NEW.task_set_version < 1 THEN 1
  WHEN NEW.scope_policy_id IS NULL OR length(trim(NEW.scope_policy_id)) = 0 THEN 1
  WHEN NEW.scope_policy_version IS NULL OR NEW.scope_policy_version < 1 THEN 1
  WHEN NEW.resolved_tools IS NULL OR json_valid(NEW.resolved_tools) = 0 THEN 1
  WHEN json_type(NEW.resolved_tools) <> ''array'' OR json_array_length(NEW.resolved_tools) < 1 THEN 1
  WHEN NEW.resolved_scope_constraints IS NULL OR json_valid(NEW.resolved_scope_constraints) = 0 THEN 1
  WHEN json_type(NEW.resolved_scope_constraints) <> ''object'' THEN 1
  WHEN NEW.access_snapshot_hash IS NULL OR length(NEW.access_snapshot_hash) <> 43 THEN 1
  WHEN NEW.access_snapshot_hash GLOB ''*[^A-Za-z0-9_-]*'' THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, ''agent_grant_versioned_snapshot_required'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_migration_job_fencing', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_migration_job_fencing' AND sql='CREATE TRIGGER trg_tenant_placement_migration_job_fencing
BEFORE UPDATE ON tenant_placement_migration_jobs
WHEN OLD.lease_owner IS NOT NULL AND (
  NEW.lease_owner IS NULL OR
  NEW.lease_owner <> OLD.lease_owner OR
  NEW.fencing_token <> OLD.fencing_token
)
AND NEW.status NOT IN (''waiting_retry'', ''blocked'', ''succeeded'', ''canceled'')
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_job_stale_lease'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_migration_job_identity_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_migration_job_identity_immutable' AND sql='CREATE TRIGGER trg_tenant_placement_migration_job_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, control_operation_id,
                 target_isolation_policy, request_hash, idempotency_key,
                 retry_budget_started_at, requested_by, created_at
ON tenant_placement_migration_jobs
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_job_identity_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_migration_job_status_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_migration_job_status_transition' AND sql='CREATE TRIGGER trg_tenant_placement_migration_job_status_transition
BEFORE UPDATE OF status ON tenant_placement_migration_jobs
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = ''queued'' AND NEW.status IN (''running'', ''blocked'', ''canceled'')) OR
  (OLD.status = ''running'' AND NEW.status IN (''waiting_retry'', ''blocked'', ''succeeded'', ''canceled'')) OR
  (OLD.status = ''waiting_retry'' AND NEW.status IN (''running'', ''blocked'', ''canceled'')) OR
  (OLD.status = ''blocked'' AND NEW.status IN (''running'', ''canceled''))
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_job_status_transition_invalid'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_migration_job_step_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_migration_job_step_transition' AND sql='CREATE TRIGGER trg_tenant_placement_migration_job_step_transition
BEFORE UPDATE OF current_step ON tenant_placement_migration_jobs
WHEN OLD.current_step <> NEW.current_step AND NOT (
  (OLD.current_step = ''wait_control'' AND NEW.current_step = ''begin_route_cutover'') OR
  (OLD.current_step = ''begin_route_cutover'' AND NEW.current_step = ''prepare_lookup'') OR
  (OLD.current_step = ''prepare_lookup'' AND NEW.current_step = ''prepare_alias'') OR
  (OLD.current_step = ''prepare_alias'' AND NEW.current_step = ''commit_control'') OR
  (OLD.current_step = ''commit_control'' AND NEW.current_step = ''publish_registry'') OR
  (OLD.current_step = ''publish_registry'' AND NEW.current_step = ''activate_alias'') OR
  (OLD.current_step = ''activate_alias'' AND NEW.current_step = ''activate_lookup'') OR
  (OLD.current_step = ''activate_lookup'' AND NEW.current_step = ''verify_routes'') OR
  (OLD.current_step = ''verify_routes'' AND NEW.current_step = ''finalize_source'') OR
  (OLD.current_step = ''finalize_source'' AND NEW.current_step = ''complete'')
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_job_step_transition_invalid'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_provisioning_placement_policy_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_provisioning_placement_policy_immutable' AND sql='CREATE TRIGGER trg_tenant_provisioning_placement_policy_immutable
BEFORE UPDATE OF isolation_policy ON tenant_provisioning_operations
BEGIN
  SELECT RAISE(ABORT, ''tenant_provisioning_placement_policy_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-schema-objects', (SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN ('admin_agent_delegation_jtis','admin_agent_grants','admin_agent_login_handoffs','admin_agent_mcp_sessions','admin_agent_token_families','admin_agent_token_revocation_outbox','admin_attribute_values','admin_attributes','admin_audit_coverage_status','admin_audit_log','admin_database_connection_usages','admin_database_connections','admin_destination_health_events','admin_destinations','admin_external_token_refresh_runs','admin_external_token_refresh_tenant_runs','admin_invitation_enrollments','admin_invitations','admin_ip_allowlist','admin_jobs','admin_logging_critical_policies','admin_logging_sensitive_detail_policies','admin_login_attempts','admin_machine_assertion_jti','admin_machine_credential_permissions','admin_machine_credential_tenant_scopes','admin_machine_credentials','admin_machine_principal_permissions','admin_machine_principal_tenant_scopes','admin_machine_principals','admin_machine_resource_scopes','admin_passkeys','admin_policies','admin_rebac_definitions','admin_relationships','admin_role_assignments','admin_roles','admin_search_projections','admin_sessions','admin_setup_tokens','admin_storage_destination_usages','admin_storage_destinations','admin_users','agent_baseline_assignments','agent_baseline_exceptions','agent_bulk_plans','agent_bulk_tenant_executions','agent_configuration_plan_steps','agent_configuration_plans','agent_consents','agent_elevation_challenges','agent_plan_confirmations','agent_scope_policies','agent_scope_policy_versions','agent_secret_refs','agent_task_set_versions','agent_task_sets','agent_template_copies','approval_request_approvals','approval_requests','attribute_field_registry','attribute_group_registry','authrim_migrations','authrim_runtime_probes','blind_index_rotation_jobs','compiled_mapping_snapshots','credential_profile_versions','credential_profiles','credential_secret_bodies','credential_secret_metadata','custom_field_catalog_entries','dependency_graph_snapshots','destination_profile_versions','destination_profiles','elevation_grants','external_schema_catalogs','federation_entity_statements','federation_metadata_documents','federation_metadata_entity_summaries','federation_metadata_refresh_jobs','federation_metadata_validation_events','federation_saml_runtime_entities','federation_selected_entity_import_events','federation_trust_anchors','federation_trust_chains','federation_trust_context_snapshots','federation_trust_scope_bindings','federation_trust_sources','field_catalog_entries','field_catalog_versions','field_catalogs','field_mapping_activations','field_mapping_sets','field_mapping_versions','idempotency_records','internal_notification_delivery_attempts','internal_notification_delivery_routes','internal_notification_events','key_access_events','key_material_refs','key_registries','key_versions','log_chunk_manifests','log_object_catalog','logging_catalog_repair_jobs','logging_delivery_events','logging_destination_override_history','logging_destination_overrides','logging_dlq_items','logging_export_jobs','logging_fallback_policies','logging_key_material_bodies','logging_key_registry','logging_message_export_builds','logging_message_jobs','logging_message_repair_findings','logging_policy_snapshots','logging_quota_evaluations','logging_quota_policies','logging_rewrap_jobs','logging_usage_aggregates','mapping_activation_leases','mapping_conflict_rules','mapping_events','mapping_release_rules','mapping_rule_edges','mapping_rules','mapping_templates','mapping_transform_steps','mapping_validation_rules','migration_metadata','object_catalog','object_catalog_objects','operational_notification_states','persistent_identifier_profiles','projection_jobs','projection_outbox','protocol_schema_catalogs','provider_reprojection_jobs','replay_jobs','review_task_groups','review_tasks','rewrap_jobs','scheduled_task_leases','sensitive_detail_chunk_index','source_authority_contracts','source_profile_parse_drafts','source_profile_versions','source_profiles','storage_destination_assignments','tenant_database_probe_results','tenant_placement_migration_jobs','tenant_provisioning_operation_steps','tenant_provisioning_operations'))) AND name NOT IN ('idx_admin_agent_delegation_jti_expiry','idx_admin_agent_grants_active_unique','idx_admin_agent_grants_client','idx_admin_agent_grants_delegator','idx_admin_agent_grants_management_mode','idx_admin_agent_grants_principal','idx_admin_agent_login_handoffs_pending','idx_admin_agent_login_handoffs_target','idx_admin_agent_mcp_sessions_admission','idx_admin_agent_mcp_sessions_expiration','idx_admin_agent_token_families_client','idx_admin_agent_token_families_finalization','idx_admin_agent_token_families_grant','idx_admin_agent_token_families_revocation_outbox','idx_admin_agent_token_revocation_pending','idx_admin_attr_values_attr','idx_admin_attr_values_expires','idx_admin_attr_values_lookup','idx_admin_attr_values_tenant','idx_admin_attr_values_user','idx_admin_attributes_name','idx_admin_attributes_tenant','idx_admin_attributes_type','idx_admin_audit_actor_type','idx_admin_audit_coverage_status_state','idx_admin_audit_grant','idx_admin_audit_log_action','idx_admin_audit_log_detail_object_catalog','idx_admin_audit_log_request','idx_admin_audit_log_resource','idx_admin_audit_log_tenant_time','idx_admin_audit_log_user','idx_admin_database_connection_usages_connection','idx_admin_database_connections_provider','idx_admin_destination_health_events_destination','idx_admin_destination_health_events_status','idx_admin_destinations_health','idx_admin_destinations_kind_provider','idx_admin_destinations_scope_name_active','idx_admin_destinations_scope_status','idx_admin_invitation_enrollments_expiry','idx_admin_invitation_enrollments_invitation','idx_admin_invitations_code_hash','idx_admin_invitations_email','idx_admin_invitations_tenant_status','idx_admin_ip_allowlist_enabled','idx_admin_ip_allowlist_tenant','idx_admin_ip_allowlist_version','idx_admin_jobs_cleanup','idx_admin_jobs_next_run','idx_admin_jobs_object_catalog','idx_admin_jobs_status','idx_admin_jobs_tenant','idx_admin_jobs_type','idx_admin_logging_critical_policies_destination','idx_admin_logging_critical_policies_status','idx_admin_logging_sensitive_detail_policy_scope','idx_admin_logging_sensitive_detail_policy_status','idx_admin_login_attempts_email','idx_admin_login_attempts_ip','idx_admin_login_attempts_success','idx_admin_login_attempts_time','idx_admin_machine_assertion_jti_expires','idx_admin_machine_credential_tenant_scopes_credential','idx_admin_machine_credentials_principal','idx_admin_machine_credentials_status','idx_admin_machine_principal_tenant_scopes_principal','idx_admin_machine_principals_status','idx_admin_machine_resource_scopes_credential','idx_admin_machine_resource_scopes_principal','idx_admin_passkeys_credential','idx_admin_passkeys_user','idx_admin_policies_active','idx_admin_policies_name','idx_admin_policies_priority','idx_admin_policies_resource','idx_admin_policies_tenant','idx_admin_rebac_def_name','idx_admin_rebac_def_tenant','idx_admin_rel_expires','idx_admin_rel_from','idx_admin_rel_tenant','idx_admin_rel_to','idx_admin_rel_type','idx_admin_rel_unique','idx_admin_role_assignments_expires','idx_admin_role_assignments_role','idx_admin_role_assignments_scope','idx_admin_role_assignments_tenant','idx_admin_role_assignments_user','idx_admin_roles_hierarchy','idx_admin_roles_inherits','idx_admin_roles_name','idx_admin_roles_tenant','idx_admin_roles_type','idx_admin_sessions_activity','idx_admin_sessions_derived_target','idx_admin_sessions_expires','idx_admin_sessions_parent','idx_admin_sessions_tenant','idx_admin_sessions_user','idx_admin_setup_tokens_expires','idx_admin_setup_tokens_status','idx_admin_setup_tokens_tenant','idx_admin_setup_tokens_user','idx_admin_storage_destination_usages_destination','idx_admin_storage_destination_usages_feature','idx_admin_storage_destinations_provider','idx_admin_storage_destinations_scope','idx_admin_users_active','idx_admin_users_last_login','idx_admin_users_status','idx_admin_users_tenant_email','idx_agent_baseline_assignments_remediation_plan','idx_agent_baseline_assignments_transition','idx_agent_bulk_children_capability','idx_agent_bulk_plans_actor','idx_agent_bulk_plans_control','idx_agent_bulk_plans_retention','idx_agent_bulk_plans_transition','idx_agent_bulk_tenant_claim','idx_agent_bulk_tenant_lease','idx_agent_bulk_tenant_transition','idx_agent_configuration_plans_context','idx_agent_configuration_plans_retention','idx_agent_configuration_plans_transition','idx_agent_consents_grant','idx_agent_consents_user','idx_agent_elevation_approval_artifact','idx_agent_elevation_approval_request','idx_agent_elevation_args_active','idx_agent_elevation_grant','idx_agent_elevation_recovery','idx_agent_plan_confirmations_transition','idx_agent_scope_policies_management_mode','idx_agent_scope_policies_transition','idx_agent_scope_policy_versions_transition','idx_agent_secret_refs_transition','idx_agent_task_set_versions_transition','idx_agent_task_sets_management_mode','idx_agent_task_sets_transition','idx_approval_request_approvals_expires','idx_approval_request_approvals_request_status','idx_approval_request_approvals_subject','idx_approval_request_approvals_unique_subject','idx_approval_requests_detail_object_catalog','idx_approval_requests_expires','idx_approval_requests_investigation','idx_approval_requests_requester','idx_approval_requests_target','idx_approval_requests_tenant_status_requested','idx_compiled_mapping_snapshots_state','idx_credential_profile_versions_state','idx_credential_profiles_state','idx_credential_secret_bodies_destination','idx_credential_secret_metadata_destination','idx_destination_profile_versions_state','idx_destination_profiles_owner','idx_destination_profiles_type_state','idx_elevation_grants_actor','idx_elevation_grants_expires','idx_elevation_grants_request','idx_elevation_grants_tenant_status_issued','idx_external_token_refresh_runs_requested_tenant','idx_external_token_refresh_runs_started','idx_external_token_refresh_tenant_runs_tenant','idx_federation_metadata_documents_latest_valid','idx_federation_metadata_entity_summaries_document','idx_federation_metadata_refresh_jobs_source_created','idx_federation_metadata_validation_events_document','idx_federation_metadata_validation_events_source_created','idx_federation_saml_runtime_entities_document','idx_federation_saml_runtime_entities_lookup','idx_field_mapping_versions_state','idx_internal_notification_delivery_attempts_event','idx_internal_notification_delivery_attempts_retry','idx_internal_notification_delivery_routes_lookup','idx_internal_notification_events_dedup','idx_internal_notification_events_pending','idx_internal_notification_events_tenant_created','idx_log_chunk_manifests_bucket','idx_log_object_catalog_object_key','idx_log_object_catalog_status','idx_log_object_catalog_tenant_type_time','idx_logging_catalog_repair_jobs_queue','idx_logging_catalog_repair_jobs_scope','idx_logging_delivery_events_destination','idx_logging_delivery_events_tenant_status','idx_logging_destination_override_history_override','idx_logging_destination_override_history_scope','idx_logging_destination_overrides_destination','idx_logging_destination_overrides_effective','idx_logging_dlq_items_lane_status','idx_logging_dlq_items_tenant_status','idx_logging_export_jobs_status','idx_logging_export_jobs_tenant','idx_logging_fallback_policies_scope','idx_logging_key_material_bodies_scope','idx_logging_key_registry_scope','idx_logging_key_registry_status','idx_logging_message_export_builds_export','idx_logging_message_export_builds_job','idx_logging_message_jobs_chain','idx_logging_message_jobs_claimed','idx_logging_message_jobs_due','idx_logging_message_jobs_scope_status','idx_logging_message_jobs_source','idx_logging_message_jobs_tenant','idx_logging_message_repair_findings_job','idx_logging_message_repair_findings_status','idx_logging_policy_snapshots_scope_version','idx_logging_policy_snapshots_status','idx_logging_quota_evaluations_policy_time','idx_logging_quota_evaluations_state','idx_logging_quota_policies_lookup','idx_logging_quota_policies_scope','idx_logging_rewrap_jobs_queue','idx_logging_rewrap_jobs_registry','idx_logging_usage_aggregates_scope','idx_logging_usage_aggregates_window','idx_object_catalog_deleted_at','idx_object_catalog_objects_bucket_key','idx_object_catalog_objects_catalog_repr','idx_object_catalog_objects_deleted_at','idx_object_catalog_tenant_class_created','idx_persistent_identifier_profiles_tenant_state','idx_provider_reprojection_jobs_due','idx_provider_reprojection_jobs_plugin','idx_sensitive_detail_chunk_index_object','idx_sensitive_detail_chunk_index_tenant_class','idx_source_profile_parse_drafts_expiry','idx_source_profile_versions_state','idx_source_profiles_type_state','idx_storage_destination_assignments_scope','idx_storage_destination_assignments_tenant','idx_tenant_database_probe_results_scope','idx_tenant_database_probe_results_status','idx_tenant_placement_migration_jobs_runnable','idx_tenant_provisioning_operations_runnable','idx_tenant_provisioning_steps_status','ux_attribute_field_registry_key','ux_attribute_group_registry_key','ux_destination_profile_versions_label','ux_destination_profiles_active_resource_server_client','ux_destination_profiles_scope_key','trg_admin_agent_grants_expiry_insert','trg_admin_agent_grants_expiry_update','trg_admin_agent_grants_require_snapshot_active_update','trg_admin_agent_grants_require_snapshot_insert','trg_tenant_placement_migration_job_fencing','trg_tenant_placement_migration_job_identity_immutable','trg_tenant_placement_migration_job_status_transition','trg_tenant_placement_migration_job_step_transition','trg_tenant_provisioning_placement_policy_immutable')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-dependent-table', (WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN ('admin_agent_delegation_jtis','admin_agent_grants','admin_agent_login_handoffs','admin_agent_mcp_sessions','admin_agent_token_families','admin_agent_token_revocation_outbox','admin_attribute_values','admin_attributes','admin_audit_coverage_status','admin_audit_log','admin_database_connection_usages','admin_database_connections','admin_destination_health_events','admin_destinations','admin_external_token_refresh_runs','admin_external_token_refresh_tenant_runs','admin_invitation_enrollments','admin_invitations','admin_ip_allowlist','admin_jobs','admin_logging_critical_policies','admin_logging_sensitive_detail_policies','admin_login_attempts','admin_machine_assertion_jti','admin_machine_credential_permissions','admin_machine_credential_tenant_scopes','admin_machine_credentials','admin_machine_principal_permissions','admin_machine_principal_tenant_scopes','admin_machine_principals','admin_machine_resource_scopes','admin_passkeys','admin_policies','admin_rebac_definitions','admin_relationships','admin_role_assignments','admin_roles','admin_search_projections','admin_sessions','admin_setup_tokens','admin_storage_destination_usages','admin_storage_destinations','admin_users','agent_baseline_assignments','agent_baseline_exceptions','agent_bulk_plans','agent_bulk_tenant_executions','agent_configuration_plan_steps','agent_configuration_plans','agent_consents','agent_elevation_challenges','agent_plan_confirmations','agent_scope_policies','agent_scope_policy_versions','agent_secret_refs','agent_task_set_versions','agent_task_sets','agent_template_copies','approval_request_approvals','approval_requests','attribute_field_registry','attribute_group_registry','authrim_migrations','authrim_runtime_probes','blind_index_rotation_jobs','compiled_mapping_snapshots','credential_profile_versions','credential_profiles','credential_secret_bodies','credential_secret_metadata','custom_field_catalog_entries','dependency_graph_snapshots','destination_profile_versions','destination_profiles','elevation_grants','external_schema_catalogs','federation_entity_statements','federation_metadata_documents','federation_metadata_entity_summaries','federation_metadata_refresh_jobs','federation_metadata_validation_events','federation_saml_runtime_entities','federation_selected_entity_import_events','federation_trust_anchors','federation_trust_chains','federation_trust_context_snapshots','federation_trust_scope_bindings','federation_trust_sources','field_catalog_entries','field_catalog_versions','field_catalogs','field_mapping_activations','field_mapping_sets','field_mapping_versions','idempotency_records','internal_notification_delivery_attempts','internal_notification_delivery_routes','internal_notification_events','key_access_events','key_material_refs','key_registries','key_versions','log_chunk_manifests','log_object_catalog','logging_catalog_repair_jobs','logging_delivery_events','logging_destination_override_history','logging_destination_overrides','logging_dlq_items','logging_export_jobs','logging_fallback_policies','logging_key_material_bodies','logging_key_registry','logging_message_export_builds','logging_message_jobs','logging_message_repair_findings','logging_policy_snapshots','logging_quota_evaluations','logging_quota_policies','logging_rewrap_jobs','logging_usage_aggregates','mapping_activation_leases','mapping_conflict_rules','mapping_events','mapping_release_rules','mapping_rule_edges','mapping_rules','mapping_templates','mapping_transform_steps','mapping_validation_rules','migration_metadata','object_catalog','object_catalog_objects','operational_notification_states','persistent_identifier_profiles','projection_jobs','projection_outbox','protocol_schema_catalogs','provider_reprojection_jobs','replay_jobs','review_task_groups','review_tasks','rewrap_jobs','scheduled_task_leases','sensitive_detail_chunk_index','source_authority_contracts','source_profile_parse_drafts','source_profile_versions','source_profiles','storage_destination_assignments','tenant_database_probe_results','tenant_placement_migration_jobs','tenant_provisioning_operation_steps','tenant_provisioning_operations')) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN ('admin_agent_delegation_jtis','admin_agent_grants','admin_agent_login_handoffs','admin_agent_mcp_sessions','admin_agent_token_families','admin_agent_token_revocation_outbox','admin_attribute_values','admin_attributes','admin_audit_coverage_status','admin_audit_log','admin_database_connection_usages','admin_database_connections','admin_destination_health_events','admin_destinations','admin_external_token_refresh_runs','admin_external_token_refresh_tenant_runs','admin_invitation_enrollments','admin_invitations','admin_ip_allowlist','admin_jobs','admin_logging_critical_policies','admin_logging_sensitive_detail_policies','admin_login_attempts','admin_machine_assertion_jti','admin_machine_credential_permissions','admin_machine_credential_tenant_scopes','admin_machine_credentials','admin_machine_principal_permissions','admin_machine_principal_tenant_scopes','admin_machine_principals','admin_machine_resource_scopes','admin_passkeys','admin_policies','admin_rebac_definitions','admin_relationships','admin_role_assignments','admin_roles','admin_search_projections','admin_sessions','admin_setup_tokens','admin_storage_destination_usages','admin_storage_destinations','admin_users','agent_baseline_assignments','agent_baseline_exceptions','agent_bulk_plans','agent_bulk_tenant_executions','agent_configuration_plan_steps','agent_configuration_plans','agent_consents','agent_elevation_challenges','agent_plan_confirmations','agent_scope_policies','agent_scope_policy_versions','agent_secret_refs','agent_task_set_versions','agent_task_sets','agent_template_copies','approval_request_approvals','approval_requests','attribute_field_registry','attribute_group_registry','authrim_migrations','authrim_runtime_probes','blind_index_rotation_jobs','compiled_mapping_snapshots','credential_profile_versions','credential_profiles','credential_secret_bodies','credential_secret_metadata','custom_field_catalog_entries','dependency_graph_snapshots','destination_profile_versions','destination_profiles','elevation_grants','external_schema_catalogs','federation_entity_statements','federation_metadata_documents','federation_metadata_entity_summaries','federation_metadata_refresh_jobs','federation_metadata_validation_events','federation_saml_runtime_entities','federation_selected_entity_import_events','federation_trust_anchors','federation_trust_chains','federation_trust_context_snapshots','federation_trust_scope_bindings','federation_trust_sources','field_catalog_entries','field_catalog_versions','field_catalogs','field_mapping_activations','field_mapping_sets','field_mapping_versions','idempotency_records','internal_notification_delivery_attempts','internal_notification_delivery_routes','internal_notification_events','key_access_events','key_material_refs','key_registries','key_versions','log_chunk_manifests','log_object_catalog','logging_catalog_repair_jobs','logging_delivery_events','logging_destination_override_history','logging_destination_overrides','logging_dlq_items','logging_export_jobs','logging_fallback_policies','logging_key_material_bodies','logging_key_registry','logging_message_export_builds','logging_message_jobs','logging_message_repair_findings','logging_policy_snapshots','logging_quota_evaluations','logging_quota_policies','logging_rewrap_jobs','logging_usage_aggregates','mapping_activation_leases','mapping_conflict_rules','mapping_events','mapping_release_rules','mapping_rule_edges','mapping_rules','mapping_templates','mapping_transform_steps','mapping_validation_rules','migration_metadata','object_catalog','object_catalog_objects','operational_notification_states','persistent_identifier_profiles','projection_jobs','projection_outbox','protocol_schema_catalogs','provider_reprojection_jobs','replay_jobs','review_task_groups','review_tasks','rewrap_jobs','scheduled_task_leases','sensitive_detail_chunk_index','source_authority_contracts','source_profile_parse_drafts','source_profile_versions','source_profiles','storage_destination_assignments','tenant_database_probe_results','tenant_placement_migration_jobs','tenant_provisioning_operation_steps','tenant_provisioning_operations')));

CREATE TABLE "__authrim_pk_copy_admin_agent_delegation_jtis" AS SELECT "rowid" AS "__authrim_original_rowid","jti","tenant_id","grant_id","machine_principal_id","expires_at","consumed_at" FROM "admin_agent_delegation_jtis";

CREATE TABLE "__authrim_pk_copy_admin_agent_grants" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","machine_principal_id","grantor_id","delegator_id","permissions","task_sets","scope_policy_id","scope_policy_version","scope_overrides","resolved_scope_constraints","access_snapshot_hash","scopes","authorization_details","delegation_mode","purpose","generation","consent_version","approval_id","status","active_uniqueness_key","expires_at","last_used_at","client_metadata_url","client_metadata_hash","client_metadata_fetched_at","created_at","updated_at","revoked_at","revoked_by","last_mutation_id","task_set_id","task_set_version","resolved_tools","management_mode" FROM "admin_agent_grants";

CREATE TABLE "__authrim_pk_copy_admin_agent_login_handoffs" AS SELECT "rowid" AS "__authrim_original_rowid","id","target_tenant_id","target_origin","authorization_path","status","browser_binding_hash","source_session_id","source_session_hash","admin_user_id","code_hash","last_transition_id","created_at","expires_at","issued_at","consumed_at" FROM "admin_agent_login_handoffs";

CREATE TABLE "__authrim_pk_copy_admin_agent_mcp_sessions" AS SELECT "rowid" AS "__authrim_original_rowid","session_id","tenant_id","grant_id","client_id","actor_sub","created_at","last_active_at","expires_at","absolute_expires_at" FROM "admin_agent_mcp_sessions";

CREATE TABLE "__authrim_pk_copy_admin_agent_token_families" AS SELECT "rowid" AS "__authrim_original_rowid","family_id","family_jti","tenant_id","grant_id","grant_generation","admin_user_id","client_id","consent_version","status","finalization_nonce","finalized_at","expires_at","created_at","updated_at","revocation_outbox_id" FROM "admin_agent_token_families";

CREATE TABLE "__authrim_pk_copy_admin_agent_token_revocation_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","grant_id","grant_generation","client_id","event_type","payload","status","attempt_count","processing_fence","next_attempt_at","processing_owner_id","processing_lease_expires_at","created_at","completed_at","completion_transition_id","failure_transition_id" FROM "admin_agent_token_revocation_outbox";

CREATE TABLE "__authrim_pk_copy_admin_attribute_values" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","admin_user_id","admin_attribute_id","value","value_index","source","expires_at","assigned_by","created_at","updated_at" FROM "admin_attribute_values";

CREATE TABLE "__authrim_pk_copy_admin_attributes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","attribute_type","allowed_values_json","min_value","max_value","regex_pattern","is_required","is_multi_valued","is_system","created_at","updated_at" FROM "admin_attributes";

CREATE TABLE "__authrim_pk_copy_admin_audit_coverage_status" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","route","method","required_audit","criticality","status","first_seen_at","last_seen_at","updated_at" FROM "admin_audit_coverage_status";

CREATE TABLE "__authrim_pk_copy_admin_audit_log" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","admin_user_id","admin_email","action","resource_type","resource_id","result","error_code","error_message","severity","ip_address","user_agent","request_id","session_id","before_json","after_json","metadata_json","created_at","detail_object_catalog_id","actor_type","actor_sub","actor_mode","actor_assurance","token_binding","act_client_id","act_principal_id","grant_id","elevation_id","mcp_tool" FROM "admin_audit_log";

CREATE TABLE "__authrim_pk_copy_admin_database_connection_usages" AS SELECT "rowid" AS "__authrim_original_rowid","id","connection_id","purpose","resource_type","resource_id","tenant_id","metadata_json","created_by","created_at","updated_at","is_active" FROM "admin_database_connection_usages";

CREATE TABLE "__authrim_pk_copy_admin_database_connections" AS SELECT "rowid" AS "__authrim_original_rowid","id","name","display_name","description","provider","config_json","credential_encrypted","credential_key_version","credential_updated_at","credential_updated_by","status","created_by","updated_by","created_at","updated_at","is_active" FROM "admin_database_connections";

CREATE TABLE "__authrim_pk_copy_admin_destination_health_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","destination_id","check_type","previous_health_status","next_health_status","result","error_class","latency_ms","checked_at","metadata" FROM "admin_destination_health_events";

CREATE TABLE "__authrim_pk_copy_admin_destinations" AS SELECT "rowid" AS "__authrim_original_rowid","id","scope_type","scope_id","destination_kind","provider","name","display_name","description","lifecycle_status","health_status","rotation_status","provider_config","credential_ref","credential_version","next_credential_ref","next_credential_version","previous_credential_ref","previous_credential_retire_after","allowed_tenant_ids","allowed_log_types","allowed_planes","region","critical_allowed","default_fallback_eligible","retention_days","encryption_mode","last_health_check_at","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "admin_destinations";

CREATE TABLE "__authrim_pk_copy_admin_external_token_refresh_runs" AS SELECT "rowid" AS "__authrim_original_rowid","id","trigger_type","status","requested_tenant_id","actor_type","actor_id","config_json","selected_tenants_count","processed_tenants","failed_tenants","tokens_refreshed","cursor_before","cursor_after","detail_object_catalog_id","error_message","started_at","completed_at" FROM "admin_external_token_refresh_runs";

CREATE TABLE "__authrim_pk_copy_admin_external_token_refresh_tenant_runs" AS SELECT "rowid" AS "__authrim_original_rowid","run_id","tenant_id","status","tokens_refreshed","error_message","started_at","completed_at" FROM "admin_external_token_refresh_tenant_runs";

CREATE TABLE "__authrim_pk_copy_admin_invitation_enrollments" AS SELECT "rowid" AS "__authrim_original_rowid","token_hash","invitation_id","phase","state_json","expires_at","created_at","updated_at" FROM "admin_invitation_enrollments";

CREATE TABLE "__authrim_pk_copy_admin_invitations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","admin_user_id","email","pending_email_key","name","code_hash","status","admin_role_id","admin_role_name","admin_role_display_name","scope_type","scope_id","role_expires_at","ip_restriction_enabled","allowed_ip_ranges_json","expires_at","last_sent_at","last_delivery_status","last_delivery_error","accepted_at","accepted_ip","created_by","created_at","updated_at" FROM "admin_invitations";

CREATE TABLE "__authrim_pk_copy_admin_ip_allowlist" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","ip_range","ip_version","description","enabled","created_by","created_at","updated_at" FROM "admin_ip_allowlist";

CREATE TABLE "__authrim_pk_copy_admin_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","job_type","status","progress","config","input_r2_key","result_r2_key","object_catalog_id","result","error_code","error_message","created_by","created_at","updated_at","started_at","completed_at","estimated_completion","attempt_count","max_attempts","next_run_at","dead_lettered_at" FROM "admin_jobs";

CREATE TABLE "__authrim_pk_copy_admin_logging_critical_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","policy_key","destination_id","critical_allowed","default_fallback_eligible","failure_mode","change_protection","approval_policy_id","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "admin_logging_critical_policies";

CREATE TABLE "__authrim_pk_copy_admin_logging_sensitive_detail_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","log_type","plane","destination_id","chunking_enabled","encryption_required","read_audit_required","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "admin_logging_sensitive_detail_policies";

CREATE TABLE "__authrim_pk_copy_admin_login_attempts" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","email","ip_address","user_agent","success","failure_reason","created_at" FROM "admin_login_attempts";

CREATE TABLE "__authrim_pk_copy_admin_machine_assertion_jti" AS SELECT "rowid" AS "__authrim_original_rowid","client_id","credential_id","jti","expires_at","created_at" FROM "admin_machine_assertion_jti";

CREATE TABLE "__authrim_pk_copy_admin_machine_credential_permissions" AS SELECT "rowid" AS "__authrim_original_rowid","credential_id","permission","created_at","created_by_actor_type","created_by_actor_id" FROM "admin_machine_credential_permissions";

CREATE TABLE "__authrim_pk_copy_admin_machine_credential_tenant_scopes" AS SELECT "rowid" AS "__authrim_original_rowid","credential_id","scope_mode","tenant_id","created_at","created_by_actor_type","created_by_actor_id" FROM "admin_machine_credential_tenant_scopes";

CREATE TABLE "__authrim_pk_copy_admin_machine_credentials" AS SELECT "rowid" AS "__authrim_original_rowid","id","principal_id","kid","public_jwk_json","alg","display_name","description","status","not_before","expires_at","last_used_at","last_used_ip","last_used_user_agent","created_by_actor_type","created_by_actor_id","created_at","updated_at","revoked_at","revoked_by_actor_type","revoked_by_actor_id","revoke_reason" FROM "admin_machine_credentials";

CREATE TABLE "__authrim_pk_copy_admin_machine_principal_permissions" AS SELECT "rowid" AS "__authrim_original_rowid","principal_id","permission","created_at","created_by_actor_type","created_by_actor_id" FROM "admin_machine_principal_permissions";

CREATE TABLE "__authrim_pk_copy_admin_machine_principal_tenant_scopes" AS SELECT "rowid" AS "__authrim_original_rowid","principal_id","scope_mode","tenant_id","created_at","created_by_actor_type","created_by_actor_id" FROM "admin_machine_principal_tenant_scopes";

CREATE TABLE "__authrim_pk_copy_admin_machine_principals" AS SELECT "rowid" AS "__authrim_original_rowid","id","client_id","display_name","description","principal_type","status","default_audience","token_ttl_seconds","created_by_actor_type","created_by_actor_id","created_at","updated_at","disabled_at","disabled_by_actor_type","disabled_by_actor_id" FROM "admin_machine_principals";

CREATE TABLE "__authrim_pk_copy_admin_machine_resource_scopes" AS SELECT "rowid" AS "__authrim_original_rowid","id","principal_id","credential_id","resource_type","resource_id","constraints_json","created_at","created_by_actor_type","created_by_actor_id" FROM "admin_machine_resource_scopes";

CREATE TABLE "__authrim_pk_copy_admin_passkeys" AS SELECT "rowid" AS "__authrim_original_rowid","id","admin_user_id","credential_id","public_key","counter","device_name","transports_json","attestation_type","aaguid","created_at","last_used_at" FROM "admin_passkeys";

CREATE TABLE "__authrim_pk_copy_admin_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","effect","priority","resource_pattern","actions_json","conditions_json","is_active","is_system","created_at","updated_at" FROM "admin_policies";

CREATE TABLE "__authrim_pk_copy_admin_rebac_definitions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","relation_name","display_name","description","priority","is_system","created_at","updated_at" FROM "admin_rebac_definitions";

CREATE TABLE "__authrim_pk_copy_admin_relationships" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","relationship_type","from_type","from_id","to_type","to_id","permission_level","is_transitive","expires_at","is_bidirectional","metadata_json","created_by","created_at","updated_at" FROM "admin_relationships";

CREATE TABLE "__authrim_pk_copy_admin_role_assignments" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","admin_user_id","admin_role_id","scope_type","scope_id","expires_at","assigned_by","created_at" FROM "admin_role_assignments";

CREATE TABLE "__authrim_pk_copy_admin_roles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","permissions_json","hierarchy_level","role_type","is_system","created_at","updated_at","inherits_from" FROM "admin_roles";

CREATE TABLE "__authrim_pk_copy_admin_search_projections" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","projection_kind","projection_json","classification","lifecycle_state","indexed_at","created_at","updated_at" FROM "admin_search_projections";

CREATE TABLE "__authrim_pk_copy_admin_sessions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","admin_user_id","ip_address","user_agent","created_at","expires_at","last_activity_at","mfa_verified","mfa_verified_at","parent_session_id","derived_target_tenant_id" FROM "admin_sessions";

CREATE TABLE "__authrim_pk_copy_admin_setup_tokens" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","admin_user_id","status","expires_at","used_at","used_ip","created_at","created_by" FROM "admin_setup_tokens";

CREATE TABLE "__authrim_pk_copy_admin_storage_destination_usages" AS SELECT "rowid" AS "__authrim_original_rowid","id","destination_id","feature","resource_type","resource_id","tenant_id","metadata_json","created_by","created_at","updated_at","is_active" FROM "admin_storage_destination_usages";

CREATE TABLE "__authrim_pk_copy_admin_storage_destinations" AS SELECT "rowid" AS "__authrim_original_rowid","id","scope_type","scope_id","name","display_name","description","provider","config_json","credential_encrypted","credential_key_version","credential_updated_at","credential_updated_by","status","created_by","updated_by","created_at","updated_at","is_active" FROM "admin_storage_destinations";

CREATE TABLE "__authrim_pk_copy_admin_users" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","email","email_verified","name","password_hash","is_active","status","mfa_enabled","mfa_method","totp_secret_encrypted","last_login_at","last_login_ip","failed_login_count","locked_until","created_by","created_at","updated_at","passkey_setup_completed" FROM "admin_users";

CREATE TABLE "__authrim_pk_copy_agent_baseline_assignments" AS SELECT "rowid" AS "__authrim_original_rowid","id","baseline_id","baseline_version","tenant_id","source_bulk_plan_id","assigned_by","assigned_at","last_evaluated_at","drift_status","drift_digest","remediation_bulk_plan_id","remediation_bulk_plan_version","remediation_drift_digest","remediation_requested_at","last_transition_id","source_bulk_plan_version" FROM "agent_baseline_assignments";

CREATE TABLE "__authrim_pk_copy_agent_baseline_exceptions" AS SELECT "rowid" AS "__authrim_original_rowid","id","assignment_id","fields_json","reason","approved_by","approved_at","expires_at","revoked_at" FROM "agent_baseline_exceptions";

CREATE TABLE "__authrim_pk_copy_agent_bulk_plans" AS SELECT "rowid" AS "__authrim_original_rowid","id","version","control_tenant_id","grant_id","actor_sub","client_id","definition_json","definition_digest","target_snapshot_json","target_snapshot_digest","canary_tenant_ids_json","canary_digest","status","stage","canary_size","wave_size","wave_failure_threshold_bps","current_wave","succeeded_count","failed_count","indeterminate_count","pause_reason","last_transition_id","expires_at","cancelled_at","cancelled_by","cancel_reason","payload_purge_at","payload_purged_at","created_at","updated_at","delegator_id","actor_mode","actor_assurance","token_binding","machine_principal_id","machine_credential_id","grant_generation","consent_version","approved_by","approved_at","approval_digest" FROM "agent_bulk_plans";

CREATE TABLE "__authrim_pk_copy_agent_bulk_tenant_executions" AS SELECT "rowid" AS "__authrim_original_rowid","id","bulk_plan_id","bulk_plan_version","target_tenant_id","target_sequence","is_canary","wave_number","stage","status","plan_digest","child_capability_digest","precondition_snapshot_digest","execution_attempt","execution_fence","execution_owner_id","execution_lease_expires_at","idempotency_key","result_json","result_digest","failure_kind","last_transition_id","created_at","started_at","completed_at","updated_at","child_capability_expires_at" FROM "agent_bulk_tenant_executions";

CREATE TABLE "__authrim_pk_copy_agent_configuration_plan_steps" AS SELECT "rowid" AS "__authrim_original_rowid","plan_id","plan_version","step_id","sequence","operation","tool_contract_version","input_json","input_digest","resource_precondition","risk_level","status","result_json","result_digest","started_at","completed_at" FROM "agent_configuration_plan_steps";

CREATE TABLE "__authrim_pk_copy_agent_configuration_plans" AS SELECT "rowid" AS "__authrim_original_rowid","id","version","tenant_id","grant_id","grant_generation","consent_version","actor_sub","client_id","definition_json","snapshot_json","diff_json","validation_json","result_json","definition_digest","status","stage","applied_step_count","failed_step_id","failure_kind","confirmation_id","last_transition_id","expires_at","cancelled_at","cancelled_by","cancel_reason","payload_purge_at","payload_purged_at","created_at","updated_at" FROM "agent_configuration_plans";

CREATE TABLE "__authrim_pk_copy_agent_consents" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","consent_type","grant_id","user_id","client_id","consent_version","scopes","granted_at","revoked_at","revoked_reason","last_mutation_id" FROM "agent_consents";

CREATE TABLE "__authrim_pk_copy_agent_elevation_challenges" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","grant_id","user_id","actor_sub","client_id","tool_name","tool_schema_version","args_envelope","args_hash","confirm_summary_redacted","target_resource_refs","status","active_args_key","elevation_grant_id","approver_type","approver_id","execution_result_envelope","execution_result_digest","execution_lease_expires_at","retry_count","execution_attempt","execution_owner_id","execution_fence","reconciled_by","reconciled_outcome","reconciliation_evidence_envelope","reconciliation_evidence_digest","reconciled_at","successor_challenge_id","payload_key_version","payload_purge_at","payload_purged_at","created_at","expires_at","executing_at","consumed_at","terminal_at","terminal_transition_id","approval_request_id","approval_artifact_id" FROM "agent_elevation_challenges";

CREATE TABLE "__authrim_pk_copy_agent_plan_confirmations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","plan_id","plan_version","plan_digest","grant_id","actor_sub","confirmed_by","status","created_at","expires_at","confirmed_at","consumed_at","last_transition_id" FROM "agent_plan_confirmations";

CREATE TABLE "__authrim_pk_copy_agent_scope_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","description","kind","status","current_version","source_template_id","source_template_version","last_transition_id","created_by","created_at","updated_at","management_mode" FROM "agent_scope_policies";

CREATE TABLE "__authrim_pk_copy_agent_scope_policy_versions" AS SELECT "rowid" AS "__authrim_original_rowid","scope_policy_id","version","definition_json","definition_digest","selector_catalog_version","status","last_transition_id","created_by","created_at" FROM "agent_scope_policy_versions";

CREATE TABLE "__authrim_pk_copy_agent_secret_refs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","resource_type","resource_id","purpose","provider_key","status","created_by","created_at","expires_at","revoked_at","revoked_by","last_transition_id" FROM "agent_secret_refs";

CREATE TABLE "__authrim_pk_copy_agent_task_set_versions" AS SELECT "rowid" AS "__authrim_original_rowid","task_set_id","version","tool_entries_json","resolved_permissions_json","definition_digest","catalog_version","status","last_transition_id","created_by","created_at" FROM "agent_task_set_versions";

CREATE TABLE "__authrim_pk_copy_agent_task_sets" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","description","kind","status","current_version","source_template_id","source_template_version","last_transition_id","created_by","created_at","updated_at","management_mode" FROM "agent_task_sets";

CREATE TABLE "__authrim_pk_copy_agent_template_copies" AS SELECT "rowid" AS "__authrim_original_rowid","id","template_id","template_version","target_tenant_id","target_object_id","target_object_version","target_object_status","bulk_plan_id","copied_by","copied_at","bulk_plan_version" FROM "agent_template_copies";

CREATE TABLE "__authrim_pk_copy_approval_request_approvals" AS SELECT "rowid" AS "__authrim_original_rowid","id","approval_request_id","step_key","side","subject_type","subject_id","relation_type","relation_source","status","method","transport_channel","reason_code","reason_note","requested_at","decided_at","expires_at","created_at","updated_at","last_notification_action","last_notified_at","notification_count" FROM "approval_request_approvals";

CREATE TABLE "__authrim_pk_copy_approval_requests" AS SELECT "rowid" AS "__authrim_original_rowid","id","public_request_id","tenant_id","investigation_id","requester_subject_type","requester_subject_id","target_subject_type","target_subject_id","request_surface","requested_action","redaction_level","status","scope_canonical","scope_json","reason_code","reason_note","reference_system","reference_value","reference_url","ticket_reference_system","ticket_reference_value","ticket_reference_url","reuse_scope","policy_preset","partial_access_allowed","requested_at","expires_at","decided_at","detail_object_catalog_id","created_at","updated_at" FROM "approval_requests";

CREATE TABLE "__authrim_pk_copy_attribute_field_registry" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","owner_scope_type","owner_scope_id","protocol","field_key","display_name","value_type","classification","surfaces_json","lifecycle_state","created_at","updated_at" FROM "attribute_field_registry";

CREATE TABLE "__authrim_pk_copy_attribute_group_registry" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","owner_scope_type","owner_scope_id","protocol","group_type","group_key","display_name","description","field_keys_json","lifecycle_state","created_at","updated_at" FROM "attribute_group_registry";

CREATE TABLE "__authrim_pk_copy_authrim_migrations" AS SELECT "rowid" AS "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "authrim_migrations";

CREATE TABLE "__authrim_pk_copy_authrim_runtime_probes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "authrim_runtime_probes";

CREATE TABLE "__authrim_pk_copy_blind_index_rotation_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","key_registry_id","source_version_id","target_version_id","status","cursor_json","created_at","updated_at" FROM "blind_index_rotation_jobs";

CREATE TABLE "__authrim_pk_copy_compiled_mapping_snapshots" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","catalog_version_id","snapshot_hash","compatibility_range","artifact_ref","lifecycle_state","compiled_at","activated_at","expires_at","metadata_json" FROM "compiled_mapping_snapshots";

CREATE TABLE "__authrim_pk_copy_credential_profile_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","credential_profile_id","version_number","lifecycle_state","credential_configuration_id","issuance_flow_id","issuance_flow_version_id","verification_flow_id","verification_flow_version_id","issuance_mapping_set_id","issuance_mapping_version_id","issuance_mapping_snapshot_hash","verification_mapping_set_id","verification_mapping_version_id","verification_mapping_snapshot_hash","claim_allowlist_json","offer_ttl_seconds","maximum_attribute_age_seconds","transaction_code_required","snapshot_hash","published_at","created_by","created_at","updated_by","updated_at" FROM "credential_profile_versions";

CREATE TABLE "__authrim_pk_copy_credential_profiles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","profile_key","display_name","description","lifecycle_state","current_published_version_id","created_by","created_at","updated_by","updated_at" FROM "credential_profiles";

CREATE TABLE "__authrim_pk_copy_credential_secret_bodies" AS SELECT "rowid" AS "__authrim_original_rowid","credential_ref","destination_id","version","envelope_json","created_at","updated_at" FROM "credential_secret_bodies";

CREATE TABLE "__authrim_pk_copy_credential_secret_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","credential_ref","destination_id","backend","version","status","created_at","retired_at","metadata" FROM "credential_secret_metadata";

CREATE TABLE "__authrim_pk_copy_custom_field_catalog_entries" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","catalog_entry_id","custom_key","display_name","value_type","classification","lifecycle_state","created_at","updated_at" FROM "custom_field_catalog_entries";

CREATE TABLE "__authrim_pk_copy_dependency_graph_snapshots" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","snapshot_hash","graph_json","created_at" FROM "dependency_graph_snapshots";

CREATE TABLE "__authrim_pk_copy_destination_profile_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","profile_id","version_label","lifecycle_state","schema_hash","schema_json","validation_summary_json","warning_summary_json","release_impact_json","reviewed_at","activated_at","created_at","updated_at" FROM "destination_profile_versions";

CREATE TABLE "__authrim_pk_copy_destination_profiles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","destination_type","profile_key","display_name","owner_scope_type","owner_scope_id","base_profile_id","lifecycle_state","active_version_id","created_at","updated_at" FROM "destination_profiles";

CREATE TABLE "__authrim_pk_copy_elevation_grants" AS SELECT "rowid" AS "__authrim_original_rowid","id","public_grant_id","approval_request_id","tenant_id","status","target_audience","resource_class","redaction_level","scope_canonical","scope_json","authorization_details_json","requester_subject_type","requester_subject_id","actor_subject_type","actor_subject_id","issued_at","expires_at","revoked_at","revoke_reason","created_at","updated_at" FROM "elevation_grants";

CREATE TABLE "__authrim_pk_copy_external_schema_catalogs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","source_type","source_id","schema_key","schema_json","imported_at","lifecycle_state","created_at","updated_at" FROM "external_schema_catalogs";

CREATE TABLE "__authrim_pk_copy_federation_entity_statements" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","issuer","subject","statement_hash","statement_ref","expires_at","lifecycle_state","created_at","updated_at" FROM "federation_entity_statements";

CREATE TABLE "__authrim_pk_copy_federation_metadata_documents" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","document_type","source_url","document_hash","document_ref","fetched_at","validated_at","validation_state","created_at","updated_at" FROM "federation_metadata_documents";

CREATE TABLE "__authrim_pk_copy_federation_metadata_entity_summaries" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","metadata_document_id","entity_id","entity_role","display_name","summary_json","created_at","updated_at" FROM "federation_metadata_entity_summaries";

CREATE TABLE "__authrim_pk_copy_federation_metadata_refresh_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","status","refresh_mode","scheduled_for","cursor_json","created_at","updated_at" FROM "federation_metadata_refresh_jobs";

CREATE TABLE "__authrim_pk_copy_federation_metadata_validation_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","metadata_document_id","validation_state","reason_codes_json","trace_ref","created_at" FROM "federation_metadata_validation_events";

CREATE TABLE "__authrim_pk_copy_federation_saml_runtime_entities" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","trust_context_snapshot_hash","metadata_document_id","entity_id","entity_role","metadata_xml","entity_categories_json","entity_category_support_json","registration_authority","valid_until","created_at","updated_at" FROM "federation_saml_runtime_entities";

CREATE TABLE "__authrim_pk_copy_federation_selected_entity_import_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","metadata_entity_summary_id","provider_id","import_action","outcome","reason_codes_json","created_at" FROM "federation_selected_entity_import_events";

CREATE TABLE "__authrim_pk_copy_federation_trust_anchors" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","anchor_type","anchor_hash","anchor_ref","not_before","not_after","lifecycle_state","created_at","updated_at" FROM "federation_trust_anchors";

CREATE TABLE "__authrim_pk_copy_federation_trust_chains" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","subject","chain_hash","chain_json","validation_state","created_at","updated_at" FROM "federation_trust_chains";

CREATE TABLE "__authrim_pk_copy_federation_trust_context_snapshots" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","snapshot_hash","trust_context_json","lifecycle_state","created_at","activated_at" FROM "federation_trust_context_snapshots";

CREATE TABLE "__authrim_pk_copy_federation_trust_scope_bindings" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","trust_source_id","scope_type","scope_id","priority","lifecycle_state","created_at","updated_at" FROM "federation_trust_scope_bindings";

CREATE TABLE "__authrim_pk_copy_federation_trust_sources" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","source_type","source_key","display_name","lifecycle_state","protocol_payload_json","created_at","updated_at","refresh_operation_token","refresh_operation_expires_at","active_metadata_document_id" FROM "federation_trust_sources";

CREATE TABLE "__authrim_pk_copy_field_catalog_entries" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","catalog_version_id","stable_field_id","namespace","path","target_taxonomy","value_type","cardinality","classification","aliases_json","validation_json","created_at","updated_at","ui_group_key","ui_group_label","ui_group_order","ui_field_order","examples_json","note" FROM "field_catalog_entries";

CREATE TABLE "__authrim_pk_copy_field_catalog_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","catalog_id","version_label","bundle_hash","compatibility_range","lifecycle_state","created_at","updated_at" FROM "field_catalog_versions";

CREATE TABLE "__authrim_pk_copy_field_catalogs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","catalog_key","display_name","lifecycle_state","created_at","updated_at" FROM "field_catalogs";

CREATE TABLE "__authrim_pk_copy_field_mapping_activations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_set_id","field_mapping_version_id","activation_scope_json","lifecycle_state","active_from","active_until","activated_at","created_at","updated_at" FROM "field_mapping_activations";

CREATE TABLE "__authrim_pk_copy_field_mapping_sets" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_key","display_name","description","owner_scope_type","owner_scope_id","lifecycle_state","created_at","updated_at" FROM "field_mapping_sets";

CREATE TABLE "__authrim_pk_copy_field_mapping_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_set_id","version_label","lifecycle_state","field_mapping_hash","compatibility_range","author_id","published_at","created_at","updated_at" FROM "field_mapping_versions";

CREATE TABLE "__authrim_pk_copy_idempotency_records" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","idempotency_key","operation_key","request_hash","response_ref","status","expires_at","created_at","updated_at" FROM "idempotency_records";

CREATE TABLE "__authrim_pk_copy_internal_notification_delivery_attempts" AS SELECT "rowid" AS "__authrim_original_rowid","id","event_id","route_id","provider","destination_id","status","attempt_count","response_status","error_class","error_message","next_attempt_at","payload_sha256","delivered_at","created_at","updated_at" FROM "internal_notification_delivery_attempts";

CREATE TABLE "__authrim_pk_copy_internal_notification_delivery_routes" AS SELECT "rowid" AS "__authrim_original_rowid","id","name","scope_type","scope_id","provider","destination_id","categories_json","severities_json","min_severity","enabled","failure_policy","max_attempts","retry_after_seconds","suppression_key","created_by","updated_by","created_at","updated_at","version" FROM "internal_notification_delivery_routes";

CREATE TABLE "__authrim_pk_copy_internal_notification_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","category","event_type","severity","status","deduplication_key","payload_json","attempts","last_error","next_attempt_at","created_at","updated_at","delivered_at" FROM "internal_notification_events";

CREATE TABLE "__authrim_pk_copy_key_access_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","key_registry_id","key_version_id","actor_id","access_type","outcome","created_at" FROM "key_access_events";

CREATE TABLE "__authrim_pk_copy_key_material_refs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","key_version_id","backend_type","material_ref","metadata_json","created_at" FROM "key_material_refs";

CREATE TABLE "__authrim_pk_copy_key_registries" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","key_purpose","scope_json","active_version_id","status","created_at","updated_at" FROM "key_registries";

CREATE TABLE "__authrim_pk_copy_key_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","key_registry_id","version","status","algorithm","created_at","activated_at","retired_at" FROM "key_versions";

CREATE TABLE "__authrim_pk_copy_log_chunk_manifests" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","log_type","plane","bucket_start_at","bucket_end_at","shard","manifest_object_key","chunk_count","record_count","checksum_sha256","status","created_at","updated_at" FROM "log_chunk_manifests";

CREATE TABLE "__authrim_pk_copy_log_object_catalog" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","log_type","plane","surface","object_key","object_kind","status","record_count","byte_count","checksum_sha256","compression","encryption_scope","key_version","created_at","committed_at","deleted_at" FROM "log_object_catalog";

CREATE TABLE "__authrim_pk_copy_logging_catalog_repair_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","job_kind","status","tenant_key","log_type","plane","requested_action","progress_current","progress_total","preview_artifact_ref","result_json","error_class","last_error","requested_by","created_at","updated_at","started_at","completed_at","cancel_requested_at","cancel_requested_by","metadata_json" FROM "logging_catalog_repair_jobs";

CREATE TABLE "__authrim_pk_copy_logging_delivery_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","destination_id","log_type","plane","lane","status","attempt_count","error_class","object_catalog_id","created_at","updated_at","next_retry_at","metadata" FROM "logging_delivery_events";

CREATE TABLE "__authrim_pk_copy_logging_destination_override_history" AS SELECT "rowid" AS "__authrim_original_rowid","id","override_id","tenant_id","log_type","plane","previous_destination_id","next_destination_id","previous_fallback_policy_id","next_fallback_policy_id","previous_enabled","next_enabled","previous_change_protection","next_change_protection","previous_approval_policy_id","next_approval_policy_id","previous_policy_hash","next_policy_hash","previous_version","next_version","changed_by","changed_at","change_reason","metadata" FROM "logging_destination_override_history";

CREATE TABLE "__authrim_pk_copy_logging_destination_overrides" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","log_type","plane","destination_id","fallback_policy_id","enabled","managed_by","change_protection","approval_policy_id","policy_hash","created_by","updated_by","created_at","updated_at","version" FROM "logging_destination_overrides";

CREATE TABLE "__authrim_pk_copy_logging_dlq_items" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","payload_type","schema_version","lane","destination_id","payload_object_ref","error_class","attempt_count","status","created_at","updated_at" FROM "logging_dlq_items";

CREATE TABLE "__authrim_pk_copy_logging_export_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","log_type","plane","format","status","artifact_object_ref","manifest_object_ref","checksum_sha256","record_count","byte_count","requested_by","error_class","filter_json","created_at","updated_at","completed_at","expires_at" FROM "logging_export_jobs";

CREATE TABLE "__authrim_pk_copy_logging_fallback_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","scope_type","scope_id","log_type","plane","fallback_destination_id","failure_mode","created_at","updated_at","version" FROM "logging_fallback_policies";

CREATE TABLE "__authrim_pk_copy_logging_key_material_bodies" AS SELECT "rowid" AS "__authrim_original_rowid","backend_ref","scope_id","tenant_key","surface","log_type","plane","version","envelope_json","created_at","updated_at" FROM "logging_key_material_bodies";

CREATE TABLE "__authrim_pk_copy_logging_key_registry" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","surface","log_type","plane","active_version","status","last_rotated_at","created_at","updated_at" FROM "logging_key_registry";

CREATE TABLE "__authrim_pk_copy_logging_message_export_builds" AS SELECT "rowid" AS "__authrim_original_rowid","id","message_job_id","export_job_id","phase","partition_strategy","partition_key","partition_index","partition_count","snapshot_cutoff_at","part_object_ref","part_checksum_sha256","part_record_count","part_byte_count","manifest_object_ref","final_checksum_sha256","final_record_count","final_byte_count","skipped_count","pending_count","late_arriving_count","cleanup_status","metadata_json","created_at","updated_at" FROM "logging_message_export_builds";

CREATE TABLE "__authrim_pk_copy_logging_message_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","kind","status","lane","criticality","priority","tenant_id","tenant_key","topology_type","database_binding_ref","connection_ref","topology_snapshot_version","topology_resolved_at","scope_type","scope_id","scope_key","source_type","source_id","root_job_id","parent_job_id","depth","payload_object_ref","payload_sha256","payload_type","payload_schema_version","redacted_summary_json","validation_summary_json","idempotency_key","dedupe_until","not_before","attempt_count","max_attempts","attempt_policy_json","claim_token","claimed_at","claimed_until","requested_by","reason","error_class","last_error","blocked_reason","cancel_requested_at","cancelled_by","created_at","updated_at","started_at","completed_at","expires_at" FROM "logging_message_jobs";

CREATE TABLE "__authrim_pk_copy_logging_message_repair_findings" AS SELECT "rowid" AS "__authrim_original_rowid","id","message_job_id","finding_type","severity","status","safe_action","dangerous_action","impact_json","detected_at","updated_at","applied_at","applied_by" FROM "logging_message_repair_findings";

CREATE TABLE "__authrim_pk_copy_logging_policy_snapshots" AS SELECT "rowid" AS "__authrim_original_rowid","id","scope_type","scope_id","version","status","policy_hash","object_ref","snapshot_json","published_by","created_at","published_at" FROM "logging_policy_snapshots";

CREATE TABLE "__authrim_pk_copy_logging_quota_evaluations" AS SELECT "rowid" AS "__authrim_original_rowid","id","quota_policy_id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","soft_limit","hard_limit","state","enforcement_action","evaluated_at","notification_event_id","metadata_json" FROM "logging_quota_evaluations";

CREATE TABLE "__authrim_pk_copy_logging_quota_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","scope_type","scope_id","log_type","plane","lane","metric_name","window_kind","soft_limit","hard_limit","warning_ratio","enforcement_mode","critical_behavior","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "logging_quota_policies";

CREATE TABLE "__authrim_pk_copy_logging_rewrap_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","key_registry_id","from_version","to_version","priority","status","created_at","started_at","completed_at","metadata" FROM "logging_rewrap_jobs";

CREATE TABLE "__authrim_pk_copy_logging_usage_aggregates" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","source_table","metadata_json","refreshed_at","created_at","updated_at" FROM "logging_usage_aggregates";

CREATE TABLE "__authrim_pk_copy_mapping_activation_leases" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","lease_key","holder_id","expires_at","created_at","updated_at" FROM "mapping_activation_leases";

CREATE TABLE "__authrim_pk_copy_mapping_conflict_rules" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","target_ref_json","conflict_strategy","source_priority_json","condition_json","created_at","updated_at" FROM "mapping_conflict_rules";

CREATE TABLE "__authrim_pk_copy_mapping_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","event_type","field_mapping_version_id","subject_id","source_id","outcome","reason_codes_json","trace_ref","created_at" FROM "mapping_events";

CREATE TABLE "__authrim_pk_copy_mapping_release_rules" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","destination_type","destination_id","source_ref_json","release_action","legal_basis","purpose","condition_json","priority","created_at","updated_at" FROM "mapping_release_rules";

CREATE TABLE "__authrim_pk_copy_mapping_rule_edges" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","rule_id","source_ref_json","target_ref_json","edge_kind","display_order","created_at","updated_at" FROM "mapping_rule_edges";

CREATE TABLE "__authrim_pk_copy_mapping_rules" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","rule_key","rule_kind","action","priority","scope_json","condition_json","metadata_json","created_at","updated_at" FROM "mapping_rules";

CREATE TABLE "__authrim_pk_copy_mapping_templates" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","template_key","template_scope","display_name","template_json","lifecycle_state","created_at","updated_at" FROM "mapping_templates";

CREATE TABLE "__authrim_pk_copy_mapping_transform_steps" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","rule_id","edge_id","step_order","operation","parameters_json","created_at","updated_at" FROM "mapping_transform_steps";

CREATE TABLE "__authrim_pk_copy_mapping_validation_rules" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","rule_id","target_ref_json","validation_kind","severity","parameters_json","created_at","updated_at" FROM "mapping_validation_rules";

CREATE TABLE "__authrim_pk_copy_migration_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "migration_metadata";

CREATE TABLE "__authrim_pk_copy_object_catalog" AS SELECT "rowid" AS "__authrim_original_rowid","id","public_artifact_id","tenant_id","object_class","created_at","updated_at","deleted_at" FROM "object_catalog";

CREATE TABLE "__authrim_pk_copy_object_catalog_objects" AS SELECT "rowid" AS "__authrim_original_rowid","id","catalog_id","representation","object_kind","object_index","bucket_binding","object_key","key_version","checksum_sha256","total_bytes","created_at","deleted_at" FROM "object_catalog_objects";

CREATE TABLE "__authrim_pk_copy_operational_notification_states" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","notification_event_id","subject_type","subject_id","state","assigned_to","acknowledged_at","resolved_at","created_at","updated_at" FROM "operational_notification_states";

CREATE TABLE "__authrim_pk_copy_persistent_identifier_profiles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","profile_key","display_name","description","mode","algorithm","protocol_scope","usage_json","source_ref_json","secret_ref","issuer_entity_id","audience_mode","format_json","lifecycle_state","created_at","updated_at" FROM "persistent_identifier_profiles";

CREATE TABLE "__authrim_pk_copy_projection_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","job_type","scope_json","status","cursor_json","started_at","completed_at","created_at","updated_at" FROM "projection_jobs";

CREATE TABLE "__authrim_pk_copy_projection_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","event_type","subject_id","aggregate_type","aggregate_id","payload_json","status","available_at","created_at","updated_at" FROM "projection_outbox";

CREATE TABLE "__authrim_pk_copy_protocol_schema_catalogs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","protocol","schema_key","schema_version","schema_json","lifecycle_state","created_at","updated_at" FROM "protocol_schema_catalogs";

CREATE TABLE "__authrim_pk_copy_provider_reprojection_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","job_id","plugin_id","desired_revision","status","cursor_tenant_id","total_tenants","processed_tenants","succeeded_tenants","skipped_tenants","failed_tenants","attempt_count","max_attempts","next_run_at","lease_owner","lease_expires_at","fencing_token","last_error_code","created_at","updated_at","completed_at" FROM "provider_reprojection_jobs";

CREATE TABLE "__authrim_pk_copy_replay_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","replay_type","impact_scope_json","status","cursor_json","result_summary_json","created_at","updated_at" FROM "replay_jobs";

CREATE TABLE "__authrim_pk_copy_review_task_groups" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","group_key","status","summary_json","created_at","updated_at" FROM "review_task_groups";

CREATE TABLE "__authrim_pk_copy_review_tasks" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","task_type","subject_id","account_id","status","priority","assigned_to","payload_json","due_at","created_at","updated_at" FROM "review_tasks";

CREATE TABLE "__authrim_pk_copy_rewrap_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","key_registry_id","source_version_id","target_version_id","artifact_scope_json","status","cursor_json","created_at","updated_at" FROM "rewrap_jobs";

CREATE TABLE "__authrim_pk_copy_scheduled_task_leases" AS SELECT "rowid" AS "__authrim_original_rowid","task_id","lease_token","lease_until","updated_at" FROM "scheduled_task_leases";

CREATE TABLE "__authrim_pk_copy_sensitive_detail_chunk_index" AS SELECT "rowid" AS "__authrim_original_rowid","catalog_id","tenant_id","object_class","bucket_binding","object_key","content_encoding","line_number","byte_offset","byte_length","key_version","checksum_sha256","created_at","deleted_at" FROM "sensitive_detail_chunk_index";

CREATE TABLE "__authrim_pk_copy_source_authority_contracts" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","source_type","source_id","field_ref_json","authority_actions_json","condition_json","priority","lifecycle_state","created_at","updated_at" FROM "source_authority_contracts";

CREATE TABLE "__authrim_pk_copy_source_profile_parse_drafts" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","source_type","schema_hash","schema_json","parser_options_json","warning_summary_json","source_metadata_json","expires_at","created_at","updated_at" FROM "source_profile_parse_drafts";

CREATE TABLE "__authrim_pk_copy_source_profile_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","profile_id","version_label","lifecycle_state","schema_hash","schema_json","parser_options_json","warning_summary_json","source_metadata_json","reviewed_at","activated_at","created_at","updated_at" FROM "source_profile_versions";

CREATE TABLE "__authrim_pk_copy_source_profiles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","source_type","profile_key","display_name","lifecycle_state","active_version_id","created_at","updated_at" FROM "source_profiles";

CREATE TABLE "__authrim_pk_copy_storage_destination_assignments" AS SELECT "rowid" AS "__authrim_original_rowid","id","destination_id","tenant_id","log_type","plane","enabled","created_by","updated_by","created_at","updated_at","version" FROM "storage_destination_assignments";

CREATE TABLE "__authrim_pk_copy_tenant_database_probe_results" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","role","shard_group","shard_index","generation","probe_kind","status","latency_ms","binding_ref","connection_ref","provider","schema_version","error_class","error_message","metadata_json","created_by","created_at" FROM "tenant_database_probe_results";

CREATE TABLE "__authrim_pk_copy_tenant_placement_migration_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","environment_id","tenant_id","control_operation_id","target_isolation_policy","status","active_job_key","current_step","lookup_cursor_json","lookup_prepared_row_count","lookup_activated_row_count","lookup_verified_row_count","request_hash","idempotency_key","attempt_count","retry_budget_started_at","next_attempt_at","last_error_code","lease_owner","lease_expires_at","fencing_token","requested_by","created_at","started_at","completed_at","updated_at" FROM "tenant_placement_migration_jobs";

CREATE TABLE "__authrim_pk_copy_tenant_provisioning_operation_steps" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","step_key","display_order","status","attempt_count","next_attempt_at","last_error_code","observed_resource_id","started_at","completed_at","updated_at" FROM "tenant_provisioning_operation_steps";

CREATE TABLE "__authrim_pk_copy_tenant_provisioning_operations" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","environment_id","tenant_id","tenant_code","tenant_name","tenant_description","operation_kind","source_tenant_id","preparation_payload_json","preparation_result_json","residency_policy_id","residency_partition","request_hash","idempotency_key","status","current_step","capacity_operation_ids_json","default_route_allocation_json","attempt_count","retry_budget_started_at","next_attempt_at","last_error_code","lease_owner","lease_expires_at","fencing_token","created_by","created_at","started_at","completed_at","updated_at","isolation_policy" FROM "tenant_provisioning_operations";

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "trg_admin_agent_grants_expiry_insert";

DROP TRIGGER "trg_admin_agent_grants_expiry_update";

DROP TRIGGER "trg_admin_agent_grants_require_snapshot_active_update";

DROP TRIGGER "trg_admin_agent_grants_require_snapshot_insert";

DROP TRIGGER "trg_tenant_placement_migration_job_fencing";

DROP TRIGGER "trg_tenant_placement_migration_job_identity_immutable";

DROP TRIGGER "trg_tenant_placement_migration_job_status_transition";

DROP TRIGGER "trg_tenant_placement_migration_job_step_transition";

DROP TRIGGER "trg_tenant_provisioning_placement_policy_immutable";

DROP TABLE "admin_agent_delegation_jtis";

DROP TABLE "admin_agent_login_handoffs";

DROP TABLE "admin_agent_mcp_sessions";

DROP TABLE "admin_agent_token_families";

DROP TABLE "admin_agent_token_revocation_outbox";

DROP TABLE "admin_attribute_values";

DROP TABLE "admin_audit_coverage_status";

DROP TABLE "admin_audit_log";

DROP TABLE "admin_database_connection_usages";

DROP TABLE "admin_database_connections";

DROP TABLE "admin_destination_health_events";

DROP TABLE "admin_destinations";

DROP TABLE "admin_external_token_refresh_tenant_runs";

DROP TABLE "admin_invitation_enrollments";

DROP TABLE "admin_invitations";

DROP TABLE "admin_ip_allowlist";

DROP TABLE "admin_jobs";

DROP TABLE "admin_logging_critical_policies";

DROP TABLE "admin_logging_sensitive_detail_policies";

DROP TABLE "admin_login_attempts";

DROP TABLE "admin_machine_assertion_jti";

DROP TABLE "admin_machine_credential_permissions";

DROP TABLE "admin_machine_credential_tenant_scopes";

DROP TABLE "admin_machine_principal_permissions";

DROP TABLE "admin_machine_principal_tenant_scopes";

DROP TABLE "admin_machine_resource_scopes";

DROP TABLE "admin_passkeys";

DROP TABLE "admin_policies";

DROP TABLE "admin_rebac_definitions";

DROP TABLE "admin_relationships";

DROP TABLE "admin_role_assignments";

DROP TABLE "admin_search_projections";

DROP TABLE "admin_sessions";

DROP TABLE "admin_setup_tokens";

DROP TABLE "admin_storage_destination_usages";

DROP TABLE "admin_storage_destinations";

DROP TABLE "agent_baseline_exceptions";

DROP TABLE "agent_bulk_tenant_executions";

DROP TABLE "agent_configuration_plan_steps";

DROP TABLE "agent_consents";

DROP TABLE "agent_elevation_challenges";

DROP TABLE "agent_plan_confirmations";

DROP TABLE "agent_scope_policy_versions";

DROP TABLE "agent_secret_refs";

DROP TABLE "agent_task_set_versions";

DROP TABLE "agent_template_copies";

DROP TABLE "approval_request_approvals";

DROP TABLE "attribute_field_registry";

DROP TABLE "attribute_group_registry";

DROP TABLE "authrim_migrations";

DROP TABLE "authrim_runtime_probes";

DROP TABLE "blind_index_rotation_jobs";

DROP TABLE "compiled_mapping_snapshots";

DROP TABLE "credential_profile_versions";

DROP TABLE "credential_secret_bodies";

DROP TABLE "credential_secret_metadata";

DROP TABLE "custom_field_catalog_entries";

DROP TABLE "dependency_graph_snapshots";

DROP TABLE "destination_profile_versions";

DROP TABLE "elevation_grants";

DROP TABLE "external_schema_catalogs";

DROP TABLE "federation_entity_statements";

DROP TABLE "federation_metadata_entity_summaries";

DROP TABLE "federation_metadata_refresh_jobs";

DROP TABLE "federation_metadata_validation_events";

DROP TABLE "federation_saml_runtime_entities";

DROP TABLE "federation_selected_entity_import_events";

DROP TABLE "federation_trust_anchors";

DROP TABLE "federation_trust_chains";

DROP TABLE "federation_trust_context_snapshots";

DROP TABLE "federation_trust_scope_bindings";

DROP TABLE "field_catalog_entries";

DROP TABLE "field_mapping_activations";

DROP TABLE "idempotency_records";

DROP TABLE "internal_notification_delivery_attempts";

DROP TABLE "internal_notification_delivery_routes";

DROP TABLE "internal_notification_events";

DROP TABLE "key_access_events";

DROP TABLE "key_material_refs";

DROP TABLE "log_chunk_manifests";

DROP TABLE "log_object_catalog";

DROP TABLE "logging_catalog_repair_jobs";

DROP TABLE "logging_delivery_events";

DROP TABLE "logging_destination_override_history";

DROP TABLE "logging_destination_overrides";

DROP TABLE "logging_dlq_items";

DROP TABLE "logging_export_jobs";

DROP TABLE "logging_fallback_policies";

DROP TABLE "logging_key_material_bodies";

DROP TABLE "logging_key_registry";

DROP TABLE "logging_message_export_builds";

DROP TABLE "logging_message_jobs";

DROP TABLE "logging_message_repair_findings";

DROP TABLE "logging_policy_snapshots";

DROP TABLE "logging_quota_evaluations";

DROP TABLE "logging_quota_policies";

DROP TABLE "logging_rewrap_jobs";

DROP TABLE "logging_usage_aggregates";

DROP TABLE "mapping_activation_leases";

DROP TABLE "mapping_conflict_rules";

DROP TABLE "mapping_events";

DROP TABLE "mapping_release_rules";

DROP TABLE "mapping_templates";

DROP TABLE "mapping_transform_steps";

DROP TABLE "mapping_validation_rules";

DROP TABLE "migration_metadata";

DROP TABLE "object_catalog_objects";

DROP TABLE "operational_notification_states";

DROP TABLE "persistent_identifier_profiles";

DROP TABLE "projection_jobs";

DROP TABLE "projection_outbox";

DROP TABLE "protocol_schema_catalogs";

DROP TABLE "provider_reprojection_jobs";

DROP TABLE "replay_jobs";

DROP TABLE "review_task_groups";

DROP TABLE "review_tasks";

DROP TABLE "rewrap_jobs";

DROP TABLE "scheduled_task_leases";

DROP TABLE "sensitive_detail_chunk_index";

DROP TABLE "source_authority_contracts";

DROP TABLE "source_profile_parse_drafts";

DROP TABLE "source_profile_versions";

DROP TABLE "storage_destination_assignments";

DROP TABLE "tenant_database_probe_results";

DROP TABLE "tenant_placement_migration_jobs";

DROP TABLE "tenant_provisioning_operation_steps";

DROP TABLE "admin_attributes";

DROP TABLE "admin_external_token_refresh_runs";

DROP TABLE "admin_machine_credentials";

DROP TABLE "admin_roles";

DROP TABLE "agent_baseline_assignments";

DROP TABLE "agent_bulk_plans";

DROP TABLE "agent_configuration_plans";

DROP TABLE "agent_scope_policies";

DROP TABLE "agent_task_sets";

DROP TABLE "approval_requests";

DROP TABLE "credential_profiles";

DROP TABLE "destination_profiles";

DROP TABLE "federation_metadata_documents";

DROP TABLE "field_catalog_versions";

DROP TABLE "key_versions";

DROP TABLE "mapping_rule_edges";

DROP TABLE "source_profiles";

DROP TABLE "tenant_provisioning_operations";

DROP TABLE "admin_agent_grants";

DROP TABLE "federation_trust_sources";

DROP TABLE "field_catalogs";

DROP TABLE "key_registries";

DROP TABLE "mapping_rules";

DROP TABLE "object_catalog";

DROP TABLE "admin_machine_principals";

DROP TABLE "admin_users";

DROP TABLE "field_mapping_versions";

DROP TABLE "field_mapping_sets";

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

CREATE TABLE "approval_request_approvals" (
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

CREATE TABLE "approval_requests" (
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

CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY
 NOT NULL
,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
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

CREATE TABLE "elevation_grants" (
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

CREATE TABLE "internal_notification_events" (
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
);

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

CREATE TABLE "object_catalog" (
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

CREATE INDEX idx_admin_attr_values_tenant ON admin_attribute_values(tenant_id);

CREATE INDEX idx_admin_attr_values_user ON admin_attribute_values(admin_user_id);

CREATE INDEX idx_admin_attributes_name ON admin_attributes(tenant_id, name);

CREATE INDEX idx_admin_attributes_tenant ON admin_attributes(tenant_id);

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

CREATE INDEX idx_admin_policies_tenant ON admin_policies(tenant_id);

CREATE INDEX idx_admin_rebac_def_name ON admin_rebac_definitions(tenant_id, relation_name);

CREATE INDEX idx_admin_rebac_def_tenant ON admin_rebac_definitions(tenant_id);

CREATE INDEX idx_admin_rel_expires ON admin_relationships(expires_at);

CREATE INDEX idx_admin_rel_from ON admin_relationships(from_type, from_id);

CREATE INDEX idx_admin_rel_tenant ON admin_relationships(tenant_id);

CREATE INDEX idx_admin_rel_to ON admin_relationships(to_type, to_id);

CREATE INDEX idx_admin_rel_type ON admin_relationships(relationship_type);

CREATE UNIQUE INDEX idx_admin_rel_unique
  ON admin_relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);

CREATE INDEX idx_admin_role_assignments_expires ON admin_role_assignments(expires_at);

CREATE INDEX idx_admin_role_assignments_role ON admin_role_assignments(admin_role_id);

CREATE INDEX idx_admin_role_assignments_scope ON admin_role_assignments(scope_type, scope_id);

CREATE INDEX idx_admin_role_assignments_tenant ON admin_role_assignments(tenant_id);

CREATE INDEX idx_admin_role_assignments_user ON admin_role_assignments(admin_user_id);

CREATE INDEX idx_admin_roles_hierarchy ON admin_roles(hierarchy_level);

CREATE INDEX idx_admin_roles_inherits ON admin_roles(inherits_from);

CREATE INDEX idx_admin_roles_name ON admin_roles(tenant_id, name);

CREATE INDEX idx_admin_roles_tenant ON admin_roles(tenant_id);

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

INSERT INTO "admin_agent_delegation_jtis" ("rowid","jti","tenant_id","grant_id","machine_principal_id","expires_at","consumed_at") SELECT "__authrim_original_rowid","jti","tenant_id","grant_id","machine_principal_id","expires_at","consumed_at" FROM "__authrim_pk_copy_admin_agent_delegation_jtis";

INSERT INTO "admin_agent_grants" ("rowid","id","tenant_id","client_id","machine_principal_id","grantor_id","delegator_id","permissions","task_sets","scope_policy_id","scope_policy_version","scope_overrides","resolved_scope_constraints","access_snapshot_hash","scopes","authorization_details","delegation_mode","purpose","generation","consent_version","approval_id","status","active_uniqueness_key","expires_at","last_used_at","client_metadata_url","client_metadata_hash","client_metadata_fetched_at","created_at","updated_at","revoked_at","revoked_by","last_mutation_id","task_set_id","task_set_version","resolved_tools","management_mode") SELECT "__authrim_original_rowid","id","tenant_id","client_id","machine_principal_id","grantor_id","delegator_id","permissions","task_sets","scope_policy_id","scope_policy_version","scope_overrides","resolved_scope_constraints","access_snapshot_hash","scopes","authorization_details","delegation_mode","purpose","generation","consent_version","approval_id","status","active_uniqueness_key","expires_at","last_used_at","client_metadata_url","client_metadata_hash","client_metadata_fetched_at","created_at","updated_at","revoked_at","revoked_by","last_mutation_id","task_set_id","task_set_version","resolved_tools","management_mode" FROM "__authrim_pk_copy_admin_agent_grants";

INSERT INTO "admin_agent_login_handoffs" ("rowid","id","target_tenant_id","target_origin","authorization_path","status","browser_binding_hash","source_session_id","source_session_hash","admin_user_id","code_hash","last_transition_id","created_at","expires_at","issued_at","consumed_at") SELECT "__authrim_original_rowid","id","target_tenant_id","target_origin","authorization_path","status","browser_binding_hash","source_session_id","source_session_hash","admin_user_id","code_hash","last_transition_id","created_at","expires_at","issued_at","consumed_at" FROM "__authrim_pk_copy_admin_agent_login_handoffs";

INSERT INTO "admin_agent_mcp_sessions" ("rowid","session_id","tenant_id","grant_id","client_id","actor_sub","created_at","last_active_at","expires_at","absolute_expires_at") SELECT "__authrim_original_rowid","session_id","tenant_id","grant_id","client_id","actor_sub","created_at","last_active_at","expires_at","absolute_expires_at" FROM "__authrim_pk_copy_admin_agent_mcp_sessions";

INSERT INTO "admin_agent_token_families" ("rowid","family_id","family_jti","tenant_id","grant_id","grant_generation","admin_user_id","client_id","consent_version","status","finalization_nonce","finalized_at","expires_at","created_at","updated_at","revocation_outbox_id") SELECT "__authrim_original_rowid","family_id","family_jti","tenant_id","grant_id","grant_generation","admin_user_id","client_id","consent_version","status","finalization_nonce","finalized_at","expires_at","created_at","updated_at","revocation_outbox_id" FROM "__authrim_pk_copy_admin_agent_token_families";

INSERT INTO "admin_agent_token_revocation_outbox" ("rowid","id","tenant_id","grant_id","grant_generation","client_id","event_type","payload","status","attempt_count","processing_fence","next_attempt_at","processing_owner_id","processing_lease_expires_at","created_at","completed_at","completion_transition_id","failure_transition_id") SELECT "__authrim_original_rowid","id","tenant_id","grant_id","grant_generation","client_id","event_type","payload","status","attempt_count","processing_fence","next_attempt_at","processing_owner_id","processing_lease_expires_at","created_at","completed_at","completion_transition_id","failure_transition_id" FROM "__authrim_pk_copy_admin_agent_token_revocation_outbox";

INSERT INTO "admin_attribute_values" ("rowid","id","tenant_id","admin_user_id","admin_attribute_id","value","value_index","source","expires_at","assigned_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","admin_user_id","admin_attribute_id","value","value_index","source","expires_at","assigned_by","created_at","updated_at" FROM "__authrim_pk_copy_admin_attribute_values";

INSERT INTO "admin_attributes" ("rowid","id","tenant_id","name","display_name","description","attribute_type","allowed_values_json","min_value","max_value","regex_pattern","is_required","is_multi_valued","is_system","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","attribute_type","allowed_values_json","min_value","max_value","regex_pattern","is_required","is_multi_valued","is_system","created_at","updated_at" FROM "__authrim_pk_copy_admin_attributes";

INSERT INTO "admin_audit_coverage_status" ("rowid","operation_id","route","method","required_audit","criticality","status","first_seen_at","last_seen_at","updated_at") SELECT "__authrim_original_rowid","operation_id","route","method","required_audit","criticality","status","first_seen_at","last_seen_at","updated_at" FROM "__authrim_pk_copy_admin_audit_coverage_status";

INSERT INTO "admin_audit_log" ("rowid","id","tenant_id","admin_user_id","admin_email","action","resource_type","resource_id","result","error_code","error_message","severity","ip_address","user_agent","request_id","session_id","before_json","after_json","metadata_json","created_at","detail_object_catalog_id","actor_type","actor_sub","actor_mode","actor_assurance","token_binding","act_client_id","act_principal_id","grant_id","elevation_id","mcp_tool") SELECT "__authrim_original_rowid","id","tenant_id","admin_user_id","admin_email","action","resource_type","resource_id","result","error_code","error_message","severity","ip_address","user_agent","request_id","session_id","before_json","after_json","metadata_json","created_at","detail_object_catalog_id","actor_type","actor_sub","actor_mode","actor_assurance","token_binding","act_client_id","act_principal_id","grant_id","elevation_id","mcp_tool" FROM "__authrim_pk_copy_admin_audit_log";

INSERT INTO "admin_database_connection_usages" ("rowid","id","connection_id","purpose","resource_type","resource_id","tenant_id","metadata_json","created_by","created_at","updated_at","is_active") SELECT "__authrim_original_rowid","id","connection_id","purpose","resource_type","resource_id","tenant_id","metadata_json","created_by","created_at","updated_at","is_active" FROM "__authrim_pk_copy_admin_database_connection_usages";

INSERT INTO "admin_database_connections" ("rowid","id","name","display_name","description","provider","config_json","credential_encrypted","credential_key_version","credential_updated_at","credential_updated_by","status","created_by","updated_by","created_at","updated_at","is_active") SELECT "__authrim_original_rowid","id","name","display_name","description","provider","config_json","credential_encrypted","credential_key_version","credential_updated_at","credential_updated_by","status","created_by","updated_by","created_at","updated_at","is_active" FROM "__authrim_pk_copy_admin_database_connections";

INSERT INTO "admin_destination_health_events" ("rowid","id","destination_id","check_type","previous_health_status","next_health_status","result","error_class","latency_ms","checked_at","metadata") SELECT "__authrim_original_rowid","id","destination_id","check_type","previous_health_status","next_health_status","result","error_class","latency_ms","checked_at","metadata" FROM "__authrim_pk_copy_admin_destination_health_events";

INSERT INTO "admin_destinations" ("rowid","id","scope_type","scope_id","destination_kind","provider","name","display_name","description","lifecycle_status","health_status","rotation_status","provider_config","credential_ref","credential_version","next_credential_ref","next_credential_version","previous_credential_ref","previous_credential_retire_after","allowed_tenant_ids","allowed_log_types","allowed_planes","region","critical_allowed","default_fallback_eligible","retention_days","encryption_mode","last_health_check_at","created_by","updated_by","created_at","updated_at","deleted_at","version") SELECT "__authrim_original_rowid","id","scope_type","scope_id","destination_kind","provider","name","display_name","description","lifecycle_status","health_status","rotation_status","provider_config","credential_ref","credential_version","next_credential_ref","next_credential_version","previous_credential_ref","previous_credential_retire_after","allowed_tenant_ids","allowed_log_types","allowed_planes","region","critical_allowed","default_fallback_eligible","retention_days","encryption_mode","last_health_check_at","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "__authrim_pk_copy_admin_destinations";

INSERT INTO "admin_external_token_refresh_runs" ("rowid","id","trigger_type","status","requested_tenant_id","actor_type","actor_id","config_json","selected_tenants_count","processed_tenants","failed_tenants","tokens_refreshed","cursor_before","cursor_after","detail_object_catalog_id","error_message","started_at","completed_at") SELECT "__authrim_original_rowid","id","trigger_type","status","requested_tenant_id","actor_type","actor_id","config_json","selected_tenants_count","processed_tenants","failed_tenants","tokens_refreshed","cursor_before","cursor_after","detail_object_catalog_id","error_message","started_at","completed_at" FROM "__authrim_pk_copy_admin_external_token_refresh_runs";

INSERT INTO "admin_external_token_refresh_tenant_runs" ("rowid","run_id","tenant_id","status","tokens_refreshed","error_message","started_at","completed_at") SELECT "__authrim_original_rowid","run_id","tenant_id","status","tokens_refreshed","error_message","started_at","completed_at" FROM "__authrim_pk_copy_admin_external_token_refresh_tenant_runs";

INSERT INTO "admin_invitation_enrollments" ("rowid","token_hash","invitation_id","phase","state_json","expires_at","created_at","updated_at") SELECT "__authrim_original_rowid","token_hash","invitation_id","phase","state_json","expires_at","created_at","updated_at" FROM "__authrim_pk_copy_admin_invitation_enrollments";

INSERT INTO "admin_invitations" ("rowid","id","tenant_id","admin_user_id","email","pending_email_key","name","code_hash","status","admin_role_id","admin_role_name","admin_role_display_name","scope_type","scope_id","role_expires_at","ip_restriction_enabled","allowed_ip_ranges_json","expires_at","last_sent_at","last_delivery_status","last_delivery_error","accepted_at","accepted_ip","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","admin_user_id","email","pending_email_key","name","code_hash","status","admin_role_id","admin_role_name","admin_role_display_name","scope_type","scope_id","role_expires_at","ip_restriction_enabled","allowed_ip_ranges_json","expires_at","last_sent_at","last_delivery_status","last_delivery_error","accepted_at","accepted_ip","created_by","created_at","updated_at" FROM "__authrim_pk_copy_admin_invitations";

INSERT INTO "admin_ip_allowlist" ("rowid","id","tenant_id","ip_range","ip_version","description","enabled","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","ip_range","ip_version","description","enabled","created_by","created_at","updated_at" FROM "__authrim_pk_copy_admin_ip_allowlist";

INSERT INTO "admin_jobs" ("rowid","id","tenant_id","job_type","status","progress","config","input_r2_key","result_r2_key","object_catalog_id","result","error_code","error_message","created_by","created_at","updated_at","started_at","completed_at","estimated_completion","attempt_count","max_attempts","next_run_at","dead_lettered_at") SELECT "__authrim_original_rowid","id","tenant_id","job_type","status","progress","config","input_r2_key","result_r2_key","object_catalog_id","result","error_code","error_message","created_by","created_at","updated_at","started_at","completed_at","estimated_completion","attempt_count","max_attempts","next_run_at","dead_lettered_at" FROM "__authrim_pk_copy_admin_jobs";

INSERT INTO "admin_logging_critical_policies" ("rowid","id","policy_key","destination_id","critical_allowed","default_fallback_eligible","failure_mode","change_protection","approval_policy_id","status","created_by","updated_by","created_at","updated_at","deleted_at","version") SELECT "__authrim_original_rowid","id","policy_key","destination_id","critical_allowed","default_fallback_eligible","failure_mode","change_protection","approval_policy_id","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "__authrim_pk_copy_admin_logging_critical_policies";

INSERT INTO "admin_logging_sensitive_detail_policies" ("rowid","id","log_type","plane","destination_id","chunking_enabled","encryption_required","read_audit_required","status","created_by","updated_by","created_at","updated_at","deleted_at","version") SELECT "__authrim_original_rowid","id","log_type","plane","destination_id","chunking_enabled","encryption_required","read_audit_required","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "__authrim_pk_copy_admin_logging_sensitive_detail_policies";

INSERT INTO "admin_login_attempts" ("rowid","id","tenant_id","email","ip_address","user_agent","success","failure_reason","created_at") SELECT "__authrim_original_rowid","id","tenant_id","email","ip_address","user_agent","success","failure_reason","created_at" FROM "__authrim_pk_copy_admin_login_attempts";

INSERT INTO "admin_machine_assertion_jti" ("rowid","client_id","credential_id","jti","expires_at","created_at") SELECT "__authrim_original_rowid","client_id","credential_id","jti","expires_at","created_at" FROM "__authrim_pk_copy_admin_machine_assertion_jti";

INSERT INTO "admin_machine_credential_permissions" ("rowid","credential_id","permission","created_at","created_by_actor_type","created_by_actor_id") SELECT "__authrim_original_rowid","credential_id","permission","created_at","created_by_actor_type","created_by_actor_id" FROM "__authrim_pk_copy_admin_machine_credential_permissions";

INSERT INTO "admin_machine_credential_tenant_scopes" ("rowid","credential_id","scope_mode","tenant_id","created_at","created_by_actor_type","created_by_actor_id") SELECT "__authrim_original_rowid","credential_id","scope_mode","tenant_id","created_at","created_by_actor_type","created_by_actor_id" FROM "__authrim_pk_copy_admin_machine_credential_tenant_scopes";

INSERT INTO "admin_machine_credentials" ("rowid","id","principal_id","kid","public_jwk_json","alg","display_name","description","status","not_before","expires_at","last_used_at","last_used_ip","last_used_user_agent","created_by_actor_type","created_by_actor_id","created_at","updated_at","revoked_at","revoked_by_actor_type","revoked_by_actor_id","revoke_reason") SELECT "__authrim_original_rowid","id","principal_id","kid","public_jwk_json","alg","display_name","description","status","not_before","expires_at","last_used_at","last_used_ip","last_used_user_agent","created_by_actor_type","created_by_actor_id","created_at","updated_at","revoked_at","revoked_by_actor_type","revoked_by_actor_id","revoke_reason" FROM "__authrim_pk_copy_admin_machine_credentials";

INSERT INTO "admin_machine_principal_permissions" ("rowid","principal_id","permission","created_at","created_by_actor_type","created_by_actor_id") SELECT "__authrim_original_rowid","principal_id","permission","created_at","created_by_actor_type","created_by_actor_id" FROM "__authrim_pk_copy_admin_machine_principal_permissions";

INSERT INTO "admin_machine_principal_tenant_scopes" ("rowid","principal_id","scope_mode","tenant_id","created_at","created_by_actor_type","created_by_actor_id") SELECT "__authrim_original_rowid","principal_id","scope_mode","tenant_id","created_at","created_by_actor_type","created_by_actor_id" FROM "__authrim_pk_copy_admin_machine_principal_tenant_scopes";

INSERT INTO "admin_machine_principals" ("rowid","id","client_id","display_name","description","principal_type","status","default_audience","token_ttl_seconds","created_by_actor_type","created_by_actor_id","created_at","updated_at","disabled_at","disabled_by_actor_type","disabled_by_actor_id") SELECT "__authrim_original_rowid","id","client_id","display_name","description","principal_type","status","default_audience","token_ttl_seconds","created_by_actor_type","created_by_actor_id","created_at","updated_at","disabled_at","disabled_by_actor_type","disabled_by_actor_id" FROM "__authrim_pk_copy_admin_machine_principals";

INSERT INTO "admin_machine_resource_scopes" ("rowid","id","principal_id","credential_id","resource_type","resource_id","constraints_json","created_at","created_by_actor_type","created_by_actor_id") SELECT "__authrim_original_rowid","id","principal_id","credential_id","resource_type","resource_id","constraints_json","created_at","created_by_actor_type","created_by_actor_id" FROM "__authrim_pk_copy_admin_machine_resource_scopes";

INSERT INTO "admin_passkeys" ("rowid","id","admin_user_id","credential_id","public_key","counter","device_name","transports_json","attestation_type","aaguid","created_at","last_used_at") SELECT "__authrim_original_rowid","id","admin_user_id","credential_id","public_key","counter","device_name","transports_json","attestation_type","aaguid","created_at","last_used_at" FROM "__authrim_pk_copy_admin_passkeys";

INSERT INTO "admin_policies" ("rowid","id","tenant_id","name","display_name","description","effect","priority","resource_pattern","actions_json","conditions_json","is_active","is_system","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","effect","priority","resource_pattern","actions_json","conditions_json","is_active","is_system","created_at","updated_at" FROM "__authrim_pk_copy_admin_policies";

INSERT INTO "admin_rebac_definitions" ("rowid","id","tenant_id","relation_name","display_name","description","priority","is_system","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","relation_name","display_name","description","priority","is_system","created_at","updated_at" FROM "__authrim_pk_copy_admin_rebac_definitions";

INSERT INTO "admin_relationships" ("rowid","id","tenant_id","relationship_type","from_type","from_id","to_type","to_id","permission_level","is_transitive","expires_at","is_bidirectional","metadata_json","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","relationship_type","from_type","from_id","to_type","to_id","permission_level","is_transitive","expires_at","is_bidirectional","metadata_json","created_by","created_at","updated_at" FROM "__authrim_pk_copy_admin_relationships";

INSERT INTO "admin_role_assignments" ("rowid","id","tenant_id","admin_user_id","admin_role_id","scope_type","scope_id","expires_at","assigned_by","created_at") SELECT "__authrim_original_rowid","id","tenant_id","admin_user_id","admin_role_id","scope_type","scope_id","expires_at","assigned_by","created_at" FROM "__authrim_pk_copy_admin_role_assignments";

INSERT INTO "admin_roles" ("rowid","id","tenant_id","name","display_name","description","permissions_json","hierarchy_level","role_type","is_system","created_at","updated_at","inherits_from") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","permissions_json","hierarchy_level","role_type","is_system","created_at","updated_at","inherits_from" FROM "__authrim_pk_copy_admin_roles";

INSERT INTO "admin_search_projections" ("rowid","id","tenant_id","subject_id","account_id","projection_kind","projection_json","classification","lifecycle_state","indexed_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","projection_kind","projection_json","classification","lifecycle_state","indexed_at","created_at","updated_at" FROM "__authrim_pk_copy_admin_search_projections";

INSERT INTO "admin_sessions" ("rowid","id","tenant_id","admin_user_id","ip_address","user_agent","created_at","expires_at","last_activity_at","mfa_verified","mfa_verified_at","parent_session_id","derived_target_tenant_id") SELECT "__authrim_original_rowid","id","tenant_id","admin_user_id","ip_address","user_agent","created_at","expires_at","last_activity_at","mfa_verified","mfa_verified_at","parent_session_id","derived_target_tenant_id" FROM "__authrim_pk_copy_admin_sessions";

INSERT INTO "admin_setup_tokens" ("rowid","id","tenant_id","admin_user_id","status","expires_at","used_at","used_ip","created_at","created_by") SELECT "__authrim_original_rowid","id","tenant_id","admin_user_id","status","expires_at","used_at","used_ip","created_at","created_by" FROM "__authrim_pk_copy_admin_setup_tokens";

INSERT INTO "admin_storage_destination_usages" ("rowid","id","destination_id","feature","resource_type","resource_id","tenant_id","metadata_json","created_by","created_at","updated_at","is_active") SELECT "__authrim_original_rowid","id","destination_id","feature","resource_type","resource_id","tenant_id","metadata_json","created_by","created_at","updated_at","is_active" FROM "__authrim_pk_copy_admin_storage_destination_usages";

INSERT INTO "admin_storage_destinations" ("rowid","id","scope_type","scope_id","name","display_name","description","provider","config_json","credential_encrypted","credential_key_version","credential_updated_at","credential_updated_by","status","created_by","updated_by","created_at","updated_at","is_active") SELECT "__authrim_original_rowid","id","scope_type","scope_id","name","display_name","description","provider","config_json","credential_encrypted","credential_key_version","credential_updated_at","credential_updated_by","status","created_by","updated_by","created_at","updated_at","is_active" FROM "__authrim_pk_copy_admin_storage_destinations";

INSERT INTO "admin_users" ("rowid","id","tenant_id","email","email_verified","name","password_hash","is_active","status","mfa_enabled","mfa_method","totp_secret_encrypted","last_login_at","last_login_ip","failed_login_count","locked_until","created_by","created_at","updated_at","passkey_setup_completed") SELECT "__authrim_original_rowid","id","tenant_id","email","email_verified","name","password_hash","is_active","status","mfa_enabled","mfa_method","totp_secret_encrypted","last_login_at","last_login_ip","failed_login_count","locked_until","created_by","created_at","updated_at","passkey_setup_completed" FROM "__authrim_pk_copy_admin_users";

INSERT INTO "agent_baseline_assignments" ("rowid","id","baseline_id","baseline_version","tenant_id","source_bulk_plan_id","assigned_by","assigned_at","last_evaluated_at","drift_status","drift_digest","remediation_bulk_plan_id","remediation_bulk_plan_version","remediation_drift_digest","remediation_requested_at","last_transition_id","source_bulk_plan_version") SELECT "__authrim_original_rowid","id","baseline_id","baseline_version","tenant_id","source_bulk_plan_id","assigned_by","assigned_at","last_evaluated_at","drift_status","drift_digest","remediation_bulk_plan_id","remediation_bulk_plan_version","remediation_drift_digest","remediation_requested_at","last_transition_id","source_bulk_plan_version" FROM "__authrim_pk_copy_agent_baseline_assignments";

INSERT INTO "agent_baseline_exceptions" ("rowid","id","assignment_id","fields_json","reason","approved_by","approved_at","expires_at","revoked_at") SELECT "__authrim_original_rowid","id","assignment_id","fields_json","reason","approved_by","approved_at","expires_at","revoked_at" FROM "__authrim_pk_copy_agent_baseline_exceptions";

INSERT INTO "agent_bulk_plans" ("rowid","id","version","control_tenant_id","grant_id","actor_sub","client_id","definition_json","definition_digest","target_snapshot_json","target_snapshot_digest","canary_tenant_ids_json","canary_digest","status","stage","canary_size","wave_size","wave_failure_threshold_bps","current_wave","succeeded_count","failed_count","indeterminate_count","pause_reason","last_transition_id","expires_at","cancelled_at","cancelled_by","cancel_reason","payload_purge_at","payload_purged_at","created_at","updated_at","delegator_id","actor_mode","actor_assurance","token_binding","machine_principal_id","machine_credential_id","grant_generation","consent_version","approved_by","approved_at","approval_digest") SELECT "__authrim_original_rowid","id","version","control_tenant_id","grant_id","actor_sub","client_id","definition_json","definition_digest","target_snapshot_json","target_snapshot_digest","canary_tenant_ids_json","canary_digest","status","stage","canary_size","wave_size","wave_failure_threshold_bps","current_wave","succeeded_count","failed_count","indeterminate_count","pause_reason","last_transition_id","expires_at","cancelled_at","cancelled_by","cancel_reason","payload_purge_at","payload_purged_at","created_at","updated_at","delegator_id","actor_mode","actor_assurance","token_binding","machine_principal_id","machine_credential_id","grant_generation","consent_version","approved_by","approved_at","approval_digest" FROM "__authrim_pk_copy_agent_bulk_plans";

INSERT INTO "agent_bulk_tenant_executions" ("rowid","id","bulk_plan_id","bulk_plan_version","target_tenant_id","target_sequence","is_canary","wave_number","stage","status","plan_digest","child_capability_digest","precondition_snapshot_digest","execution_attempt","execution_fence","execution_owner_id","execution_lease_expires_at","idempotency_key","result_json","result_digest","failure_kind","last_transition_id","created_at","started_at","completed_at","updated_at","child_capability_expires_at") SELECT "__authrim_original_rowid","id","bulk_plan_id","bulk_plan_version","target_tenant_id","target_sequence","is_canary","wave_number","stage","status","plan_digest","child_capability_digest","precondition_snapshot_digest","execution_attempt","execution_fence","execution_owner_id","execution_lease_expires_at","idempotency_key","result_json","result_digest","failure_kind","last_transition_id","created_at","started_at","completed_at","updated_at","child_capability_expires_at" FROM "__authrim_pk_copy_agent_bulk_tenant_executions";

INSERT INTO "agent_configuration_plan_steps" ("rowid","plan_id","plan_version","step_id","sequence","operation","tool_contract_version","input_json","input_digest","resource_precondition","risk_level","status","result_json","result_digest","started_at","completed_at") SELECT "__authrim_original_rowid","plan_id","plan_version","step_id","sequence","operation","tool_contract_version","input_json","input_digest","resource_precondition","risk_level","status","result_json","result_digest","started_at","completed_at" FROM "__authrim_pk_copy_agent_configuration_plan_steps";

INSERT INTO "agent_configuration_plans" ("rowid","id","version","tenant_id","grant_id","grant_generation","consent_version","actor_sub","client_id","definition_json","snapshot_json","diff_json","validation_json","result_json","definition_digest","status","stage","applied_step_count","failed_step_id","failure_kind","confirmation_id","last_transition_id","expires_at","cancelled_at","cancelled_by","cancel_reason","payload_purge_at","payload_purged_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","version","tenant_id","grant_id","grant_generation","consent_version","actor_sub","client_id","definition_json","snapshot_json","diff_json","validation_json","result_json","definition_digest","status","stage","applied_step_count","failed_step_id","failure_kind","confirmation_id","last_transition_id","expires_at","cancelled_at","cancelled_by","cancel_reason","payload_purge_at","payload_purged_at","created_at","updated_at" FROM "__authrim_pk_copy_agent_configuration_plans";

INSERT INTO "agent_consents" ("rowid","id","tenant_id","consent_type","grant_id","user_id","client_id","consent_version","scopes","granted_at","revoked_at","revoked_reason","last_mutation_id") SELECT "__authrim_original_rowid","id","tenant_id","consent_type","grant_id","user_id","client_id","consent_version","scopes","granted_at","revoked_at","revoked_reason","last_mutation_id" FROM "__authrim_pk_copy_agent_consents";

INSERT INTO "agent_elevation_challenges" ("rowid","id","tenant_id","grant_id","user_id","actor_sub","client_id","tool_name","tool_schema_version","args_envelope","args_hash","confirm_summary_redacted","target_resource_refs","status","active_args_key","elevation_grant_id","approver_type","approver_id","execution_result_envelope","execution_result_digest","execution_lease_expires_at","retry_count","execution_attempt","execution_owner_id","execution_fence","reconciled_by","reconciled_outcome","reconciliation_evidence_envelope","reconciliation_evidence_digest","reconciled_at","successor_challenge_id","payload_key_version","payload_purge_at","payload_purged_at","created_at","expires_at","executing_at","consumed_at","terminal_at","terminal_transition_id","approval_request_id","approval_artifact_id") SELECT "__authrim_original_rowid","id","tenant_id","grant_id","user_id","actor_sub","client_id","tool_name","tool_schema_version","args_envelope","args_hash","confirm_summary_redacted","target_resource_refs","status","active_args_key","elevation_grant_id","approver_type","approver_id","execution_result_envelope","execution_result_digest","execution_lease_expires_at","retry_count","execution_attempt","execution_owner_id","execution_fence","reconciled_by","reconciled_outcome","reconciliation_evidence_envelope","reconciliation_evidence_digest","reconciled_at","successor_challenge_id","payload_key_version","payload_purge_at","payload_purged_at","created_at","expires_at","executing_at","consumed_at","terminal_at","terminal_transition_id","approval_request_id","approval_artifact_id" FROM "__authrim_pk_copy_agent_elevation_challenges";

INSERT INTO "agent_plan_confirmations" ("rowid","id","tenant_id","plan_id","plan_version","plan_digest","grant_id","actor_sub","confirmed_by","status","created_at","expires_at","confirmed_at","consumed_at","last_transition_id") SELECT "__authrim_original_rowid","id","tenant_id","plan_id","plan_version","plan_digest","grant_id","actor_sub","confirmed_by","status","created_at","expires_at","confirmed_at","consumed_at","last_transition_id" FROM "__authrim_pk_copy_agent_plan_confirmations";

INSERT INTO "agent_scope_policies" ("rowid","id","tenant_id","name","description","kind","status","current_version","source_template_id","source_template_version","last_transition_id","created_by","created_at","updated_at","management_mode") SELECT "__authrim_original_rowid","id","tenant_id","name","description","kind","status","current_version","source_template_id","source_template_version","last_transition_id","created_by","created_at","updated_at","management_mode" FROM "__authrim_pk_copy_agent_scope_policies";

INSERT INTO "agent_scope_policy_versions" ("rowid","scope_policy_id","version","definition_json","definition_digest","selector_catalog_version","status","last_transition_id","created_by","created_at") SELECT "__authrim_original_rowid","scope_policy_id","version","definition_json","definition_digest","selector_catalog_version","status","last_transition_id","created_by","created_at" FROM "__authrim_pk_copy_agent_scope_policy_versions";

INSERT INTO "agent_secret_refs" ("rowid","id","tenant_id","resource_type","resource_id","purpose","provider_key","status","created_by","created_at","expires_at","revoked_at","revoked_by","last_transition_id") SELECT "__authrim_original_rowid","id","tenant_id","resource_type","resource_id","purpose","provider_key","status","created_by","created_at","expires_at","revoked_at","revoked_by","last_transition_id" FROM "__authrim_pk_copy_agent_secret_refs";

INSERT INTO "agent_task_set_versions" ("rowid","task_set_id","version","tool_entries_json","resolved_permissions_json","definition_digest","catalog_version","status","last_transition_id","created_by","created_at") SELECT "__authrim_original_rowid","task_set_id","version","tool_entries_json","resolved_permissions_json","definition_digest","catalog_version","status","last_transition_id","created_by","created_at" FROM "__authrim_pk_copy_agent_task_set_versions";

INSERT INTO "agent_task_sets" ("rowid","id","tenant_id","name","description","kind","status","current_version","source_template_id","source_template_version","last_transition_id","created_by","created_at","updated_at","management_mode") SELECT "__authrim_original_rowid","id","tenant_id","name","description","kind","status","current_version","source_template_id","source_template_version","last_transition_id","created_by","created_at","updated_at","management_mode" FROM "__authrim_pk_copy_agent_task_sets";

INSERT INTO "agent_template_copies" ("rowid","id","template_id","template_version","target_tenant_id","target_object_id","target_object_version","target_object_status","bulk_plan_id","copied_by","copied_at","bulk_plan_version") SELECT "__authrim_original_rowid","id","template_id","template_version","target_tenant_id","target_object_id","target_object_version","target_object_status","bulk_plan_id","copied_by","copied_at","bulk_plan_version" FROM "__authrim_pk_copy_agent_template_copies";

INSERT INTO "approval_request_approvals" ("rowid","id","approval_request_id","step_key","side","subject_type","subject_id","relation_type","relation_source","status","method","transport_channel","reason_code","reason_note","requested_at","decided_at","expires_at","created_at","updated_at","last_notification_action","last_notified_at","notification_count") SELECT "__authrim_original_rowid","id","approval_request_id","step_key","side","subject_type","subject_id","relation_type","relation_source","status","method","transport_channel","reason_code","reason_note","requested_at","decided_at","expires_at","created_at","updated_at","last_notification_action","last_notified_at","notification_count" FROM "__authrim_pk_copy_approval_request_approvals";

INSERT INTO "approval_requests" ("rowid","id","public_request_id","tenant_id","investigation_id","requester_subject_type","requester_subject_id","target_subject_type","target_subject_id","request_surface","requested_action","redaction_level","status","scope_canonical","scope_json","reason_code","reason_note","reference_system","reference_value","reference_url","ticket_reference_system","ticket_reference_value","ticket_reference_url","reuse_scope","policy_preset","partial_access_allowed","requested_at","expires_at","decided_at","detail_object_catalog_id","created_at","updated_at") SELECT "__authrim_original_rowid","id","public_request_id","tenant_id","investigation_id","requester_subject_type","requester_subject_id","target_subject_type","target_subject_id","request_surface","requested_action","redaction_level","status","scope_canonical","scope_json","reason_code","reason_note","reference_system","reference_value","reference_url","ticket_reference_system","ticket_reference_value","ticket_reference_url","reuse_scope","policy_preset","partial_access_allowed","requested_at","expires_at","decided_at","detail_object_catalog_id","created_at","updated_at" FROM "__authrim_pk_copy_approval_requests";

INSERT INTO "attribute_field_registry" ("rowid","id","tenant_id","owner_scope_type","owner_scope_id","protocol","field_key","display_name","value_type","classification","surfaces_json","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","owner_scope_type","owner_scope_id","protocol","field_key","display_name","value_type","classification","surfaces_json","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_attribute_field_registry";

INSERT INTO "attribute_group_registry" ("rowid","id","tenant_id","owner_scope_type","owner_scope_id","protocol","group_type","group_key","display_name","description","field_keys_json","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","owner_scope_type","owner_scope_id","protocol","group_type","group_key","display_name","description","field_keys_json","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_attribute_group_registry";

INSERT INTO "authrim_migrations" ("rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version") SELECT "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "__authrim_pk_copy_authrim_migrations";

INSERT INTO "authrim_runtime_probes" ("rowid","id","tenant_id","role","probe_kind","nonce","created_at") SELECT "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "__authrim_pk_copy_authrim_runtime_probes";

INSERT INTO "blind_index_rotation_jobs" ("rowid","id","tenant_id","key_registry_id","source_version_id","target_version_id","status","cursor_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","key_registry_id","source_version_id","target_version_id","status","cursor_json","created_at","updated_at" FROM "__authrim_pk_copy_blind_index_rotation_jobs";

INSERT INTO "compiled_mapping_snapshots" ("rowid","id","tenant_id","field_mapping_version_id","catalog_version_id","snapshot_hash","compatibility_range","artifact_ref","lifecycle_state","compiled_at","activated_at","expires_at","metadata_json") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","catalog_version_id","snapshot_hash","compatibility_range","artifact_ref","lifecycle_state","compiled_at","activated_at","expires_at","metadata_json" FROM "__authrim_pk_copy_compiled_mapping_snapshots";

INSERT INTO "credential_profile_versions" ("rowid","id","tenant_id","credential_profile_id","version_number","lifecycle_state","credential_configuration_id","issuance_flow_id","issuance_flow_version_id","verification_flow_id","verification_flow_version_id","issuance_mapping_set_id","issuance_mapping_version_id","issuance_mapping_snapshot_hash","verification_mapping_set_id","verification_mapping_version_id","verification_mapping_snapshot_hash","claim_allowlist_json","offer_ttl_seconds","maximum_attribute_age_seconds","transaction_code_required","snapshot_hash","published_at","created_by","created_at","updated_by","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","credential_profile_id","version_number","lifecycle_state","credential_configuration_id","issuance_flow_id","issuance_flow_version_id","verification_flow_id","verification_flow_version_id","issuance_mapping_set_id","issuance_mapping_version_id","issuance_mapping_snapshot_hash","verification_mapping_set_id","verification_mapping_version_id","verification_mapping_snapshot_hash","claim_allowlist_json","offer_ttl_seconds","maximum_attribute_age_seconds","transaction_code_required","snapshot_hash","published_at","created_by","created_at","updated_by","updated_at" FROM "__authrim_pk_copy_credential_profile_versions";

INSERT INTO "credential_profiles" ("rowid","id","tenant_id","profile_key","display_name","description","lifecycle_state","current_published_version_id","created_by","created_at","updated_by","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","profile_key","display_name","description","lifecycle_state","current_published_version_id","created_by","created_at","updated_by","updated_at" FROM "__authrim_pk_copy_credential_profiles";

INSERT INTO "credential_secret_bodies" ("rowid","credential_ref","destination_id","version","envelope_json","created_at","updated_at") SELECT "__authrim_original_rowid","credential_ref","destination_id","version","envelope_json","created_at","updated_at" FROM "__authrim_pk_copy_credential_secret_bodies";

INSERT INTO "credential_secret_metadata" ("rowid","credential_ref","destination_id","backend","version","status","created_at","retired_at","metadata") SELECT "__authrim_original_rowid","credential_ref","destination_id","backend","version","status","created_at","retired_at","metadata" FROM "__authrim_pk_copy_credential_secret_metadata";

INSERT INTO "custom_field_catalog_entries" ("rowid","id","tenant_id","catalog_entry_id","custom_key","display_name","value_type","classification","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","catalog_entry_id","custom_key","display_name","value_type","classification","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_custom_field_catalog_entries";

INSERT INTO "dependency_graph_snapshots" ("rowid","id","tenant_id","field_mapping_version_id","snapshot_hash","graph_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","snapshot_hash","graph_json","created_at" FROM "__authrim_pk_copy_dependency_graph_snapshots";

INSERT INTO "destination_profile_versions" ("rowid","id","tenant_id","profile_id","version_label","lifecycle_state","schema_hash","schema_json","validation_summary_json","warning_summary_json","release_impact_json","reviewed_at","activated_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","profile_id","version_label","lifecycle_state","schema_hash","schema_json","validation_summary_json","warning_summary_json","release_impact_json","reviewed_at","activated_at","created_at","updated_at" FROM "__authrim_pk_copy_destination_profile_versions";

INSERT INTO "destination_profiles" ("rowid","id","tenant_id","destination_type","profile_key","display_name","owner_scope_type","owner_scope_id","base_profile_id","lifecycle_state","active_version_id","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","destination_type","profile_key","display_name","owner_scope_type","owner_scope_id","base_profile_id","lifecycle_state","active_version_id","created_at","updated_at" FROM "__authrim_pk_copy_destination_profiles";

INSERT INTO "elevation_grants" ("rowid","id","public_grant_id","approval_request_id","tenant_id","status","target_audience","resource_class","redaction_level","scope_canonical","scope_json","authorization_details_json","requester_subject_type","requester_subject_id","actor_subject_type","actor_subject_id","issued_at","expires_at","revoked_at","revoke_reason","created_at","updated_at") SELECT "__authrim_original_rowid","id","public_grant_id","approval_request_id","tenant_id","status","target_audience","resource_class","redaction_level","scope_canonical","scope_json","authorization_details_json","requester_subject_type","requester_subject_id","actor_subject_type","actor_subject_id","issued_at","expires_at","revoked_at","revoke_reason","created_at","updated_at" FROM "__authrim_pk_copy_elevation_grants";

INSERT INTO "external_schema_catalogs" ("rowid","id","tenant_id","source_type","source_id","schema_key","schema_json","imported_at","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","source_type","source_id","schema_key","schema_json","imported_at","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_external_schema_catalogs";

INSERT INTO "federation_entity_statements" ("rowid","id","tenant_id","trust_source_id","issuer","subject","statement_hash","statement_ref","expires_at","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","issuer","subject","statement_hash","statement_ref","expires_at","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_federation_entity_statements";

INSERT INTO "federation_metadata_documents" ("rowid","id","tenant_id","trust_source_id","document_type","source_url","document_hash","document_ref","fetched_at","validated_at","validation_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","document_type","source_url","document_hash","document_ref","fetched_at","validated_at","validation_state","created_at","updated_at" FROM "__authrim_pk_copy_federation_metadata_documents";

INSERT INTO "federation_metadata_entity_summaries" ("rowid","id","tenant_id","metadata_document_id","entity_id","entity_role","display_name","summary_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","metadata_document_id","entity_id","entity_role","display_name","summary_json","created_at","updated_at" FROM "__authrim_pk_copy_federation_metadata_entity_summaries";

INSERT INTO "federation_metadata_refresh_jobs" ("rowid","id","tenant_id","trust_source_id","status","refresh_mode","scheduled_for","cursor_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","status","refresh_mode","scheduled_for","cursor_json","created_at","updated_at" FROM "__authrim_pk_copy_federation_metadata_refresh_jobs";

INSERT INTO "federation_metadata_validation_events" ("rowid","id","tenant_id","trust_source_id","metadata_document_id","validation_state","reason_codes_json","trace_ref","created_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","metadata_document_id","validation_state","reason_codes_json","trace_ref","created_at" FROM "__authrim_pk_copy_federation_metadata_validation_events";

INSERT INTO "federation_saml_runtime_entities" ("rowid","id","tenant_id","trust_source_id","trust_context_snapshot_hash","metadata_document_id","entity_id","entity_role","metadata_xml","entity_categories_json","entity_category_support_json","registration_authority","valid_until","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","trust_context_snapshot_hash","metadata_document_id","entity_id","entity_role","metadata_xml","entity_categories_json","entity_category_support_json","registration_authority","valid_until","created_at","updated_at" FROM "__authrim_pk_copy_federation_saml_runtime_entities";

INSERT INTO "federation_selected_entity_import_events" ("rowid","id","tenant_id","trust_source_id","metadata_entity_summary_id","provider_id","import_action","outcome","reason_codes_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","metadata_entity_summary_id","provider_id","import_action","outcome","reason_codes_json","created_at" FROM "__authrim_pk_copy_federation_selected_entity_import_events";

INSERT INTO "federation_trust_anchors" ("rowid","id","tenant_id","trust_source_id","anchor_type","anchor_hash","anchor_ref","not_before","not_after","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","anchor_type","anchor_hash","anchor_ref","not_before","not_after","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_federation_trust_anchors";

INSERT INTO "federation_trust_chains" ("rowid","id","tenant_id","trust_source_id","subject","chain_hash","chain_json","validation_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","subject","chain_hash","chain_json","validation_state","created_at","updated_at" FROM "__authrim_pk_copy_federation_trust_chains";

INSERT INTO "federation_trust_context_snapshots" ("rowid","id","tenant_id","trust_source_id","snapshot_hash","trust_context_json","lifecycle_state","created_at","activated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","snapshot_hash","trust_context_json","lifecycle_state","created_at","activated_at" FROM "__authrim_pk_copy_federation_trust_context_snapshots";

INSERT INTO "federation_trust_scope_bindings" ("rowid","id","tenant_id","trust_source_id","scope_type","scope_id","priority","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","trust_source_id","scope_type","scope_id","priority","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_federation_trust_scope_bindings";

INSERT INTO "federation_trust_sources" ("rowid","id","tenant_id","source_type","source_key","display_name","lifecycle_state","protocol_payload_json","created_at","updated_at","refresh_operation_token","refresh_operation_expires_at","active_metadata_document_id") SELECT "__authrim_original_rowid","id","tenant_id","source_type","source_key","display_name","lifecycle_state","protocol_payload_json","created_at","updated_at","refresh_operation_token","refresh_operation_expires_at","active_metadata_document_id" FROM "__authrim_pk_copy_federation_trust_sources";

INSERT INTO "field_catalog_entries" ("rowid","id","tenant_id","catalog_version_id","stable_field_id","namespace","path","target_taxonomy","value_type","cardinality","classification","aliases_json","validation_json","created_at","updated_at","ui_group_key","ui_group_label","ui_group_order","ui_field_order","examples_json","note") SELECT "__authrim_original_rowid","id","tenant_id","catalog_version_id","stable_field_id","namespace","path","target_taxonomy","value_type","cardinality","classification","aliases_json","validation_json","created_at","updated_at","ui_group_key","ui_group_label","ui_group_order","ui_field_order","examples_json","note" FROM "__authrim_pk_copy_field_catalog_entries";

INSERT INTO "field_catalog_versions" ("rowid","id","tenant_id","catalog_id","version_label","bundle_hash","compatibility_range","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","catalog_id","version_label","bundle_hash","compatibility_range","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_field_catalog_versions";

INSERT INTO "field_catalogs" ("rowid","id","tenant_id","catalog_key","display_name","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","catalog_key","display_name","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_field_catalogs";

INSERT INTO "field_mapping_activations" ("rowid","id","tenant_id","field_mapping_set_id","field_mapping_version_id","activation_scope_json","lifecycle_state","active_from","active_until","activated_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_set_id","field_mapping_version_id","activation_scope_json","lifecycle_state","active_from","active_until","activated_at","created_at","updated_at" FROM "__authrim_pk_copy_field_mapping_activations";

INSERT INTO "field_mapping_sets" ("rowid","id","tenant_id","field_mapping_key","display_name","description","owner_scope_type","owner_scope_id","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_key","display_name","description","owner_scope_type","owner_scope_id","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_field_mapping_sets";

INSERT INTO "field_mapping_versions" ("rowid","id","tenant_id","field_mapping_set_id","version_label","lifecycle_state","field_mapping_hash","compatibility_range","author_id","published_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_set_id","version_label","lifecycle_state","field_mapping_hash","compatibility_range","author_id","published_at","created_at","updated_at" FROM "__authrim_pk_copy_field_mapping_versions";

INSERT INTO "idempotency_records" ("rowid","id","tenant_id","idempotency_key","operation_key","request_hash","response_ref","status","expires_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","idempotency_key","operation_key","request_hash","response_ref","status","expires_at","created_at","updated_at" FROM "__authrim_pk_copy_idempotency_records";

INSERT INTO "internal_notification_delivery_attempts" ("rowid","id","event_id","route_id","provider","destination_id","status","attempt_count","response_status","error_class","error_message","next_attempt_at","payload_sha256","delivered_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","event_id","route_id","provider","destination_id","status","attempt_count","response_status","error_class","error_message","next_attempt_at","payload_sha256","delivered_at","created_at","updated_at" FROM "__authrim_pk_copy_internal_notification_delivery_attempts";

INSERT INTO "internal_notification_delivery_routes" ("rowid","id","name","scope_type","scope_id","provider","destination_id","categories_json","severities_json","min_severity","enabled","failure_policy","max_attempts","retry_after_seconds","suppression_key","created_by","updated_by","created_at","updated_at","version") SELECT "__authrim_original_rowid","id","name","scope_type","scope_id","provider","destination_id","categories_json","severities_json","min_severity","enabled","failure_policy","max_attempts","retry_after_seconds","suppression_key","created_by","updated_by","created_at","updated_at","version" FROM "__authrim_pk_copy_internal_notification_delivery_routes";

INSERT INTO "internal_notification_events" ("rowid","id","tenant_id","category","event_type","severity","status","deduplication_key","payload_json","attempts","last_error","next_attempt_at","created_at","updated_at","delivered_at") SELECT "__authrim_original_rowid","id","tenant_id","category","event_type","severity","status","deduplication_key","payload_json","attempts","last_error","next_attempt_at","created_at","updated_at","delivered_at" FROM "__authrim_pk_copy_internal_notification_events";

INSERT INTO "key_access_events" ("rowid","id","tenant_id","key_registry_id","key_version_id","actor_id","access_type","outcome","created_at") SELECT "__authrim_original_rowid","id","tenant_id","key_registry_id","key_version_id","actor_id","access_type","outcome","created_at" FROM "__authrim_pk_copy_key_access_events";

INSERT INTO "key_material_refs" ("rowid","id","tenant_id","key_version_id","backend_type","material_ref","metadata_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","key_version_id","backend_type","material_ref","metadata_json","created_at" FROM "__authrim_pk_copy_key_material_refs";

INSERT INTO "key_registries" ("rowid","id","tenant_id","key_purpose","scope_json","active_version_id","status","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","key_purpose","scope_json","active_version_id","status","created_at","updated_at" FROM "__authrim_pk_copy_key_registries";

INSERT INTO "key_versions" ("rowid","id","tenant_id","key_registry_id","version","status","algorithm","created_at","activated_at","retired_at") SELECT "__authrim_original_rowid","id","tenant_id","key_registry_id","version","status","algorithm","created_at","activated_at","retired_at" FROM "__authrim_pk_copy_key_versions";

INSERT INTO "log_chunk_manifests" ("rowid","id","tenant_key","log_type","plane","bucket_start_at","bucket_end_at","shard","manifest_object_key","chunk_count","record_count","checksum_sha256","status","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_key","log_type","plane","bucket_start_at","bucket_end_at","shard","manifest_object_key","chunk_count","record_count","checksum_sha256","status","created_at","updated_at" FROM "__authrim_pk_copy_log_chunk_manifests";

INSERT INTO "log_object_catalog" ("rowid","id","tenant_key","log_type","plane","surface","object_key","object_kind","status","record_count","byte_count","checksum_sha256","compression","encryption_scope","key_version","created_at","committed_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_key","log_type","plane","surface","object_key","object_kind","status","record_count","byte_count","checksum_sha256","compression","encryption_scope","key_version","created_at","committed_at","deleted_at" FROM "__authrim_pk_copy_log_object_catalog";

INSERT INTO "logging_catalog_repair_jobs" ("rowid","id","job_kind","status","tenant_key","log_type","plane","requested_action","progress_current","progress_total","preview_artifact_ref","result_json","error_class","last_error","requested_by","created_at","updated_at","started_at","completed_at","cancel_requested_at","cancel_requested_by","metadata_json") SELECT "__authrim_original_rowid","id","job_kind","status","tenant_key","log_type","plane","requested_action","progress_current","progress_total","preview_artifact_ref","result_json","error_class","last_error","requested_by","created_at","updated_at","started_at","completed_at","cancel_requested_at","cancel_requested_by","metadata_json" FROM "__authrim_pk_copy_logging_catalog_repair_jobs";

INSERT INTO "logging_delivery_events" ("rowid","id","tenant_key","destination_id","log_type","plane","lane","status","attempt_count","error_class","object_catalog_id","created_at","updated_at","next_retry_at","metadata") SELECT "__authrim_original_rowid","id","tenant_key","destination_id","log_type","plane","lane","status","attempt_count","error_class","object_catalog_id","created_at","updated_at","next_retry_at","metadata" FROM "__authrim_pk_copy_logging_delivery_events";

INSERT INTO "logging_destination_override_history" ("rowid","id","override_id","tenant_id","log_type","plane","previous_destination_id","next_destination_id","previous_fallback_policy_id","next_fallback_policy_id","previous_enabled","next_enabled","previous_change_protection","next_change_protection","previous_approval_policy_id","next_approval_policy_id","previous_policy_hash","next_policy_hash","previous_version","next_version","changed_by","changed_at","change_reason","metadata") SELECT "__authrim_original_rowid","id","override_id","tenant_id","log_type","plane","previous_destination_id","next_destination_id","previous_fallback_policy_id","next_fallback_policy_id","previous_enabled","next_enabled","previous_change_protection","next_change_protection","previous_approval_policy_id","next_approval_policy_id","previous_policy_hash","next_policy_hash","previous_version","next_version","changed_by","changed_at","change_reason","metadata" FROM "__authrim_pk_copy_logging_destination_override_history";

INSERT INTO "logging_destination_overrides" ("rowid","id","tenant_id","log_type","plane","destination_id","fallback_policy_id","enabled","managed_by","change_protection","approval_policy_id","policy_hash","created_by","updated_by","created_at","updated_at","version") SELECT "__authrim_original_rowid","id","tenant_id","log_type","plane","destination_id","fallback_policy_id","enabled","managed_by","change_protection","approval_policy_id","policy_hash","created_by","updated_by","created_at","updated_at","version" FROM "__authrim_pk_copy_logging_destination_overrides";

INSERT INTO "logging_dlq_items" ("rowid","id","tenant_key","payload_type","schema_version","lane","destination_id","payload_object_ref","error_class","attempt_count","status","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_key","payload_type","schema_version","lane","destination_id","payload_object_ref","error_class","attempt_count","status","created_at","updated_at" FROM "__authrim_pk_copy_logging_dlq_items";

INSERT INTO "logging_export_jobs" ("rowid","id","tenant_key","log_type","plane","format","status","artifact_object_ref","manifest_object_ref","checksum_sha256","record_count","byte_count","requested_by","error_class","filter_json","created_at","updated_at","completed_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_key","log_type","plane","format","status","artifact_object_ref","manifest_object_ref","checksum_sha256","record_count","byte_count","requested_by","error_class","filter_json","created_at","updated_at","completed_at","expires_at" FROM "__authrim_pk_copy_logging_export_jobs";

INSERT INTO "logging_fallback_policies" ("rowid","id","scope_type","scope_id","log_type","plane","fallback_destination_id","failure_mode","created_at","updated_at","version") SELECT "__authrim_original_rowid","id","scope_type","scope_id","log_type","plane","fallback_destination_id","failure_mode","created_at","updated_at","version" FROM "__authrim_pk_copy_logging_fallback_policies";

INSERT INTO "logging_key_material_bodies" ("rowid","backend_ref","scope_id","tenant_key","surface","log_type","plane","version","envelope_json","created_at","updated_at") SELECT "__authrim_original_rowid","backend_ref","scope_id","tenant_key","surface","log_type","plane","version","envelope_json","created_at","updated_at" FROM "__authrim_pk_copy_logging_key_material_bodies";

INSERT INTO "logging_key_registry" ("rowid","id","tenant_key","surface","log_type","plane","active_version","status","last_rotated_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_key","surface","log_type","plane","active_version","status","last_rotated_at","created_at","updated_at" FROM "__authrim_pk_copy_logging_key_registry";

INSERT INTO "logging_message_export_builds" ("rowid","id","message_job_id","export_job_id","phase","partition_strategy","partition_key","partition_index","partition_count","snapshot_cutoff_at","part_object_ref","part_checksum_sha256","part_record_count","part_byte_count","manifest_object_ref","final_checksum_sha256","final_record_count","final_byte_count","skipped_count","pending_count","late_arriving_count","cleanup_status","metadata_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","message_job_id","export_job_id","phase","partition_strategy","partition_key","partition_index","partition_count","snapshot_cutoff_at","part_object_ref","part_checksum_sha256","part_record_count","part_byte_count","manifest_object_ref","final_checksum_sha256","final_record_count","final_byte_count","skipped_count","pending_count","late_arriving_count","cleanup_status","metadata_json","created_at","updated_at" FROM "__authrim_pk_copy_logging_message_export_builds";

INSERT INTO "logging_message_jobs" ("rowid","id","kind","status","lane","criticality","priority","tenant_id","tenant_key","topology_type","database_binding_ref","connection_ref","topology_snapshot_version","topology_resolved_at","scope_type","scope_id","scope_key","source_type","source_id","root_job_id","parent_job_id","depth","payload_object_ref","payload_sha256","payload_type","payload_schema_version","redacted_summary_json","validation_summary_json","idempotency_key","dedupe_until","not_before","attempt_count","max_attempts","attempt_policy_json","claim_token","claimed_at","claimed_until","requested_by","reason","error_class","last_error","blocked_reason","cancel_requested_at","cancelled_by","created_at","updated_at","started_at","completed_at","expires_at") SELECT "__authrim_original_rowid","id","kind","status","lane","criticality","priority","tenant_id","tenant_key","topology_type","database_binding_ref","connection_ref","topology_snapshot_version","topology_resolved_at","scope_type","scope_id","scope_key","source_type","source_id","root_job_id","parent_job_id","depth","payload_object_ref","payload_sha256","payload_type","payload_schema_version","redacted_summary_json","validation_summary_json","idempotency_key","dedupe_until","not_before","attempt_count","max_attempts","attempt_policy_json","claim_token","claimed_at","claimed_until","requested_by","reason","error_class","last_error","blocked_reason","cancel_requested_at","cancelled_by","created_at","updated_at","started_at","completed_at","expires_at" FROM "__authrim_pk_copy_logging_message_jobs";

INSERT INTO "logging_message_repair_findings" ("rowid","id","message_job_id","finding_type","severity","status","safe_action","dangerous_action","impact_json","detected_at","updated_at","applied_at","applied_by") SELECT "__authrim_original_rowid","id","message_job_id","finding_type","severity","status","safe_action","dangerous_action","impact_json","detected_at","updated_at","applied_at","applied_by" FROM "__authrim_pk_copy_logging_message_repair_findings";

INSERT INTO "logging_policy_snapshots" ("rowid","id","scope_type","scope_id","version","status","policy_hash","object_ref","snapshot_json","published_by","created_at","published_at") SELECT "__authrim_original_rowid","id","scope_type","scope_id","version","status","policy_hash","object_ref","snapshot_json","published_by","created_at","published_at" FROM "__authrim_pk_copy_logging_policy_snapshots";

INSERT INTO "logging_quota_evaluations" ("rowid","id","quota_policy_id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","soft_limit","hard_limit","state","enforcement_action","evaluated_at","notification_event_id","metadata_json") SELECT "__authrim_original_rowid","id","quota_policy_id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","soft_limit","hard_limit","state","enforcement_action","evaluated_at","notification_event_id","metadata_json" FROM "__authrim_pk_copy_logging_quota_evaluations";

INSERT INTO "logging_quota_policies" ("rowid","id","scope_type","scope_id","log_type","plane","lane","metric_name","window_kind","soft_limit","hard_limit","warning_ratio","enforcement_mode","critical_behavior","status","created_by","updated_by","created_at","updated_at","deleted_at","version") SELECT "__authrim_original_rowid","id","scope_type","scope_id","log_type","plane","lane","metric_name","window_kind","soft_limit","hard_limit","warning_ratio","enforcement_mode","critical_behavior","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "__authrim_pk_copy_logging_quota_policies";

INSERT INTO "logging_rewrap_jobs" ("rowid","id","key_registry_id","from_version","to_version","priority","status","created_at","started_at","completed_at","metadata") SELECT "__authrim_original_rowid","id","key_registry_id","from_version","to_version","priority","status","created_at","started_at","completed_at","metadata" FROM "__authrim_pk_copy_logging_rewrap_jobs";

INSERT INTO "logging_usage_aggregates" ("rowid","id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","source_table","metadata_json","refreshed_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","source_table","metadata_json","refreshed_at","created_at","updated_at" FROM "__authrim_pk_copy_logging_usage_aggregates";

INSERT INTO "mapping_activation_leases" ("rowid","id","tenant_id","lease_key","holder_id","expires_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","lease_key","holder_id","expires_at","created_at","updated_at" FROM "__authrim_pk_copy_mapping_activation_leases";

INSERT INTO "mapping_conflict_rules" ("rowid","id","tenant_id","field_mapping_version_id","target_ref_json","conflict_strategy","source_priority_json","condition_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","target_ref_json","conflict_strategy","source_priority_json","condition_json","created_at","updated_at" FROM "__authrim_pk_copy_mapping_conflict_rules";

INSERT INTO "mapping_events" ("rowid","id","tenant_id","event_type","field_mapping_version_id","subject_id","source_id","outcome","reason_codes_json","trace_ref","created_at") SELECT "__authrim_original_rowid","id","tenant_id","event_type","field_mapping_version_id","subject_id","source_id","outcome","reason_codes_json","trace_ref","created_at" FROM "__authrim_pk_copy_mapping_events";

INSERT INTO "mapping_release_rules" ("rowid","id","tenant_id","field_mapping_version_id","destination_type","destination_id","source_ref_json","release_action","legal_basis","purpose","condition_json","priority","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","destination_type","destination_id","source_ref_json","release_action","legal_basis","purpose","condition_json","priority","created_at","updated_at" FROM "__authrim_pk_copy_mapping_release_rules";

INSERT INTO "mapping_rule_edges" ("rowid","id","tenant_id","rule_id","source_ref_json","target_ref_json","edge_kind","display_order","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","rule_id","source_ref_json","target_ref_json","edge_kind","display_order","created_at","updated_at" FROM "__authrim_pk_copy_mapping_rule_edges";

INSERT INTO "mapping_rules" ("rowid","id","tenant_id","field_mapping_version_id","rule_key","rule_kind","action","priority","scope_json","condition_json","metadata_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","field_mapping_version_id","rule_key","rule_kind","action","priority","scope_json","condition_json","metadata_json","created_at","updated_at" FROM "__authrim_pk_copy_mapping_rules";

INSERT INTO "mapping_templates" ("rowid","id","tenant_id","template_key","template_scope","display_name","template_json","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","template_key","template_scope","display_name","template_json","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_mapping_templates";

INSERT INTO "mapping_transform_steps" ("rowid","id","tenant_id","rule_id","edge_id","step_order","operation","parameters_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","rule_id","edge_id","step_order","operation","parameters_json","created_at","updated_at" FROM "__authrim_pk_copy_mapping_transform_steps";

INSERT INTO "mapping_validation_rules" ("rowid","id","tenant_id","rule_id","target_ref_json","validation_kind","severity","parameters_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","rule_id","target_ref_json","validation_kind","severity","parameters_json","created_at","updated_at" FROM "__authrim_pk_copy_mapping_validation_rules";

INSERT INTO "migration_metadata" ("rowid","id","current_version","last_migration_at","environment","metadata_json") SELECT "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "__authrim_pk_copy_migration_metadata";

INSERT INTO "object_catalog" ("rowid","id","public_artifact_id","tenant_id","object_class","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","public_artifact_id","tenant_id","object_class","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_object_catalog";

INSERT INTO "object_catalog_objects" ("rowid","id","catalog_id","representation","object_kind","object_index","bucket_binding","object_key","key_version","checksum_sha256","total_bytes","created_at","deleted_at") SELECT "__authrim_original_rowid","id","catalog_id","representation","object_kind","object_index","bucket_binding","object_key","key_version","checksum_sha256","total_bytes","created_at","deleted_at" FROM "__authrim_pk_copy_object_catalog_objects";

INSERT INTO "operational_notification_states" ("rowid","id","tenant_id","notification_event_id","subject_type","subject_id","state","assigned_to","acknowledged_at","resolved_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","notification_event_id","subject_type","subject_id","state","assigned_to","acknowledged_at","resolved_at","created_at","updated_at" FROM "__authrim_pk_copy_operational_notification_states";

INSERT INTO "persistent_identifier_profiles" ("rowid","id","tenant_id","profile_key","display_name","description","mode","algorithm","protocol_scope","usage_json","source_ref_json","secret_ref","issuer_entity_id","audience_mode","format_json","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","profile_key","display_name","description","mode","algorithm","protocol_scope","usage_json","source_ref_json","secret_ref","issuer_entity_id","audience_mode","format_json","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_persistent_identifier_profiles";

INSERT INTO "projection_jobs" ("rowid","id","tenant_id","job_type","scope_json","status","cursor_json","started_at","completed_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","job_type","scope_json","status","cursor_json","started_at","completed_at","created_at","updated_at" FROM "__authrim_pk_copy_projection_jobs";

INSERT INTO "projection_outbox" ("rowid","id","tenant_id","event_type","subject_id","aggregate_type","aggregate_id","payload_json","status","available_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","event_type","subject_id","aggregate_type","aggregate_id","payload_json","status","available_at","created_at","updated_at" FROM "__authrim_pk_copy_projection_outbox";

INSERT INTO "protocol_schema_catalogs" ("rowid","id","tenant_id","protocol","schema_key","schema_version","schema_json","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","protocol","schema_key","schema_version","schema_json","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_protocol_schema_catalogs";

INSERT INTO "provider_reprojection_jobs" ("rowid","job_id","plugin_id","desired_revision","status","cursor_tenant_id","total_tenants","processed_tenants","succeeded_tenants","skipped_tenants","failed_tenants","attempt_count","max_attempts","next_run_at","lease_owner","lease_expires_at","fencing_token","last_error_code","created_at","updated_at","completed_at") SELECT "__authrim_original_rowid","job_id","plugin_id","desired_revision","status","cursor_tenant_id","total_tenants","processed_tenants","succeeded_tenants","skipped_tenants","failed_tenants","attempt_count","max_attempts","next_run_at","lease_owner","lease_expires_at","fencing_token","last_error_code","created_at","updated_at","completed_at" FROM "__authrim_pk_copy_provider_reprojection_jobs";

INSERT INTO "replay_jobs" ("rowid","id","tenant_id","replay_type","impact_scope_json","status","cursor_json","result_summary_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","replay_type","impact_scope_json","status","cursor_json","result_summary_json","created_at","updated_at" FROM "__authrim_pk_copy_replay_jobs";

INSERT INTO "review_task_groups" ("rowid","id","tenant_id","group_key","status","summary_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","group_key","status","summary_json","created_at","updated_at" FROM "__authrim_pk_copy_review_task_groups";

INSERT INTO "review_tasks" ("rowid","id","tenant_id","task_type","subject_id","account_id","status","priority","assigned_to","payload_json","due_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","task_type","subject_id","account_id","status","priority","assigned_to","payload_json","due_at","created_at","updated_at" FROM "__authrim_pk_copy_review_tasks";

INSERT INTO "rewrap_jobs" ("rowid","id","tenant_id","key_registry_id","source_version_id","target_version_id","artifact_scope_json","status","cursor_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","key_registry_id","source_version_id","target_version_id","artifact_scope_json","status","cursor_json","created_at","updated_at" FROM "__authrim_pk_copy_rewrap_jobs";

INSERT INTO "scheduled_task_leases" ("rowid","task_id","lease_token","lease_until","updated_at") SELECT "__authrim_original_rowid","task_id","lease_token","lease_until","updated_at" FROM "__authrim_pk_copy_scheduled_task_leases";

INSERT INTO "sensitive_detail_chunk_index" ("rowid","catalog_id","tenant_id","object_class","bucket_binding","object_key","content_encoding","line_number","byte_offset","byte_length","key_version","checksum_sha256","created_at","deleted_at") SELECT "__authrim_original_rowid","catalog_id","tenant_id","object_class","bucket_binding","object_key","content_encoding","line_number","byte_offset","byte_length","key_version","checksum_sha256","created_at","deleted_at" FROM "__authrim_pk_copy_sensitive_detail_chunk_index";

INSERT INTO "source_authority_contracts" ("rowid","id","tenant_id","source_type","source_id","field_ref_json","authority_actions_json","condition_json","priority","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","source_type","source_id","field_ref_json","authority_actions_json","condition_json","priority","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_source_authority_contracts";

INSERT INTO "source_profile_parse_drafts" ("rowid","id","tenant_id","source_type","schema_hash","schema_json","parser_options_json","warning_summary_json","source_metadata_json","expires_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","source_type","schema_hash","schema_json","parser_options_json","warning_summary_json","source_metadata_json","expires_at","created_at","updated_at" FROM "__authrim_pk_copy_source_profile_parse_drafts";

INSERT INTO "source_profile_versions" ("rowid","id","tenant_id","profile_id","version_label","lifecycle_state","schema_hash","schema_json","parser_options_json","warning_summary_json","source_metadata_json","reviewed_at","activated_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","profile_id","version_label","lifecycle_state","schema_hash","schema_json","parser_options_json","warning_summary_json","source_metadata_json","reviewed_at","activated_at","created_at","updated_at" FROM "__authrim_pk_copy_source_profile_versions";

INSERT INTO "source_profiles" ("rowid","id","tenant_id","source_type","profile_key","display_name","lifecycle_state","active_version_id","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","source_type","profile_key","display_name","lifecycle_state","active_version_id","created_at","updated_at" FROM "__authrim_pk_copy_source_profiles";

INSERT INTO "storage_destination_assignments" ("rowid","id","destination_id","tenant_id","log_type","plane","enabled","created_by","updated_by","created_at","updated_at","version") SELECT "__authrim_original_rowid","id","destination_id","tenant_id","log_type","plane","enabled","created_by","updated_by","created_at","updated_at","version" FROM "__authrim_pk_copy_storage_destination_assignments";

INSERT INTO "tenant_database_probe_results" ("rowid","id","tenant_id","role","shard_group","shard_index","generation","probe_kind","status","latency_ms","binding_ref","connection_ref","provider","schema_version","error_class","error_message","metadata_json","created_by","created_at") SELECT "__authrim_original_rowid","id","tenant_id","role","shard_group","shard_index","generation","probe_kind","status","latency_ms","binding_ref","connection_ref","provider","schema_version","error_class","error_message","metadata_json","created_by","created_at" FROM "__authrim_pk_copy_tenant_database_probe_results";

INSERT INTO "tenant_placement_migration_jobs" ("rowid","operation_id","environment_id","tenant_id","control_operation_id","target_isolation_policy","status","active_job_key","current_step","lookup_cursor_json","lookup_prepared_row_count","lookup_activated_row_count","lookup_verified_row_count","request_hash","idempotency_key","attempt_count","retry_budget_started_at","next_attempt_at","last_error_code","lease_owner","lease_expires_at","fencing_token","requested_by","created_at","started_at","completed_at","updated_at") SELECT "__authrim_original_rowid","operation_id","environment_id","tenant_id","control_operation_id","target_isolation_policy","status","active_job_key","current_step","lookup_cursor_json","lookup_prepared_row_count","lookup_activated_row_count","lookup_verified_row_count","request_hash","idempotency_key","attempt_count","retry_budget_started_at","next_attempt_at","last_error_code","lease_owner","lease_expires_at","fencing_token","requested_by","created_at","started_at","completed_at","updated_at" FROM "__authrim_pk_copy_tenant_placement_migration_jobs";

INSERT INTO "tenant_provisioning_operation_steps" ("rowid","operation_id","step_key","display_order","status","attempt_count","next_attempt_at","last_error_code","observed_resource_id","started_at","completed_at","updated_at") SELECT "__authrim_original_rowid","operation_id","step_key","display_order","status","attempt_count","next_attempt_at","last_error_code","observed_resource_id","started_at","completed_at","updated_at" FROM "__authrim_pk_copy_tenant_provisioning_operation_steps";

INSERT INTO "tenant_provisioning_operations" ("rowid","operation_id","environment_id","tenant_id","tenant_code","tenant_name","tenant_description","operation_kind","source_tenant_id","preparation_payload_json","preparation_result_json","residency_policy_id","residency_partition","request_hash","idempotency_key","status","current_step","capacity_operation_ids_json","default_route_allocation_json","attempt_count","retry_budget_started_at","next_attempt_at","last_error_code","lease_owner","lease_expires_at","fencing_token","created_by","created_at","started_at","completed_at","updated_at","isolation_policy") SELECT "__authrim_original_rowid","operation_id","environment_id","tenant_id","tenant_code","tenant_name","tenant_description","operation_kind","source_tenant_id","preparation_payload_json","preparation_result_json","residency_policy_id","residency_partition","request_hash","idempotency_key","status","current_step","capacity_operation_ids_json","default_route_allocation_json","attempt_count","retry_budget_started_at","next_attempt_at","last_error_code","lease_owner","lease_expires_at","fencing_token","created_by","created_at","started_at","completed_at","updated_at","isolation_policy" FROM "__authrim_pk_copy_tenant_provisioning_operations";

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

INSERT INTO "__authrim_pk_guard" VALUES ('foreign-key-check', (SELECT count(*) FROM pragma_foreign_key_check));

DROP TABLE "__authrim_pk_copy_admin_agent_delegation_jtis";

DROP TABLE "__authrim_pk_copy_admin_agent_grants";

DROP TABLE "__authrim_pk_copy_admin_agent_login_handoffs";

DROP TABLE "__authrim_pk_copy_admin_agent_mcp_sessions";

DROP TABLE "__authrim_pk_copy_admin_agent_token_families";

DROP TABLE "__authrim_pk_copy_admin_agent_token_revocation_outbox";

DROP TABLE "__authrim_pk_copy_admin_attribute_values";

DROP TABLE "__authrim_pk_copy_admin_attributes";

DROP TABLE "__authrim_pk_copy_admin_audit_coverage_status";

DROP TABLE "__authrim_pk_copy_admin_audit_log";

DROP TABLE "__authrim_pk_copy_admin_database_connection_usages";

DROP TABLE "__authrim_pk_copy_admin_database_connections";

DROP TABLE "__authrim_pk_copy_admin_destination_health_events";

DROP TABLE "__authrim_pk_copy_admin_destinations";

DROP TABLE "__authrim_pk_copy_admin_external_token_refresh_runs";

DROP TABLE "__authrim_pk_copy_admin_external_token_refresh_tenant_runs";

DROP TABLE "__authrim_pk_copy_admin_invitation_enrollments";

DROP TABLE "__authrim_pk_copy_admin_invitations";

DROP TABLE "__authrim_pk_copy_admin_ip_allowlist";

DROP TABLE "__authrim_pk_copy_admin_jobs";

DROP TABLE "__authrim_pk_copy_admin_logging_critical_policies";

DROP TABLE "__authrim_pk_copy_admin_logging_sensitive_detail_policies";

DROP TABLE "__authrim_pk_copy_admin_login_attempts";

DROP TABLE "__authrim_pk_copy_admin_machine_assertion_jti";

DROP TABLE "__authrim_pk_copy_admin_machine_credential_permissions";

DROP TABLE "__authrim_pk_copy_admin_machine_credential_tenant_scopes";

DROP TABLE "__authrim_pk_copy_admin_machine_credentials";

DROP TABLE "__authrim_pk_copy_admin_machine_principal_permissions";

DROP TABLE "__authrim_pk_copy_admin_machine_principal_tenant_scopes";

DROP TABLE "__authrim_pk_copy_admin_machine_principals";

DROP TABLE "__authrim_pk_copy_admin_machine_resource_scopes";

DROP TABLE "__authrim_pk_copy_admin_passkeys";

DROP TABLE "__authrim_pk_copy_admin_policies";

DROP TABLE "__authrim_pk_copy_admin_rebac_definitions";

DROP TABLE "__authrim_pk_copy_admin_relationships";

DROP TABLE "__authrim_pk_copy_admin_role_assignments";

DROP TABLE "__authrim_pk_copy_admin_roles";

DROP TABLE "__authrim_pk_copy_admin_search_projections";

DROP TABLE "__authrim_pk_copy_admin_sessions";

DROP TABLE "__authrim_pk_copy_admin_setup_tokens";

DROP TABLE "__authrim_pk_copy_admin_storage_destination_usages";

DROP TABLE "__authrim_pk_copy_admin_storage_destinations";

DROP TABLE "__authrim_pk_copy_admin_users";

DROP TABLE "__authrim_pk_copy_agent_baseline_assignments";

DROP TABLE "__authrim_pk_copy_agent_baseline_exceptions";

DROP TABLE "__authrim_pk_copy_agent_bulk_plans";

DROP TABLE "__authrim_pk_copy_agent_bulk_tenant_executions";

DROP TABLE "__authrim_pk_copy_agent_configuration_plan_steps";

DROP TABLE "__authrim_pk_copy_agent_configuration_plans";

DROP TABLE "__authrim_pk_copy_agent_consents";

DROP TABLE "__authrim_pk_copy_agent_elevation_challenges";

DROP TABLE "__authrim_pk_copy_agent_plan_confirmations";

DROP TABLE "__authrim_pk_copy_agent_scope_policies";

DROP TABLE "__authrim_pk_copy_agent_scope_policy_versions";

DROP TABLE "__authrim_pk_copy_agent_secret_refs";

DROP TABLE "__authrim_pk_copy_agent_task_set_versions";

DROP TABLE "__authrim_pk_copy_agent_task_sets";

DROP TABLE "__authrim_pk_copy_agent_template_copies";

DROP TABLE "__authrim_pk_copy_approval_request_approvals";

DROP TABLE "__authrim_pk_copy_approval_requests";

DROP TABLE "__authrim_pk_copy_attribute_field_registry";

DROP TABLE "__authrim_pk_copy_attribute_group_registry";

DROP TABLE "__authrim_pk_copy_authrim_migrations";

DROP TABLE "__authrim_pk_copy_authrim_runtime_probes";

DROP TABLE "__authrim_pk_copy_blind_index_rotation_jobs";

DROP TABLE "__authrim_pk_copy_compiled_mapping_snapshots";

DROP TABLE "__authrim_pk_copy_credential_profile_versions";

DROP TABLE "__authrim_pk_copy_credential_profiles";

DROP TABLE "__authrim_pk_copy_credential_secret_bodies";

DROP TABLE "__authrim_pk_copy_credential_secret_metadata";

DROP TABLE "__authrim_pk_copy_custom_field_catalog_entries";

DROP TABLE "__authrim_pk_copy_dependency_graph_snapshots";

DROP TABLE "__authrim_pk_copy_destination_profile_versions";

DROP TABLE "__authrim_pk_copy_destination_profiles";

DROP TABLE "__authrim_pk_copy_elevation_grants";

DROP TABLE "__authrim_pk_copy_external_schema_catalogs";

DROP TABLE "__authrim_pk_copy_federation_entity_statements";

DROP TABLE "__authrim_pk_copy_federation_metadata_documents";

DROP TABLE "__authrim_pk_copy_federation_metadata_entity_summaries";

DROP TABLE "__authrim_pk_copy_federation_metadata_refresh_jobs";

DROP TABLE "__authrim_pk_copy_federation_metadata_validation_events";

DROP TABLE "__authrim_pk_copy_federation_saml_runtime_entities";

DROP TABLE "__authrim_pk_copy_federation_selected_entity_import_events";

DROP TABLE "__authrim_pk_copy_federation_trust_anchors";

DROP TABLE "__authrim_pk_copy_federation_trust_chains";

DROP TABLE "__authrim_pk_copy_federation_trust_context_snapshots";

DROP TABLE "__authrim_pk_copy_federation_trust_scope_bindings";

DROP TABLE "__authrim_pk_copy_federation_trust_sources";

DROP TABLE "__authrim_pk_copy_field_catalog_entries";

DROP TABLE "__authrim_pk_copy_field_catalog_versions";

DROP TABLE "__authrim_pk_copy_field_catalogs";

DROP TABLE "__authrim_pk_copy_field_mapping_activations";

DROP TABLE "__authrim_pk_copy_field_mapping_sets";

DROP TABLE "__authrim_pk_copy_field_mapping_versions";

DROP TABLE "__authrim_pk_copy_idempotency_records";

DROP TABLE "__authrim_pk_copy_internal_notification_delivery_attempts";

DROP TABLE "__authrim_pk_copy_internal_notification_delivery_routes";

DROP TABLE "__authrim_pk_copy_internal_notification_events";

DROP TABLE "__authrim_pk_copy_key_access_events";

DROP TABLE "__authrim_pk_copy_key_material_refs";

DROP TABLE "__authrim_pk_copy_key_registries";

DROP TABLE "__authrim_pk_copy_key_versions";

DROP TABLE "__authrim_pk_copy_log_chunk_manifests";

DROP TABLE "__authrim_pk_copy_log_object_catalog";

DROP TABLE "__authrim_pk_copy_logging_catalog_repair_jobs";

DROP TABLE "__authrim_pk_copy_logging_delivery_events";

DROP TABLE "__authrim_pk_copy_logging_destination_override_history";

DROP TABLE "__authrim_pk_copy_logging_destination_overrides";

DROP TABLE "__authrim_pk_copy_logging_dlq_items";

DROP TABLE "__authrim_pk_copy_logging_export_jobs";

DROP TABLE "__authrim_pk_copy_logging_fallback_policies";

DROP TABLE "__authrim_pk_copy_logging_key_material_bodies";

DROP TABLE "__authrim_pk_copy_logging_key_registry";

DROP TABLE "__authrim_pk_copy_logging_message_export_builds";

DROP TABLE "__authrim_pk_copy_logging_message_jobs";

DROP TABLE "__authrim_pk_copy_logging_message_repair_findings";

DROP TABLE "__authrim_pk_copy_logging_policy_snapshots";

DROP TABLE "__authrim_pk_copy_logging_quota_evaluations";

DROP TABLE "__authrim_pk_copy_logging_quota_policies";

DROP TABLE "__authrim_pk_copy_logging_rewrap_jobs";

DROP TABLE "__authrim_pk_copy_logging_usage_aggregates";

DROP TABLE "__authrim_pk_copy_mapping_activation_leases";

DROP TABLE "__authrim_pk_copy_mapping_conflict_rules";

DROP TABLE "__authrim_pk_copy_mapping_events";

DROP TABLE "__authrim_pk_copy_mapping_release_rules";

DROP TABLE "__authrim_pk_copy_mapping_rule_edges";

DROP TABLE "__authrim_pk_copy_mapping_rules";

DROP TABLE "__authrim_pk_copy_mapping_templates";

DROP TABLE "__authrim_pk_copy_mapping_transform_steps";

DROP TABLE "__authrim_pk_copy_mapping_validation_rules";

DROP TABLE "__authrim_pk_copy_migration_metadata";

DROP TABLE "__authrim_pk_copy_object_catalog";

DROP TABLE "__authrim_pk_copy_object_catalog_objects";

DROP TABLE "__authrim_pk_copy_operational_notification_states";

DROP TABLE "__authrim_pk_copy_persistent_identifier_profiles";

DROP TABLE "__authrim_pk_copy_projection_jobs";

DROP TABLE "__authrim_pk_copy_projection_outbox";

DROP TABLE "__authrim_pk_copy_protocol_schema_catalogs";

DROP TABLE "__authrim_pk_copy_provider_reprojection_jobs";

DROP TABLE "__authrim_pk_copy_replay_jobs";

DROP TABLE "__authrim_pk_copy_review_task_groups";

DROP TABLE "__authrim_pk_copy_review_tasks";

DROP TABLE "__authrim_pk_copy_rewrap_jobs";

DROP TABLE "__authrim_pk_copy_scheduled_task_leases";

DROP TABLE "__authrim_pk_copy_sensitive_detail_chunk_index";

DROP TABLE "__authrim_pk_copy_source_authority_contracts";

DROP TABLE "__authrim_pk_copy_source_profile_parse_drafts";

DROP TABLE "__authrim_pk_copy_source_profile_versions";

DROP TABLE "__authrim_pk_copy_source_profiles";

DROP TABLE "__authrim_pk_copy_storage_destination_assignments";

DROP TABLE "__authrim_pk_copy_tenant_database_probe_results";

DROP TABLE "__authrim_pk_copy_tenant_placement_migration_jobs";

DROP TABLE "__authrim_pk_copy_tenant_provisioning_operation_steps";

DROP TABLE "__authrim_pk_copy_tenant_provisioning_operations";

DROP TABLE "__authrim_pk_guard";

PRAGMA defer_foreign_keys = OFF;
