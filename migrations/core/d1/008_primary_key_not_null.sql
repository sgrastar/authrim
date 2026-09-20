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

CREATE TABLE IF NOT EXISTS tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    );

-- Apply this entire migration and its history record as one atomic D1 batch.

-- NULL identities are not repaired, removed or assigned automatically.

CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:access_review_items', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='access_review_items' AND sql IN ('CREATE TABLE access_review_items (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,        -- User being reviewed
  permission_type TEXT NOT NULL, -- role, permission, group_membership
  permission_value TEXT NOT NULL, -- The specific permission/role/group
  decision TEXT,                -- approved, revoked, pending
  decided_by TEXT,              -- Reviewer who made decision
  decided_at TEXT,              -- When decision was made
  justification TEXT,           -- Reason for decision
  created_at TEXT NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:access_review_items', (SELECT count(*) FROM "access_review_items" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:access_reviews', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='access_reviews' AND sql IN ('CREATE TABLE access_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,           -- Review campaign name
  description TEXT,             -- Campaign description
  scope TEXT NOT NULL,          -- all_users, role, organization, application
  scope_value TEXT,             -- Value for scope (role_id, org_id, client_id)
  status TEXT NOT NULL DEFAULT ''pending'',  -- pending, in_progress, completed, cancelled
  reviewer_id TEXT,             -- User assigned to review
  total_items INTEGER NOT NULL DEFAULT 0,     -- Total items to review
  reviewed_items INTEGER NOT NULL DEFAULT 0,  -- Items reviewed
  approved_items INTEGER NOT NULL DEFAULT 0,  -- Items approved (access retained)
  revoked_items INTEGER NOT NULL DEFAULT 0,   -- Items revoked (access removed)
  created_at TEXT NOT NULL,
  started_at TEXT,              -- When review started
  completed_at TEXT,            -- When review completed
  due_date TEXT                 -- Review deadline
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:access_reviews', (SELECT count(*) FROM "access_reviews" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:account_creation_operations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_creation_operations' AND sql IN ('CREATE TABLE account_creation_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  allocation_idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''preparing''
    CHECK (status IN (
      ''preparing'', ''reserved'', ''writing'', ''directory_pending'',
      ''succeeded'', ''blocked'', ''canceled''
    )),
  publication_json TEXT
    CHECK (publication_json IS NULL OR
      (json_valid(publication_json) AND length(publication_json) <= 16384)),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, actor_id, idempotency_key),
  UNIQUE (tenant_id, account_id),
  CHECK ((status = ''succeeded'' AND completed_at IS NOT NULL) OR status <> ''succeeded'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:account_creation_operations', (SELECT count(*) FROM "account_creation_operations" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:account_lifecycle_event_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_lifecycle_event_outbox' AND sql IN ('CREATE TABLE "account_lifecycle_event_outbox" (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = ''account.created''),
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 4096),
  plugin_targets_json TEXT
    CHECK (plugin_targets_json IS NULL OR
      (json_valid(plugin_targets_json) AND length(plugin_targets_json) <= 4096)),
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''leased'', ''retry'', ''succeeded'', ''dead_letter'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, operation_id, event_type),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (
    (status = ''leased'' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> ''leased'' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = ''retry'' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL) OR
         status <> ''retry''),
  CHECK ((status = ''succeeded'' AND succeeded_at IS NOT NULL) OR status <> ''succeeded'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:account_lifecycle_event_outbox', (SELECT count(*) FROM "account_lifecycle_event_outbox" WHERE "event_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:account_routing_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_routing_outbox' AND sql IN ('CREATE TABLE account_routing_outbox (
  outbox_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN (''account_created'', ''identifier_added'', ''identifier_replaced'', ''identifier_removed'', ''account_disabled'', ''account_deleted'')),
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  route_schema_version INTEGER NOT NULL CHECK (route_schema_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  status TEXT NOT NULL DEFAULT ''prepared''
    CHECK (status IN (''prepared'', ''pending'', ''leased'', ''retry'', ''succeeded'', ''blocked'', ''dead_letter'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:account_routing_outbox', (SELECT count(*) FROM "account_routing_outbox" WHERE "outbox_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:account_support_contexts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_support_contexts' AND sql IN ('CREATE TABLE account_support_contexts (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT ''{"schema_version":1}''
    CHECK (json_valid(context_json) AND json_type(context_json) = ''object'' AND
           length(context_json) BETWEEN 20 AND 32768),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(account_id) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:account_webhook_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_webhook_outbox' AND sql IN ('CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN (''guest'', ''registered'')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:account_webhook_outbox', (SELECT count(*) FROM "account_webhook_outbox" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:admin_jobs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_jobs' AND sql IN ('CREATE TABLE admin_jobs (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL,

  -- Job type (e.g., ''users/import'', ''users/bulk-update'', ''reports/generate'')
  job_type TEXT NOT NULL,

  -- Job status (pending, processing, completed, failed, partial_failure)
  status TEXT NOT NULL DEFAULT ''pending'',

  -- Progress tracking (JSON)
  -- { "total": 100, "processed": 45, "succeeded": 43, "failed": 2 }
  progress TEXT,

  -- Job configuration (JSON)
  -- Input parameters for the job
  config TEXT,

  -- R2 key for input file (for import jobs)
  input_r2_key TEXT,

  -- R2 key for result file (for completed jobs with large results)
  result_r2_key TEXT,
  object_catalog_id TEXT,

  -- Result summary (JSON, for completed jobs)
  -- { "summary": {...}, "failures": [...] }
  result TEXT,

  -- Error information (for failed jobs)
  error_code TEXT,
  error_message TEXT,

  -- Actor who created the job
  created_by TEXT NOT NULL,

  -- Timestamps (Unix timestamp in seconds)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,

  -- Estimated completion time
  estimated_completion INTEGER,

  -- Generic job runner retry/dead-letter state
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  dead_lettered_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:admin_jobs', (SELECT count(*) FROM "admin_jobs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:assurance_evidence', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='assurance_evidence' AND sql IN ('CREATE TABLE assurance_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT,
  binding_id TEXT,
  evidence_type TEXT NOT NULL,
  issuer_ref TEXT,
  assurance_framework TEXT,
  assurance_level TEXT,
  evidence_hash TEXT,
  evidence_storage_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:assurance_evidence', (SELECT count(*) FROM "assurance_evidence" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:attribute_release_consents', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='attribute_release_consents' AND sql IN ('CREATE TABLE attribute_release_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  destination_type TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  attribute_set_hash TEXT NOT NULL,
  consent_mode TEXT NOT NULL,
  consent_state TEXT NOT NULL DEFAULT ''granted'',
  consent_record_id TEXT,
  first_granted_at INTEGER,
  last_confirmed_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:attribute_release_consents', (SELECT count(*) FROM "attribute_release_consents" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:attribute_verifications', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='attribute_verifications' AND sql IN ('CREATE TABLE attribute_verifications (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vp_request_id TEXT REFERENCES vp_requests(id),
    -- Issuer DID
    issuer_did TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: ''dc+sd-jwt'' | ''mso_mdoc''
    format TEXT NOT NULL,
    -- Verification result: ''verified'' | ''failed'' | ''expired''
    verification_result TEXT NOT NULL,
    -- Individual verification flags
    holder_binding_verified INTEGER DEFAULT 0,
    issuer_trusted INTEGER DEFAULT 0,
    status_valid INTEGER DEFAULT 0,
    -- JSON array of user_verified_attributes IDs
    mapped_attribute_ids TEXT,
    verified_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT
, credential_profile_id TEXT, credential_profile_version_id TEXT, mapping_version_id TEXT, mapping_snapshot_hash TEXT, policy_version TEXT, evidence_fingerprint TEXT, status_checked_at INTEGER, status_fresh_until INTEGER, revalidate_after INTEGER, invalidated_at INTEGER, invalidation_reason TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:attribute_verifications', (SELECT count(*) FROM "attribute_verifications" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:audit_log', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='audit_log' AND sql IN ('CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT ''default'', severity TEXT DEFAULT ''info'')'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:audit_log', (SELECT count(*) FROM "audit_log" WHERE "id" IS NULL));

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

INSERT INTO "__authrim_pk_guard" VALUES ('schema:branding_settings', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='branding_settings' AND sql IN ('CREATE TABLE branding_settings (
  id TEXT PRIMARY KEY DEFAULT ''default'',
  custom_css TEXT,
  custom_html_header TEXT,
  custom_html_footer TEXT,
  logo_url TEXT,
  background_image_url TEXT,
  primary_color TEXT DEFAULT ''#3B82F6'',
  secondary_color TEXT DEFAULT ''#10B981'',
  font_family TEXT DEFAULT ''Inter'',
  -- Authentication method settings
  enabled_auth_methods TEXT DEFAULT ''["passkey","magic_link"]'', -- JSON array
  password_policy_json TEXT, -- Password policy config (if password auth enabled)
  updated_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT ''default'')'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:branding_settings', (SELECT count(*) FROM "branding_settings" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:check_api_keys', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='check_api_keys' AND sql IN ('CREATE TABLE check_api_keys (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT ''default'',
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,                    -- SHA-256 hash of the API key
    key_prefix TEXT NOT NULL,                  -- First 8 chars (chk_xxxx) for identification
    allowed_operations TEXT DEFAULT ''["check"]'', -- JSON array: check, batch, subscribe
    rate_limit_tier TEXT DEFAULT ''moderate'',   -- strict, moderate, lenient
    is_active INTEGER DEFAULT 1,
    expires_at INTEGER,                        -- Unix timestamp, NULL = no expiry
    created_by TEXT,                           -- User ID who created this key
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:check_api_keys', (SELECT count(*) FROM "check_api_keys" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:ciba_requests', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ciba_requests' AND sql IN ('CREATE TABLE "ciba_requests" (
  auth_req_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  login_hint TEXT,
  login_hint_token TEXT,
  id_token_hint TEXT,
  binding_message TEXT,
  user_code TEXT,
  acr_values TEXT,
  requested_expiry INTEGER,
  status TEXT NOT NULL CHECK (status IN (''pending'', ''approved'', ''denied'', ''expired'')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN (''poll'', ''ping'', ''push'')),
  client_notification_token TEXT,
  client_notification_endpoint TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  interval INTEGER NOT NULL DEFAULT 5,
  user_id TEXT,
  sub TEXT,
  nonce TEXT,
  token_issued INTEGER DEFAULT 0,
  token_issued_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:ciba_requests', (SELECT count(*) FROM "ciba_requests" WHERE "auth_req_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:client_consent_overrides', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='client_consent_overrides' AND sql IN ('CREATE TABLE client_consent_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  client_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT ''inherit'', -- ''required''|''optional''|''hidden''|''inherit''
  min_version TEXT,                      -- null = use tenant default
  enforcement TEXT,                      -- null = use tenant default
  conditional_rules_json TEXT,           -- null = use tenant default
  display_order INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, statement_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:client_consent_overrides', (SELECT count(*) FROM "client_consent_overrides" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:client_trust_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='client_trust_policies' AND sql IN ('CREATE TABLE client_trust_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN (''oidc_client'', ''saml_sp'')),
  target_id TEXT NOT NULL,
  first_party INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 0,
  skip_authorization_consent INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, target_type, target_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:client_trust_policies', (SELECT count(*) FROM "client_trust_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:compliance_reports', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='compliance_reports' AND sql IN ('CREATE TABLE compliance_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  type TEXT NOT NULL,           -- audit_log, access_report, user_activity, etc.
  name TEXT NOT NULL,           -- Report name/title
  status TEXT NOT NULL DEFAULT ''pending'',  -- pending, generating, completed, failed
  requested_by TEXT,            -- User who requested the report
  parameters TEXT,              -- JSON: Report generation parameters
  result_url TEXT,              -- URL to download completed report
  error_message TEXT,           -- Error message if failed
  created_at TEXT NOT NULL,
  completed_at TEXT,            -- When report generation completed
  expires_at TEXT               -- When report download expires
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:compliance_reports', (SELECT count(*) FROM "compliance_reports" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_history' AND sql IN ('CREATE TABLE consent_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  action TEXT NOT NULL,  -- ''granted'' | ''updated'' | ''revoked'' | ''version_upgraded'' | ''expired'' | ''scopes_updated''
  scopes_before TEXT,    -- JSON array of previous scopes (null for initial grant)
  scopes_after TEXT,     -- JSON array of new scopes (null for revocation)
  privacy_policy_version TEXT,
  tos_version TEXT,
  ip_address_hash TEXT,  -- Hashed IP for privacy
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,    -- Additional context as JSON
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_history', (SELECT count(*) FROM "consent_history" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_item_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_item_history' AND sql IN ('CREATE TABLE "consent_item_history" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  version_id_before TEXT,
  version_id_after TEXT,
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_item_history', (SELECT count(*) FROM "consent_item_history" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_policies' AND sql IN ('CREATE TABLE consent_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_policies', (SELECT count(*) FROM "consent_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_policy_items', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_policy_items' AND sql IN ('CREATE TABLE consent_policy_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  policy_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT ''required'', -- ''required''|''optional''|''hidden''
  version_mode TEXT NOT NULL DEFAULT ''current'', -- ''current''|''fixed''|''minimum''
  version_id TEXT,
  min_version TEXT,
  checkbox_mode TEXT NOT NULL DEFAULT ''required'', -- ''none''|''required''|''optional''
  checkbox_default_checked INTEGER NOT NULL DEFAULT 0,
  binding_type TEXT, -- ''scope''|''claim''|''saml_attribute''|''destination_field_set''
  binding_value TEXT,
  evidence_profile TEXT,
  language_fallback TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, policy_id, statement_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_policy_items', (SELECT count(*) FROM "consent_policy_items" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_policy_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_policy_versions' AND sql IN ('CREATE TABLE consent_policy_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  version TEXT NOT NULL,
  policy_type TEXT NOT NULL,  -- ''privacy_policy'' | ''terms_of_service'' | ''cookie_policy''
  policy_uri TEXT,
  policy_hash TEXT,           -- SHA-256 hash of policy content for integrity verification
  effective_at INTEGER NOT NULL,  -- Unix timestamp when this version becomes effective
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_type, version)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_policy_versions', (SELECT count(*) FROM "consent_policy_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_records', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_records' AND sql IN ('CREATE TABLE consent_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  protocol TEXT NOT NULL CHECK (protocol IN (''oidc'', ''saml'', ''document'', ''custom'')),
  consent_kind TEXT NOT NULL CHECK (
    consent_kind IN (
      ''terms'',
      ''privacy'',
      ''attribute_release'',
      ''scope_claim_release'',
      ''form_confirmation'',
      ''custom''
    )
  ),
  client_id TEXT,
  saml_sp_id TEXT,
  recipient_type TEXT CHECK (
    recipient_type IN (''oidc_client'', ''saml_sp'', ''tenant'', ''external_party'')
  ),
  recipient_id TEXT,
  binding_type TEXT NOT NULL CHECK (
    binding_type IN (''subject'', ''identity_schema'', ''destination_field_mapping_set'', ''user_decision'')
  ),
  binding_key TEXT,
  resource_type TEXT CHECK (
    resource_type IN (''userinfo'', ''id_token'', ''saml_attributes'', ''document'', ''custom'')
  ),
  resource_id TEXT,
  purpose_key TEXT,
  statement_id TEXT NOT NULL,
  statement_version TEXT NOT NULL,
  policy_id TEXT,
  flow_id TEXT,
  flow_version_id TEXT,
  flow_node_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN (''accepted'', ''rejected'', ''once'', ''always'', ''selected'')),
  selected_value TEXT,
  selected_options_json TEXT,
  released_scopes_json TEXT,
  released_claims_json TEXT,
  released_attributes_json TEXT,
  status TEXT NOT NULL DEFAULT ''active'' CHECK (
    status IN (''active'', ''revoked'', ''expired'', ''superseded'')
  ),
  expires_at INTEGER,
  revoked_at INTEGER,
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_records', (SELECT count(*) FROM "consent_records" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_statement_localizations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_statement_localizations' AND sql IN ('CREATE TABLE consent_statement_localizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  version_id TEXT NOT NULL,
  language TEXT NOT NULL,                -- BCP 47: ''en'', ''ja'', ''de''
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  document_url TEXT,                     -- External document URL (content_type=''url'')
  inline_content TEXT,                   -- Inline text (content_type=''inline'')
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, processing_purpose TEXT, withdrawal_impact TEXT,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE CASCADE,
  UNIQUE (version_id, language)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_statement_localizations', (SELECT count(*) FROM "consent_statement_localizations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_statement_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_statement_versions' AND sql IN ('CREATE TABLE consent_statement_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  statement_id TEXT NOT NULL,
  version TEXT NOT NULL,                 -- YYYYMMDD fixed: ''20250206''
  content_type TEXT NOT NULL DEFAULT ''url'', -- ''url'' | ''inline''
  effective_at INTEGER NOT NULL,
  content_hash TEXT,                     -- SHA-256 integrity hash
  is_current INTEGER NOT NULL DEFAULT 0,
  current_statement_guard TEXT,
  status TEXT NOT NULL DEFAULT ''draft'',  -- ''draft''|''active''|''archived''
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, effective_until INTEGER,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id, version)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_statement_versions', (SELECT count(*) FROM "consent_statement_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:consent_statements', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='consent_statements' AND sql IN ('CREATE TABLE consent_statements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  slug TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT ''custom'',
  legal_basis TEXT NOT NULL DEFAULT ''consent'',
  processing_purpose TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, record_retention_days INTEGER, withdrawal_allowed INTEGER NOT NULL DEFAULT 1, withdrawal_impact TEXT, reconsent_on_version_change INTEGER NOT NULL DEFAULT 1, reconsent_interval_days INTEGER,
  UNIQUE (tenant_id, slug)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:consent_statements', (SELECT count(*) FROM "consent_statements" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:contact_point_search_indexes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='contact_point_search_indexes' AND sql IN ('CREATE TABLE contact_point_search_indexes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  contact_point_id TEXT NOT NULL,
  index_kind TEXT NOT NULL,
  index_value TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1,
  classification TEXT NOT NULL DEFAULT ''internal'',
  status TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, index_kind, index_value, index_version),
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:contact_point_search_indexes', (SELECT count(*) FROM "contact_point_search_indexes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:contact_points', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='contact_points' AND sql IN ('CREATE TABLE contact_points (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT,
  account_id TEXT,
  contact_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT ''primary'',
  normalized_hash TEXT,
  value_storage_ref TEXT,
  display_label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verification_state TEXT NOT NULL DEFAULT ''unverified'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:contact_points', (SELECT count(*) FROM "contact_points" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:contact_verifications', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='contact_verifications' AND sql IN ('CREATE TABLE contact_verifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  contact_point_id TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  evidence_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:contact_verifications', (SELECT count(*) FROM "contact_verifications" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:credential_configurations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='credential_configurations' AND sql IN ('CREATE TABLE credential_configurations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    -- Configuration ID (used in metadata)
    configuration_id TEXT NOT NULL,
    -- Format: ''dc+sd-jwt'' | ''mso_mdoc''
    format TEXT NOT NULL,
    -- Verifiable Credential Type
    vct TEXT NOT NULL,
    -- JSON of display information
    display TEXT,
    -- JSON of claims configuration
    claims TEXT,
    -- JSON of proof types supported
    proof_types_supported TEXT,
    -- Signing algorithm
    signing_alg TEXT DEFAULT ''ES256'',
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(tenant_id, configuration_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:credential_configurations', (SELECT count(*) FROM "credential_configurations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:credential_offers', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='credential_offers' AND sql IN ('CREATE TABLE credential_offers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Credential configuration ID
    credential_configuration_id TEXT NOT NULL,
    -- Pre-authorized code
    pre_authorized_code TEXT,
    -- Transaction code (PIN)
    tx_code TEXT,
    -- JSON of grants configuration
    grants TEXT NOT NULL,
    -- Status: ''pending'' | ''accepted'' | ''issued'' | ''failed'' | ''expired''
    status TEXT DEFAULT ''pending'',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    issued_at TEXT,
    issued_credential_id TEXT,
    issued_credential_internal_id TEXT,
    FOREIGN KEY (issued_credential_internal_id) REFERENCES issued_credentials(internal_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:credential_offers', (SELECT count(*) FROM "credential_offers" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:custom_claim_schema_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='custom_claim_schema_history' AND sql IN ('CREATE TABLE custom_claim_schema_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  schema_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN (''create'',''update'',''delete'',''rename'',''toggle_active'')),
  snapshot TEXT NOT NULL,
  changes TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT CHECK(actor_type IN (''user'',''admin'',''system'',''api'')),
  change_source TEXT CHECK(change_source IN (''admin_api'',''admin_ui'',''migration'',''rollback'')),
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, schema_id, version)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:custom_claim_schema_history', (SELECT count(*) FROM "custom_claim_schema_history" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:custom_claim_schemas', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='custom_claim_schemas' AND sql IN ('CREATE TABLE custom_claim_schemas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_key TEXT NOT NULL,
  active_field_key TEXT,
  display_label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT ''string'',
  is_pii INTEGER NOT NULL DEFAULT 0,
  is_required INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  validation_rules TEXT CHECK(validation_rules IS NULL OR json_valid(validation_rules)),
  include_in_id_token INTEGER NOT NULL DEFAULT 0,
  include_in_userinfo INTEGER NOT NULL DEFAULT 0,
  include_in_introspection INTEGER NOT NULL DEFAULT 0,
  required_scopes TEXT CHECK(required_scopes IS NULL OR json_valid(required_scopes)),
  scope_mode TEXT NOT NULL DEFAULT ''any'' CHECK(scope_mode IN (''all'', ''any'')),
  is_searchable INTEGER NOT NULL DEFAULT 1,
  is_exportable INTEGER NOT NULL DEFAULT 1,
  is_vc_claim INTEGER NOT NULL DEFAULT 0,
  claim_namespace TEXT,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  operation_status TEXT NOT NULL DEFAULT ''active'',
  operation_detail TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  show_on_registration    INTEGER NOT NULL DEFAULT 0,
  registration_required   INTEGER NOT NULL DEFAULT 0,
  registration_order      INTEGER NOT NULL DEFAULT 0,
  registration_placeholder TEXT
, ui_group_key TEXT, ui_group_label TEXT, ui_group_order INTEGER NOT NULL DEFAULT 0, ui_field_order INTEGER NOT NULL DEFAULT 0, examples_json TEXT CHECK(examples_json IS NULL OR json_valid(examples_json)), cardinality TEXT NOT NULL DEFAULT ''single''
  CHECK (cardinality IN (''single'', ''multi'')))'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:custom_claim_schemas', (SELECT count(*) FROM "custom_claim_schemas" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:data_export_requests', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='data_export_requests' AND sql IN ('CREATE TABLE data_export_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending'',  -- ''pending'' | ''processing'' | ''completed'' | ''failed'' | ''expired''
  format TEXT NOT NULL DEFAULT ''json'',     -- ''json'' | ''csv''
  include_sections TEXT NOT NULL,          -- JSON array: ["profile", "consents", "sessions", "audit_log", "passkeys"]
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER,                      -- Download link expiration
  file_path TEXT,                          -- R2 object path (for async exports)
  object_catalog_id TEXT,                  -- object_catalog pointer for materialized export artifacts
  file_size INTEGER,
  error_message TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:data_export_requests', (SELECT count(*) FROM "data_export_requests" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:delegations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='delegations' AND sql IN ('CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT NOT NULL,
  delegate_subject_id TEXT NOT NULL,
  parent_delegation_id TEXT,
  chain_id TEXT,
  delegation_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  scope_json TEXT,
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:delegations', (SELECT count(*) FROM "delegations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:device_codes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='device_codes' AND sql IN ('CREATE TABLE "device_codes" (
  device_code TEXT PRIMARY KEY,
  user_code TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''pending'', ''approved'', ''denied'', ''expired'')),
  user_id TEXT,
  sub TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  token_issued INTEGER DEFAULT 0,
  token_issued_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  FOREIGN KEY (tenant_id, client_id)
    REFERENCES oauth_clients(tenant_id, client_id)
    ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:device_codes', (SELECT count(*) FROM "device_codes" WHERE "device_code" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:device_installations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='device_installations' AND sql IN ('CREATE TABLE device_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  client_id TEXT,
  trust_group_id TEXT,
  source_installation_id TEXT,
  source_client_id TEXT,
  linked_device_secret_id TEXT,
  session_id TEXT,
  display_name TEXT,
  device_platform TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:device_installations', (SELECT count(*) FROM "device_installations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:device_secrets', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='device_secrets' AND sql IN ('CREATE TABLE device_secrets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  device_name TEXT,
  device_platform TEXT,
  installation_id TEXT,
  client_id TEXT,
  trust_group_id TEXT,
  source_installation_id TEXT,
  source_client_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:device_secrets', (SELECT count(*) FROM "device_secrets" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:did_document_cache', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='did_document_cache' AND sql IN ('CREATE TABLE did_document_cache (
    did TEXT PRIMARY KEY,
    -- JSON of DID Document
    document TEXT NOT NULL,
    resolved_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:did_document_cache', (SELECT count(*) FROM "did_document_cache" WHERE "did" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_config_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_config_history' AND sql IN ('CREATE TABLE directory_auth_config_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_redacted_json TEXT NOT NULL DEFAULT ''{}'',
  after_redacted_json TEXT NOT NULL DEFAULT ''{}'',
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_config_history', (SELECT count(*) FROM "directory_auth_config_history" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_evidence_exports', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_evidence_exports' AND sql IN ('CREATE TABLE directory_auth_evidence_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''running'', ''ready'', ''failed'', ''deleted'', ''expired'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_evidence_exports', (SELECT count(*) FROM "directory_auth_evidence_exports" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_migration_campaigns', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_migration_campaigns' AND sql IN ('CREATE TABLE directory_auth_migration_campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT ''disabled''
    CHECK (status IN (''disabled'', ''draft'', ''active'', ''paused'', ''archived'')),
  mode TEXT NOT NULL DEFAULT ''directory_login_allowed''
    CHECK (mode IN (
      ''directory_login_allowed'',
      ''prompt_passkey'',
      ''grace_then_require_passkey'',
      ''require_passkey_after_directory'',
      ''disabled''
    )),
  passkey_prompt_mode TEXT NOT NULL DEFAULT ''campaign_only''
    CHECK (passkey_prompt_mode IN (''none'', ''optional'', ''campaign_only'')),
  email_code_fallback_mode TEXT NOT NULL DEFAULT ''migration_recovery''
    CHECK (email_code_fallback_mode IN (
      ''tenant_default'',
      ''migration_recovery'',
      ''directory_unavailable_recovery'',
      ''admin_invitation_only'',
      ''login_method'',
      ''disabled''
    )),
  grace_period_days INTEGER NOT NULL DEFAULT 30,
  transaction_ttl_seconds INTEGER NOT NULL DEFAULT 600,
  enforcement_start_mode TEXT NOT NULL DEFAULT ''first_directory_login''
    CHECK (enforcement_start_mode IN (''first_directory_login'')),
  target_policy_json TEXT NOT NULL DEFAULT ''{}'',
  is_template INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_migration_campaigns', (SELECT count(*) FROM "directory_auth_migration_campaigns" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_migration_transaction_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_migration_transaction_events' AND sql IN ('CREATE TABLE directory_auth_migration_transaction_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  campaign_id TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  event_payload_json TEXT NOT NULL DEFAULT ''{}'',
  request_id TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_migration_transaction_events', (SELECT count(*) FROM "directory_auth_migration_transaction_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_migration_transactions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_migration_transactions' AND sql IN ('CREATE TABLE directory_auth_migration_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT,
  user_id TEXT,
  connector_id TEXT,
  directory_subject TEXT,
  token_hash TEXT NOT NULL,
  scope TEXT NOT NULL
    CHECK (scope IN (''passkey_enrollment'', ''email_code_fallback'', ''recovery'', ''status_display'')),
  state TEXT NOT NULL DEFAULT ''active''
    CHECK (state IN (''active'', ''completed'', ''expired'', ''blocked'')),
  request_id TEXT,
  authorization_challenge_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  blocked_reason TEXT,
  UNIQUE (tenant_id, token_hash)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_migration_transactions', (SELECT count(*) FROM "directory_auth_migration_transactions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_migration_user_states', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_migration_user_states' AND sql IN ('CREATE TABLE directory_auth_migration_user_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  user_id TEXT,
  connector_id TEXT,
  directory_subject TEXT,
  cohort_key TEXT,
  state TEXT NOT NULL DEFAULT ''eligible''
    CHECK (state IN (
      ''not_applicable'',
      ''eligible'',
      ''prompted'',
      ''deferred'',
      ''passkey_required'',
      ''enrolled'',
      ''blocked'',
      ''recovered''
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_migration_user_states', (SELECT count(*) FROM "directory_auth_migration_user_states" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_release_advisories', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_release_advisories' AND sql IN ('CREATE TABLE directory_auth_release_advisories (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT ''stable'',
  severity TEXT NOT NULL
    CHECK (severity IN (''low'', ''medium'', ''high'', ''critical'')),
  affected_versions_json TEXT NOT NULL DEFAULT ''[]'',
  fixed_version TEXT,
  summary TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  release_url TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_release_advisories', (SELECT count(*) FROM "directory_auth_release_advisories" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_retention_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_retention_policies' AND sql IN ('CREATE TABLE directory_auth_retention_policies (
  tenant_id TEXT PRIMARY KEY,
  authrim_audit_retention_days INTEGER NOT NULL DEFAULT 365,
  wordwarden_local_retention_days INTEGER,
  artifact_delete_grace_hours INTEGER NOT NULL DEFAULT 72,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_retention_policies', (SELECT count(*) FROM "directory_auth_retention_policies" WHERE "tenant_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_support_bundles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_support_bundles' AND sql IN ('CREATE TABLE directory_auth_support_bundles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  redaction_level TEXT NOT NULL DEFAULT ''standard''
    CHECK (redaction_level IN (''minimal'', ''standard'', ''detailed'')),
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''running'', ''ready'', ''failed'', ''deleted'', ''expired'')),
  scope_json TEXT NOT NULL DEFAULT ''{}'',
  consent_summary_json TEXT NOT NULL DEFAULT ''{}'',
  artifact_key TEXT,
  artifact_sha256 TEXT,
  object_catalog_id TEXT,
  retention_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_support_bundles', (SELECT count(*) FROM "directory_auth_support_bundles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_auth_tenant_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_auth_tenant_policies' AND sql IN ('CREATE TABLE directory_auth_tenant_policies (
  tenant_id TEXT PRIMARY KEY,
  email_code_fallback_mode TEXT NOT NULL DEFAULT ''migration_recovery''
    CHECK (email_code_fallback_mode IN (
      ''migration_recovery'',
      ''directory_unavailable_recovery'',
      ''admin_invitation_only'',
      ''login_method'',
      ''disabled''
    )),
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_auth_tenant_policies', (SELECT count(*) FROM "directory_auth_tenant_policies" WHERE "tenant_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_connector_instances', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_connector_instances' AND sql IN ('CREATE TABLE directory_connector_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT,
  transport TEXT NOT NULL,
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (''connected'', ''disconnected'', ''stale'', ''version_mismatch'', ''unhealthy'', ''deactivated'')),
  health_status TEXT NOT NULL,
  health_summary_json TEXT NOT NULL DEFAULT ''{}'',
  config_fingerprint TEXT NOT NULL,
  config_categories_json TEXT NOT NULL DEFAULT ''[]'',
  drift_severity TEXT NOT NULL DEFAULT ''none''
    CHECK (drift_severity IN (''none'', ''warning'', ''critical'')),
  deactivated_at INTEGER,
  deactivated_by TEXT,
  deactivation_reason TEXT,
  updated_at INTEGER NOT NULL, release_channel TEXT NOT NULL DEFAULT ''stable'',
  UNIQUE (tenant_id, connector_id, instance_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_connector_instances', (SELECT count(*) FROM "directory_connector_instances" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_connector_status_episodes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_connector_status_episodes' AND sql IN ('CREATE TABLE directory_connector_status_episodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (''connected'', ''disconnected'', ''stale'', ''version_mismatch'', ''unhealthy'', ''deactivated'')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  reason TEXT,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_connector_status_episodes', (SELECT count(*) FROM "directory_connector_status_episodes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_identity_links', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_identity_links' AND sql IN ('CREATE TABLE directory_identity_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  latest_facts_json TEXT NOT NULL DEFAULT ''{}'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (tenant_id, connector_id, directory_subject)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_identity_links', (SELECT count(*) FROM "directory_identity_links" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:directory_jit_pending_users', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='directory_jit_pending_users' AND sql IN ('CREATE TABLE directory_jit_pending_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  login_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''approved'', ''rejected'', ''linked'')),
  directory_facts_json TEXT NOT NULL DEFAULT ''{}'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decision_reason TEXT,
  linked_user_id TEXT,
  UNIQUE (tenant_id, connector_id, directory_subject)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:directory_jit_pending_users', (SELECT count(*) FROM "directory_jit_pending_users" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:entitlements', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='entitlements' AND sql IN ('CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT,
  account_id TEXT,
  entitlement_type TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  source_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  value_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, entitlement_type, entitlement_key, subject_id, account_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:entitlements', (SELECT count(*) FROM "entitlements" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:event_log', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='event_log' AND sql IN ('CREATE TABLE event_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  event_type TEXT NOT NULL,
  event_category TEXT NOT NULL,
  result TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT ''info'',
  error_code TEXT,
  error_message TEXT,
  anonymized_user_id TEXT,
  client_id TEXT,
  session_id TEXT,
  request_id TEXT,
  duration_ms INTEGER,
  details_r2_key TEXT,
  details_json TEXT,
  retention_until INTEGER,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:event_log', (SELECT count(*) FROM "event_log" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:external_idp_auth_states', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='external_idp_auth_states' AND sql IN ('CREATE TABLE external_idp_auth_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  client_id TEXT,                        -- Client ID from the original auth request
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  state TEXT UNIQUE NOT NULL,            -- OAuth state parameter
  nonce TEXT,                            -- OIDC nonce for ID token validation
  code_verifier TEXT,                    -- PKCE code verifier for Authrim ↔ External IdP
  code_challenge TEXT,                   -- PKCE code challenge from client ↔ Authrim
  flow_id TEXT,                          -- Flow ID for diagnostic logging correlation
  redirect_uri TEXT NOT NULL,            -- Where to redirect after auth

  -- For linking flow
  user_id TEXT,                          -- Set if linking to existing account
  session_id TEXT,                       -- Authrim session (for linking flow)

  -- For OIDC proxy flow (future)
  original_auth_request TEXT,            -- JSON of original OIDC auth request

  -- OIDC Core 1.0 parameters (for validation in callback)
  max_age INTEGER,                       -- max_age parameter for auth_time validation
  acr_values TEXT,                       -- acr_values parameter for acr validation

  -- Silent Auth & SSO control (Phase 1 & 2)
  prompt TEXT,                           -- OIDC prompt parameter (none, login, consent, select_account)
  enable_sso INTEGER NOT NULL DEFAULT 1, -- 1 = SSO enabled (handoff), 0 = SSO disabled (Direct Auth)

  -- Timestamps
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,                   -- When state was consumed (for single-use)

  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:external_idp_auth_states', (SELECT count(*) FROM "external_idp_auth_states" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:external_lifecycle_signal_decisions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='external_lifecycle_signal_decisions' AND sql IN ('CREATE TABLE external_lifecycle_signal_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  signal_event_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  decision TEXT NOT NULL,
  propagation_targets_json TEXT,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (signal_event_id) REFERENCES external_lifecycle_signal_events(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:external_lifecycle_signal_decisions', (SELECT count(*) FROM "external_lifecycle_signal_decisions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:external_lifecycle_signal_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='external_lifecycle_signal_events' AND sql IN ('CREATE TABLE external_lifecycle_signal_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_timestamp INTEGER,
  observed_at INTEGER NOT NULL,
  binding_version TEXT,
  payload_ref TEXT,
  signal_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT ''pending'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, source_type, source_id, dedupe_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:external_lifecycle_signal_events', (SELECT count(*) FROM "external_lifecycle_signal_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:field_usage_bindings', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='field_usage_bindings' AND sql IN ('CREATE TABLE field_usage_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  field_key TEXT NOT NULL,
  binding_type TEXT NOT NULL CHECK (
    binding_type IN (
      ''authentication_method'',
      ''notification'',
      ''discovery'',
      ''consent'',
      ''policy'',
      ''protocol_output'',
      ''display'',
      ''ui'',
      ''custom''
    )
  ),
  binding_id TEXT NOT NULL,
  protection TEXT NOT NULL DEFAULT ''warn'' CHECK (
    protection IN (''none'', ''warn'', ''delete_blocked'')
  ),
  reason TEXT,
  source TEXT NOT NULL DEFAULT ''admin'' CHECK (
    source IN (''system'', ''admin'', ''derived'', ''migration'')
  ),
  metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, field_key, binding_type, binding_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:field_usage_bindings', (SELECT count(*) FROM "field_usage_bindings" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:flow_assignments', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='flow_assignments' AND sql IN ('CREATE TABLE "flow_assignments" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  target_type TEXT NOT NULL CHECK (
    target_type IN (''tenant'', ''oidc_client'', ''saml_sp'', ''credential_profile'')
  ),
  target_id TEXT,
  flow_kind TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (target_type = ''tenant'' AND target_id IS NULL)
    OR (target_type IN (''oidc_client'', ''saml_sp'', ''credential_profile'') AND target_id IS NOT NULL)
  ),
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:flow_assignments', (SELECT count(*) FROM "flow_assignments" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:flow_audit_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='flow_audit_events' AND sql IN ('CREATE TABLE flow_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  interaction_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  node_id TEXT,
  branch_handle_id TEXT,
  event_type TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  contract_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:flow_audit_events', (SELECT count(*) FROM "flow_audit_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:flow_interaction_steps', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='flow_interaction_steps' AND sql IN ('CREATE TABLE flow_interaction_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  interaction_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (''pending'', ''waiting_input'', ''processing'', ''completed'', ''skipped'', ''failed'')
  ),
  selected_handle TEXT,
  state_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (interaction_id) REFERENCES flow_interactions(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:flow_interaction_steps', (SELECT count(*) FROM "flow_interaction_steps" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:flow_interactions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='flow_interactions' AND sql IN ('CREATE TABLE flow_interactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  state TEXT NOT NULL CHECK (state IN (''created'', ''active'', ''completed'', ''expired'', ''failed'')),
  current_node_id TEXT,
  current_step_id TEXT,
  contract_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER, context_json TEXT,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  FOREIGN KEY (flow_version_id) REFERENCES flow_versions(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:flow_interactions', (SELECT count(*) FROM "flow_interactions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:flow_versions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='flow_versions' AND sql IN ('CREATE TABLE flow_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  flow_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  runtime_snapshot_json TEXT NOT NULL,
  editor_snapshot_json TEXT,
  validation_result_json TEXT NOT NULL,
  published_by TEXT,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, flow_id, version_number)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:flow_versions', (SELECT count(*) FROM "flow_versions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:group_memberships', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='group_memberships' AND sql IN ('CREATE TABLE group_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  group_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  membership_type TEXT NOT NULL DEFAULT ''member'',
  assignment_source TEXT NOT NULL DEFAULT ''manual'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_id, subject_id, account_id, membership_type),
  FOREIGN KEY (group_id) REFERENCES "groups"(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:group_memberships', (SELECT count(*) FROM "group_memberships" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:groups', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='groups' AND sql IN ('CREATE TABLE "groups" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  parent_group_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:groups', (SELECT count(*) FROM "groups" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:guest_account_upgrades', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='guest_account_upgrades' AND sql IN ('CREATE TABLE guest_account_upgrades (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  guest_user_id TEXT NOT NULL,
  upgraded_user_id TEXT NOT NULL,
  upgrade_method TEXT NOT NULL,
  provider_id TEXT,
  preserve_sub INTEGER NOT NULL DEFAULT 1 CHECK (preserve_sub = 1),
  upgraded_at BIGINT NOT NULL,
  data_migrated INTEGER NOT NULL DEFAULT 0 CHECK (data_migrated IN (0, 1))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:guest_account_upgrades', (SELECT count(*) FROM "guest_account_upgrades" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:guest_deletion_audit_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='guest_deletion_audit_outbox' AND sql IN ('CREATE TABLE guest_deletion_audit_outbox (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 4096),
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''retry'', ''succeeded'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  UNIQUE (tenant_id, operation_id),
  CHECK ((status = ''succeeded'' AND succeeded_at IS NOT NULL) OR
         (status <> ''succeeded'' AND succeeded_at IS NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:guest_deletion_audit_outbox', (SELECT count(*) FROM "guest_deletion_audit_outbox" WHERE "audit_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:guest_devices', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='guest_devices' AND sql IN ('CREATE TABLE guest_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  resume_credential_hash TEXT NOT NULL CHECK (length(resume_credential_hash) = 64),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:guest_devices', (SELECT count(*) FROM "guest_devices" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:idempotency_keys', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='idempotency_keys' AND sql IN ('CREATE TABLE idempotency_keys (
    id TEXT PRIMARY KEY,          -- Composite: tenant_id:actor_id:method:path:resource_id:key
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,       -- admin_id who made the request
    method TEXT NOT NULL,         -- HTTP method (POST, PUT, DELETE)
    path TEXT NOT NULL,           -- API path pattern
    resource_id TEXT,             -- Target resource ID (if applicable)
    idempotency_key TEXT NOT NULL,-- The Idempotency-Key header value
    body_hash TEXT NOT NULL,      -- SHA-256 hash of request body
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,  -- Sanitized response (PII removed)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:idempotency_keys', (SELECT count(*) FROM "idempotency_keys" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_accounts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_accounts' AND sql IN ('CREATE TABLE identity_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  account_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  legacy_user_id TEXT,
  primary_subject_id TEXT,
  display_label TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER, directory_publication_state TEXT NOT NULL DEFAULT ''pending''
  CHECK (directory_publication_state IN (''pending'', ''active_pending_directory'', ''active'', ''disabled'')), account_route_generation INTEGER NOT NULL DEFAULT 1
  CHECK (account_route_generation >= 1), registration_state TEXT NOT NULL DEFAULT ''registered''
  CHECK (registration_state IN (''guest'', ''registered'')),
  FOREIGN KEY (primary_subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_accounts', (SELECT count(*) FROM "identity_accounts" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_binding_lookup_indexes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_binding_lookup_indexes' AND sql IN ('CREATE TABLE identity_binding_lookup_indexes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  identity_binding_id TEXT NOT NULL,
  lookup_kind TEXT NOT NULL,
  lookup_value TEXT NOT NULL,
  lookup_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lookup_kind, lookup_value, lookup_version),
  FOREIGN KEY (identity_binding_id) REFERENCES identity_bindings(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_binding_lookup_indexes', (SELECT count(*) FROM "identity_binding_lookup_indexes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_bindings', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_bindings' AND sql IN ('CREATE TABLE identity_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  protocol TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider_subject_key_hash TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT ''external_subject'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  assurance_level TEXT,
  trust_context_snapshot_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  last_seen_at INTEGER,
  UNIQUE (tenant_id, protocol, source_id, provider_subject_key_hash),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_bindings', (SELECT count(*) FROM "identity_bindings" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_providers', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_providers' AND sql IN ('CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT ''default'')'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_providers', (SELECT count(*) FROM "identity_providers" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_resolution_candidates', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_resolution_candidates' AND sql IN ('CREATE TABLE identity_resolution_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  source_id TEXT NOT NULL,
  candidate_subject_id TEXT,
  candidate_account_id TEXT,
  candidate_binding_id TEXT,
  candidate_score INTEGER NOT NULL DEFAULT 0,
  risk_tier TEXT,
  decision_state TEXT NOT NULL DEFAULT ''pending'',
  reason_codes_json TEXT,
  review_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_resolution_candidates', (SELECT count(*) FROM "identity_resolution_candidates" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_resolution_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_resolution_events' AND sql IN ('CREATE TABLE identity_resolution_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT,
  account_id TEXT,
  binding_id TEXT,
  source_id TEXT NOT NULL,
  resolution_method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (binding_id) REFERENCES identity_bindings(id) ON DELETE SET NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_resolution_events', (SELECT count(*) FROM "identity_resolution_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_subjects', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_subjects' AND sql IN ('CREATE TABLE identity_subjects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  display_label TEXT,
  primary_account_id TEXT,
  risk_tier TEXT,
  assurance_level TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_subjects', (SELECT count(*) FROM "identity_subjects" WHERE "id" IS NULL));

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

INSERT INTO "__authrim_pk_guard" VALUES ('schema:issued_credentials', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='issued_credentials' AND sql IN ('CREATE TABLE issued_credentials (
    internal_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: ''dc+sd-jwt'' | ''mso_mdoc''
    format TEXT NOT NULL,
    -- JSON of claims included in credential
    claims TEXT NOT NULL,
    -- Status: ''active'' | ''suspended'' | ''revoked''
    status TEXT DEFAULT ''active'',
    -- Status list for revocation/suspension
    status_list_id TEXT,
    status_list_internal_id TEXT,
    status_list_index INTEGER,
    holder_binding TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT,
    UNIQUE (tenant_id, public_id),
    FOREIGN KEY (status_list_internal_id) REFERENCES status_lists(internal_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:issued_credentials', (SELECT count(*) FROM "issued_credentials" WHERE "internal_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:legal_hold_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='legal_hold_events' AND sql IN ('CREATE TABLE legal_hold_events (
  event_id TEXT PRIMARY KEY,
  hold_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (''created'', ''extended'', ''released'', ''expired'')),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  effective_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(event_id) BETWEEN 1 AND 256),
  CHECK (length(actor_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (created_at >= effective_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:legal_hold_events', (SELECT count(*) FROM "legal_hold_events" WHERE "event_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:legal_hold_projection_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='legal_hold_projection_outbox' AND sql IN ('CREATE TABLE legal_hold_projection_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_state TEXT NOT NULL CHECK (projection_state IN (''active'', ''inactive'')),
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''processing'', ''succeeded'', ''blocked'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = ''succeeded'' AND completed_at IS NOT NULL) OR status <> ''succeeded''),
  CHECK (updated_at >= created_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:legal_hold_projection_outbox', (SELECT count(*) FROM "legal_hold_projection_outbox" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:legal_holds', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='legal_holds' AND sql IN ('CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT ''account'' CHECK (subject_type = ''account''),
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT ''active''
    CHECK (state IN (''active'', ''released'', ''expired'')),
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_by TEXT,
  released_at INTEGER,
  release_reason TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(subject_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (released_by IS NULL OR length(released_by) BETWEEN 1 AND 256),
  CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 256),
  CHECK (expires_at IS NULL OR expires_at >= created_at),
  CHECK (
    (state = ''active'' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (state IN (''released'', ''expired'') AND released_by IS NOT NULL AND released_at IS NOT NULL AND
      release_reason IS NOT NULL)
  ),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (updated_at >= created_at)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:legal_holds', (SELECT count(*) FROM "legal_holds" WHERE "id" IS NULL));

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
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL DEFAULT ''day'' CHECK (window_kind IN (''hour'', ''day'')),
  soft_limit INTEGER,
  hard_limit INTEGER,
  warning_ratio REAL NOT NULL DEFAULT 0.8,
  enforcement_mode TEXT NOT NULL DEFAULT ''warn_only''
    CHECK (enforcement_mode IN (''disabled'', ''observe'', ''warn_only'', ''soft_limit'', ''hard_non_critical'')),
  critical_behavior TEXT NOT NULL DEFAULT ''never_block'' CHECK (critical_behavior IN (''never_block'')),
  status TEXT NOT NULL DEFAULT ''active'' CHECK (status IN (''active'', ''disabled'', ''deleted'')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:logging_quota_policies', (SELECT count(*) FROM "logging_quota_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:logging_usage_aggregates', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='logging_usage_aggregates' AND sql IN ('CREATE TABLE logging_usage_aggregates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN (''critical'', ''default'', ''bulk'')),
  metric_name TEXT NOT NULL,
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

INSERT INTO "__authrim_pk_guard" VALUES ('schema:lookup_retention_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lookup_retention_policies' AND sql IN ('CREATE TABLE lookup_retention_policies (
  tenant_id TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 3650),
  policy_generation INTEGER NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:lookup_retention_policies', (SELECT count(*) FROM "lookup_retention_policies" WHERE "tenant_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:lookup_retention_policy_projection_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lookup_retention_policy_projection_outbox' AND sql IN ('CREATE TABLE lookup_retention_policy_projection_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''processing'', ''succeeded'', ''blocked'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = ''succeeded'' AND completed_at IS NOT NULL) OR status <> ''succeeded''),
  CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, policy_generation)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:lookup_retention_policy_projection_outbox', (SELECT count(*) FROM "lookup_retention_policy_projection_outbox" WHERE "operation_id" IS NULL));

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

INSERT INTO "__authrim_pk_guard" VALUES ('schema:notification_delivery_intents', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='notification_delivery_intents' AND sql IN ('CREATE TABLE notification_delivery_intents (
  intent_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  provider_order_version INTEGER NOT NULL CHECK (provider_order_version >= 1),
  provider_installation_ids_json TEXT NOT NULL
    CHECK (json_valid(provider_installation_ids_json)
      AND json_type(provider_installation_ids_json) = ''array''
      AND json_array_length(provider_installation_ids_json) BETWEEN 1 AND 8),
  active_provider_index INTEGER NOT NULL DEFAULT 0 CHECK (active_provider_index BETWEEN 0 AND 7),
  provider_started_at INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN (''email'', ''sms'', ''push'')),
  notification_kind TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  payload_key_id TEXT,
  payload_envelope_json TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB ''*[^0-9a-f]*'' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB ''*[^a-zA-Z0-9._:-]*''
      AND length(fingerprint_key_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL DEFAULT ''pending''
    CHECK (state IN (''pending'', ''delivered'', ''canceled'', ''expired'', ''dead_letter'')),
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  canceled_at INTEGER,
  dead_lettered_at INTEGER,
  delete_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, account_id TEXT, recipient_masked TEXT, recipient_encrypted TEXT, recipient_encryption_key_version INTEGER, provider_message_id TEXT, provider_accepted_at INTEGER, delivery_status TEXT NOT NULL DEFAULT ''requested''
  CHECK (delivery_status IN (
    ''requested'', ''provider_accepted'', ''delivered'', ''deferred'', ''bounced'', ''failed'',
    ''rejected'', ''complained'', ''unknown''
  )), delivery_status_updated_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0), last_error_code TEXT,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (length(intent_id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (active_provider_index < json_array_length(provider_installation_ids_json)),
  CHECK (json_extract(provider_installation_ids_json, ''$[0]'') = plugin_installation_id),
  CHECK (notification_kind NOT GLOB ''*[^a-z0-9._:-]*''
    AND length(notification_kind) BETWEEN 1 AND 128),
  CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CHECK (expires_at > created_at),
  CHECK (provider_started_at >= created_at),
  CHECK (delete_after >= expires_at),
  CHECK (
    (state = ''pending''
      AND payload_key_id IS NOT NULL
      AND payload_key_id NOT GLOB ''*[^a-zA-Z0-9._:-]*''
      AND length(payload_key_id) BETWEEN 1 AND 128
      AND payload_envelope_json IS NOT NULL
      AND json_valid(payload_envelope_json)
      AND length(payload_envelope_json) BETWEEN 1 AND 196608
      AND delivered_at IS NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = ''delivered''
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND delivered_at IS NOT NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state IN (''canceled'', ''expired'')
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND canceled_at IS NOT NULL
      AND delivered_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = ''dead_letter''
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND dead_lettered_at IS NOT NULL
      AND delivered_at IS NULL
      AND canceled_at IS NULL)
  )
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:notification_delivery_intents', (SELECT count(*) FROM "notification_delivery_intents" WHERE "intent_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:oauth_client_consents', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='oauth_client_consents' AND sql IN ('CREATE TABLE "oauth_client_consents" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  selected_scopes TEXT,
  privacy_policy_version TEXT,
  tos_version TEXT,
  consent_version INTEGER DEFAULT 1,
  UNIQUE (tenant_id, user_id, client_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:oauth_client_consents', (SELECT count(*) FROM "oauth_client_consents" WHERE "id" IS NULL));

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

INSERT INTO "__authrim_pk_guard" VALUES ('schema:oidc_scopes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='oidc_scopes' AND sql IN ('CREATE TABLE oidc_scopes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  scope_type TEXT NOT NULL DEFAULT ''custom'' CHECK (scope_type IN (''system'', ''custom'')),
  enabled INTEGER NOT NULL DEFAULT 1,
  localizations_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:oidc_scopes', (SELECT count(*) FROM "oidc_scopes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:operational_logs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='operational_logs' AND sql IN ('CREATE TABLE operational_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,  -- Code expects: ''user'', ''client'', ''session''
    subject_id TEXT NOT NULL,    -- Code expects this name, not ''resource_id''
    actor_id TEXT NOT NULL,      -- Who performed the operation
    action TEXT NOT NULL,        -- ''user.suspend'', ''user.lock'', etc.
    reason_detail_encrypted TEXT,-- AES-GCM encrypted reason_detail
    encryption_key_version INTEGER NOT NULL DEFAULT 1, -- Code expects this column
    detail_object_catalog_id TEXT,
    request_id TEXT,             -- X-Request-ID header value
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, -- When this log should be deleted

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:operational_logs', (SELECT count(*) FROM "operational_logs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:org_domain_mappings', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='org_domain_mappings' AND sql IN ('CREATE TABLE org_domain_mappings (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Domain identification (hashed for privacy)
  -- Algorithm: HMAC-SHA256(lowercase(domain), secret_key)
  domain_hash TEXT NOT NULL,

  -- Key rotation support
  domain_hash_version INTEGER DEFAULT 1,

  -- Target organization
  org_id TEXT NOT NULL,                   -- Reference to organizations.id

  -- Auto-join settings
  auto_join_enabled INTEGER DEFAULT 1,    -- 0 = mapping exists but auto-join disabled
  membership_type TEXT NOT NULL DEFAULT ''member'',  -- member, admin, owner
  auto_assign_role_id TEXT,               -- Optional: auto-assign this role on join

  -- Verification status
  verified INTEGER DEFAULT 0,             -- 1 = domain ownership verified (DNS TXT, etc.)

  -- Priority for multiple mappings
  priority INTEGER DEFAULT 0,             -- Higher = preferred when multiple match

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, verification_token TEXT, verification_status TEXT DEFAULT ''unverified'', verification_expires_at INTEGER, verification_method TEXT,

  -- Constraints
  -- Allow same domain to map to multiple orgs with different versions
  UNIQUE(tenant_id, domain_hash, domain_hash_version, org_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:org_domain_mappings', (SELECT count(*) FROM "org_domain_mappings" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:organizations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='organizations' AND sql IN ('CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  org_type TEXT NOT NULL DEFAULT ''enterprise'',  -- distributor, enterprise, department
  parent_org_id TEXT REFERENCES organizations(id),
  plan TEXT DEFAULT ''free'',  -- free, starter, professional, enterprise
  is_active INTEGER DEFAULT 1,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:organizations', (SELECT count(*) FROM "organizations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:passkeys', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='passkeys' AND sql IN ('CREATE TABLE "passkeys" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT ''default'', aaguid TEXT, rp_id TEXT,
  UNIQUE(tenant_id, credential_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:passkeys', (SELECT count(*) FROM "passkeys" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:password_reset_tokens', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='password_reset_tokens' AND sql IN ('CREATE TABLE "password_reset_tokens" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:password_reset_tokens', (SELECT count(*) FROM "password_reset_tokens" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:permission_change_audit', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='permission_change_audit' AND sql IN ('CREATE TABLE permission_change_audit (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT ''default'',
    event_type TEXT NOT NULL,                  -- ''grant'', ''revoke'', ''modify''
    subject_id TEXT NOT NULL,
    resource TEXT,                             -- Resource affected (optional)
    relation TEXT,                             -- Relation affected (optional)
    permission TEXT,                           -- Permission affected (optional)
    timestamp INTEGER NOT NULL,                -- Event timestamp (Unix milliseconds)
    created_at INTEGER NOT NULL                -- Record creation time (Unix seconds)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:permission_change_audit', (SELECT count(*) FROM "permission_change_audit" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:permission_check_audit', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='permission_check_audit' AND sql IN ('CREATE TABLE permission_check_audit (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT ''default'',
    subject_id TEXT NOT NULL,
    permission TEXT NOT NULL,                  -- Original permission string
    permission_json TEXT,                      -- Structured permission (if provided)
    allowed INTEGER NOT NULL,                  -- 1 = allowed, 0 = denied
    resolved_via_json TEXT NOT NULL,           -- JSON array: ["role", "rebac"]
    final_decision TEXT NOT NULL,              -- ''allow'' | ''deny''
    reason TEXT,                               -- Denial reason (when denied)
    api_key_id TEXT,                           -- Which API key was used (if any)
    client_id TEXT,                            -- Client ID (from API key or token)
    checked_at INTEGER NOT NULL                -- Unix timestamp
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:permission_check_audit', (SELECT count(*) FROM "permission_check_audit" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_account_metadata', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_account_metadata' AND sql IN ('CREATE TABLE plugin_account_metadata (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  value_json TEXT NOT NULL
    CHECK (json_valid(value_json) AND length(value_json) BETWEEN 1 AND 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id, plugin_id, metadata_key),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (metadata_key NOT GLOB ''*[^a-z0-9._-]*'' AND length(metadata_key) BETWEEN 1 AND 64)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_hook_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_hook_outbox' AND sql IN ('CREATE TABLE plugin_hook_outbox (
  outbox_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  payload_class TEXT NOT NULL DEFAULT ''reference_v1'' CHECK (payload_class = ''reference_v1''),
  status TEXT NOT NULL DEFAULT ''queued''
    CHECK (status IN (''queued'', ''locked'', ''waiting_retry'', ''succeeded'', ''dead_letter'', ''canceled'')),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  claim_owner TEXT,
  claim_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  dead_lettered_at INTEGER,
  canceled_at INTEGER,
  delete_after INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_installation_id, idempotency_key),
  CHECK (
    (status = ''locked'' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL
      AND lease_until IS NOT NULL AND lease_until > updated_at AND attempt_no >= 1) OR
    (status <> ''locked'' AND claim_owner IS NULL AND claim_token IS NULL AND lease_until IS NULL)
  ),
  CHECK ((status = ''waiting_retry'' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL)
    OR status <> ''waiting_retry''),
  CHECK ((status = ''queued'' AND attempt_no = 0 AND next_attempt_at IS NULL) OR status <> ''queued''),
  CHECK ((status IN (''succeeded'', ''dead_letter'') AND attempt_no >= 1)
    OR status NOT IN (''succeeded'', ''dead_letter'')),
  CHECK ((status = ''succeeded'' AND succeeded_at IS NOT NULL AND delete_after = succeeded_at + 604800) OR status <> ''succeeded''),
  CHECK ((status = ''dead_letter'' AND dead_lettered_at IS NOT NULL AND delete_after = dead_lettered_at + 7776000) OR status <> ''dead_letter''),
  CHECK ((status = ''canceled'' AND canceled_at IS NOT NULL) OR status <> ''canceled'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_hook_outbox', (SELECT count(*) FROM "plugin_hook_outbox" WHERE "outbox_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:presentation_definitions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='presentation_definitions' AND sql IN ('CREATE TABLE presentation_definitions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    purpose TEXT,
    -- JSON: {"dc+sd-jwt": {...}, "mso_mdoc": {...}}
    format TEXT NOT NULL,
    -- JSON array of input descriptors
    input_descriptors TEXT NOT NULL,
    -- JSON for complex submission requirements
    submission_requirements TEXT,
    -- DCQL query (preferred for HAIP)
    dcql_query TEXT,
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:presentation_definitions', (SELECT count(*) FROM "presentation_definitions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:profile_attribute_values', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='profile_attribute_values' AND sql IN ('CREATE TABLE profile_attribute_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  profile_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT,
  value_storage_ref TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT ''internal'',
  purpose TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:profile_attribute_values', (SELECT count(*) FROM "profile_attribute_values" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:profiles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='profiles' AND sql IN ('CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT NOT NULL,
  profile_type TEXT NOT NULL DEFAULT ''person'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  locale TEXT,
  zoneinfo TEXT,
  display_name_ref TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, subject_id, profile_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:profiles', (SELECT count(*) FROM "profiles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:provisioning_assignment_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='provisioning_assignment_events' AND sql IN ('CREATE TABLE provisioning_assignment_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  rule_id TEXT,
  subject_id TEXT,
  account_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:provisioning_assignment_events', (SELECT count(*) FROM "provisioning_assignment_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:provisioning_assignment_ownership', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='provisioning_assignment_ownership' AND sql IN ('CREATE TABLE provisioning_assignment_ownership (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  assignment_type TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  source_id TEXT,
  ownership_policy TEXT NOT NULL DEFAULT ''source_owned'',
  revoke_policy TEXT NOT NULL DEFAULT ''review'',
  protected_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, assignment_type, assignment_id, source_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:provisioning_assignment_ownership', (SELECT count(*) FROM "provisioning_assignment_ownership" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:provisioning_assignment_rules', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='provisioning_assignment_rules' AND sql IN ('CREATE TABLE provisioning_assignment_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  rule_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT ''draft'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:provisioning_assignment_rules', (SELECT count(*) FROM "provisioning_assignment_rules" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:provisioning_revocation_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='provisioning_revocation_events' AND sql IN ('CREATE TABLE provisioning_revocation_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT,
  account_id TEXT,
  source_event_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:provisioning_revocation_events', (SELECT count(*) FROM "provisioning_revocation_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:refresh_token_shard_configs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='refresh_token_shard_configs' AND sql IN ('CREATE TABLE refresh_token_shard_configs (
  id TEXT PRIMARY KEY,                -- UUID
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  client_id TEXT,                     -- NULL = global config
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,      -- When this config was activated (ms)
  deprecated_at INTEGER,              -- When this config was deprecated (ms)
  created_by TEXT,                    -- Admin user who created this config
  notes TEXT,                         -- Human-readable notes

  UNIQUE(tenant_id, client_id, generation)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:refresh_token_shard_configs', (SELECT count(*) FROM "refresh_token_shard_configs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:relation_definitions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='relation_definitions' AND sql IN ('CREATE TABLE relation_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Object type this definition applies to
  object_type TEXT NOT NULL,        -- ''document'', ''folder'', ''org'', etc.
  -- Relation name being defined
  relation_name TEXT NOT NULL,      -- ''viewer'', ''editor'', ''owner'', etc.
  -- Relation composition rule (JSON)
  definition_json TEXT NOT NULL,
  -- Description for documentation
  description TEXT,
  -- Evaluation priority (higher = evaluated first)
  priority INTEGER DEFAULT 0,
  -- Whether this definition is active
  is_active INTEGER DEFAULT 1,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:relation_definitions', (SELECT count(*) FROM "relation_definitions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:relationship_closure', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='relationship_closure' AND sql IN ('CREATE TABLE relationship_closure (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Ancestor (source) entity
  ancestor_type TEXT NOT NULL,      -- ''subject'', ''org'', ''group''
  ancestor_id TEXT NOT NULL,
  -- Descendant (target) entity
  descendant_type TEXT NOT NULL,    -- ''document'', ''folder'', ''org'', ''resource''
  descendant_id TEXT NOT NULL,
  -- Computed relation (derived from relationship chain)
  relation TEXT NOT NULL,           -- ''viewer'', ''editor'', ''owner''
  -- Path information
  depth INTEGER NOT NULL,           -- Number of hops (0 = direct)
  path_json TEXT,                   -- JSON array of relationship IDs in the path
  -- Computed metadata
  effective_permission TEXT,        -- Most restrictive permission in path
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:relationship_closure', (SELECT count(*) FROM "relationship_closure" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:relationships', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='relationships' AND sql IN ('CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  relationship_type TEXT NOT NULL,  -- parent_child, guardian, delegate, manager, reseller_of
  from_type TEXT NOT NULL DEFAULT ''subject'',  -- subject, org (future)
  from_id TEXT NOT NULL,  -- subject_id or org_id
  to_type TEXT NOT NULL DEFAULT ''subject'',  -- subject, org (future)
  to_id TEXT NOT NULL,  -- subject_id or org_id
  permission_level TEXT NOT NULL DEFAULT ''full'',  -- full, limited, read_only
  expires_at INTEGER,  -- Optional expiration (UNIX seconds)
  is_bidirectional INTEGER DEFAULT 0,  -- Phase 1: always 0
  metadata_json TEXT,  -- Additional constraints, notes, etc.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, evidence_type TEXT DEFAULT ''manual'', evidence_ref TEXT)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:relationships', (SELECT count(*) FROM "relationships" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:resource_permissions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='resource_permissions' AND sql IN ('CREATE TABLE resource_permissions (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Subject (who has the permission)
  subject_type TEXT NOT NULL DEFAULT ''user'',  -- ''user'' | ''role'' | ''org''
  subject_id TEXT NOT NULL,                   -- user_id, role_id, or org_id

  -- Resource (what is being accessed)
  resource_type TEXT NOT NULL,                -- e.g., ''documents'', ''projects''
  resource_id TEXT NOT NULL,                  -- e.g., ''doc_123'', ''proj_456''

  -- Actions allowed (JSON array)
  -- Example: ["read", "write", "delete"]
  actions_json TEXT NOT NULL,

  -- Optional condition for permission (JSON)
  -- Example: {"time_restricted": true, "hours": [9, 17]}
  condition_json TEXT,

  -- Expiration (UNIX seconds)
  -- NULL = no expiration
  -- Evaluated at token generation time only
  expires_at INTEGER,

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Audit fields
  granted_by TEXT,                            -- Admin or system that granted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  -- Same subject can have only one permission entry per resource
  UNIQUE(tenant_id, subject_type, subject_id, resource_type, resource_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:resource_permissions', (SELECT count(*) FROM "resource_permissions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:role_assignment_rules', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='role_assignment_rules' AND sql IN ('CREATE TABLE role_assignment_rules (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target role (reference only, no FK for flexibility)
  role_id TEXT NOT NULL,

  -- Scope for assigned role
  scope_type TEXT NOT NULL DEFAULT ''global'',  -- global, org, resource
  scope_target TEXT NOT NULL DEFAULT '''',      -- e.g., ''org:org_123'' or '''' for global

  -- Conditions (JSON format)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "email_domain_hash", "operator": "eq", "value": "abc123..."},
  --   {"field": "idp_claim", "claim_path": "groups", "operator": "contains", "value": "admin"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "assign_role", "role_id": "role_org_admin", "scope_type": "org", "scope_target": "auto"},
  --   {"type": "join_org", "org_id": "auto"}
  -- ]
  actions_json TEXT NOT NULL,

  -- Priority and control
  priority INTEGER NOT NULL DEFAULT 0,    -- Higher = evaluated first (DESC order)
  stop_processing INTEGER DEFAULT 0,      -- 1 = stop evaluating further rules after match
  is_active INTEGER DEFAULT 1,            -- 0 = disabled

  -- Validity period (optional, UNIX seconds)
  valid_from INTEGER,                     -- NULL = no start restriction
  valid_until INTEGER,                    -- NULL = no end restriction

  -- Audit fields
  created_by TEXT,                        -- Admin user ID who created
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:role_assignment_rules', (SELECT count(*) FROM "role_assignment_rules" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:role_assignments', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='role_assignments' AND sql IN ('CREATE TABLE "role_assignments" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT ''global'',
  scope_target TEXT NOT NULL DEFAULT '''',
  expires_at INTEGER,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:role_assignments', (SELECT count(*) FROM "role_assignments" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:roles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='roles' AND sql IN ('CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  role_type TEXT NOT NULL DEFAULT ''custom'',
  hierarchy_level INTEGER DEFAULT 0,
  is_assignable INTEGER DEFAULT 1,
  parent_role_id TEXT REFERENCES roles(id),
  display_name TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER, external_id TEXT,
  UNIQUE(tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:roles', (SELECT count(*) FROM "roles" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:saml_attribute_presets', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='saml_attribute_presets' AND sql IN ('CREATE TABLE saml_attribute_presets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  applies_to TEXT NOT NULL DEFAULT ''sp_attribute_release'',
  profile TEXT NOT NULL DEFAULT ''custom'',
  stability TEXT NOT NULL DEFAULT ''custom'',
  application_mode TEXT NOT NULL DEFAULT ''clone_edit'',
  attribute_release_policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, label)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:saml_attribute_presets', (SELECT count(*) FROM "saml_attribute_presets" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:screens', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='screens' AND sql IN ('CREATE TABLE "screens" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  screen_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  screen_kind TEXT NOT NULL CHECK (
    screen_kind IN (
      ''registration'',
      ''profile_completion'',
      ''login'',
      ''consent'',
      ''code_input'',
      ''account'',
      ''custom''
    )
  ),
  fields_json TEXT NOT NULL,
  localizations_json TEXT,
  settings_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, screen_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:screens', (SELECT count(*) FROM "screens" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:security_alerts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='security_alerts' AND sql IN ('CREATE TABLE security_alerts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        ''brute_force'',
        ''credential_stuffing'',
        ''suspicious_login'',
        ''impossible_travel'',
        ''account_takeover'',
        ''mfa_bypass_attempt'',
        ''token_abuse'',
        ''rate_limit_exceeded'',
        ''config_change'',
        ''privilege_escalation'',
        ''data_exfiltration'',
        ''other''
    )),
    severity TEXT NOT NULL CHECK (severity IN (''critical'', ''high'', ''medium'', ''low'', ''info'')),
    status TEXT NOT NULL DEFAULT ''open'' CHECK (status IN (''open'', ''acknowledged'', ''resolved'', ''dismissed'')),
    title TEXT NOT NULL,
    description TEXT,
    source_ip TEXT,
    user_id TEXT,
    client_id TEXT,
    metadata TEXT, -- JSON string for additional context
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    acknowledged_by TEXT,
    resolved_at INTEGER,
    resolved_by TEXT,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:security_alerts', (SELECT count(*) FROM "security_alerts" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:security_threats', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='security_threats' AND sql IN ('CREATE TABLE security_threats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  type TEXT NOT NULL,           -- credential_compromise, attack_pattern, vulnerability, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  status TEXT NOT NULL DEFAULT ''active'',  -- active, investigating, mitigated, resolved
  title TEXT NOT NULL,          -- Short title
  description TEXT,             -- Detailed description
  source TEXT,                  -- Detection source (system, external, manual)
  affected_resources TEXT,      -- JSON: List of affected resources
  indicators TEXT,              -- JSON: Indicators of compromise (IOCs)
  metadata TEXT,                -- JSON: Additional context
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,    -- When threat was detected
  mitigated_at TEXT             -- When threat was mitigated
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:security_threats', (SELECT count(*) FROM "security_threats" WHERE "id" IS NULL));

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
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:sensitive_detail_chunk_index', (SELECT count(*) FROM "sensitive_detail_chunk_index" WHERE "catalog_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:service_group_audit', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='service_group_audit' AND sql IN ('CREATE TABLE service_group_audit (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 rule_version INTEGER NOT NULL, generation INTEGER NOT NULL,
 event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:service_group_audit', (SELECT count(*) FROM "service_group_audit" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:service_group_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='service_group_catalog' AND sql IN ('CREATE TABLE service_group_catalog (
 tenant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, plan_json TEXT NOT NULL,
 updated_at INTEGER NOT NULL, write_token TEXT NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:service_group_catalog', (SELECT count(*) FROM "service_group_catalog" WHERE "tenant_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:service_group_epoch', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='service_group_epoch' AND sql IN ('CREATE TABLE service_group_epoch (
 tenant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:service_group_epoch', (SELECT count(*) FROM "service_group_epoch" WHERE "tenant_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:service_group_write_boundaries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='service_group_write_boundaries' AND sql IN ('CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:service_group_write_boundaries', (SELECT count(*) FROM "service_group_write_boundaries" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:sessions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sessions' AND sql IN ('CREATE TABLE "sessions" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  external_provider_id TEXT,
  external_provider_sub TEXT,
  tenant_id TEXT NOT NULL DEFAULT ''default'', external_provider_sid TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:sessions', (SELECT count(*) FROM "sessions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:settings_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='settings_history' AND sql IN ('CREATE TABLE settings_history (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Category (oauth, rate_limit, logout, webhook, feature_flags, etc.)
  category TEXT NOT NULL,

  -- Version number (auto-incremented per tenant+category)
  version INTEGER NOT NULL,

  -- Full configuration snapshot (JSON)
  -- This allows complete restoration without dependencies
  snapshot TEXT NOT NULL,

  -- Change summary (JSON)
  -- { "added": [...], "removed": [...], "modified": [...] }
  changes TEXT NOT NULL,

  -- Actor who made the change
  actor_id TEXT,           -- User ID or ''system''
  actor_type TEXT,         -- ''user'', ''admin'', ''system'', ''api''

  -- Change metadata
  change_reason TEXT,      -- Optional reason for the change
  change_source TEXT,      -- ''admin_api'', ''settings_ui'', ''migration'', ''rollback''

  -- Timestamps
  created_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, category, version)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:settings_history', (SELECT count(*) FROM "settings_history" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:sign_in_confirmation_policies', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sign_in_confirmation_policies' AND sql IN ('CREATE TABLE sign_in_confirmation_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL DEFAULT ''login'', -- ''login'' for initial implementation
  mode TEXT NOT NULL DEFAULT ''disabled'', -- ''disabled''|''first_time''|''every_time''
  remember_duration_days INTEGER NOT NULL DEFAULT 365,
  show_application_context INTEGER NOT NULL DEFAULT 1,
  show_tenant_context INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, trigger_type)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:sign_in_confirmation_policies', (SELECT count(*) FROM "sign_in_confirmation_policies" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:status_lists', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='status_lists' AND sql IN ('CREATE TABLE status_lists (
    internal_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    -- Purpose: ''revocation'' | ''suspension''
    purpose TEXT NOT NULL DEFAULT ''revocation'',
    -- Bitstring of status values (base64url encoded)
    encoded_list TEXT NOT NULL,
    -- Current index for new credentials
    current_index INTEGER DEFAULT 0,
    -- Total capacity
    capacity INTEGER DEFAULT 131072,
    used_count INTEGER DEFAULT 0,
    state TEXT DEFAULT ''active'',
    sealed_at TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE (tenant_id, public_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:status_lists', (SELECT count(*) FROM "status_lists" WHERE "internal_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:structured_attribute_values', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='structured_attribute_values' AND sql IN ('CREATE TABLE structured_attribute_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  projected_index_json TEXT,
  classification TEXT NOT NULL DEFAULT ''internal'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:structured_attribute_values', (SELECT count(*) FROM "structured_attribute_values" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:subject_account_links', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='subject_account_links' AND sql IN ('CREATE TABLE subject_account_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT ''primary'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, subject_id, account_id, link_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:subject_account_links', (SELECT count(*) FROM "subject_account_links" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:subject_lifecycle_timeline_events', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='subject_lifecycle_timeline_events' AND sql IN ('CREATE TABLE subject_lifecycle_timeline_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT,
  account_id TEXT,
  event_type TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  summary_json TEXT,
  event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:subject_lifecycle_timeline_events', (SELECT count(*) FROM "subject_lifecycle_timeline_events" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:subject_org_membership', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='subject_org_membership' AND sql IN ('CREATE TABLE "subject_org_membership" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  subject_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  membership_type TEXT NOT NULL DEFAULT ''member'',
  is_primary INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:subject_org_membership', (SELECT count(*) FROM "subject_org_membership" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:support_operation_actions', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='support_operation_actions' AND sql IN ('CREATE TABLE support_operation_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  cohort_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (''approval_required'', ''approved'', ''running'', ''completed'', ''failed'', ''cancelled'')
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:support_operation_actions', (SELECT count(*) FROM "support_operation_actions" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:support_operation_cohort_targets', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='support_operation_cohort_targets' AND sql IN ('CREATE TABLE support_operation_cohort_targets (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  resource TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_hash TEXT,
  block_reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE CASCADE,
  UNIQUE(cohort_id, target_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:support_operation_cohort_targets', (SELECT count(*) FROM "support_operation_cohort_targets" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:support_operation_cohorts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='support_operation_cohorts' AND sql IN ('CREATE TABLE support_operation_cohorts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  resource TEXT NOT NULL,
  intended_action TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  selector_hash TEXT NOT NULL,
  matched_count INTEGER NOT NULL,
  actionable_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  blocked_summary_json TEXT,
  snapshot_status TEXT NOT NULL DEFAULT ''completed'' CHECK (
    snapshot_status IN (''pending'', ''running'', ''completed'', ''failed'', ''cancelled'')
  ),
  snapshot_job_id TEXT,
  snapshot_error TEXT,
  risk_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  support_case_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:support_operation_cohorts', (SELECT count(*) FROM "support_operation_cohorts" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:suspicious_activities', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='suspicious_activities' AND sql IN ('CREATE TABLE suspicious_activities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  type TEXT NOT NULL,           -- brute_force, credential_stuffing, anomalous_login, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  user_id TEXT,                 -- Associated user (nullable for pre-auth events)
  client_id TEXT,               -- Associated OAuth client
  source_ip TEXT,               -- Source IP address
  user_agent TEXT,              -- User agent string
  description TEXT,             -- Human-readable description
  metadata TEXT,                -- JSON: Additional context data
  created_at TEXT NOT NULL,     -- When detected
  resolved_at TEXT              -- When resolved/dismissed
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:suspicious_activities', (SELECT count(*) FROM "suspicious_activities" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_consent_requirements', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_consent_requirements' AND sql IN ('CREATE TABLE tenant_consent_requirements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  statement_id TEXT NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 0,
  min_version TEXT,
  enforcement TEXT NOT NULL DEFAULT ''block'',
  show_deletion_link INTEGER NOT NULL DEFAULT 0,
  deletion_url TEXT,
  conditional_rules_json TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_consent_requirements', (SELECT count(*) FROM "tenant_consent_requirements" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_database_migration_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_database_migration_state' AND sql IN ('CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )','CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_database_migration_state', (SELECT count(*) FROM "tenant_database_migration_state" WHERE "stream_id" IS NULL));

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

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_domain_mappings', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_domain_mappings' AND sql IN ('CREATE TABLE tenant_domain_mappings (
  id                      TEXT PRIMARY KEY,
  domain_hash             TEXT NOT NULL,
  hash_version            INTEGER NOT NULL DEFAULT 1,
  tenant_id               TEXT NOT NULL,
  priority                INTEGER NOT NULL DEFAULT 0,
  is_active               INTEGER NOT NULL DEFAULT 1,
  active_domain_hash      TEXT,
  verified                INTEGER NOT NULL DEFAULT 0,
  verification_token      TEXT,
  verification_expires_at INTEGER,
  created_by              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_domain_mappings', (SELECT count(*) FROM "tenant_domain_mappings" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_invitations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_invitations' AND sql IN ('CREATE TABLE tenant_invitations (
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_invitations', (SELECT count(*) FROM "tenant_invitations" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_placement_migration_captures', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_placement_migration_captures' AND sql IN ('CREATE TABLE tenant_placement_migration_captures (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  capture_state TEXT NOT NULL DEFAULT ''capturing''
    CHECK (capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'', ''canceled'')),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  installed_at INTEGER NOT NULL,
  write_fenced_at INTEGER,
  cutover_committed_at INTEGER,
  canceled_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((capture_state = ''write_fenced'' AND write_fenced_at IS NOT NULL)
    OR capture_state <> ''write_fenced''),
  CHECK ((capture_state = ''cutover_committed'' AND cutover_committed_at IS NOT NULL)
    OR capture_state <> ''cutover_committed''),
  CHECK ((capture_state = ''canceled'' AND canceled_at IS NOT NULL)
    OR capture_state <> ''canceled'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_placement_migration_captures', (SELECT count(*) FROM "tenant_placement_migration_captures" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_placement_migration_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_placement_migration_outbox' AND sql IN ('CREATE TABLE tenant_placement_migration_outbox (
  source_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (
    length(table_name) BETWEEN 1 AND 128 AND table_name NOT GLOB ''*[^a-z0-9_]*''
  ),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN (''upsert'', ''delete'')),
  mutation_key_json TEXT NOT NULL CHECK (json_valid(mutation_key_json)),
  row_json TEXT CHECK (row_json IS NULL OR json_valid(row_json)),
  capture_fencing_token INTEGER NOT NULL CHECK (capture_fencing_token >= 1),
  delivery_state TEXT NOT NULL DEFAULT ''pending''
    CHECK (delivery_state IN (''pending'', ''applied'')),
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES tenant_placement_migration_captures(operation_id),
  CHECK ((mutation_kind = ''upsert'' AND row_json IS NOT NULL) OR
         (mutation_kind = ''delete'' AND row_json IS NULL)),
  CHECK ((delivery_state = ''applied'' AND applied_at IS NOT NULL) OR
         (delivery_state = ''pending'' AND applied_at IS NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_vanity_domains', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_vanity_domains' AND sql IN ('CREATE TABLE tenant_vanity_domains (
  id                             TEXT PRIMARY KEY,
  tenant_id                      TEXT NOT NULL,
  hostname                       TEXT NOT NULL,
  is_active                      INTEGER NOT NULL DEFAULT 1,
  active_hostname                TEXT,
  is_primary                     INTEGER NOT NULL DEFAULT 0,
  primary_active_tenant_key      TEXT,
  status                         TEXT NOT NULL DEFAULT ''pending'',
  cloudflare_zone_id             TEXT,
  cloudflare_custom_hostname_id  TEXT,
  ssl_status                     TEXT,
  ownership_status               TEXT,
  validation_method              TEXT,
  validation_records_json        TEXT,
  last_sync_at                   INTEGER,
  created_by                     TEXT,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_vanity_domains', (SELECT count(*) FROM "tenant_vanity_domains" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenants', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenants' AND sql IN ('CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,           -- slug format: ^[a-z0-9-]+$, max 63chars
  tenant_code TEXT NOT NULL UNIQUE,       -- manual-entry/discovery code (globally unique)
  tenant_key  TEXT NOT NULL UNIQUE,       -- opaque key for logging/storage object paths
  name        TEXT NOT NULL,              -- display name
  description TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0, -- default tenant (only one)
  default_tenant_guard TEXT,              -- ''default'' when is_default=1, NULL otherwise
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
, lifecycle_state TEXT NOT NULL DEFAULT ''active''
  CHECK (lifecycle_state IN (
    ''provisioning'',
    ''active'',
    ''suspended'',
    ''frozen'',
    ''migration_read_only'',
    ''deleting'',
    ''deleted'',
    ''restore_pending'',
    ''restore_validating''
  )), isolation_policy TEXT NOT NULL DEFAULT ''tenant_exclusive''
  CHECK (isolation_policy IN (''shared_pool'', ''tenant_exclusive'')))'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenants', (SELECT count(*) FROM "tenants" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:token_claim_rules', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='token_claim_rules' AND sql IN ('CREATE TABLE token_claim_rules (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target token type
  token_type TEXT NOT NULL DEFAULT ''access'',  -- ''access'' | ''id'' | ''both''

  -- Conditions (JSON format, same structure as role_assignment_rules)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "has_role", "operator": "contains", "value": "premium_user"},
  --   {"field": "org_type", "operator": "eq", "value": "enterprise"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "add_claim", "claim_name": "tier", "claim_value": "premium"},
  --   {"type": "add_claim_template", "claim_name": "greeting", "template": "Hello {{user_type}}"},
  --   {"type": "copy_from_context", "claim_name": "org", "context_field": "org_id"}
  -- ]
  actions_json TEXT NOT NULL,

  -- Priority and control
  priority INTEGER NOT NULL DEFAULT 0,    -- Higher = evaluated first (DESC order)
  stop_processing INTEGER DEFAULT 0,      -- 1 = stop evaluating further rules after match
  is_active INTEGER DEFAULT 1,            -- 0 = disabled

  -- Validity period (optional, UNIX seconds)
  valid_from INTEGER,                     -- NULL = no start restriction
  valid_until INTEGER,                    -- NULL = no end restriction

  -- Audit fields
  created_by TEXT,                        -- Admin user ID who created
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:token_claim_rules', (SELECT count(*) FROM "token_claim_rules" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:totp_backup_codes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='totp_backup_codes' AND sql IN ('CREATE TABLE totp_backup_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  credential_id TEXT,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  UNIQUE (tenant_id, user_id, code_hash)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:totp_backup_codes', (SELECT count(*) FROM "totp_backup_codes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:totp_credentials', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='totp_credentials' AND sql IN ('CREATE TABLE totp_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  algorithm TEXT NOT NULL DEFAULT ''SHA1'',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  window INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT ''pending'',
  last_used_time_step INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_used_at INTEGER,
  CHECK (algorithm IN (''SHA1'', ''SHA256'')),
  CHECK (digits IN (6, 8)),
  CHECK (period BETWEEN 15 AND 300),
  CHECK (window BETWEEN 0 AND 2),
  CHECK (status IN (''pending'', ''active'', ''disabled''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:totp_credentials', (SELECT count(*) FROM "totp_credentials" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:trusted_issuers', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='trusted_issuers' AND sql IN ('CREATE TABLE trusted_issuers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    issuer_did TEXT NOT NULL,
    display_name TEXT,
    -- JSON array of accepted Verifiable Credential Types
    credential_types TEXT,
    -- Trust level: ''standard'' | ''high'' (HAIP-compliant)
    trust_level TEXT DEFAULT ''standard'',
    -- JWKS URI for issuer public keys
    jwks_uri TEXT,
    -- Issuer status: ''active'' | ''suspended'' | ''revoked''
    status TEXT DEFAULT ''active'',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(tenant_id, issuer_did)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:trusted_issuers', (SELECT count(*) FROM "trusted_issuers" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:upstream_providers', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='upstream_providers' AND sql IN ('CREATE TABLE upstream_providers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  name TEXT NOT NULL,                    -- Display name: "Google", "GitHub"
  provider_type TEXT NOT NULL,           -- ''oidc'' | ''oauth2''
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,            -- Display order (lower = higher priority)

  -- OIDC/OAuth2 endpoints
  issuer TEXT,                           -- OIDC issuer URL (for discovery)
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL, -- Encrypted with RP_TOKEN_ENCRYPTION_KEY
  authorization_endpoint TEXT,           -- Override for non-standard providers
  token_endpoint TEXT,
  userinfo_endpoint TEXT,
  jwks_uri TEXT,
  scopes TEXT NOT NULL DEFAULT ''openid email profile'', -- Space-separated

  -- Configuration
  attribute_mapping TEXT DEFAULT ''{}'',   -- JSON: {"sub": "sub", "email": "email"}
  auto_link_email INTEGER DEFAULT 1,     -- Enable email-based identity stitching
  jit_provisioning INTEGER DEFAULT 1,    -- Create user on first login
  require_email_verified INTEGER DEFAULT 1, -- Only link if email is verified

  -- Provider-specific settings
  provider_quirks TEXT DEFAULT ''{}'',     -- JSON for provider-specific handling

  -- UI customization
  icon_url TEXT,                         -- Provider icon for login button
  icon_name TEXT,                        -- Built-in icon name for login button
  button_color TEXT,                     -- Brand color for login button (hex, light theme)
  button_color_dark TEXT,                -- Brand color for login button (hex, dark theme)
  button_text TEXT,                      -- Custom button text (optional)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, slug TEXT, token_endpoint_auth_method TEXT DEFAULT ''client_secret_post'', always_fetch_userinfo INTEGER DEFAULT 0, enable_sso INTEGER NOT NULL DEFAULT 1, use_request_object INTEGER DEFAULT 0, request_object_signing_alg TEXT, private_key_jwk_encrypted TEXT, public_key_jwk TEXT)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:upstream_providers', (SELECT count(*) FROM "upstream_providers" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:user_consent_records', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user_consent_records' AND sql IN ('CREATE TABLE "user_consent_records" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''granted'',
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  client_id TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  receipt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id),
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id),
  UNIQUE (tenant_id, user_id, statement_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:user_consent_records', (SELECT count(*) FROM "user_consent_records" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:user_roles', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user_roles' AND sql IN ('CREATE TABLE "user_roles" (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:user_token_families', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user_token_families' AND sql IN ('CREATE TABLE "user_token_families" (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  is_revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:user_token_families', (SELECT count(*) FROM "user_token_families" WHERE "jti" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:user_verified_attributes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user_verified_attributes' AND sql IN ('CREATE TABLE user_verified_attributes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Attribute name: ''age_over_18'', ''country'', ''organization'', etc.
    attribute_name TEXT NOT NULL,
    -- Attribute value: ''true'', ''JP'', ''Acme Corp'', etc.
    attribute_value TEXT NOT NULL,
    -- Source type: ''vc'' | ''saml'' | ''oidc'' | ''manual''
    source_type TEXT NOT NULL DEFAULT ''vc'',
    -- Issuer DID (for VC-sourced attributes)
    issuer_did TEXT,
    -- Reference to verification record
    verification_id TEXT REFERENCES attribute_verifications(id),
    verified_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT, revalidate_after INTEGER, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    -- Each user can have only one value per attribute
    UNIQUE(tenant_id, user_id, attribute_name)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:user_verified_attributes', (SELECT count(*) FROM "user_verified_attributes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:users', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users' AND sql IN ('CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,
  profile TEXT,
  picture TEXT,
  website TEXT,
  gender TEXT,
  birthdate TEXT,
  zoneinfo TEXT,
  locale TEXT,
  phone_number TEXT,
  phone_number_verified INTEGER DEFAULT 0,
  address_json TEXT,
  custom_attributes_json TEXT,
  parent_user_id TEXT REFERENCES users(id),
  identity_provider_id TEXT REFERENCES identity_providers(id),
  -- Password authentication fields (optional, disabled by default)
  password_hash TEXT,
  password_changed_at INTEGER,
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until INTEGER,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
, tenant_id TEXT NOT NULL DEFAULT ''default'', user_type TEXT NOT NULL DEFAULT ''end_user'', status TEXT DEFAULT ''active'' CHECK (status IN (''active'', ''suspended'', ''locked'')), suspended_at INTEGER, suspended_until INTEGER, locked_at INTEGER)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:users', (SELECT count(*) FROM "users" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:users_core', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users_core' AND sql IN ('CREATE TABLE users_core (
  -- Primary key (UUID, same as users_pii.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- Verification status (not PII - just flags)
  email_verified INTEGER DEFAULT 0,
  phone_number_verified INTEGER DEFAULT 0,

  -- Blind index for domain-based role assignment (Phase 8)
  -- Stored as hash, cannot be reversed to original domain
  email_domain_hash TEXT,

  -- Authentication
  password_hash TEXT,

  -- Soft delete (1 = active, 0 = deleted)
  is_active INTEGER DEFAULT 1,

  -- User type: end_user | admin | m2m
  -- m2m is reserved for non-human service principals represented as user rows.
  -- Many OAuth client_credentials actors are modeled as OAuth clients instead.
  user_type TEXT NOT NULL DEFAULT ''end_user'',

  -- PII partition info
  -- Which database contains this user''s PII (e.g., ''default'', ''eu'', ''tenant-acme'')
  pii_partition TEXT NOT NULL DEFAULT ''default'',

  -- PII write status
  -- none: No PII (M2M clients)
  -- pending: Core created, PII write in progress
  -- active: Both Core and PII created successfully
  -- failed: PII write failed (requires retry via Admin UI)
  -- deleted: PII deleted (GDPR), tombstone created
  pii_status TEXT NOT NULL DEFAULT ''pending'',

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
, email_domain_hash_version INTEGER DEFAULT 1, external_id TEXT DEFAULT NULL,
  -- Operational access control only. Keep separate from future lifecycle_state.
  status TEXT DEFAULT ''active'' CHECK (status IN (''active'', ''suspended'', ''locked'')),
  -- Account lifecycle stage. Keep separate from status and user_type.
  -- Values: invited, pending_verification, provisioning, incomplete,
  -- active, dormant, archived, deprovisioned.
  lifecycle_state TEXT DEFAULT ''active'' CHECK (
    lifecycle_state IN (
      ''invited'',
      ''pending_verification'',
      ''provisioning'',
      ''incomplete'',
      ''active'',
      ''dormant'',
      ''archived'',
      ''deprovisioned''
    )
  ),
  suspended_at INTEGER,
  suspended_until INTEGER,
  locked_at INTEGER,
  locked_until INTEGER
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:users_core', (SELECT count(*) FROM "users_core" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:value_provenance', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='value_provenance' AND sql IN ('CREATE TABLE value_provenance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  owner_table TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_record_id TEXT,
  source_field_ref TEXT,
  source_authority_contract_id TEXT,
  observed_at INTEGER NOT NULL,
  confidence_score INTEGER,
  provenance_json TEXT,
  created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:value_provenance', (SELECT count(*) FROM "value_provenance" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:vp_requests', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='vp_requests' AND sql IN ('CREATE TABLE vp_requests (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    -- Nonce for replay protection (single-use, enforced by DO)
    nonce TEXT NOT NULL,
    state TEXT,
    -- Reference to presentation definition (optional, can use inline)
    presentation_definition_id TEXT REFERENCES presentation_definitions(id),
    response_uri TEXT NOT NULL,
    -- Response mode: ''direct_post'' | ''direct_post.jwt'' | ''fragment'' | ''query''
    response_mode TEXT DEFAULT ''direct_post'',
    -- Request status: ''pending'' | ''submitted'' | ''verified'' | ''failed'' | ''expired''
    status TEXT DEFAULT ''pending'',
    -- Error information if failed
    error_code TEXT,
    error_description TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    verified_at TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:vp_requests', (SELECT count(*) FROM "vp_requests" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:web_origin_registry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='web_origin_registry' AND sql IN ('CREATE TABLE web_origin_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  client_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  cors_allowed INTEGER NOT NULL DEFAULT 1,
  csp_frame_ancestors TEXT,
  handoff_allowed INTEGER NOT NULL DEFAULT 1,
  iframe_allowed INTEGER NOT NULL DEFAULT 0,
  environment TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, origin)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:web_origin_registry', (SELECT count(*) FROM "web_origin_registry" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:webhook_configs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='webhook_configs' AND sql IN ('CREATE TABLE webhook_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  client_id TEXT,
  scope TEXT NOT NULL DEFAULT ''tenant'',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_encrypted TEXT,
  headers TEXT,
  retry_policy TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT
, payload_fields TEXT NOT NULL DEFAULT ''[]'', registration_states TEXT NOT NULL DEFAULT ''[]'')'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:webhook_configs', (SELECT count(*) FROM "webhook_configs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:webhook_deliveries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='webhook_deliveries' AND sql IN ('CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (''pending'', ''success'', ''failed'', ''retrying'')),
  status_code INTEGER,
  request_headers TEXT,
  request_body TEXT,
  response_body TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  detail_object_catalog_id TEXT,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:webhook_deliveries', (SELECT count(*) FROM "webhook_deliveries" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:webhook_delivery_logs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='webhook_delivery_logs' AND sql IN ('CREATE TABLE webhook_delivery_logs (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:webhook_delivery_logs', (SELECT count(*) FROM "webhook_delivery_logs" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_review_items_decision', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_review_items_decision' AND sql='CREATE INDEX idx_access_review_items_decision ON access_review_items(review_id, decision)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_review_items_review', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_review_items_review' AND sql='CREATE INDEX idx_access_review_items_review ON access_review_items(review_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_review_items_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_review_items_user' AND sql='CREATE INDEX idx_access_review_items_user ON access_review_items(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_reviews_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_reviews_created' AND sql='CREATE INDEX idx_access_reviews_created ON access_reviews(tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_reviews_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_reviews_due' AND sql='CREATE INDEX idx_access_reviews_due ON access_reviews(tenant_id, due_date)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_reviews_reviewer', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_reviews_reviewer' AND sql='CREATE INDEX idx_access_reviews_reviewer ON access_reviews(tenant_id, reviewer_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_reviews_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_reviews_status' AND sql='CREATE INDEX idx_access_reviews_status ON access_reviews(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_access_reviews_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_access_reviews_tenant' AND sql='CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_account_creation_operations_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_account_creation_operations_status' AND sql='CREATE INDEX idx_account_creation_operations_status
  ON account_creation_operations(status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_account_lifecycle_event_outbox_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_account_lifecycle_event_outbox_due' AND sql='CREATE INDEX idx_account_lifecycle_event_outbox_due
  ON account_lifecycle_event_outbox(status, next_attempt_at, created_at, event_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_account_routing_outbox_account_event_route', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_account_routing_outbox_account_event_route' AND sql='CREATE INDEX idx_account_routing_outbox_account_event_route
  ON account_routing_outbox(
    tenant_id,
    account_id,
    event_kind,
    route_generation,
    status,
    outbox_id
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_account_routing_outbox_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_account_routing_outbox_due' AND sql='CREATE INDEX idx_account_routing_outbox_due
  ON account_routing_outbox(status, next_attempt_at, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_account_webhook_outbox_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_account_webhook_outbox_due' AND sql='CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_cleanup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_cleanup' AND sql='CREATE INDEX idx_admin_jobs_cleanup ON admin_jobs(
  status,
  completed_at
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_object_catalog' AND sql='CREATE INDEX idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_status' AND sql='CREATE INDEX idx_admin_jobs_status ON admin_jobs(
  tenant_id,
  status,
  created_at DESC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_tenant' AND sql='CREATE INDEX idx_admin_jobs_tenant ON admin_jobs(
  tenant_id,
  created_at DESC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_admin_jobs_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_admin_jobs_type' AND sql='CREATE INDEX idx_admin_jobs_type ON admin_jobs(
  tenant_id,
  job_type,
  created_at DESC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_assurance_evidence_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_assurance_evidence_subject' AND sql='CREATE INDEX idx_assurance_evidence_subject
  ON assurance_evidence(tenant_id, subject_id, evidence_type, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_attribute_release_consents_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_attribute_release_consents_destination' AND sql='CREATE INDEX idx_attribute_release_consents_destination
  ON attribute_release_consents(tenant_id, destination_type, destination_id, consent_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_attribute_verifications_result', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_attribute_verifications_result' AND sql='CREATE INDEX idx_attribute_verifications_result ON attribute_verifications(verification_result)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_attribute_verifications_runtime_validity', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_attribute_verifications_runtime_validity' AND sql='CREATE INDEX idx_attribute_verifications_runtime_validity
  ON attribute_verifications(tenant_id, verification_result, invalidated_at, revalidate_after)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_attribute_verifications_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_attribute_verifications_user' AND sql='CREATE INDEX idx_attribute_verifications_user ON attribute_verifications(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_log_action', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_log_action' AND sql='CREATE INDEX idx_audit_log_action ON audit_log(action)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_log_created_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_log_created_at' AND sql='CREATE INDEX idx_audit_log_created_at ON audit_log(created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_log_resource', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_log_resource' AND sql='CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_log_tenant_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_log_tenant_id' AND sql='CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_log_user_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_log_user_id' AND sql='CREATE INDEX idx_audit_log_user_id ON audit_log(user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_cco_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_cco_client' AND sql='CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ccs_operation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ccs_operation' AND sql='CREATE INDEX idx_ccs_operation ON custom_claim_schemas(operation_status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ccs_tenant_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ccs_tenant_active' AND sql='CREATE INDEX idx_ccs_tenant_active ON custom_claim_schemas(tenant_id, is_active, display_order)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ccs_tenant_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ccs_tenant_key' AND sql='CREATE INDEX idx_ccs_tenant_key ON custom_claim_schemas(tenant_id, field_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ccsh_cleanup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ccsh_cleanup' AND sql='CREATE INDEX idx_ccsh_cleanup ON custom_claim_schema_history(tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ccsh_schema', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ccsh_schema' AND sql='CREATE INDEX idx_ccsh_schema ON custom_claim_schema_history(tenant_id, schema_id, version DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_check_api_keys_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_check_api_keys_client' AND sql='CREATE INDEX idx_check_api_keys_client
    ON check_api_keys(client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_check_api_keys_hash', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_check_api_keys_hash' AND sql='CREATE UNIQUE INDEX idx_check_api_keys_hash
    ON check_api_keys(key_hash)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_check_api_keys_prefix', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_check_api_keys_prefix' AND sql='CREATE INDEX idx_check_api_keys_prefix
    ON check_api_keys(key_prefix)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_check_api_keys_tenant_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_check_api_keys_tenant_active' AND sql='CREATE INDEX idx_check_api_keys_tenant_active
    ON check_api_keys(tenant_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ciba_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ciba_client' AND sql='CREATE INDEX idx_ciba_client ON ciba_requests(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ciba_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ciba_status' AND sql='CREATE INDEX idx_ciba_status ON ciba_requests(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ciba_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ciba_user' AND sql='CREATE INDEX idx_ciba_user ON ciba_requests(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_cih_retain_until', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_cih_retain_until' AND sql='CREATE INDEX idx_cih_retain_until ON consent_item_history(retain_until)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_cih_statement', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_cih_statement' AND sql='CREATE INDEX idx_cih_statement ON consent_item_history(statement_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_cih_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_cih_tenant' AND sql='CREATE INDEX idx_cih_tenant ON consent_item_history(tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_cih_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_cih_user' AND sql='CREATE INDEX idx_cih_user ON consent_item_history(tenant_id, user_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_client_trust_policies_target', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_client_trust_policies_target' AND sql='CREATE INDEX idx_client_trust_policies_target
  ON client_trust_policies(tenant_id, target_type, target_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_closure_ancestor_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_closure_ancestor_lookup' AND sql='CREATE INDEX idx_closure_ancestor_lookup
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, relation)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_closure_depth', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_closure_depth' AND sql='CREATE INDEX idx_closure_depth
  ON relationship_closure(tenant_id, depth)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_closure_descendant_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_closure_descendant_lookup' AND sql='CREATE INDEX idx_closure_descendant_lookup
  ON relationship_closure(tenant_id, descendant_type, descendant_id, relation)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_closure_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_closure_unique' AND sql='CREATE UNIQUE INDEX idx_closure_unique
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, descendant_type, descendant_id, relation)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_compliance_reports_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_compliance_reports_created' AND sql='CREATE INDEX idx_compliance_reports_created ON compliance_reports(tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_compliance_reports_requested', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_compliance_reports_requested' AND sql='CREATE INDEX idx_compliance_reports_requested ON compliance_reports(tenant_id, requested_by)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_compliance_reports_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_compliance_reports_status' AND sql='CREATE INDEX idx_compliance_reports_status ON compliance_reports(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_compliance_reports_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_compliance_reports_tenant' AND sql='CREATE INDEX idx_compliance_reports_tenant ON compliance_reports(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_compliance_reports_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_compliance_reports_type' AND sql='CREATE INDEX idx_compliance_reports_type ON compliance_reports(tenant_id, type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_history_action', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_history_action' AND sql='CREATE INDEX idx_consent_history_action
  ON consent_history(action, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_history_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_history_client' AND sql='CREATE INDEX idx_consent_history_client
  ON consent_history(client_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_history_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_history_tenant' AND sql='CREATE INDEX idx_consent_history_tenant
  ON consent_history(tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_history_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_history_user' AND sql='CREATE INDEX idx_consent_history_user
  ON consent_history(user_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_policy_items_policy', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_policy_items_policy' AND sql='CREATE INDEX idx_consent_policy_items_policy
  ON consent_policy_items(tenant_id, policy_id, display_order)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_policy_versions_effective', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_policy_versions_effective' AND sql='CREATE INDEX idx_consent_policy_versions_effective
  ON consent_policy_versions(effective_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_policy_versions_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_policy_versions_tenant' AND sql='CREATE INDEX idx_consent_policy_versions_tenant
  ON consent_policy_versions(tenant_id, policy_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_records_flow', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_records_flow' AND sql='CREATE INDEX idx_consent_records_flow
  ON consent_records(tenant_id, flow_id, flow_version_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_records_recipient', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_records_recipient' AND sql='CREATE INDEX idx_consent_records_recipient
  ON consent_records(tenant_id, recipient_type, recipient_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_records_statement', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_records_statement' AND sql='CREATE INDEX idx_consent_records_statement
  ON consent_records(tenant_id, subject_user_id, statement_id, statement_version, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_records_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_records_subject' AND sql='CREATE INDEX idx_consent_records_subject
  ON consent_records(tenant_id, subject_user_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consent_statements_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consent_statements_tenant' AND sql='CREATE INDEX idx_consent_statements_tenant ON consent_statements(tenant_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consents_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consents_client' AND sql='CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consents_expires_at_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consents_expires_at_active' AND sql='CREATE INDEX idx_consents_expires_at_active ON oauth_client_consents(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_consents_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_consents_user' AND sql='CREATE INDEX idx_consents_user ON oauth_client_consents(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_contact_points_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_contact_points_lookup' AND sql='CREATE INDEX idx_contact_points_lookup
  ON contact_points(tenant_id, contact_type, normalized_hash)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_contact_points_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_contact_points_subject' AND sql='CREATE INDEX idx_contact_points_subject
  ON contact_points(tenant_id, subject_id, contact_type, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_contact_verifications_contact', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_contact_verifications_contact' AND sql='CREATE INDEX idx_contact_verifications_contact
  ON contact_verifications(tenant_id, contact_point_id, verification_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_credential_configurations_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_credential_configurations_tenant' AND sql='CREATE INDEX idx_credential_configurations_tenant ON credential_configurations(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_credential_offers_code', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_credential_offers_code' AND sql='CREATE INDEX idx_credential_offers_code ON credential_offers(pre_authorized_code)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_credential_offers_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_credential_offers_status' AND sql='CREATE INDEX idx_credential_offers_status ON credential_offers(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_csl_version', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_csl_version' AND sql='CREATE INDEX idx_csl_version ON consent_statement_localizations(version_id, language)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_csv_effective', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_csv_effective' AND sql='CREATE INDEX idx_csv_effective ON consent_statement_versions(effective_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_csv_statement', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_csv_statement' AND sql='CREATE INDEX idx_csv_statement ON consent_statement_versions(statement_id, is_current)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_csv_unique_current', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_csv_unique_current' AND sql='CREATE UNIQUE INDEX idx_csv_unique_current
  ON consent_statement_versions(tenant_id, current_statement_guard)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_data_export_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_data_export_expires' AND sql='CREATE INDEX idx_data_export_expires
  ON data_export_requests(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_data_export_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_data_export_object_catalog' AND sql='CREATE INDEX idx_data_export_object_catalog
  ON data_export_requests(object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_data_export_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_data_export_status' AND sql='CREATE INDEX idx_data_export_status
  ON data_export_requests(status, requested_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_data_export_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_data_export_user' AND sql='CREATE INDEX idx_data_export_user
  ON data_export_requests(user_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_codes_client_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_codes_client_id' AND sql='CREATE INDEX idx_device_codes_client_id ON device_codes(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_codes_expires_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_codes_expires_at' AND sql='CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_codes_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_codes_status' AND sql='CREATE INDEX idx_device_codes_status ON device_codes(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_codes_user_code', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_codes_user_code' AND sql='CREATE INDEX idx_device_codes_user_code ON device_codes(user_code)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_installations_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_installations_client' AND sql='CREATE INDEX idx_device_installations_client
  ON device_installations(tenant_id, client_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_installations_linked_secret', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_installations_linked_secret' AND sql='CREATE INDEX idx_device_installations_linked_secret
  ON device_installations(tenant_id, linked_device_secret_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_installations_source', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_installations_source' AND sql='CREATE INDEX idx_device_installations_source
  ON device_installations(tenant_id, source_installation_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_installations_trust_group', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_installations_trust_group' AND sql='CREATE INDEX idx_device_installations_trust_group
  ON device_installations(tenant_id, trust_group_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_installations_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_installations_user' AND sql='CREATE INDEX idx_device_installations_user
  ON device_installations(tenant_id, user_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_secrets_active_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_secrets_active_expires' AND sql='CREATE INDEX idx_device_secrets_active_expires
  ON device_secrets(is_active, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_secrets_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_secrets_client' AND sql='CREATE INDEX idx_device_secrets_client
  ON device_secrets(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_secrets_installation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_secrets_installation' AND sql='CREATE INDEX idx_device_secrets_installation
  ON device_secrets(tenant_id, installation_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_secrets_secret_hash', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_secrets_secret_hash' AND sql='CREATE INDEX idx_device_secrets_secret_hash
  ON device_secrets(secret_hash)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_secrets_session_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_secrets_session_id' AND sql='CREATE INDEX idx_device_secrets_session_id
  ON device_secrets(session_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_secrets_tenant_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_secrets_tenant_user' AND sql='CREATE INDEX idx_device_secrets_tenant_user
  ON device_secrets(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_device_secrets_trust_group', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_device_secrets_trust_group' AND sql='CREATE INDEX idx_device_secrets_trust_group
  ON device_secrets(tenant_id, trust_group_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_did_document_cache_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_did_document_cache_expires' AND sql='CREATE INDEX idx_did_document_cache_expires ON did_document_cache(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_config_history_tenant_time', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_config_history_tenant_time' AND sql='CREATE INDEX idx_directory_auth_config_history_tenant_time
  ON directory_auth_config_history (tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_evidence_exports_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_evidence_exports_object_catalog' AND sql='CREATE INDEX idx_directory_auth_evidence_exports_object_catalog
  ON directory_auth_evidence_exports (object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_evidence_exports_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_evidence_exports_retention' AND sql='CREATE INDEX idx_directory_auth_evidence_exports_retention
  ON directory_auth_evidence_exports (tenant_id, retention_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_evidence_exports_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_evidence_exports_status' AND sql='CREATE INDEX idx_directory_auth_evidence_exports_status
  ON directory_auth_evidence_exports (tenant_id, status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_migration_campaigns_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_migration_campaigns_status' AND sql='CREATE INDEX idx_directory_auth_migration_campaigns_status
  ON directory_auth_migration_campaigns (tenant_id, status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_migration_transaction_events_txn', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_migration_transaction_events_txn' AND sql='CREATE INDEX idx_directory_auth_migration_transaction_events_txn
  ON directory_auth_migration_transaction_events (tenant_id, transaction_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_migration_transactions_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_migration_transactions_state' AND sql='CREATE INDEX idx_directory_auth_migration_transactions_state
  ON directory_auth_migration_transactions (tenant_id, state, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_migration_transactions_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_migration_transactions_user' AND sql='CREATE INDEX idx_directory_auth_migration_transactions_user
  ON directory_auth_migration_transactions (tenant_id, user_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_migration_user_states_cohort', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_migration_user_states_cohort' AND sql='CREATE INDEX idx_directory_auth_migration_user_states_cohort
  ON directory_auth_migration_user_states (tenant_id, campaign_id, cohort_key, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_migration_user_states_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_migration_user_states_status' AND sql='CREATE INDEX idx_directory_auth_migration_user_states_status
  ON directory_auth_migration_user_states (tenant_id, state, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_migration_user_states_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_migration_user_states_user' AND sql='CREATE INDEX idx_directory_auth_migration_user_states_user
  ON directory_auth_migration_user_states (tenant_id, user_id, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_release_advisories_channel_time', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_release_advisories_channel_time' AND sql='CREATE INDEX idx_directory_auth_release_advisories_channel_time
  ON directory_auth_release_advisories (channel, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_support_bundles_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_support_bundles_object_catalog' AND sql='CREATE INDEX idx_directory_auth_support_bundles_object_catalog
  ON directory_auth_support_bundles (object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_support_bundles_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_support_bundles_retention' AND sql='CREATE INDEX idx_directory_auth_support_bundles_retention
  ON directory_auth_support_bundles (tenant_id, retention_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_auth_support_bundles_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_auth_support_bundles_status' AND sql='CREATE INDEX idx_directory_auth_support_bundles_status
  ON directory_auth_support_bundles (tenant_id, status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_connector_instances_connector', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_connector_instances_connector' AND sql='CREATE INDEX idx_directory_connector_instances_connector
  ON directory_connector_instances (tenant_id, connector_id, status, last_seen_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_connector_status_episodes_current', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_connector_status_episodes_current' AND sql='CREATE INDEX idx_directory_connector_status_episodes_current
  ON directory_connector_status_episodes (tenant_id, connector_id, instance_id, ended_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_connector_status_episodes_recent', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_connector_status_episodes_recent' AND sql='CREATE INDEX idx_directory_connector_status_episodes_recent
  ON directory_connector_status_episodes (tenant_id, connector_id, started_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_identity_links_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_identity_links_user' AND sql='CREATE INDEX idx_directory_identity_links_user
  ON directory_identity_links (tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_directory_jit_pending_users_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_directory_jit_pending_users_status' AND sql='CREATE INDEX idx_directory_jit_pending_users_status
  ON directory_jit_pending_users (tenant_id, status, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_entitlements_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_entitlements_subject' AND sql='CREATE INDEX idx_entitlements_subject
  ON entitlements(tenant_id, subject_id, entitlement_type, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_event_log_tenant_anon_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_event_log_tenant_anon_created' AND sql='CREATE INDEX idx_event_log_tenant_anon_created
    ON event_log(tenant_id, anonymized_user_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_event_log_tenant_category_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_event_log_tenant_category_created' AND sql='CREATE INDEX idx_event_log_tenant_category_created
    ON event_log(tenant_id, event_category, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_event_log_tenant_client_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_event_log_tenant_client_created' AND sql='CREATE INDEX idx_event_log_tenant_client_created
    ON event_log(tenant_id, client_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_event_log_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_event_log_tenant_created' AND sql='CREATE INDEX idx_event_log_tenant_created
    ON event_log(tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_event_log_tenant_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_event_log_tenant_retention' AND sql='CREATE INDEX idx_event_log_tenant_retention
    ON event_log(tenant_id, retention_until, created_at, id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_event_log_tenant_type_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_event_log_tenant_type_created' AND sql='CREATE INDEX idx_event_log_tenant_type_created
    ON event_log(tenant_id, event_type, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_external_idp_auth_states_consumed_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_external_idp_auth_states_consumed_at' AND sql='CREATE INDEX idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_external_idp_auth_states_expires_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_external_idp_auth_states_expires_at' AND sql='CREATE INDEX idx_external_idp_auth_states_expires_at
  ON external_idp_auth_states(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_external_idp_auth_states_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_external_idp_auth_states_state' AND sql='CREATE INDEX idx_external_idp_auth_states_state
  ON external_idp_auth_states(state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_field_usage_bindings_binding', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_field_usage_bindings_binding' AND sql='CREATE INDEX idx_field_usage_bindings_binding
  ON field_usage_bindings(tenant_id, binding_type, binding_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_field_usage_bindings_protection', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_field_usage_bindings_protection' AND sql='CREATE INDEX idx_field_usage_bindings_protection
  ON field_usage_bindings(tenant_id, protection, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_field_usage_bindings_tenant_field', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_field_usage_bindings_tenant_field' AND sql='CREATE INDEX idx_field_usage_bindings_tenant_field
  ON field_usage_bindings(tenant_id, field_key, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_assignments_flow', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_assignments_flow' AND sql='CREATE INDEX idx_flow_assignments_flow
  ON flow_assignments(tenant_id, flow_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_assignments_target', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_assignments_target' AND sql='CREATE INDEX idx_flow_assignments_target
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_assignments_target_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_assignments_target_unique' AND sql='CREATE UNIQUE INDEX idx_flow_assignments_target_unique
  ON flow_assignments(tenant_id, target_type, COALESCE(target_id, ''''), flow_kind)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_assignments_tenant_default', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_assignments_tenant_default' AND sql='CREATE INDEX idx_flow_assignments_tenant_default
  ON flow_assignments(tenant_id, target_type, flow_kind, target_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_audit_events_flow', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_audit_events_flow' AND sql='CREATE INDEX idx_flow_audit_events_flow
  ON flow_audit_events(tenant_id, flow_id, flow_version_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_audit_events_interaction', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_audit_events_interaction' AND sql='CREATE INDEX idx_flow_audit_events_interaction
  ON flow_audit_events(tenant_id, interaction_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_interaction_steps_node', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_interaction_steps_node' AND sql='CREATE INDEX idx_flow_interaction_steps_node
  ON flow_interaction_steps(tenant_id, interaction_id, node_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_interaction_steps_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_interaction_steps_state' AND sql='CREATE INDEX idx_flow_interaction_steps_state
  ON flow_interaction_steps(tenant_id, interaction_id, state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_interactions_expiration', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_interactions_expiration' AND sql='CREATE INDEX idx_flow_interactions_expiration
  ON flow_interactions(tenant_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_interactions_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_interactions_lookup' AND sql='CREATE INDEX idx_flow_interactions_lookup
  ON flow_interactions(tenant_id, id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_interactions_state_expiration', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_interactions_state_expiration' AND sql='CREATE INDEX idx_flow_interactions_state_expiration
  ON flow_interactions(tenant_id, state, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_interactions_state_updated', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_interactions_state_updated' AND sql='CREATE INDEX idx_flow_interactions_state_updated
  ON flow_interactions(tenant_id, state, updated_at, id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_versions_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_versions_lookup' AND sql='CREATE INDEX idx_flow_versions_lookup
  ON flow_versions(tenant_id, flow_id, version_number)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_flow_versions_published', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_flow_versions_published' AND sql='CREATE INDEX idx_flow_versions_published
  ON flow_versions(tenant_id, flow_id, published_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_group_memberships_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_group_memberships_subject' AND sql='CREATE INDEX idx_group_memberships_subject
  ON group_memberships(tenant_id, subject_id, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_groups_tenant_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_groups_tenant_state' AND sql='CREATE INDEX idx_groups_tenant_state
  ON "groups"(tenant_id, lifecycle_state, display_name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_account_upgrades_target', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_account_upgrades_target' AND sql='CREATE INDEX idx_guest_account_upgrades_target ON guest_account_upgrades (tenant_id, upgraded_user_id, upgraded_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_account_upgrades_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_account_upgrades_user' AND sql='CREATE INDEX idx_guest_account_upgrades_user ON guest_account_upgrades (tenant_id, guest_user_id, upgraded_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_deletion_audit_outbox_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_deletion_audit_outbox_due' AND sql='CREATE INDEX idx_guest_deletion_audit_outbox_due
  ON guest_deletion_audit_outbox (tenant_id, status, next_attempt_at, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_devices_active_resume_credential', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_devices_active_resume_credential' AND sql='CREATE UNIQUE INDEX idx_guest_devices_active_resume_credential ON guest_devices (tenant_id, resume_credential_hash)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_devices_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_devices_expiry' AND sql='CREATE INDEX idx_guest_devices_expiry ON guest_devices (tenant_id, is_active, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_devices_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_devices_user' AND sql='CREATE INDEX idx_guest_devices_user ON guest_devices (tenant_id, user_id, is_active, last_used_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_idempotency_keys_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_idempotency_keys_expires' AND sql='CREATE INDEX idx_idempotency_keys_expires
    ON idempotency_keys(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_idempotency_keys_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_idempotency_keys_lookup' AND sql='CREATE INDEX idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_accounts_directory_publication', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_accounts_directory_publication' AND sql='CREATE INDEX idx_identity_accounts_directory_publication
  ON identity_accounts(tenant_id, directory_publication_state, created_at, id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_accounts_legacy_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_accounts_legacy_user' AND sql='CREATE INDEX idx_identity_accounts_legacy_user
  ON identity_accounts(tenant_id, legacy_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_accounts_registration_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_accounts_registration_state' AND sql='CREATE INDEX idx_identity_accounts_registration_state ON identity_accounts (tenant_id, registration_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_accounts_tenant_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_accounts_tenant_state' AND sql='CREATE INDEX idx_identity_accounts_tenant_state
  ON identity_accounts(tenant_id, account_type, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_bindings_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_bindings_subject' AND sql='CREATE INDEX idx_identity_bindings_subject
  ON identity_bindings(tenant_id, subject_id, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_providers_saml_entity_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_providers_saml_entity_id' AND sql='CREATE UNIQUE INDEX idx_identity_providers_saml_entity_id
  ON identity_providers(
    tenant_id,
    provider_type,
    json_extract(config_json, ''$.entityId'')
  )
  WHERE provider_type IN (''saml_idp'', ''saml_sp'')
    AND json_valid(config_json)
    AND json_type(config_json, ''$.entityId'') = ''text''')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_providers_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_providers_type' AND sql='CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_resolution_candidates_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_resolution_candidates_state' AND sql='CREATE INDEX idx_identity_resolution_candidates_state
  ON identity_resolution_candidates(tenant_id, decision_state, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_resolution_events_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_resolution_events_subject' AND sql='CREATE INDEX idx_identity_resolution_events_subject
  ON identity_resolution_events(tenant_id, subject_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_subjects_tenant_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_subjects_tenant_type' AND sql='CREATE INDEX idx_identity_subjects_tenant_type
  ON identity_subjects(tenant_id, subject_type, lifecycle_state)')));

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

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_issued_credentials_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_issued_credentials_status' AND sql='CREATE INDEX idx_issued_credentials_status ON issued_credentials(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_issued_credentials_status_list', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_issued_credentials_status_list' AND sql='CREATE INDEX idx_issued_credentials_status_list
    ON issued_credentials(tenant_id, status_list_internal_id, status_list_index)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_issued_credentials_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_issued_credentials_type' AND sql='CREATE INDEX idx_issued_credentials_type ON issued_credentials(tenant_id, credential_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_issued_credentials_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_issued_credentials_user' AND sql='CREATE INDEX idx_issued_credentials_user ON issued_credentials(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_legal_hold_events_account', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_legal_hold_events_account' AND sql='CREATE INDEX idx_legal_hold_events_account
  ON legal_hold_events(tenant_id, account_id, created_at DESC, event_id DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_legal_hold_projection_outbox_runnable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_legal_hold_projection_outbox_runnable' AND sql='CREATE INDEX idx_legal_hold_projection_outbox_runnable
  ON legal_hold_projection_outbox(status, next_attempt_at, tenant_id, operation_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_legal_holds_account_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_legal_holds_account_history' AND sql='CREATE INDEX idx_legal_holds_account_history
  ON legal_holds(tenant_id, subject_id, created_at DESC, id DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_legal_holds_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_legal_holds_expiry' AND sql='CREATE INDEX idx_legal_holds_expiry
  ON legal_holds(state, expires_at, tenant_id, id)')));

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

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_quota_evaluations_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_quota_evaluations_state' AND sql='CREATE INDEX idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_quota_policies_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_quota_policies_lookup' AND sql='CREATE INDEX idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_logging_usage_aggregates_window', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_logging_usage_aggregates_window' AND sql='CREATE INDEX idx_logging_usage_aggregates_window
  ON logging_usage_aggregates(window_kind, window_start_at, metric_name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_lookup_retention_policy_projection_outbox_runnable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_lookup_retention_policy_projection_outbox_runnable' AND sql='CREATE INDEX idx_lookup_retention_policy_projection_outbox_runnable
  ON lookup_retention_policy_projection_outbox(
    status, next_attempt_at, tenant_id, policy_generation
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_membership_org', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_membership_org' AND sql='CREATE INDEX idx_membership_org ON subject_org_membership(tenant_id, org_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_membership_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_membership_subject' AND sql='CREATE INDEX idx_membership_subject ON subject_org_membership(tenant_id, subject_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_notification_delivery_history_account_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_notification_delivery_history_account_created' AND sql='CREATE INDEX idx_notification_delivery_history_account_created
  ON notification_delivery_intents(tenant_id, account_id, created_at DESC, intent_id DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_notification_delivery_history_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_notification_delivery_history_tenant_created' AND sql='CREATE INDEX idx_notification_delivery_history_tenant_created
  ON notification_delivery_intents(tenant_id, created_at DESC, intent_id DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_notification_delivery_intents_pending', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_notification_delivery_intents_pending' AND sql='CREATE INDEX idx_notification_delivery_intents_pending
  ON notification_delivery_intents(tenant_id, state, expires_at, intent_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_notification_delivery_intents_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_notification_delivery_intents_retention' AND sql='CREATE INDEX idx_notification_delivery_intents_retention
  ON notification_delivery_intents(delete_after, state, intent_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_object_catalog_deleted_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_object_catalog_deleted_at' AND sql='CREATE INDEX idx_object_catalog_deleted_at
  ON object_catalog(deleted_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_object_catalog_tenant_class_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_object_catalog_tenant_class_created' AND sql='CREATE INDEX idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_odm_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_odm_lookup' AND sql='CREATE INDEX idx_odm_lookup ON org_domain_mappings(
  tenant_id,
  domain_hash,
  is_active,
  verified DESC,
  priority DESC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_odm_org', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_odm_org' AND sql='CREATE INDEX idx_odm_org ON org_domain_mappings(org_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_odm_verification_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_odm_verification_status' AND sql='CREATE INDEX idx_odm_verification_status ON org_domain_mappings(
  verification_status,
  verification_expires_at
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_odm_version', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_odm_version' AND sql='CREATE INDEX idx_odm_version ON org_domain_mappings(domain_hash_version)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_oidc_scopes_enabled', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_oidc_scopes_enabled' AND sql='CREATE INDEX idx_oidc_scopes_enabled
  ON oidc_scopes(tenant_id, enabled, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_operational_logs_actor', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_operational_logs_actor' AND sql='CREATE INDEX idx_operational_logs_actor
    ON operational_logs(actor_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_operational_logs_detail_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_operational_logs_detail_object_catalog' AND sql='CREATE INDEX idx_operational_logs_detail_object_catalog
    ON operational_logs(detail_object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_operational_logs_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_operational_logs_expires' AND sql='CREATE INDEX idx_operational_logs_expires
    ON operational_logs(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_operational_logs_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_operational_logs_subject' AND sql='CREATE INDEX idx_operational_logs_subject
    ON operational_logs(subject_type, subject_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_operational_logs_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_operational_logs_tenant_created' AND sql='CREATE INDEX idx_operational_logs_tenant_created
    ON operational_logs(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_organizations_is_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_organizations_is_active' AND sql='CREATE INDEX idx_organizations_is_active ON organizations(is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_organizations_org_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_organizations_org_type' AND sql='CREATE INDEX idx_organizations_org_type ON organizations(org_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_organizations_parent_org_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_organizations_parent_org_id' AND sql='CREATE INDEX idx_organizations_parent_org_id ON organizations(parent_org_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_organizations_tenant_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_organizations_tenant_id' AND sql='CREATE INDEX idx_organizations_tenant_id ON organizations(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_organizations_tenant_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_organizations_tenant_name' AND sql='CREATE UNIQUE INDEX idx_organizations_tenant_name ON organizations(tenant_id, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_passkeys_credential', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_passkeys_credential' AND sql='CREATE INDEX idx_passkeys_credential ON passkeys(tenant_id, credential_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_passkeys_routing_authority', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_passkeys_routing_authority' AND sql='CREATE INDEX idx_passkeys_routing_authority
  ON passkeys(tenant_id, created_at, id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_passkeys_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_passkeys_tenant' AND sql='CREATE INDEX idx_passkeys_tenant ON passkeys(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_passkeys_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_passkeys_user' AND sql='CREATE INDEX idx_passkeys_user ON passkeys(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_password_reset_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_password_reset_user' AND sql='CREATE INDEX idx_password_reset_user ON password_reset_tokens(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pca_api_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pca_api_key' AND sql='CREATE INDEX idx_pca_api_key
    ON permission_check_audit(api_key_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pca_checked_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pca_checked_at' AND sql='CREATE INDEX idx_pca_checked_at
    ON permission_check_audit(checked_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pca_denied', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pca_denied' AND sql='CREATE INDEX idx_pca_denied
    ON permission_check_audit(tenant_id, final_decision)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pca_tenant_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pca_tenant_subject' AND sql='CREATE INDEX idx_pca_tenant_subject
    ON permission_check_audit(tenant_id, subject_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pcaudit_event_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pcaudit_event_type' AND sql='CREATE INDEX idx_pcaudit_event_type
    ON permission_change_audit(tenant_id, event_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pcaudit_tenant_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pcaudit_tenant_subject' AND sql='CREATE INDEX idx_pcaudit_tenant_subject
    ON permission_change_audit(tenant_id, subject_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pcaudit_timestamp', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pcaudit_timestamp' AND sql='CREATE INDEX idx_pcaudit_timestamp
    ON permission_change_audit(timestamp)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_account_metadata_installation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_account_metadata_installation' AND sql='CREATE INDEX idx_plugin_account_metadata_installation
  ON plugin_account_metadata(tenant_id, plugin_installation_id, account_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_hook_outbox_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_hook_outbox_due' AND sql='CREATE INDEX idx_plugin_hook_outbox_due
  ON plugin_hook_outbox(status, next_attempt_at, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_hook_outbox_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_hook_outbox_retention' AND sql='CREATE INDEX idx_plugin_hook_outbox_retention
  ON plugin_hook_outbox(delete_after, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_presentation_definitions_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_presentation_definitions_tenant' AND sql='CREATE INDEX idx_presentation_definitions_tenant ON presentation_definitions(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_profile_attribute_values_profile', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_profile_attribute_values_profile' AND sql='CREATE INDEX idx_profile_attribute_values_profile
  ON profile_attribute_values(tenant_id, profile_id, catalog_entry_id, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rar_evaluation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rar_evaluation' AND sql='CREATE INDEX idx_rar_evaluation ON role_assignment_rules(
  tenant_id,
  is_active,
  priority DESC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rar_role', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rar_role' AND sql='CREATE INDEX idx_rar_role ON role_assignment_rules(role_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relation_defs_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relation_defs_active' AND sql='CREATE INDEX idx_relation_defs_active
  ON relation_definitions(tenant_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relation_defs_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relation_defs_lookup' AND sql='CREATE INDEX idx_relation_defs_lookup
  ON relation_definitions(tenant_id, object_type, relation_name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relation_defs_tenant_object', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relation_defs_tenant_object' AND sql='CREATE INDEX idx_relation_defs_tenant_object
  ON relation_definitions(tenant_id, object_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relation_defs_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relation_defs_unique' AND sql='CREATE UNIQUE INDEX idx_relation_defs_unique
  ON relation_definitions(tenant_id, object_type, relation_name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relationships_evidence_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relationships_evidence_type' AND sql='CREATE INDEX idx_relationships_evidence_type
  ON relationships(tenant_id, evidence_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relationships_expires_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relationships_expires_at' AND sql='CREATE INDEX idx_relationships_expires_at ON relationships(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relationships_from', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relationships_from' AND sql='CREATE INDEX idx_relationships_from ON relationships(tenant_id, from_type, from_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relationships_tenant_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relationships_tenant_id' AND sql='CREATE INDEX idx_relationships_tenant_id ON relationships(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relationships_to', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relationships_to' AND sql='CREATE INDEX idx_relationships_to ON relationships(tenant_id, to_type, to_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relationships_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relationships_type' AND sql='CREATE INDEX idx_relationships_type ON relationships(tenant_id, relationship_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_relationships_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_relationships_unique' AND sql='CREATE UNIQUE INDEX idx_relationships_unique
  ON relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_role_assignments_role', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_role_assignments_role' AND sql='CREATE INDEX idx_role_assignments_role ON role_assignments(tenant_id, role_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_role_assignments_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_role_assignments_subject' AND sql='CREATE INDEX idx_role_assignments_subject ON role_assignments(tenant_id, subject_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_roles_hierarchy_level', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_roles_hierarchy_level' AND sql='CREATE INDEX idx_roles_hierarchy_level ON roles(hierarchy_level)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_roles_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_roles_name' AND sql='CREATE INDEX idx_roles_name ON roles(tenant_id, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_roles_parent_role_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_roles_parent_role_id' AND sql='CREATE INDEX idx_roles_parent_role_id ON roles(tenant_id, parent_role_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_roles_role_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_roles_role_type' AND sql='CREATE INDEX idx_roles_role_type ON roles(role_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_roles_tenant_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_roles_tenant_id' AND sql='CREATE INDEX idx_roles_tenant_id ON roles(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rp_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rp_expires' AND sql='CREATE INDEX idx_rp_expires ON resource_permissions(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rp_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rp_lookup' AND sql='CREATE INDEX idx_rp_lookup ON resource_permissions(
  tenant_id,
  subject_type,
  subject_id,
  resource_type,
  is_active
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rp_resource', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rp_resource' AND sql='CREATE INDEX idx_rp_resource ON resource_permissions(
  tenant_id,
  resource_type,
  resource_id,
  is_active
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rtsc_activated_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rtsc_activated_at' AND sql='CREATE INDEX idx_rtsc_activated_at
  ON refresh_token_shard_configs(activated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rtsc_generation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rtsc_generation' AND sql='CREATE INDEX idx_rtsc_generation
  ON refresh_token_shard_configs(generation)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_rtsc_tenant_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_rtsc_tenant_client' AND sql='CREATE INDEX idx_rtsc_tenant_client
  ON refresh_token_shard_configs(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_saml_attribute_presets_applies_to', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_saml_attribute_presets_applies_to' AND sql='CREATE INDEX idx_saml_attribute_presets_applies_to ON saml_attribute_presets(tenant_id, applies_to)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_saml_attribute_presets_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_saml_attribute_presets_tenant' AND sql='CREATE INDEX idx_saml_attribute_presets_tenant ON saml_attribute_presets(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_screens_kind', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_screens_kind' AND sql='CREATE INDEX idx_screens_kind
  ON screens(tenant_id, screen_kind, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_alerts_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_alerts_tenant_created' AND sql='CREATE INDEX idx_security_alerts_tenant_created
    ON security_alerts(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_alerts_tenant_severity', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_alerts_tenant_severity' AND sql='CREATE INDEX idx_security_alerts_tenant_severity
    ON security_alerts(tenant_id, severity)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_alerts_tenant_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_alerts_tenant_status' AND sql='CREATE INDEX idx_security_alerts_tenant_status
    ON security_alerts(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_alerts_tenant_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_alerts_tenant_type' AND sql='CREATE INDEX idx_security_alerts_tenant_type
    ON security_alerts(tenant_id, type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_alerts_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_alerts_user' AND sql='CREATE INDEX idx_security_alerts_user
    ON security_alerts(user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_threats_detected', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_threats_detected' AND sql='CREATE INDEX idx_security_threats_detected ON security_threats(tenant_id, detected_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_threats_severity', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_threats_severity' AND sql='CREATE INDEX idx_security_threats_severity ON security_threats(tenant_id, severity)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_threats_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_threats_status' AND sql='CREATE INDEX idx_security_threats_status ON security_threats(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_threats_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_threats_tenant' AND sql='CREATE INDEX idx_security_threats_tenant ON security_threats(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_security_threats_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_security_threats_type' AND sql='CREATE INDEX idx_security_threats_type ON security_threats(tenant_id, type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_service_group_audit_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_service_group_audit_subject' AND sql='CREATE INDEX idx_service_group_audit_subject ON service_group_audit(tenant_id, user_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_service_group_write_boundaries_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_service_group_write_boundaries_subject' AND sql='CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_sessions_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_sessions_expires' AND sql='CREATE INDEX idx_sessions_expires ON sessions(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_sessions_external_provider_sid', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_sessions_external_provider_sid' AND sql='CREATE INDEX idx_sessions_external_provider_sid
  ON sessions(tenant_id, external_provider_id, external_provider_sid)
  WHERE external_provider_sid IS NOT NULL')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_sessions_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_sessions_tenant' AND sql='CREATE INDEX idx_sessions_tenant ON sessions(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_sessions_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_sessions_user' AND sql='CREATE INDEX idx_sessions_user ON sessions(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_settings_history_actor', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_settings_history_actor' AND sql='CREATE INDEX idx_settings_history_actor ON settings_history(
  actor_id,
  created_at DESC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_settings_history_category', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_settings_history_category' AND sql='CREATE INDEX idx_settings_history_category ON settings_history(
  tenant_id,
  category,
  version DESC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_settings_history_cleanup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_settings_history_cleanup' AND sql='CREATE INDEX idx_settings_history_cleanup ON settings_history(
  tenant_id,
  category,
  created_at
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soa_approval_request', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soa_approval_request' AND sql='CREATE INDEX idx_soa_approval_request
  ON support_operation_actions(tenant_id, approval_request_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soa_cohort', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soa_cohort' AND sql='CREATE INDEX idx_soa_cohort
  ON support_operation_actions(tenant_id, cohort_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soa_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soa_tenant_created' AND sql='CREATE INDEX idx_soa_tenant_created
  ON support_operation_actions(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soa_tenant_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soa_tenant_status' AND sql='CREATE INDEX idx_soa_tenant_status
  ON support_operation_actions(tenant_id, status, updated_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soc_selector_hash', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soc_selector_hash' AND sql='CREATE INDEX idx_soc_selector_hash
  ON support_operation_cohorts(tenant_id, resource, selector_hash)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soc_snapshot_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soc_snapshot_status' AND sql='CREATE INDEX idx_soc_snapshot_status
  ON support_operation_cohorts(tenant_id, snapshot_status, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soc_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soc_tenant_created' AND sql='CREATE INDEX idx_soc_tenant_created
  ON support_operation_cohorts(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soc_tenant_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soc_tenant_expires' AND sql='CREATE INDEX idx_soc_tenant_expires
  ON support_operation_cohorts(tenant_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soct_cohort', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soct_cohort' AND sql='CREATE INDEX idx_soct_cohort
  ON support_operation_cohort_targets(tenant_id, cohort_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_soct_cohort_block', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_soct_cohort_block' AND sql='CREATE INDEX idx_soct_cohort_block
  ON support_operation_cohort_targets(tenant_id, cohort_id, block_reason)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_status_lists_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_status_lists_tenant' AND sql='CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_status_lists_tenant_public', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_status_lists_tenant_public' AND sql='CREATE INDEX idx_status_lists_tenant_public ON status_lists(tenant_id, public_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_structured_attribute_values_owner', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_structured_attribute_values_owner' AND sql='CREATE INDEX idx_structured_attribute_values_owner
  ON structured_attribute_values(tenant_id, owner_type, owner_id, catalog_entry_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_subject_account_links_account', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_subject_account_links_account' AND sql='CREATE INDEX idx_subject_account_links_account
  ON subject_account_links(tenant_id, account_id, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_subject_lifecycle_timeline_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_subject_lifecycle_timeline_subject' AND sql='CREATE INDEX idx_subject_lifecycle_timeline_subject
  ON subject_lifecycle_timeline_events(tenant_id, subject_id, event_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_suspicious_activities_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_suspicious_activities_created' AND sql='CREATE INDEX idx_suspicious_activities_created ON suspicious_activities(tenant_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_suspicious_activities_severity', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_suspicious_activities_severity' AND sql='CREATE INDEX idx_suspicious_activities_severity ON suspicious_activities(tenant_id, severity)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_suspicious_activities_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_suspicious_activities_tenant' AND sql='CREATE INDEX idx_suspicious_activities_tenant ON suspicious_activities(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_suspicious_activities_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_suspicious_activities_type' AND sql='CREATE INDEX idx_suspicious_activities_type ON suspicious_activities(tenant_id, type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_suspicious_activities_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_suspicious_activities_user' AND sql='CREATE INDEX idx_suspicious_activities_user ON suspicious_activities(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tcr_evaluation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tcr_evaluation' AND sql='CREATE INDEX idx_tcr_evaluation ON token_claim_rules(
  tenant_id,
  token_type,
  is_active,
  priority DESC,
  created_at ASC
)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tcr_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tcr_tenant' AND sql='CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tdm_domain_hash', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tdm_domain_hash' AND sql='CREATE UNIQUE INDEX idx_tdm_domain_hash ON tenant_domain_mappings(active_domain_hash)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tdm_domain_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tdm_domain_lookup' AND sql='CREATE INDEX idx_tdm_domain_lookup ON tenant_domain_mappings(domain_hash, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tdm_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tdm_tenant' AND sql='CREATE INDEX idx_tdm_tenant ON tenant_domain_mappings(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tdm_verified', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tdm_verified' AND sql='CREATE INDEX idx_tdm_verified ON tenant_domain_mappings(verified, is_active, priority DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_database_probe_results_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_database_probe_results_scope' AND sql='CREATE INDEX idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_placement_capture_tenant_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_placement_capture_tenant_state' AND sql='CREATE INDEX idx_tenant_placement_capture_tenant_state
  ON tenant_placement_migration_captures(tenant_id, capture_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_placement_outbox_pending', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_placement_outbox_pending' AND sql='CREATE INDEX idx_tenant_placement_outbox_pending
  ON tenant_placement_migration_outbox(operation_id, delivery_state, source_sequence)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenants_is_default', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenants_is_default' AND sql='CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ti_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ti_tenant' AND sql='CREATE INDEX idx_ti_tenant ON tenant_invitations(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ti_token', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ti_token' AND sql='CREATE INDEX idx_ti_token ON tenant_invitations(token, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_token_families_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_token_families_client' AND sql='CREATE INDEX idx_token_families_client ON user_token_families(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_token_families_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_token_families_user' AND sql='CREATE INDEX idx_token_families_user ON user_token_families(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_totp_backup_codes_unused', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_totp_backup_codes_unused' AND sql='CREATE INDEX idx_totp_backup_codes_unused
  ON totp_backup_codes(tenant_id, user_id, used_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_totp_backup_codes_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_totp_backup_codes_user' AND sql='CREATE INDEX idx_totp_backup_codes_user
  ON totp_backup_codes(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_totp_credentials_active_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_totp_credentials_active_user' AND sql='CREATE INDEX idx_totp_credentials_active_user
  ON totp_credentials(tenant_id, user_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_totp_credentials_tenant_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_totp_credentials_tenant_user' AND sql='CREATE INDEX idx_totp_credentials_tenant_user
  ON totp_credentials(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_trusted_issuers_did', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_trusted_issuers_did' AND sql='CREATE INDEX idx_trusted_issuers_did ON trusted_issuers(issuer_did)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_trusted_issuers_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_trusted_issuers_tenant' AND sql='CREATE INDEX idx_trusted_issuers_tenant ON trusted_issuers(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tvd_hostname_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tvd_hostname_active' AND sql='CREATE UNIQUE INDEX idx_tvd_hostname_active ON tenant_vanity_domains(active_hostname)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tvd_hostname_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tvd_hostname_lookup' AND sql='CREATE INDEX idx_tvd_hostname_lookup ON tenant_vanity_domains(hostname, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tvd_primary_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tvd_primary_active' AND sql='CREATE UNIQUE INDEX idx_tvd_primary_active ON tenant_vanity_domains(primary_active_tenant_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tvd_primary_lookup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tvd_primary_lookup' AND sql='CREATE INDEX idx_tvd_primary_lookup ON tenant_vanity_domains(tenant_id, is_primary, is_active, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tvd_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tvd_status' AND sql='CREATE INDEX idx_tvd_status ON tenant_vanity_domains(status, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tvd_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tvd_tenant' AND sql='CREATE INDEX idx_tvd_tenant ON tenant_vanity_domains(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ucr_expires', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ucr_expires' AND sql='CREATE INDEX idx_ucr_expires ON user_consent_records(expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ucr_retain_until', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ucr_retain_until' AND sql='CREATE INDEX idx_ucr_retain_until ON user_consent_records(retain_until)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ucr_statement', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ucr_statement' AND sql='CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ucr_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ucr_status' AND sql='CREATE INDEX idx_ucr_status ON user_consent_records(status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_ucr_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ucr_user' AND sql='CREATE INDEX idx_ucr_user ON user_consent_records(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_upstream_providers_enable_sso', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_upstream_providers_enable_sso' AND sql='CREATE INDEX idx_upstream_providers_enable_sso
  ON upstream_providers(tenant_id, enable_sso)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_upstream_providers_enabled', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_upstream_providers_enabled' AND sql='CREATE INDEX idx_upstream_providers_enabled
  ON upstream_providers(tenant_id, enabled)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_upstream_providers_tenant_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_upstream_providers_tenant_id' AND sql='CREATE INDEX idx_upstream_providers_tenant_id
  ON upstream_providers(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_upstream_providers_tenant_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_upstream_providers_tenant_name' AND sql='CREATE UNIQUE INDEX idx_upstream_providers_tenant_name
  ON upstream_providers(tenant_id, name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_upstream_providers_tenant_slug', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_upstream_providers_tenant_slug' AND sql='CREATE UNIQUE INDEX idx_upstream_providers_tenant_slug
  ON upstream_providers(tenant_id, slug)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_user_roles_role', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_user_roles_role' AND sql='CREATE INDEX idx_user_roles_role ON user_roles(tenant_id, role_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_user_verified_attributes_name', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_user_verified_attributes_name' AND sql='CREATE INDEX idx_user_verified_attributes_name ON user_verified_attributes(tenant_id, attribute_name)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_user_verified_attributes_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_user_verified_attributes_user' AND sql='CREATE INDEX idx_user_verified_attributes_user ON user_verified_attributes(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_core_email_domain', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_core_email_domain' AND sql='CREATE INDEX idx_users_core_email_domain ON users_core(email_domain_hash)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_core_partition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_core_partition' AND sql='CREATE INDEX idx_users_core_partition ON users_core(pii_partition)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_core_pii_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_core_pii_status' AND sql='CREATE INDEX idx_users_core_pii_status ON users_core(pii_status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_core_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_core_status' AND sql='CREATE INDEX idx_users_core_status ON users_core(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_core_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_core_tenant' AND sql='CREATE INDEX idx_users_core_tenant ON users_core(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_core_tenant_external_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_core_tenant_external_id' AND sql='CREATE INDEX idx_users_core_tenant_external_id ON users_core(tenant_id, external_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_core_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_core_type' AND sql='CREATE INDEX idx_users_core_type ON users_core(tenant_id, user_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_created_at', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_created_at' AND sql='CREATE INDEX idx_users_created_at ON users(created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_tenant_email', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_tenant_email' AND sql='CREATE UNIQUE INDEX idx_users_tenant_email ON users(tenant_id, email)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_tenant_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_tenant_id' AND sql='CREATE INDEX idx_users_tenant_id ON users(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_tenant_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_tenant_status' AND sql='CREATE INDEX idx_users_tenant_status ON users(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_user_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_user_type' AND sql='CREATE INDEX idx_users_user_type ON users(user_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_value_provenance_owner', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_value_provenance_owner' AND sql='CREATE INDEX idx_value_provenance_owner
  ON value_provenance(tenant_id, owner_table, owner_id, observed_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_vp_requests_nonce', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_vp_requests_nonce' AND sql='CREATE INDEX idx_vp_requests_nonce ON vp_requests(nonce)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_vp_requests_tenant_status', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_vp_requests_tenant_status' AND sql='CREATE INDEX idx_vp_requests_tenant_status ON vp_requests(tenant_id, status)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_web_origin_registry_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_web_origin_registry_client' AND sql='CREATE INDEX idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_web_origin_registry_origin', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_web_origin_registry_origin' AND sql='CREATE INDEX idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_configs_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_configs_active' AND sql='CREATE INDEX idx_webhook_configs_active ON webhook_configs(tenant_id, active)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_configs_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_configs_client' AND sql='CREATE INDEX idx_webhook_configs_client ON webhook_configs(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_configs_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_configs_scope' AND sql='CREATE INDEX idx_webhook_configs_scope ON webhook_configs(tenant_id, scope)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_configs_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_configs_tenant' AND sql='CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_deliveries_detail_object_catalog', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_deliveries_detail_object_catalog' AND sql='CREATE INDEX idx_webhook_deliveries_detail_object_catalog
  ON webhook_deliveries(detail_object_catalog_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_deliveries_status_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_deliveries_status_created' AND sql='CREATE INDEX idx_webhook_deliveries_status_created
  ON webhook_deliveries(status, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_deliveries_tenant_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_deliveries_tenant_created' AND sql='CREATE INDEX idx_webhook_deliveries_tenant_created
  ON webhook_deliveries(tenant_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_deliveries_webhook_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_deliveries_webhook_created' AND sql='CREATE INDEX idx_webhook_deliveries_webhook_created
  ON webhook_deliveries(webhook_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_delivery_logs_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_delivery_logs_created' AND sql='CREATE INDEX idx_webhook_delivery_logs_created ON webhook_delivery_logs(created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_delivery_logs_event', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_delivery_logs_event' AND sql='CREATE INDEX idx_webhook_delivery_logs_event ON webhook_delivery_logs(event_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_delivery_logs_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_delivery_logs_tenant' AND sql='CREATE INDEX idx_webhook_delivery_logs_tenant ON webhook_delivery_logs(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_webhook_delivery_logs_webhook', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_webhook_delivery_logs_webhook' AND sql='CREATE INDEX idx_webhook_delivery_logs_webhook ON webhook_delivery_logs(webhook_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:uniq_ccs_active_key', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='uniq_ccs_active_key' AND sql='CREATE UNIQUE INDEX uniq_ccs_active_key
  ON custom_claim_schemas(tenant_id, active_field_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_contact_points_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_contact_points_delete' AND sql='CREATE TRIGGER account_webhook_contact_points_delete AFTER DELETE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''contact'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND ((a.id = OLD.account_id OR a.primary_subject_id = OLD.subject_id)) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_contact_points_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_contact_points_insert' AND sql='CREATE TRIGGER account_webhook_contact_points_insert AFTER INSERT ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''contact'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND ((a.id = NEW.account_id OR a.primary_subject_id = NEW.subject_id)) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_contact_points_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_contact_points_update' AND sql='CREATE TRIGGER account_webhook_contact_points_update AFTER UPDATE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''contact'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND ((a.id = NEW.account_id OR a.primary_subject_id = NEW.subject_id)) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_created_activate', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_created_activate' AND sql='CREATE TRIGGER account_webhook_created_activate AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.created'', a.registration_state, NULL, NULL, (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.directory_publication_state <> ''active'' AND NEW.directory_publication_state = ''active'' AND OLD.directory_publication_state <> ''disabled''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_created_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_created_insert' AND sql='CREATE TRIGGER account_webhook_created_insert AFTER INSERT ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.created'', a.registration_state, NULL, NULL, (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.directory_publication_state = ''active''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_deleted', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_deleted' AND sql='CREATE TRIGGER account_webhook_deleted AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.deleted'', a.registration_state, NULL, NULL, (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state = ''deleted'' AND OLD.lifecycle_state <> ''deleted''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_profile_attribute_values_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_profile_attribute_values_delete' AND sql='CREATE TRIGGER account_webhook_profile_attribute_values_delete AFTER DELETE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''profile'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = OLD.profile_id AND p.tenant_id = OLD.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_profile_attribute_values_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_profile_attribute_values_insert' AND sql='CREATE TRIGGER account_webhook_profile_attribute_values_insert AFTER INSERT ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''profile'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_profile_attribute_values_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_profile_attribute_values_update' AND sql='CREATE TRIGGER account_webhook_profile_attribute_values_update AFTER UPDATE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''profile'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_profiles_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_profiles_delete' AND sql='CREATE TRIGGER account_webhook_profiles_delete AFTER DELETE ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''profile'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.primary_subject_id = OLD.subject_id) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_profiles_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_profiles_insert' AND sql='CREATE TRIGGER account_webhook_profiles_insert AFTER INSERT ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''profile'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_profiles_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_profiles_update' AND sql='CREATE TRIGGER account_webhook_profiles_update AFTER UPDATE ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''profile'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = ''active'' AND a.lifecycle_state NOT IN (''deleted'', ''deleting''));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_registration', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_registration' AND sql='CREATE TRIGGER account_webhook_registration AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.registration.changed'', a.registration_state, OLD.registration_state, ''registration_state'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.registration_state <> NEW.registration_state AND (NEW.registration_state = ''guest'' OR NOT EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id = NEW.tenant_id AND g.user_id = NEW.legacy_user_id AND g.phase <> ''registered''))));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:account_webhook_updated', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='account_webhook_updated' AND sql='CREATE TRIGGER account_webhook_updated AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT ''evt_'' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, ''account.updated'', a.registration_state, NULL, ''account'', (CAST(strftime(''%s'', ''now'') AS INTEGER) * 1000 + CAST(substr(strftime(''%f'', ''now''), 4, 3) AS INTEGER)) FROM identity_accounts a WHERE a.account_type = ''user'' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state NOT IN (''deleted'', ''deleting'') AND OLD.directory_publication_state = ''active'' AND NEW.registration_state = OLD.registration_state AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.display_label IS DISTINCT FROM OLD.display_label OR NEW.metadata_json IS DISTINCT FROM OLD.metadata_json)));
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_contact_points_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_contact_points_delete' AND sql='CREATE TRIGGER sg_contact_points_delete AFTER DELETE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id), 1 WHERE (OLD.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_contact_points_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_contact_points_insert' AND sql='CREATE TRIGGER sg_contact_points_insert AFTER INSERT ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_contact_points_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_contact_points_update' AND sql='CREATE TRIGGER sg_contact_points_update AFTER UPDATE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_epoch_custom_claim_schemas_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_epoch_custom_claim_schemas_delete' AND sql='CREATE TRIGGER sg_epoch_custom_claim_schemas_delete AFTER DELETE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_epoch_custom_claim_schemas_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_epoch_custom_claim_schemas_insert' AND sql='CREATE TRIGGER sg_epoch_custom_claim_schemas_insert AFTER INSERT ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_epoch_custom_claim_schemas_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_epoch_custom_claim_schemas_update' AND sql='CREATE TRIGGER sg_epoch_custom_claim_schemas_update AFTER UPDATE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_epoch_roles_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_epoch_roles_delete' AND sql='CREATE TRIGGER sg_epoch_roles_delete AFTER DELETE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_epoch_roles_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_epoch_roles_insert' AND sql='CREATE TRIGGER sg_epoch_roles_insert AFTER INSERT ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_epoch_roles_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_epoch_roles_update' AND sql='CREATE TRIGGER sg_epoch_roles_update AFTER UPDATE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_identity_accounts_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_identity_accounts_delete' AND sql='CREATE TRIGGER sg_identity_accounts_delete AFTER DELETE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.legacy_user_id, 1 WHERE (OLD.legacy_user_id IS NOT NULL) AND OLD.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_identity_accounts_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_identity_accounts_insert' AND sql='CREATE TRIGGER sg_identity_accounts_insert AFTER INSERT ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_identity_accounts_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_identity_accounts_update' AND sql='CREATE TRIGGER sg_identity_accounts_update AFTER UPDATE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_user_roles_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_user_roles_delete' AND sql='CREATE TRIGGER sg_user_roles_delete AFTER DELETE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_user_roles_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_user_roles_insert' AND sql='CREATE TRIGGER sg_user_roles_insert AFTER INSERT ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_user_roles_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_user_roles_update' AND sql='CREATE TRIGGER sg_user_roles_update AFTER UPDATE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_write_boundary_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_write_boundary_delete' AND sql='CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_write_boundary_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_write_boundary_insert' AND sql='CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_creation_operation_status_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_creation_operation_status_transition' AND sql='CREATE TRIGGER trg_account_creation_operation_status_transition
BEFORE UPDATE OF status ON account_creation_operations
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = ''preparing'' AND NEW.status IN (''reserved'', ''blocked'', ''canceled'')) OR
  (OLD.status = ''reserved'' AND NEW.status IN (''writing'', ''blocked'', ''canceled'')) OR
  (OLD.status = ''writing'' AND NEW.status IN (''directory_pending'', ''succeeded'', ''blocked'')) OR
  (OLD.status = ''directory_pending'' AND NEW.status IN (''succeeded'', ''blocked'')) OR
  (OLD.status = ''blocked'' AND NEW.status IN (''reserved'', ''writing'', ''directory_pending'', ''canceled''))
)
BEGIN
  SELECT RAISE(ABORT, ''invalid_account_creation_operation_status_transition'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_lifecycle_event_outbox_initial_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_lifecycle_event_outbox_initial_state' AND sql='CREATE TRIGGER trg_account_lifecycle_event_outbox_initial_state
BEFORE INSERT ON account_lifecycle_event_outbox
WHEN NEW.status <> ''pending'' OR NEW.attempt_count <> 0
BEGIN
  SELECT RAISE(ABORT, ''invalid_account_lifecycle_event_initial_state'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_lifecycle_event_outbox_status_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_lifecycle_event_outbox_status_transition' AND sql='CREATE TRIGGER trg_account_lifecycle_event_outbox_status_transition
BEFORE UPDATE OF status ON account_lifecycle_event_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = ''pending'' AND NEW.status IN (''leased'', ''succeeded'', ''dead_letter'')) OR
  (OLD.status = ''leased'' AND NEW.status IN (''retry'', ''succeeded'', ''dead_letter'')) OR
  (OLD.status = ''retry'' AND NEW.status IN (''leased'', ''succeeded'', ''dead_letter''))
)
BEGIN
  SELECT RAISE(ABORT, ''invalid_account_lifecycle_event_status_transition'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_routing_outbox_status_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_routing_outbox_status_transition' AND sql='CREATE TRIGGER trg_account_routing_outbox_status_transition
BEFORE UPDATE OF status ON account_routing_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = ''prepared'' AND NEW.status IN (''pending'', ''blocked'')) OR
  (OLD.status = ''pending'' AND NEW.status IN (''leased'', ''succeeded'', ''blocked'')) OR
  (OLD.status = ''leased'' AND NEW.status IN (''retry'', ''succeeded'', ''blocked'', ''dead_letter'')) OR
  (OLD.status = ''retry'' AND NEW.status IN (''leased'', ''succeeded'', ''blocked'', ''dead_letter''))
)
BEGIN
  SELECT RAISE(ABORT, ''invalid_account_routing_outbox_status_transition'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_support_context_account_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_support_context_account_immutable' AND sql='CREATE TRIGGER trg_account_support_context_account_immutable
BEFORE UPDATE OF tenant_id, account_id ON account_support_contexts
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.account_id <> NEW.account_id
BEGIN
  SELECT RAISE(ABORT, ''account_support_context_account_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_support_context_account_tenant_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_support_context_account_tenant_insert' AND sql='CREATE TRIGGER trg_account_support_context_account_tenant_insert
BEFORE INSERT ON account_support_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, ''account_support_context_account_not_found'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_support_context_active_hold_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_support_context_active_hold_delete' AND sql='CREATE TRIGGER trg_account_support_context_active_hold_delete
BEFORE DELETE ON account_support_contexts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = ''account''
     AND hold.subject_id = OLD.account_id AND hold.state = ''active''
)
BEGIN
  SELECT RAISE(ABORT, ''account_support_context_legal_hold_active'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_account_support_context_version', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_account_support_context_version' AND sql='CREATE TRIGGER trg_account_support_context_version
BEFORE UPDATE ON account_support_contexts
WHEN NEW.version <> OLD.version + 1 OR NEW.created_by <> OLD.created_by OR
     NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, ''account_support_context_version_invalid'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_identity_accounts_active_hold_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_identity_accounts_active_hold_delete' AND sql='CREATE TRIGGER trg_identity_accounts_active_hold_delete
BEFORE DELETE ON identity_accounts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = ''account''
     AND hold.subject_id = OLD.id AND hold.state = ''active''
)
BEGIN
  SELECT RAISE(ABORT, ''account_legal_hold_active'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_identity_accounts_legal_hold_state_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_identity_accounts_legal_hold_state_insert' AND sql='CREATE TRIGGER trg_identity_accounts_legal_hold_state_insert
AFTER INSERT ON identity_accounts
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.id, NULL, ''inactive'', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO NOTHING;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_hold_events_immutable_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_hold_events_immutable_delete' AND sql='CREATE TRIGGER trg_legal_hold_events_immutable_delete
BEFORE DELETE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, ''legal_hold_event_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_hold_events_immutable_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_hold_events_immutable_update' AND sql='CREATE TRIGGER trg_legal_hold_events_immutable_update
BEFORE UPDATE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, ''legal_hold_event_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_holds_account_tenant_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_holds_account_tenant_insert' AND sql='CREATE TRIGGER trg_legal_holds_account_tenant_insert
BEFORE INSERT ON legal_holds
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.subject_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, ''legal_hold_account_not_found'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_holds_account_tenant_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_holds_account_tenant_update' AND sql='CREATE TRIGGER trg_legal_holds_account_tenant_update
BEFORE UPDATE OF tenant_id, subject_type, subject_id ON legal_holds
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.subject_type <> NEW.subject_type OR
     OLD.subject_id <> NEW.subject_id
BEGIN
  SELECT RAISE(ABORT, ''legal_hold_subject_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_holds_immutable_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_holds_immutable_delete' AND sql='CREATE TRIGGER trg_legal_holds_immutable_delete
BEFORE DELETE ON legal_holds
BEGIN
  SELECT RAISE(ABORT, ''legal_hold_delete_forbidden'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_holds_one_active_account_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_holds_one_active_account_insert' AND sql='CREATE TRIGGER trg_legal_holds_one_active_account_insert
BEFORE INSERT ON legal_holds
WHEN NEW.state = ''active'' AND EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = NEW.tenant_id AND hold.subject_type = NEW.subject_type
     AND hold.subject_id = NEW.subject_id AND hold.state = ''active'' AND hold.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, ''legal_hold_active_conflict'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_holds_projection_state_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_holds_projection_state_insert' AND sql='CREATE TRIGGER trg_legal_holds_projection_state_insert
AFTER INSERT ON legal_holds
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.subject_id, NEW.id, ''active'', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO UPDATE SET
    active_hold_id = excluded.active_hold_id,
    projection_state = ''active'',
    projection_generation = account_legal_hold_states.projection_generation + 1,
    updated_at = excluded.updated_at;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_holds_projection_state_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_holds_projection_state_update' AND sql='CREATE TRIGGER trg_legal_holds_projection_state_update
AFTER UPDATE OF state ON legal_holds
WHEN OLD.state = ''active'' AND NEW.state IN (''released'', ''expired'')
BEGIN
  UPDATE account_legal_hold_states
     SET active_hold_id = NULL, projection_state = ''inactive'',
         projection_generation = projection_generation + 1, updated_at = NEW.updated_at
   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.subject_id
     AND active_hold_id = NEW.id AND projection_state = ''active'';
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_legal_holds_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_legal_holds_transition' AND sql='CREATE TRIGGER trg_legal_holds_transition
BEFORE UPDATE ON legal_holds
WHEN NOT (
  OLD.state = ''active'' AND NEW.state IN (''active'', ''released'', ''expired'') AND
  NEW.version = OLD.version + 1 AND NEW.created_by = OLD.created_by AND
  NEW.created_at = OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, ''legal_hold_transition_invalid'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_notification_delivery_history_recipient_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_notification_delivery_history_recipient_immutable' AND sql='CREATE TRIGGER trg_notification_delivery_history_recipient_immutable
BEFORE UPDATE OF account_id, recipient_masked, recipient_encrypted,
  recipient_encryption_key_version, created_at
ON notification_delivery_intents
BEGIN
  SELECT RAISE(ABORT, ''notification_delivery_history_recipient_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_notification_delivery_intent_initial_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_notification_delivery_intent_initial_state' AND sql='CREATE TRIGGER trg_notification_delivery_intent_initial_state
BEFORE INSERT ON notification_delivery_intents
WHEN NEW.state <> ''pending''
BEGIN
  SELECT RAISE(ABORT, ''invalid_notification_delivery_intent_initial_state'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_notification_delivery_intent_payload_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_notification_delivery_intent_payload_immutable' AND sql='CREATE TRIGGER trg_notification_delivery_intent_payload_immutable
BEFORE UPDATE OF payload_key_id, payload_envelope_json, tenant_id, plugin_installation_id,
  provider_order_version, provider_installation_ids_json, channel, notification_kind,
  payload_version, idempotency_key, request_fingerprint,
  fingerprint_key_id, expires_at, created_at
ON notification_delivery_intents
WHEN OLD.state <> ''pending''
  OR NEW.payload_key_id IS NOT NULL
  OR NEW.payload_envelope_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, ''notification_delivery_intent_payload_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_notification_delivery_intent_state_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_notification_delivery_intent_state_transition' AND sql='CREATE TRIGGER trg_notification_delivery_intent_state_transition
BEFORE UPDATE OF state ON notification_delivery_intents
WHEN OLD.state <> NEW.state AND NOT (
  OLD.state = ''pending'' AND NEW.state IN (''delivered'', ''canceled'', ''expired'', ''dead_letter'')
)
BEGIN
  SELECT RAISE(ABORT, ''invalid_notification_delivery_intent_state_transition'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_hook_outbox_claim_fencing', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_hook_outbox_claim_fencing' AND sql='CREATE TRIGGER trg_plugin_hook_outbox_claim_fencing
BEFORE UPDATE ON plugin_hook_outbox
WHEN NEW.status = ''locked'' AND (
  (OLD.status IN (''queued'', ''waiting_retry'') AND NEW.attempt_no <> OLD.attempt_no + 1) OR
  (OLD.status = ''locked'' AND (
    NOT (
      (NEW.claim_token = OLD.claim_token AND NEW.attempt_no = OLD.attempt_no) OR
      (OLD.lease_until <= NEW.updated_at AND NEW.claim_token <> OLD.claim_token
        AND NEW.attempt_no = OLD.attempt_no + 1)
    )
  ))
)
BEGIN
  SELECT RAISE(ABORT, ''invalid_plugin_hook_outbox_claim_fencing'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_hook_outbox_initial_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_hook_outbox_initial_state' AND sql='CREATE TRIGGER trg_plugin_hook_outbox_initial_state
BEFORE INSERT ON plugin_hook_outbox
WHEN NEW.status <> ''queued''
BEGIN
  SELECT RAISE(ABORT, ''invalid_plugin_hook_outbox_initial_state'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_hook_outbox_status_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_hook_outbox_status_transition' AND sql='CREATE TRIGGER trg_plugin_hook_outbox_status_transition
BEFORE UPDATE OF status ON plugin_hook_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = ''queued'' AND NEW.status IN (''locked'', ''canceled'')) OR
  (OLD.status = ''locked'' AND NEW.status IN (''waiting_retry'', ''succeeded'', ''dead_letter'', ''canceled'')) OR
  (OLD.status = ''waiting_retry'' AND NEW.status IN (''locked'', ''dead_letter'', ''canceled''))
)
BEGIN
  SELECT RAISE(ABORT, ''invalid_plugin_hook_outbox_status_transition'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_identity_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_identity_immutable' AND sql='CREATE TRIGGER trg_tenant_placement_capture_identity_immutable
BEFORE UPDATE OF operation_id, tenant_id, source_shard_id, migration_generation
ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_identity_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_no_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_no_delete' AND sql='CREATE TRIGGER trg_tenant_placement_capture_no_delete
BEFORE DELETE ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_delete_forbidden'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_one_active_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_one_active_insert' AND sql='CREATE TRIGGER trg_tenant_placement_capture_one_active_insert
BEFORE INSERT ON tenant_placement_migration_captures
WHEN NEW.capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'')
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_active_conflict'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_one_active_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_one_active_update' AND sql='CREATE TRIGGER trg_tenant_placement_capture_one_active_update
BEFORE UPDATE OF tenant_id, capture_state ON tenant_placement_migration_captures
WHEN NEW.capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND operation_id <> OLD.operation_id
     AND capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'')
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_active_conflict'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_transition' AND sql='CREATE TRIGGER trg_tenant_placement_capture_transition
BEFORE UPDATE OF capture_state ON tenant_placement_migration_captures
WHEN NOT (
  (OLD.capture_state = ''capturing'' AND NEW.capture_state IN (''write_fenced'', ''canceled'')) OR
  (OLD.capture_state = ''write_fenced'' AND NEW.capture_state IN (''capturing'', ''cutover_committed'', ''canceled'')) OR
  OLD.capture_state = NEW.capture_state
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_transition_invalid'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_outbox_payload_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_outbox_payload_immutable' AND sql='CREATE TRIGGER trg_tenant_placement_outbox_payload_immutable
BEFORE UPDATE OF source_sequence, operation_id, tenant_id, table_name, mutation_kind,
                 mutation_key_json, row_json, capture_fencing_token, created_at
ON tenant_placement_migration_outbox
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_outbox_payload_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_policy_no_scope_weakening', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_policy_no_scope_weakening' AND sql='CREATE TRIGGER trg_tenant_placement_policy_no_scope_weakening
BEFORE UPDATE OF isolation_policy ON tenants
WHEN OLD.isolation_policy = ''tenant_exclusive''
  AND NEW.isolation_policy <> ''tenant_exclusive''
  AND NOT (
    OLD.id = ''default''
    AND OLD.created_at = OLD.updated_at
    AND (SELECT COUNT(*) FROM tenants) = 1
  )
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_policy_scope_weakening'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenants_lookup_retention_policy_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenants_lookup_retention_policy_insert' AND sql='CREATE TRIGGER trg_tenants_lookup_retention_policy_insert
AFTER INSERT ON tenants
BEGIN
  INSERT INTO lookup_retention_policies (
    tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
  ) VALUES (NEW.id, 180, 1, ''tenant-default'', NEW.created_at, NEW.updated_at)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO lookup_retention_policy_projection_outbox (
    operation_id, tenant_id, policy_generation, retention_days,
    next_attempt_at, created_at, updated_at
  )
  SELECT ''lookup-retention-policy:init:'' || lower(hex(randomblob(16))),
         tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
    FROM lookup_retention_policies WHERE tenant_id = NEW.id
  ON CONFLICT (tenant_id, policy_generation) DO NOTHING;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-schema-objects', (SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN ('access_review_items','access_reviews','account_creation_operations','account_lifecycle_event_outbox','account_routing_outbox','account_support_contexts','account_webhook_outbox','admin_jobs','assurance_evidence','attribute_release_consents','attribute_verifications','audit_log','authrim_migrations','authrim_runtime_probes','branding_settings','check_api_keys','ciba_requests','client_consent_overrides','client_trust_policies','compliance_reports','consent_history','consent_item_history','consent_policies','consent_policy_items','consent_policy_versions','consent_records','consent_statement_localizations','consent_statement_versions','consent_statements','contact_point_search_indexes','contact_points','contact_verifications','credential_configurations','credential_offers','custom_claim_schema_history','custom_claim_schemas','data_export_requests','delegations','device_codes','device_installations','device_secrets','did_document_cache','directory_auth_config_history','directory_auth_evidence_exports','directory_auth_migration_campaigns','directory_auth_migration_transaction_events','directory_auth_migration_transactions','directory_auth_migration_user_states','directory_auth_release_advisories','directory_auth_retention_policies','directory_auth_support_bundles','directory_auth_tenant_policies','directory_connector_instances','directory_connector_status_episodes','directory_identity_links','directory_jit_pending_users','entitlements','event_log','external_idp_auth_states','external_lifecycle_signal_decisions','external_lifecycle_signal_events','field_usage_bindings','flow_assignments','flow_audit_events','flow_interaction_steps','flow_interactions','flow_versions','group_memberships','groups','guest_account_upgrades','guest_deletion_audit_outbox','guest_devices','idempotency_keys','identity_accounts','identity_binding_lookup_indexes','identity_bindings','identity_providers','identity_resolution_candidates','identity_resolution_events','identity_subjects','internal_notification_delivery_attempts','internal_notification_delivery_routes','internal_notification_events','issued_credentials','legal_hold_events','legal_hold_projection_outbox','legal_holds','log_chunk_manifests','log_object_catalog','logging_catalog_repair_jobs','logging_quota_evaluations','logging_quota_policies','logging_usage_aggregates','lookup_retention_policies','lookup_retention_policy_projection_outbox','migration_metadata','notification_delivery_intents','oauth_client_consents','object_catalog','object_catalog_objects','oidc_scopes','operational_logs','org_domain_mappings','organizations','passkeys','password_reset_tokens','permission_change_audit','permission_check_audit','plugin_account_metadata','plugin_hook_outbox','presentation_definitions','profile_attribute_values','profiles','provisioning_assignment_events','provisioning_assignment_ownership','provisioning_assignment_rules','provisioning_revocation_events','refresh_token_shard_configs','relation_definitions','relationship_closure','relationships','resource_permissions','role_assignment_rules','role_assignments','roles','saml_attribute_presets','screens','security_alerts','security_threats','sensitive_detail_chunk_index','service_group_audit','service_group_catalog','service_group_epoch','service_group_write_boundaries','sessions','settings_history','sign_in_confirmation_policies','status_lists','structured_attribute_values','subject_account_links','subject_lifecycle_timeline_events','subject_org_membership','support_operation_actions','support_operation_cohort_targets','support_operation_cohorts','suspicious_activities','tenant_consent_requirements','tenant_database_migration_state','tenant_database_probe_results','tenant_domain_mappings','tenant_invitations','tenant_placement_migration_captures','tenant_placement_migration_outbox','tenant_vanity_domains','tenants','token_claim_rules','totp_backup_codes','totp_credentials','trusted_issuers','upstream_providers','user_consent_records','user_roles','user_token_families','user_verified_attributes','users','users_core','value_provenance','vp_requests','web_origin_registry','webhook_configs','webhook_deliveries','webhook_delivery_logs'))) AND name NOT IN ('idx_access_review_items_decision','idx_access_review_items_review','idx_access_review_items_user','idx_access_reviews_created','idx_access_reviews_due','idx_access_reviews_reviewer','idx_access_reviews_status','idx_access_reviews_tenant','idx_account_creation_operations_status','idx_account_lifecycle_event_outbox_due','idx_account_routing_outbox_account_event_route','idx_account_routing_outbox_due','idx_account_webhook_outbox_due','idx_admin_jobs_cleanup','idx_admin_jobs_object_catalog','idx_admin_jobs_status','idx_admin_jobs_tenant','idx_admin_jobs_type','idx_assurance_evidence_subject','idx_attribute_release_consents_destination','idx_attribute_verifications_result','idx_attribute_verifications_runtime_validity','idx_attribute_verifications_user','idx_audit_log_action','idx_audit_log_created_at','idx_audit_log_resource','idx_audit_log_tenant_id','idx_audit_log_user_id','idx_cco_client','idx_ccs_operation','idx_ccs_tenant_active','idx_ccs_tenant_key','idx_ccsh_cleanup','idx_ccsh_schema','idx_check_api_keys_client','idx_check_api_keys_hash','idx_check_api_keys_prefix','idx_check_api_keys_tenant_active','idx_ciba_client','idx_ciba_status','idx_ciba_user','idx_cih_retain_until','idx_cih_statement','idx_cih_tenant','idx_cih_user','idx_client_trust_policies_target','idx_closure_ancestor_lookup','idx_closure_depth','idx_closure_descendant_lookup','idx_closure_unique','idx_compliance_reports_created','idx_compliance_reports_requested','idx_compliance_reports_status','idx_compliance_reports_tenant','idx_compliance_reports_type','idx_consent_history_action','idx_consent_history_client','idx_consent_history_tenant','idx_consent_history_user','idx_consent_policy_items_policy','idx_consent_policy_versions_effective','idx_consent_policy_versions_tenant','idx_consent_records_flow','idx_consent_records_recipient','idx_consent_records_statement','idx_consent_records_subject','idx_consent_statements_tenant','idx_consents_client','idx_consents_expires_at_active','idx_consents_user','idx_contact_points_lookup','idx_contact_points_subject','idx_contact_verifications_contact','idx_credential_configurations_tenant','idx_credential_offers_code','idx_credential_offers_status','idx_csl_version','idx_csv_effective','idx_csv_statement','idx_csv_unique_current','idx_data_export_expires','idx_data_export_object_catalog','idx_data_export_status','idx_data_export_user','idx_device_codes_client_id','idx_device_codes_expires_at','idx_device_codes_status','idx_device_codes_user_code','idx_device_installations_client','idx_device_installations_linked_secret','idx_device_installations_source','idx_device_installations_trust_group','idx_device_installations_user','idx_device_secrets_active_expires','idx_device_secrets_client','idx_device_secrets_installation','idx_device_secrets_secret_hash','idx_device_secrets_session_id','idx_device_secrets_tenant_user','idx_device_secrets_trust_group','idx_did_document_cache_expires','idx_directory_auth_config_history_tenant_time','idx_directory_auth_evidence_exports_object_catalog','idx_directory_auth_evidence_exports_retention','idx_directory_auth_evidence_exports_status','idx_directory_auth_migration_campaigns_status','idx_directory_auth_migration_transaction_events_txn','idx_directory_auth_migration_transactions_state','idx_directory_auth_migration_transactions_user','idx_directory_auth_migration_user_states_cohort','idx_directory_auth_migration_user_states_status','idx_directory_auth_migration_user_states_user','idx_directory_auth_release_advisories_channel_time','idx_directory_auth_support_bundles_object_catalog','idx_directory_auth_support_bundles_retention','idx_directory_auth_support_bundles_status','idx_directory_connector_instances_connector','idx_directory_connector_status_episodes_current','idx_directory_connector_status_episodes_recent','idx_directory_identity_links_user','idx_directory_jit_pending_users_status','idx_entitlements_subject','idx_event_log_tenant_anon_created','idx_event_log_tenant_category_created','idx_event_log_tenant_client_created','idx_event_log_tenant_created','idx_event_log_tenant_retention','idx_event_log_tenant_type_created','idx_external_idp_auth_states_consumed_at','idx_external_idp_auth_states_expires_at','idx_external_idp_auth_states_state','idx_field_usage_bindings_binding','idx_field_usage_bindings_protection','idx_field_usage_bindings_tenant_field','idx_flow_assignments_flow','idx_flow_assignments_target','idx_flow_assignments_target_unique','idx_flow_assignments_tenant_default','idx_flow_audit_events_flow','idx_flow_audit_events_interaction','idx_flow_interaction_steps_node','idx_flow_interaction_steps_state','idx_flow_interactions_expiration','idx_flow_interactions_lookup','idx_flow_interactions_state_expiration','idx_flow_interactions_state_updated','idx_flow_versions_lookup','idx_flow_versions_published','idx_group_memberships_subject','idx_groups_tenant_state','idx_guest_account_upgrades_target','idx_guest_account_upgrades_user','idx_guest_deletion_audit_outbox_due','idx_guest_devices_active_resume_credential','idx_guest_devices_expiry','idx_guest_devices_user','idx_idempotency_keys_expires','idx_idempotency_keys_lookup','idx_identity_accounts_directory_publication','idx_identity_accounts_legacy_user','idx_identity_accounts_registration_state','idx_identity_accounts_tenant_state','idx_identity_bindings_subject','idx_identity_providers_saml_entity_id','idx_identity_providers_type','idx_identity_resolution_candidates_state','idx_identity_resolution_events_subject','idx_identity_subjects_tenant_type','idx_internal_notification_delivery_attempts_event','idx_internal_notification_delivery_attempts_retry','idx_internal_notification_delivery_routes_lookup','idx_internal_notification_events_dedup','idx_internal_notification_events_pending','idx_internal_notification_events_tenant_created','idx_issued_credentials_status','idx_issued_credentials_status_list','idx_issued_credentials_type','idx_issued_credentials_user','idx_legal_hold_events_account','idx_legal_hold_projection_outbox_runnable','idx_legal_holds_account_history','idx_legal_holds_expiry','idx_log_chunk_manifests_bucket','idx_log_object_catalog_object_key','idx_log_object_catalog_status','idx_log_object_catalog_tenant_type_time','idx_logging_catalog_repair_jobs_queue','idx_logging_quota_evaluations_state','idx_logging_quota_policies_lookup','idx_logging_usage_aggregates_window','idx_lookup_retention_policy_projection_outbox_runnable','idx_membership_org','idx_membership_subject','idx_notification_delivery_history_account_created','idx_notification_delivery_history_tenant_created','idx_notification_delivery_intents_pending','idx_notification_delivery_intents_retention','idx_object_catalog_deleted_at','idx_object_catalog_tenant_class_created','idx_odm_lookup','idx_odm_org','idx_odm_verification_status','idx_odm_version','idx_oidc_scopes_enabled','idx_operational_logs_actor','idx_operational_logs_detail_object_catalog','idx_operational_logs_expires','idx_operational_logs_subject','idx_operational_logs_tenant_created','idx_organizations_is_active','idx_organizations_org_type','idx_organizations_parent_org_id','idx_organizations_tenant_id','idx_organizations_tenant_name','idx_passkeys_credential','idx_passkeys_routing_authority','idx_passkeys_tenant','idx_passkeys_user','idx_password_reset_user','idx_pca_api_key','idx_pca_checked_at','idx_pca_denied','idx_pca_tenant_subject','idx_pcaudit_event_type','idx_pcaudit_tenant_subject','idx_pcaudit_timestamp','idx_plugin_account_metadata_installation','idx_plugin_hook_outbox_due','idx_plugin_hook_outbox_retention','idx_presentation_definitions_tenant','idx_profile_attribute_values_profile','idx_rar_evaluation','idx_rar_role','idx_relation_defs_active','idx_relation_defs_lookup','idx_relation_defs_tenant_object','idx_relation_defs_unique','idx_relationships_evidence_type','idx_relationships_expires_at','idx_relationships_from','idx_relationships_tenant_id','idx_relationships_to','idx_relationships_type','idx_relationships_unique','idx_role_assignments_role','idx_role_assignments_subject','idx_roles_hierarchy_level','idx_roles_name','idx_roles_parent_role_id','idx_roles_role_type','idx_roles_tenant_id','idx_rp_expires','idx_rp_lookup','idx_rp_resource','idx_rtsc_activated_at','idx_rtsc_generation','idx_rtsc_tenant_client','idx_saml_attribute_presets_applies_to','idx_saml_attribute_presets_tenant','idx_screens_kind','idx_security_alerts_tenant_created','idx_security_alerts_tenant_severity','idx_security_alerts_tenant_status','idx_security_alerts_tenant_type','idx_security_alerts_user','idx_security_threats_detected','idx_security_threats_severity','idx_security_threats_status','idx_security_threats_tenant','idx_security_threats_type','idx_service_group_audit_subject','idx_service_group_write_boundaries_subject','idx_sessions_expires','idx_sessions_external_provider_sid','idx_sessions_tenant','idx_sessions_user','idx_settings_history_actor','idx_settings_history_category','idx_settings_history_cleanup','idx_soa_approval_request','idx_soa_cohort','idx_soa_tenant_created','idx_soa_tenant_status','idx_soc_selector_hash','idx_soc_snapshot_status','idx_soc_tenant_created','idx_soc_tenant_expires','idx_soct_cohort','idx_soct_cohort_block','idx_status_lists_tenant','idx_status_lists_tenant_public','idx_structured_attribute_values_owner','idx_subject_account_links_account','idx_subject_lifecycle_timeline_subject','idx_suspicious_activities_created','idx_suspicious_activities_severity','idx_suspicious_activities_tenant','idx_suspicious_activities_type','idx_suspicious_activities_user','idx_tcr_evaluation','idx_tcr_tenant','idx_tdm_domain_hash','idx_tdm_domain_lookup','idx_tdm_tenant','idx_tdm_verified','idx_tenant_database_probe_results_scope','idx_tenant_placement_capture_tenant_state','idx_tenant_placement_outbox_pending','idx_tenants_is_default','idx_ti_tenant','idx_ti_token','idx_token_families_client','idx_token_families_user','idx_totp_backup_codes_unused','idx_totp_backup_codes_user','idx_totp_credentials_active_user','idx_totp_credentials_tenant_user','idx_trusted_issuers_did','idx_trusted_issuers_tenant','idx_tvd_hostname_active','idx_tvd_hostname_lookup','idx_tvd_primary_active','idx_tvd_primary_lookup','idx_tvd_status','idx_tvd_tenant','idx_ucr_expires','idx_ucr_retain_until','idx_ucr_statement','idx_ucr_status','idx_ucr_user','idx_upstream_providers_enable_sso','idx_upstream_providers_enabled','idx_upstream_providers_tenant_id','idx_upstream_providers_tenant_name','idx_upstream_providers_tenant_slug','idx_user_roles_role','idx_user_verified_attributes_name','idx_user_verified_attributes_user','idx_users_core_email_domain','idx_users_core_partition','idx_users_core_pii_status','idx_users_core_status','idx_users_core_tenant','idx_users_core_tenant_external_id','idx_users_core_type','idx_users_created_at','idx_users_tenant_email','idx_users_tenant_id','idx_users_tenant_status','idx_users_user_type','idx_value_provenance_owner','idx_vp_requests_nonce','idx_vp_requests_tenant_status','idx_web_origin_registry_client','idx_web_origin_registry_origin','idx_webhook_configs_active','idx_webhook_configs_client','idx_webhook_configs_scope','idx_webhook_configs_tenant','idx_webhook_deliveries_detail_object_catalog','idx_webhook_deliveries_status_created','idx_webhook_deliveries_tenant_created','idx_webhook_deliveries_webhook_created','idx_webhook_delivery_logs_created','idx_webhook_delivery_logs_event','idx_webhook_delivery_logs_tenant','idx_webhook_delivery_logs_webhook','uniq_ccs_active_key','account_webhook_contact_points_delete','account_webhook_contact_points_insert','account_webhook_contact_points_update','account_webhook_created_activate','account_webhook_created_insert','account_webhook_deleted','account_webhook_profile_attribute_values_delete','account_webhook_profile_attribute_values_insert','account_webhook_profile_attribute_values_update','account_webhook_profiles_delete','account_webhook_profiles_insert','account_webhook_profiles_update','account_webhook_registration','account_webhook_updated','sg_contact_points_delete','sg_contact_points_insert','sg_contact_points_update','sg_epoch_custom_claim_schemas_delete','sg_epoch_custom_claim_schemas_insert','sg_epoch_custom_claim_schemas_update','sg_epoch_roles_delete','sg_epoch_roles_insert','sg_epoch_roles_update','sg_identity_accounts_delete','sg_identity_accounts_insert','sg_identity_accounts_update','sg_user_roles_delete','sg_user_roles_insert','sg_user_roles_update','sg_write_boundary_delete','sg_write_boundary_insert','trg_account_creation_operation_status_transition','trg_account_lifecycle_event_outbox_initial_state','trg_account_lifecycle_event_outbox_status_transition','trg_account_routing_outbox_status_transition','trg_account_support_context_account_immutable','trg_account_support_context_account_tenant_insert','trg_account_support_context_active_hold_delete','trg_account_support_context_version','trg_identity_accounts_active_hold_delete','trg_identity_accounts_legal_hold_state_insert','trg_legal_hold_events_immutable_delete','trg_legal_hold_events_immutable_update','trg_legal_holds_account_tenant_insert','trg_legal_holds_account_tenant_update','trg_legal_holds_immutable_delete','trg_legal_holds_one_active_account_insert','trg_legal_holds_projection_state_insert','trg_legal_holds_projection_state_update','trg_legal_holds_transition','trg_notification_delivery_history_recipient_immutable','trg_notification_delivery_intent_initial_state','trg_notification_delivery_intent_payload_immutable','trg_notification_delivery_intent_state_transition','trg_plugin_hook_outbox_claim_fencing','trg_plugin_hook_outbox_initial_state','trg_plugin_hook_outbox_status_transition','trg_tenant_placement_capture_identity_immutable','trg_tenant_placement_capture_no_delete','trg_tenant_placement_capture_one_active_insert','trg_tenant_placement_capture_one_active_update','trg_tenant_placement_capture_transition','trg_tenant_placement_outbox_payload_immutable','trg_tenant_placement_policy_no_scope_weakening','trg_tenants_lookup_retention_policy_insert')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-dependent-table', (WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN ('access_review_items','access_reviews','account_creation_operations','account_lifecycle_event_outbox','account_routing_outbox','account_support_contexts','account_webhook_outbox','admin_jobs','assurance_evidence','attribute_release_consents','attribute_verifications','audit_log','authrim_migrations','authrim_runtime_probes','branding_settings','check_api_keys','ciba_requests','client_consent_overrides','client_trust_policies','compliance_reports','consent_history','consent_item_history','consent_policies','consent_policy_items','consent_policy_versions','consent_records','consent_statement_localizations','consent_statement_versions','consent_statements','contact_point_search_indexes','contact_points','contact_verifications','credential_configurations','credential_offers','custom_claim_schema_history','custom_claim_schemas','data_export_requests','delegations','device_codes','device_installations','device_secrets','did_document_cache','directory_auth_config_history','directory_auth_evidence_exports','directory_auth_migration_campaigns','directory_auth_migration_transaction_events','directory_auth_migration_transactions','directory_auth_migration_user_states','directory_auth_release_advisories','directory_auth_retention_policies','directory_auth_support_bundles','directory_auth_tenant_policies','directory_connector_instances','directory_connector_status_episodes','directory_identity_links','directory_jit_pending_users','entitlements','event_log','external_idp_auth_states','external_lifecycle_signal_decisions','external_lifecycle_signal_events','field_usage_bindings','flow_assignments','flow_audit_events','flow_interaction_steps','flow_interactions','flow_versions','group_memberships','groups','guest_account_upgrades','guest_deletion_audit_outbox','guest_devices','idempotency_keys','identity_accounts','identity_binding_lookup_indexes','identity_bindings','identity_providers','identity_resolution_candidates','identity_resolution_events','identity_subjects','internal_notification_delivery_attempts','internal_notification_delivery_routes','internal_notification_events','issued_credentials','legal_hold_events','legal_hold_projection_outbox','legal_holds','log_chunk_manifests','log_object_catalog','logging_catalog_repair_jobs','logging_quota_evaluations','logging_quota_policies','logging_usage_aggregates','lookup_retention_policies','lookup_retention_policy_projection_outbox','migration_metadata','notification_delivery_intents','oauth_client_consents','object_catalog','object_catalog_objects','oidc_scopes','operational_logs','org_domain_mappings','organizations','passkeys','password_reset_tokens','permission_change_audit','permission_check_audit','plugin_account_metadata','plugin_hook_outbox','presentation_definitions','profile_attribute_values','profiles','provisioning_assignment_events','provisioning_assignment_ownership','provisioning_assignment_rules','provisioning_revocation_events','refresh_token_shard_configs','relation_definitions','relationship_closure','relationships','resource_permissions','role_assignment_rules','role_assignments','roles','saml_attribute_presets','screens','security_alerts','security_threats','sensitive_detail_chunk_index','service_group_audit','service_group_catalog','service_group_epoch','service_group_write_boundaries','sessions','settings_history','sign_in_confirmation_policies','status_lists','structured_attribute_values','subject_account_links','subject_lifecycle_timeline_events','subject_org_membership','support_operation_actions','support_operation_cohort_targets','support_operation_cohorts','suspicious_activities','tenant_consent_requirements','tenant_database_migration_state','tenant_database_probe_results','tenant_domain_mappings','tenant_invitations','tenant_placement_migration_captures','tenant_placement_migration_outbox','tenant_vanity_domains','tenants','token_claim_rules','totp_backup_codes','totp_credentials','trusted_issuers','upstream_providers','user_consent_records','user_roles','user_token_families','user_verified_attributes','users','users_core','value_provenance','vp_requests','web_origin_registry','webhook_configs','webhook_deliveries','webhook_delivery_logs')) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN ('access_review_items','access_reviews','account_creation_operations','account_lifecycle_event_outbox','account_routing_outbox','account_support_contexts','account_webhook_outbox','admin_jobs','assurance_evidence','attribute_release_consents','attribute_verifications','audit_log','authrim_migrations','authrim_runtime_probes','branding_settings','check_api_keys','ciba_requests','client_consent_overrides','client_trust_policies','compliance_reports','consent_history','consent_item_history','consent_policies','consent_policy_items','consent_policy_versions','consent_records','consent_statement_localizations','consent_statement_versions','consent_statements','contact_point_search_indexes','contact_points','contact_verifications','credential_configurations','credential_offers','custom_claim_schema_history','custom_claim_schemas','data_export_requests','delegations','device_codes','device_installations','device_secrets','did_document_cache','directory_auth_config_history','directory_auth_evidence_exports','directory_auth_migration_campaigns','directory_auth_migration_transaction_events','directory_auth_migration_transactions','directory_auth_migration_user_states','directory_auth_release_advisories','directory_auth_retention_policies','directory_auth_support_bundles','directory_auth_tenant_policies','directory_connector_instances','directory_connector_status_episodes','directory_identity_links','directory_jit_pending_users','entitlements','event_log','external_idp_auth_states','external_lifecycle_signal_decisions','external_lifecycle_signal_events','field_usage_bindings','flow_assignments','flow_audit_events','flow_interaction_steps','flow_interactions','flow_versions','group_memberships','groups','guest_account_upgrades','guest_deletion_audit_outbox','guest_devices','idempotency_keys','identity_accounts','identity_binding_lookup_indexes','identity_bindings','identity_providers','identity_resolution_candidates','identity_resolution_events','identity_subjects','internal_notification_delivery_attempts','internal_notification_delivery_routes','internal_notification_events','issued_credentials','legal_hold_events','legal_hold_projection_outbox','legal_holds','log_chunk_manifests','log_object_catalog','logging_catalog_repair_jobs','logging_quota_evaluations','logging_quota_policies','logging_usage_aggregates','lookup_retention_policies','lookup_retention_policy_projection_outbox','migration_metadata','notification_delivery_intents','oauth_client_consents','object_catalog','object_catalog_objects','oidc_scopes','operational_logs','org_domain_mappings','organizations','passkeys','password_reset_tokens','permission_change_audit','permission_check_audit','plugin_account_metadata','plugin_hook_outbox','presentation_definitions','profile_attribute_values','profiles','provisioning_assignment_events','provisioning_assignment_ownership','provisioning_assignment_rules','provisioning_revocation_events','refresh_token_shard_configs','relation_definitions','relationship_closure','relationships','resource_permissions','role_assignment_rules','role_assignments','roles','saml_attribute_presets','screens','security_alerts','security_threats','sensitive_detail_chunk_index','service_group_audit','service_group_catalog','service_group_epoch','service_group_write_boundaries','sessions','settings_history','sign_in_confirmation_policies','status_lists','structured_attribute_values','subject_account_links','subject_lifecycle_timeline_events','subject_org_membership','support_operation_actions','support_operation_cohort_targets','support_operation_cohorts','suspicious_activities','tenant_consent_requirements','tenant_database_migration_state','tenant_database_probe_results','tenant_domain_mappings','tenant_invitations','tenant_placement_migration_captures','tenant_placement_migration_outbox','tenant_vanity_domains','tenants','token_claim_rules','totp_backup_codes','totp_credentials','trusted_issuers','upstream_providers','user_consent_records','user_roles','user_token_families','user_verified_attributes','users','users_core','value_provenance','vp_requests','web_origin_registry','webhook_configs','webhook_deliveries','webhook_delivery_logs')));

CREATE TABLE "__authrim_pk_copy_access_review_items" AS SELECT "rowid" AS "__authrim_original_rowid","id","review_id","tenant_id","user_id","permission_type","permission_value","decision","decided_by","decided_at","justification","created_at" FROM "access_review_items";

CREATE TABLE "__authrim_pk_copy_access_reviews" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","description","scope","scope_value","status","reviewer_id","total_items","reviewed_items","approved_items","revoked_items","created_at","started_at","completed_at","due_date" FROM "access_reviews";

CREATE TABLE "__authrim_pk_copy_account_creation_operations" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","actor_id","idempotency_key","allocation_idempotency_key","request_hash","user_id","account_id","status","publication_json","last_error_code","created_at","completed_at","updated_at" FROM "account_creation_operations";

CREATE TABLE "__authrim_pk_copy_account_lifecycle_event_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","event_id","tenant_id","account_id","operation_id","event_type","event_version","payload_json","plugin_targets_json","status","attempt_count","lease_owner","lease_expires_at","next_attempt_at","last_error_code","created_at","succeeded_at","updated_at" FROM "account_lifecycle_event_outbox";

CREATE TABLE "__authrim_pk_copy_account_routing_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","outbox_id","tenant_id","account_id","event_kind","route_generation","route_schema_version","hmac_key_generation","payload_json","status","attempt_count","lease_owner","lease_expires_at","next_attempt_at","last_error_code","created_at","succeeded_at","updated_at" FROM "account_routing_outbox";

CREATE TABLE "__authrim_pk_copy_account_support_contexts" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","account_id","context_json","version","created_by","updated_by","created_at","updated_at" FROM "account_support_contexts";

CREATE TABLE "__authrim_pk_copy_account_webhook_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","event_type","registration_state","previous_registration_state","changed_field","occurred_at","attempts","next_attempt_at","lease_token","lease_until","delivered_at" FROM "account_webhook_outbox";

CREATE TABLE "__authrim_pk_copy_admin_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","job_type","status","progress","config","input_r2_key","result_r2_key","object_catalog_id","result","error_code","error_message","created_by","created_at","updated_at","started_at","completed_at","estimated_completion","attempt_count","max_attempts","next_run_at","dead_lettered_at" FROM "admin_jobs";

CREATE TABLE "__authrim_pk_copy_assurance_evidence" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","binding_id","evidence_type","issuer_ref","assurance_framework","assurance_level","evidence_hash","evidence_storage_ref","verified_at","expires_at","revoked_at","created_at","updated_at" FROM "assurance_evidence";

CREATE TABLE "__authrim_pk_copy_attribute_release_consents" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","destination_type","destination_id","attribute_set_hash","consent_mode","consent_state","consent_record_id","first_granted_at","last_confirmed_at","expires_at","revoked_at","created_at","updated_at" FROM "attribute_release_consents";

CREATE TABLE "__authrim_pk_copy_attribute_verifications" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","vp_request_id","issuer_did","credential_type","format","verification_result","holder_binding_verified","issuer_trusted","status_valid","mapped_attribute_ids","verified_at","expires_at","credential_profile_id","credential_profile_version_id","mapping_version_id","mapping_snapshot_hash","policy_version","evidence_fingerprint","status_checked_at","status_fresh_until","revalidate_after","invalidated_at","invalidation_reason","created_at","updated_at" FROM "attribute_verifications";

CREATE TABLE "__authrim_pk_copy_audit_log" AS SELECT "rowid" AS "__authrim_original_rowid","id","user_id","action","resource_type","resource_id","ip_address","user_agent","metadata_json","created_at","tenant_id","severity" FROM "audit_log";

CREATE TABLE "__authrim_pk_copy_authrim_migrations" AS SELECT "rowid" AS "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "authrim_migrations";

CREATE TABLE "__authrim_pk_copy_authrim_runtime_probes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "authrim_runtime_probes";

CREATE TABLE "__authrim_pk_copy_branding_settings" AS SELECT "rowid" AS "__authrim_original_rowid","id","custom_css","custom_html_header","custom_html_footer","logo_url","background_image_url","primary_color","secondary_color","font_family","enabled_auth_methods","password_policy_json","updated_at","tenant_id" FROM "branding_settings";

CREATE TABLE "__authrim_pk_copy_check_api_keys" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","name","key_hash","key_prefix","allowed_operations","rate_limit_tier","is_active","expires_at","created_by","created_at","updated_at" FROM "check_api_keys";

CREATE TABLE "__authrim_pk_copy_ciba_requests" AS SELECT "rowid" AS "__authrim_original_rowid","auth_req_id","client_id","scope","login_hint","login_hint_token","id_token_hint","binding_message","user_code","acr_values","requested_expiry","status","delivery_mode","client_notification_token","client_notification_endpoint","created_at","expires_at","last_poll_at","poll_count","interval","user_id","sub","nonce","token_issued","token_issued_at","tenant_id" FROM "ciba_requests";

CREATE TABLE "__authrim_pk_copy_client_consent_overrides" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","statement_id","requirement","min_version","enforcement","conditional_rules_json","display_order","created_at","updated_at" FROM "client_consent_overrides";

CREATE TABLE "__authrim_pk_copy_client_trust_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","target_type","target_id","first_party","trusted","skip_authorization_consent","is_active","created_at","updated_at" FROM "client_trust_policies";

CREATE TABLE "__authrim_pk_copy_compliance_reports" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","type","name","status","requested_by","parameters","result_url","error_message","created_at","completed_at","expires_at" FROM "compliance_reports";

CREATE TABLE "__authrim_pk_copy_consent_history" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","client_id","action","scopes_before","scopes_after","privacy_policy_version","tos_version","ip_address_hash","user_agent","created_at","metadata_json" FROM "consent_history";

CREATE TABLE "__authrim_pk_copy_consent_item_history" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","statement_id","action","version_before","version_after","status_before","status_after","ip_address_hash","user_agent","client_id","metadata_json","created_at","version_id_before","version_id_after","granted_at","withdrawn_at","expires_at","retain_until","consent_settings_snapshot_at","record_retention_days_snapshot","reconsent_interval_days_snapshot" FROM "consent_item_history";

CREATE TABLE "__authrim_pk_copy_consent_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","is_active","created_at","updated_at" FROM "consent_policies";

CREATE TABLE "__authrim_pk_copy_consent_policy_items" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","policy_id","statement_id","requirement","version_mode","version_id","min_version","checkbox_mode","checkbox_default_checked","binding_type","binding_value","evidence_profile","language_fallback","display_order","created_at","updated_at" FROM "consent_policy_items";

CREATE TABLE "__authrim_pk_copy_consent_policy_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","version","policy_type","policy_uri","policy_hash","effective_at","created_at" FROM "consent_policy_versions";

CREATE TABLE "__authrim_pk_copy_consent_records" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_user_id","actor_user_id","protocol","consent_kind","client_id","saml_sp_id","recipient_type","recipient_id","binding_type","binding_key","resource_type","resource_id","purpose_key","statement_id","statement_version","policy_id","flow_id","flow_version_id","flow_node_id","decision","selected_value","selected_options_json","released_scopes_json","released_claims_json","released_attributes_json","status","expires_at","revoked_at","evidence_json","created_at","updated_at" FROM "consent_records";

CREATE TABLE "__authrim_pk_copy_consent_statement_localizations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","version_id","language","title","description","document_url","inline_content","created_at","updated_at","processing_purpose","withdrawal_impact" FROM "consent_statement_localizations";

CREATE TABLE "__authrim_pk_copy_consent_statement_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","statement_id","version","content_type","effective_at","content_hash","is_current","current_statement_guard","status","created_at","updated_at","effective_until" FROM "consent_statement_versions";

CREATE TABLE "__authrim_pk_copy_consent_statements" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","slug","category","legal_basis","processing_purpose","display_order","is_active","created_at","updated_at","record_retention_days","withdrawal_allowed","withdrawal_impact","reconsent_on_version_change","reconsent_interval_days" FROM "consent_statements";

CREATE TABLE "__authrim_pk_copy_contact_point_search_indexes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","contact_point_id","index_kind","index_value","index_version","classification","status","created_at","updated_at" FROM "contact_point_search_indexes";

CREATE TABLE "__authrim_pk_copy_contact_points" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","contact_type","purpose","normalized_hash","value_storage_ref","display_label","is_primary","verification_state","lifecycle_state","created_at","updated_at","deleted_at" FROM "contact_points";

CREATE TABLE "__authrim_pk_copy_contact_verifications" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","contact_point_id","verification_type","verification_state","evidence_ref","verified_at","expires_at","revoked_at","created_at","updated_at" FROM "contact_verifications";

CREATE TABLE "__authrim_pk_copy_credential_configurations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","configuration_id","format","vct","display","claims","proof_types_supported","signing_alg","is_active","created_at","updated_at" FROM "credential_configurations";

CREATE TABLE "__authrim_pk_copy_credential_offers" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","credential_configuration_id","pre_authorized_code","tx_code","grants","status","created_at","expires_at","issued_at","issued_credential_id","issued_credential_internal_id" FROM "credential_offers";

CREATE TABLE "__authrim_pk_copy_custom_claim_schema_history" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","schema_id","version","operation","snapshot","changes","actor_id","actor_type","change_source","created_at" FROM "custom_claim_schema_history";

CREATE TABLE "__authrim_pk_copy_custom_claim_schemas" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_key","active_field_key","display_label","field_type","is_pii","is_required","is_active","validation_rules","include_in_id_token","include_in_userinfo","include_in_introspection","required_scopes","scope_mode","is_searchable","is_exportable","is_vc_claim","claim_namespace","description","display_order","schema_version","operation_status","operation_detail","is_system","created_by","created_at","updated_at","show_on_registration","registration_required","registration_order","registration_placeholder","ui_group_key","ui_group_label","ui_group_order","ui_field_order","examples_json","cardinality" FROM "custom_claim_schemas";

CREATE TABLE "__authrim_pk_copy_data_export_requests" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","status","format","include_sections","requested_at","started_at","completed_at","expires_at","file_path","object_catalog_id","file_size","error_message" FROM "data_export_requests";

CREATE TABLE "__authrim_pk_copy_delegations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","delegate_subject_id","parent_delegation_id","chain_id","delegation_type","lifecycle_state","scope_json","starts_at","expires_at","created_at","updated_at" FROM "delegations";

CREATE TABLE "__authrim_pk_copy_device_codes" AS SELECT "rowid" AS "__authrim_original_rowid","device_code","user_code","client_id","scope","status","user_id","sub","created_at","expires_at","last_poll_at","token_issued","token_issued_at","poll_count","tenant_id" FROM "device_codes";

CREATE TABLE "__authrim_pk_copy_device_installations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","client_id","trust_group_id","source_installation_id","source_client_id","linked_device_secret_id","session_id","display_name","device_platform","created_at","updated_at","last_seen_at","revoked_at","revoke_reason","is_active" FROM "device_installations";

CREATE TABLE "__authrim_pk_copy_device_secrets" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","session_id","secret_hash","device_name","device_platform","installation_id","client_id","trust_group_id","source_installation_id","source_client_id","created_at","updated_at","expires_at","last_used_at","use_count","revoked_at","revoke_reason","is_active" FROM "device_secrets";

CREATE TABLE "__authrim_pk_copy_did_document_cache" AS SELECT "rowid" AS "__authrim_original_rowid","did","document","resolved_at","expires_at" FROM "did_document_cache";

CREATE TABLE "__authrim_pk_copy_directory_auth_config_history" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","actor_id","category","action","resource_type","resource_id","before_redacted_json","after_redacted_json","created_at" FROM "directory_auth_config_history";

CREATE TABLE "__authrim_pk_copy_directory_auth_evidence_exports" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","status","requested_by","period_start_at","period_end_at","size_estimate_bytes","artifact_key","artifact_sha256","object_catalog_id","manifest_signature_key_id","manifest_signature_alg","signed_url_expires_at","retention_expires_at","download_after_delete","error_code","created_at","updated_at","completed_at","deleted_at" FROM "directory_auth_evidence_exports";

CREATE TABLE "__authrim_pk_copy_directory_auth_migration_campaigns" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","description","status","mode","passkey_prompt_mode","email_code_fallback_mode","grace_period_days","transaction_ttl_seconds","enforcement_start_mode","target_policy_json","is_template","created_by","created_at","updated_at" FROM "directory_auth_migration_campaigns";

CREATE TABLE "__authrim_pk_copy_directory_auth_migration_transaction_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","transaction_id","campaign_id","user_id","event_type","event_payload_json","request_id","created_at" FROM "directory_auth_migration_transaction_events";

CREATE TABLE "__authrim_pk_copy_directory_auth_migration_transactions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","campaign_id","user_id","connector_id","directory_subject","token_hash","scope","state","request_id","authorization_challenge_id","created_at","updated_at","expires_at","completed_at","blocked_reason" FROM "directory_auth_migration_transactions";

CREATE TABLE "__authrim_pk_copy_directory_auth_migration_user_states" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","campaign_id","user_id","connector_id","directory_subject","cohort_key","state","first_directory_login_at","prompted_at","deferred_until","passkey_required_at","enrolled_at","blocked_reason","recovery_reason","reset_count","last_reset_at","last_reset_by","last_reset_reason","created_at","updated_at" FROM "directory_auth_migration_user_states";

CREATE TABLE "__authrim_pk_copy_directory_auth_release_advisories" AS SELECT "rowid" AS "__authrim_original_rowid","id","channel","severity","affected_versions_json","fixed_version","summary","published_at","updated_at","release_url","created_at" FROM "directory_auth_release_advisories";

CREATE TABLE "__authrim_pk_copy_directory_auth_retention_policies" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","authrim_audit_retention_days","wordwarden_local_retention_days","artifact_delete_grace_hours","updated_by","created_at","updated_at" FROM "directory_auth_retention_policies";

CREATE TABLE "__authrim_pk_copy_directory_auth_support_bundles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","requested_by","redaction_level","status","scope_json","consent_summary_json","artifact_key","artifact_sha256","object_catalog_id","retention_expires_at","created_at","updated_at","completed_at","deleted_at" FROM "directory_auth_support_bundles";

CREATE TABLE "__authrim_pk_copy_directory_auth_tenant_policies" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","email_code_fallback_mode","updated_by","created_at","updated_at" FROM "directory_auth_tenant_policies";

CREATE TABLE "__authrim_pk_copy_directory_connector_instances" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","connector_id","instance_id","display_name","transport","version","started_at","first_seen_at","last_seen_at","status","health_status","health_summary_json","config_fingerprint","config_categories_json","drift_severity","deactivated_at","deactivated_by","deactivation_reason","updated_at","release_channel" FROM "directory_connector_instances";

CREATE TABLE "__authrim_pk_copy_directory_connector_status_episodes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","connector_id","instance_id","status","started_at","ended_at","last_seen_at","reason","acknowledged_at","acknowledged_by","created_at","updated_at" FROM "directory_connector_status_episodes";

CREATE TABLE "__authrim_pk_copy_directory_identity_links" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","connector_id","directory_subject","user_id","latest_facts_json","created_at","updated_at","last_login_at" FROM "directory_identity_links";

CREATE TABLE "__authrim_pk_copy_directory_jit_pending_users" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","connector_id","directory_subject","login_identifier","status","directory_facts_json","created_at","updated_at","decided_at","decided_by","decision_reason","linked_user_id" FROM "directory_jit_pending_users";

CREATE TABLE "__authrim_pk_copy_entitlements" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","entitlement_type","entitlement_key","source_id","lifecycle_state","value_json","created_at","updated_at" FROM "entitlements";

CREATE TABLE "__authrim_pk_copy_event_log" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","event_type","event_category","result","severity","error_code","error_message","anonymized_user_id","client_id","session_id","request_id","duration_ms","details_r2_key","details_json","retention_until","created_at" FROM "event_log";

CREATE TABLE "__authrim_pk_copy_external_idp_auth_states" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","provider_id","state","nonce","code_verifier","code_challenge","flow_id","redirect_uri","user_id","session_id","original_auth_request","max_age","acr_values","prompt","enable_sso","expires_at","created_at","consumed_at" FROM "external_idp_auth_states";

CREATE TABLE "__authrim_pk_copy_external_lifecycle_signal_decisions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","signal_event_id","subject_id","account_id","decision","propagation_targets_json","reason_codes_json","created_at" FROM "external_lifecycle_signal_decisions";

CREATE TABLE "__authrim_pk_copy_external_lifecycle_signal_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","source_type","source_id","source_event_id","source_timestamp","observed_at","binding_version","payload_ref","signal_type","dedupe_key","processing_state","created_at","updated_at" FROM "external_lifecycle_signal_events";

CREATE TABLE "__authrim_pk_copy_field_usage_bindings" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","field_key","binding_type","binding_id","protection","reason","source","metadata_json","is_active","created_at","updated_at" FROM "field_usage_bindings";

CREATE TABLE "__authrim_pk_copy_flow_assignments" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","target_type","target_id","flow_kind","flow_id","enabled","created_at","updated_at" FROM "flow_assignments";

CREATE TABLE "__authrim_pk_copy_flow_audit_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","interaction_id","flow_id","flow_version_id","user_id","client_id","saml_sp_id","node_id","branch_handle_id","event_type","result","error_code","contract_hash","metadata_json","created_at" FROM "flow_audit_events";

CREATE TABLE "__authrim_pk_copy_flow_interaction_steps" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","interaction_id","node_id","step_id","state","selected_handle","state_json","created_at","updated_at" FROM "flow_interaction_steps";

CREATE TABLE "__authrim_pk_copy_flow_interactions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","flow_id","flow_version_id","user_id","client_id","saml_sp_id","state","current_node_id","current_step_id","contract_hash","signature","expires_at","created_at","updated_at","completed_at","context_json" FROM "flow_interactions";

CREATE TABLE "__authrim_pk_copy_flow_versions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","flow_id","version_number","schema_version","runtime_snapshot_json","editor_snapshot_json","validation_result_json","published_by","published_at","created_at" FROM "flow_versions";

CREATE TABLE "__authrim_pk_copy_group_memberships" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","group_id","subject_id","account_id","membership_type","assignment_source","lifecycle_state","starts_at","expires_at","created_at","updated_at" FROM "group_memberships";

CREATE TABLE "__authrim_pk_copy_groups" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","group_key","display_name","description","parent_group_id","lifecycle_state","metadata_json","created_at","updated_at" FROM "groups";

CREATE TABLE "__authrim_pk_copy_guest_account_upgrades" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","guest_user_id","upgraded_user_id","upgrade_method","provider_id","preserve_sub","upgraded_at","data_migrated" FROM "guest_account_upgrades";

CREATE TABLE "__authrim_pk_copy_guest_deletion_audit_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","audit_id","tenant_id","user_id","operation_id","actor_user_id","ip_address","user_agent","metadata_json","status","attempt_count","next_attempt_at","last_error_code","created_at","updated_at","succeeded_at" FROM "guest_deletion_audit_outbox";

CREATE TABLE "__authrim_pk_copy_guest_devices" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","resume_credential_hash","expires_at","created_at","last_used_at","is_active" FROM "guest_devices";

CREATE TABLE "__authrim_pk_copy_idempotency_keys" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","actor_id","method","path","resource_id","idempotency_key","body_hash","response_status","response_body","created_at","expires_at" FROM "idempotency_keys";

CREATE TABLE "__authrim_pk_copy_identity_accounts" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","account_type","lifecycle_state","legacy_user_id","primary_subject_id","display_label","metadata_json","created_at","updated_at","deleted_at","directory_publication_state","account_route_generation","registration_state" FROM "identity_accounts";

CREATE TABLE "__authrim_pk_copy_identity_binding_lookup_indexes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","identity_binding_id","lookup_kind","lookup_value","lookup_version","status","created_at","updated_at" FROM "identity_binding_lookup_indexes";

CREATE TABLE "__authrim_pk_copy_identity_bindings" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","protocol","source_id","provider_subject_key_hash","binding_kind","lifecycle_state","assurance_level","trust_context_snapshot_id","metadata_json","created_at","updated_at","deleted_at","last_seen_at" FROM "identity_bindings";

CREATE TABLE "__authrim_pk_copy_identity_providers" AS SELECT "rowid" AS "__authrim_original_rowid","id","name","provider_type","config_json","enabled","created_at","updated_at","tenant_id" FROM "identity_providers";

CREATE TABLE "__authrim_pk_copy_identity_resolution_candidates" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","source_id","candidate_subject_id","candidate_account_id","candidate_binding_id","candidate_score","risk_tier","decision_state","reason_codes_json","review_task_id","created_at","updated_at" FROM "identity_resolution_candidates";

CREATE TABLE "__authrim_pk_copy_identity_resolution_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","binding_id","source_id","resolution_method","outcome","reason_codes_json","trace_ref","metadata_json","created_at" FROM "identity_resolution_events";

CREATE TABLE "__authrim_pk_copy_identity_subjects" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_type","lifecycle_state","display_label","primary_account_id","risk_tier","assurance_level","metadata_json","created_at","updated_at","deleted_at" FROM "identity_subjects";

CREATE TABLE "__authrim_pk_copy_internal_notification_delivery_attempts" AS SELECT "rowid" AS "__authrim_original_rowid","id","event_id","route_id","provider","destination_id","status","attempt_count","response_status","error_class","error_message","next_attempt_at","payload_sha256","delivered_at","created_at","updated_at" FROM "internal_notification_delivery_attempts";

CREATE TABLE "__authrim_pk_copy_internal_notification_delivery_routes" AS SELECT "rowid" AS "__authrim_original_rowid","id","name","scope_type","scope_id","provider","destination_id","categories_json","severities_json","min_severity","enabled","failure_policy","max_attempts","retry_after_seconds","suppression_key","created_by","updated_by","created_at","updated_at","version" FROM "internal_notification_delivery_routes";

CREATE TABLE "__authrim_pk_copy_internal_notification_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","category","event_type","severity","status","deduplication_key","payload_json","attempts","last_error","next_attempt_at","created_at","updated_at","delivered_at" FROM "internal_notification_events";

CREATE TABLE "__authrim_pk_copy_issued_credentials" AS SELECT "rowid" AS "__authrim_original_rowid","internal_id","public_id","tenant_id","user_id","credential_type","format","claims","status","status_list_id","status_list_internal_id","status_list_index","holder_binding","created_at","updated_at","expires_at","revoked_at","revoked_reason" FROM "issued_credentials";

CREATE TABLE "__authrim_pk_copy_legal_hold_events" AS SELECT "rowid" AS "__authrim_original_rowid","event_id","hold_id","tenant_id","account_id","event_type","hold_version","projection_generation","actor_id","reason_code","case_reference","effective_at","created_at" FROM "legal_hold_events";

CREATE TABLE "__authrim_pk_copy_legal_hold_projection_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","hold_id","account_id","projection_generation","hold_version","projection_state","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","last_error_code","created_at","updated_at","completed_at" FROM "legal_hold_projection_outbox";

CREATE TABLE "__authrim_pk_copy_legal_holds" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_type","subject_id","state","reason_code","case_reference","expires_at","version","created_by","created_at","released_by","released_at","release_reason","updated_at" FROM "legal_holds";

CREATE TABLE "__authrim_pk_copy_log_chunk_manifests" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","log_type","plane","bucket_start_at","bucket_end_at","shard","manifest_object_key","chunk_count","record_count","checksum_sha256","status","created_at","updated_at" FROM "log_chunk_manifests";

CREATE TABLE "__authrim_pk_copy_log_object_catalog" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_key","log_type","plane","surface","object_key","object_kind","status","record_count","byte_count","checksum_sha256","compression","encryption_scope","key_version","created_at","committed_at","deleted_at" FROM "log_object_catalog";

CREATE TABLE "__authrim_pk_copy_logging_catalog_repair_jobs" AS SELECT "rowid" AS "__authrim_original_rowid","id","job_kind","status","tenant_key","log_type","plane","requested_action","progress_current","progress_total","preview_artifact_ref","result_json","error_class","last_error","requested_by","created_at","updated_at","started_at","completed_at","cancel_requested_at","cancel_requested_by","metadata_json" FROM "logging_catalog_repair_jobs";

CREATE TABLE "__authrim_pk_copy_logging_quota_evaluations" AS SELECT "rowid" AS "__authrim_original_rowid","id","quota_policy_id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","soft_limit","hard_limit","state","enforcement_action","evaluated_at","notification_event_id","metadata_json" FROM "logging_quota_evaluations";

CREATE TABLE "__authrim_pk_copy_logging_quota_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","scope_type","scope_id","log_type","plane","lane","metric_name","window_kind","soft_limit","hard_limit","warning_ratio","enforcement_mode","critical_behavior","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "logging_quota_policies";

CREATE TABLE "__authrim_pk_copy_logging_usage_aggregates" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","source_table","metadata_json","refreshed_at","created_at","updated_at" FROM "logging_usage_aggregates";

CREATE TABLE "__authrim_pk_copy_lookup_retention_policies" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","retention_days","policy_generation","updated_by","created_at","updated_at" FROM "lookup_retention_policies";

CREATE TABLE "__authrim_pk_copy_lookup_retention_policy_projection_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","policy_generation","retention_days","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","last_error_code","created_at","updated_at","completed_at" FROM "lookup_retention_policy_projection_outbox";

CREATE TABLE "__authrim_pk_copy_migration_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "migration_metadata";

CREATE TABLE "__authrim_pk_copy_notification_delivery_intents" AS SELECT "rowid" AS "__authrim_original_rowid","intent_id","tenant_id","plugin_installation_id","provider_order_version","provider_installation_ids_json","active_provider_index","provider_started_at","channel","notification_kind","payload_version","payload_key_id","payload_envelope_json","idempotency_key","request_fingerprint","fingerprint_key_id","state","expires_at","delivered_at","canceled_at","dead_lettered_at","delete_after","created_at","updated_at","account_id","recipient_masked","recipient_encrypted","recipient_encryption_key_version","provider_message_id","provider_accepted_at","delivery_status","delivery_status_updated_at","attempt_count","last_error_code" FROM "notification_delivery_intents";

CREATE TABLE "__authrim_pk_copy_oauth_client_consents" AS SELECT "rowid" AS "__authrim_original_rowid","id","user_id","client_id","scope","granted_at","expires_at","created_at","updated_at","tenant_id","selected_scopes","privacy_policy_version","tos_version","consent_version" FROM "oauth_client_consents";

CREATE TABLE "__authrim_pk_copy_object_catalog" AS SELECT "rowid" AS "__authrim_original_rowid","id","public_artifact_id","tenant_id","object_class","created_at","updated_at","deleted_at" FROM "object_catalog";

CREATE TABLE "__authrim_pk_copy_object_catalog_objects" AS SELECT "rowid" AS "__authrim_original_rowid","id","catalog_id","representation","object_kind","object_index","bucket_binding","object_key","key_version","checksum_sha256","total_bytes","created_at","deleted_at" FROM "object_catalog_objects";

CREATE TABLE "__authrim_pk_copy_oidc_scopes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","scope_type","enabled","localizations_json","created_at","updated_at" FROM "oidc_scopes";

CREATE TABLE "__authrim_pk_copy_operational_logs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_type","subject_id","actor_id","action","reason_detail_encrypted","encryption_key_version","detail_object_catalog_id","request_id","created_at","expires_at" FROM "operational_logs";

CREATE TABLE "__authrim_pk_copy_org_domain_mappings" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","domain_hash","domain_hash_version","org_id","auto_join_enabled","membership_type","auto_assign_role_id","verified","priority","is_active","created_at","updated_at","verification_token","verification_status","verification_expires_at","verification_method" FROM "org_domain_mappings";

CREATE TABLE "__authrim_pk_copy_organizations" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","org_type","parent_org_id","plan","is_active","metadata_json","created_at","updated_at" FROM "organizations";

CREATE TABLE "__authrim_pk_copy_passkeys" AS SELECT "rowid" AS "__authrim_original_rowid","id","user_id","credential_id","public_key","counter","transports","device_name","created_at","last_used_at","tenant_id","aaguid","rp_id" FROM "passkeys";

CREATE TABLE "__authrim_pk_copy_password_reset_tokens" AS SELECT "rowid" AS "__authrim_original_rowid","id","user_id","token_hash","expires_at","used","created_at","tenant_id" FROM "password_reset_tokens";

CREATE TABLE "__authrim_pk_copy_permission_change_audit" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","event_type","subject_id","resource","relation","permission","timestamp","created_at" FROM "permission_change_audit";

CREATE TABLE "__authrim_pk_copy_permission_check_audit" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","permission","permission_json","allowed","resolved_via_json","final_decision","reason","api_key_id","client_id","checked_at" FROM "permission_check_audit";

CREATE TABLE "__authrim_pk_copy_plugin_account_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","account_id","plugin_id","plugin_installation_id","metadata_key","value_json","version","created_at","updated_at" FROM "plugin_account_metadata";

CREATE TABLE "__authrim_pk_copy_plugin_hook_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","outbox_id","tenant_id","plugin_installation_id","capability","event_type","event_version","idempotency_key","payload_json","payload_class","status","attempt_no","claim_owner","claim_token","lease_until","next_attempt_at","last_error_code","created_at","succeeded_at","dead_lettered_at","canceled_at","delete_after","updated_at" FROM "plugin_hook_outbox";

CREATE TABLE "__authrim_pk_copy_presentation_definitions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","purpose","format","input_descriptors","submission_requirements","dcql_query","is_active","created_at","updated_at" FROM "presentation_definitions";

CREATE TABLE "__authrim_pk_copy_profile_attribute_values" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","profile_id","catalog_entry_id","value_type","value_json","value_storage_ref","value_hash","classification","purpose","is_primary","display_order","lifecycle_state","created_at","updated_at","deleted_at" FROM "profile_attribute_values";

CREATE TABLE "__authrim_pk_copy_profiles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","profile_type","lifecycle_state","locale","zoneinfo","display_name_ref","metadata_json","created_at","updated_at","deleted_at" FROM "profiles";

CREATE TABLE "__authrim_pk_copy_provisioning_assignment_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","rule_id","subject_id","account_id","target_type","target_id","outcome","reason_codes_json","trace_ref","created_at" FROM "provisioning_assignment_events";

CREATE TABLE "__authrim_pk_copy_provisioning_assignment_ownership" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","assignment_type","assignment_id","source_id","ownership_policy","revoke_policy","protected_until","created_at","updated_at" FROM "provisioning_assignment_ownership";

CREATE TABLE "__authrim_pk_copy_provisioning_assignment_rules" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","scope_type","scope_id","rule_type","target_type","target_id","condition_json","priority","lifecycle_state","created_at","updated_at" FROM "provisioning_assignment_rules";

CREATE TABLE "__authrim_pk_copy_provisioning_revocation_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","source_event_id","target_type","target_id","decision","reason_codes_json","created_at" FROM "provisioning_revocation_events";

CREATE TABLE "__authrim_pk_copy_refresh_token_shard_configs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","generation","shard_count","activated_at","deprecated_at","created_by","notes" FROM "refresh_token_shard_configs";

CREATE TABLE "__authrim_pk_copy_relation_definitions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","object_type","relation_name","definition_json","description","priority","is_active","created_at","updated_at" FROM "relation_definitions";

CREATE TABLE "__authrim_pk_copy_relationship_closure" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","ancestor_type","ancestor_id","descendant_type","descendant_id","relation","depth","path_json","effective_permission","created_at","updated_at" FROM "relationship_closure";

CREATE TABLE "__authrim_pk_copy_relationships" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","relationship_type","from_type","from_id","to_type","to_id","permission_level","expires_at","is_bidirectional","metadata_json","created_at","updated_at","evidence_type","evidence_ref" FROM "relationships";

CREATE TABLE "__authrim_pk_copy_resource_permissions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_type","subject_id","resource_type","resource_id","actions_json","condition_json","expires_at","is_active","granted_by","created_at","updated_at" FROM "resource_permissions";

CREATE TABLE "__authrim_pk_copy_role_assignment_rules" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","description","role_id","scope_type","scope_target","conditions_json","actions_json","priority","stop_processing","is_active","valid_from","valid_until","created_by","created_at","updated_at" FROM "role_assignment_rules";

CREATE TABLE "__authrim_pk_copy_role_assignments" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","role_id","scope_type","scope_target","expires_at","assigned_by","metadata_json","created_at","updated_at" FROM "role_assignments";

CREATE TABLE "__authrim_pk_copy_roles" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","description","permissions_json","created_at","role_type","hierarchy_level","is_assignable","parent_role_id","display_name","is_system","updated_at","external_id" FROM "roles";

CREATE TABLE "__authrim_pk_copy_saml_attribute_presets" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","label","description","applies_to","profile","stability","application_mode","attribute_release_policy_json","created_at","updated_at" FROM "saml_attribute_presets";

CREATE TABLE "__authrim_pk_copy_screens" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","screen_key","display_name","description","screen_kind","fields_json","localizations_json","settings_json","is_active","is_system","created_at","updated_at" FROM "screens";

CREATE TABLE "__authrim_pk_copy_security_alerts" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","type","severity","status","title","description","source_ip","user_id","client_id","metadata","created_at","updated_at","acknowledged_at","acknowledged_by","resolved_at","resolved_by" FROM "security_alerts";

CREATE TABLE "__authrim_pk_copy_security_threats" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","type","severity","status","title","description","source","affected_resources","indicators","metadata","created_at","updated_at","detected_at","mitigated_at" FROM "security_threats";

CREATE TABLE "__authrim_pk_copy_sensitive_detail_chunk_index" AS SELECT "rowid" AS "__authrim_original_rowid","catalog_id","tenant_id","object_class","bucket_binding","object_key","content_encoding","line_number","byte_offset","byte_length","key_version","checksum_sha256","created_at","deleted_at" FROM "sensitive_detail_chunk_index";

CREATE TABLE "__authrim_pk_copy_service_group_audit" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","rule_version","generation","event_type","detail_json","created_at" FROM "service_group_audit";

CREATE TABLE "__authrim_pk_copy_service_group_catalog" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","revision","plan_json","updated_at","write_token" FROM "service_group_catalog";

CREATE TABLE "__authrim_pk_copy_service_group_epoch" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","revision" FROM "service_group_epoch";

CREATE TABLE "__authrim_pk_copy_service_group_write_boundaries" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","operation","status","created_at" FROM "service_group_write_boundaries";

CREATE TABLE "__authrim_pk_copy_sessions" AS SELECT "rowid" AS "__authrim_original_rowid","id","user_id","expires_at","created_at","external_provider_id","external_provider_sub","tenant_id","external_provider_sid" FROM "sessions";

CREATE TABLE "__authrim_pk_copy_settings_history" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","category","version","snapshot","changes","actor_id","actor_type","change_reason","change_source","created_at" FROM "settings_history";

CREATE TABLE "__authrim_pk_copy_sign_in_confirmation_policies" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","display_name","description","trigger_type","mode","remember_duration_days","show_application_context","show_tenant_context","is_active","created_at","updated_at" FROM "sign_in_confirmation_policies";

CREATE TABLE "__authrim_pk_copy_status_lists" AS SELECT "rowid" AS "__authrim_original_rowid","internal_id","public_id","tenant_id","purpose","encoded_list","current_index","capacity","used_count","state","sealed_at","created_at","updated_at" FROM "status_lists";

CREATE TABLE "__authrim_pk_copy_structured_attribute_values" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","owner_type","owner_id","catalog_entry_id","canonical_json","projected_index_json","classification","lifecycle_state","created_at","updated_at","deleted_at" FROM "structured_attribute_values";

CREATE TABLE "__authrim_pk_copy_subject_account_links" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","link_type","lifecycle_state","source_ref","created_at","updated_at","deleted_at" FROM "subject_account_links";

CREATE TABLE "__authrim_pk_copy_subject_lifecycle_timeline_events" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","account_id","event_type","source_type","source_id","summary_json","event_at","created_at" FROM "subject_lifecycle_timeline_events";

CREATE TABLE "__authrim_pk_copy_subject_org_membership" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","org_id","membership_type","is_primary","created_at","updated_at" FROM "subject_org_membership";

CREATE TABLE "__authrim_pk_copy_support_operation_actions" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","cohort_id","resource","action","status","reason","support_case_id","approval_request_id","job_id","result_summary_json","requested_by","approved_by","approved_at","created_at","updated_at" FROM "support_operation_actions";

CREATE TABLE "__authrim_pk_copy_support_operation_cohort_targets" AS SELECT "rowid" AS "__authrim_original_rowid","id","cohort_id","tenant_id","resource","target_id","target_hash","block_reason","created_at" FROM "support_operation_cohort_targets";

CREATE TABLE "__authrim_pk_copy_support_operation_cohorts" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","resource","intended_action","selector_json","selector_hash","matched_count","actionable_count","blocked_count","blocked_summary_json","snapshot_status","snapshot_job_id","snapshot_error","risk_json","created_by","support_case_id","expires_at","created_at" FROM "support_operation_cohorts";

CREATE TABLE "__authrim_pk_copy_suspicious_activities" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","type","severity","user_id","client_id","source_ip","user_agent","description","metadata","created_at","resolved_at" FROM "suspicious_activities";

CREATE TABLE "__authrim_pk_copy_tenant_consent_requirements" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","statement_id","is_required","min_version","enforcement","show_deletion_link","deletion_url","conditional_rules_json","display_order","created_at","updated_at" FROM "tenant_consent_requirements";

CREATE TABLE "__authrim_pk_copy_tenant_database_migration_state" AS SELECT "rowid" AS "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "tenant_database_migration_state";

CREATE TABLE "__authrim_pk_copy_tenant_database_probe_results" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","role","shard_group","shard_index","generation","probe_kind","status","latency_ms","binding_ref","connection_ref","provider","schema_version","error_class","error_message","metadata_json","created_by","created_at" FROM "tenant_database_probe_results";

CREATE TABLE "__authrim_pk_copy_tenant_domain_mappings" AS SELECT "rowid" AS "__authrim_original_rowid","id","domain_hash","hash_version","tenant_id","priority","is_active","active_domain_hash","verified","verification_token","verification_expires_at","created_by","created_at","updated_at" FROM "tenant_domain_mappings";

CREATE TABLE "__authrim_pk_copy_tenant_invitations" AS SELECT "rowid" AS "__authrim_original_rowid","id","token","tenant_id","invited_email","invited_by","role_id","org_id","max_uses","use_count","expires_at","created_at","updated_at" FROM "tenant_invitations";

CREATE TABLE "__authrim_pk_copy_tenant_placement_migration_captures" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","source_shard_id","migration_generation","capture_state","fencing_token","installed_at","write_fenced_at","cutover_committed_at","canceled_at","updated_at" FROM "tenant_placement_migration_captures";

CREATE TABLE "__authrim_pk_copy_tenant_placement_migration_outbox" AS SELECT "source_sequence","operation_id","tenant_id","table_name","mutation_kind","mutation_key_json","row_json","capture_fencing_token","delivery_state","applied_at","created_at" FROM "tenant_placement_migration_outbox";

CREATE TABLE "__authrim_pk_copy_tenant_vanity_domains" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","hostname","is_active","active_hostname","is_primary","primary_active_tenant_key","status","cloudflare_zone_id","cloudflare_custom_hostname_id","ssl_status","ownership_status","validation_method","validation_records_json","last_sync_at","created_by","created_at","updated_at" FROM "tenant_vanity_domains";

CREATE TABLE "__authrim_pk_copy_tenants" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_code","tenant_key","name","description","is_default","default_tenant_guard","created_at","updated_at","lifecycle_state","isolation_policy" FROM "tenants";

CREATE TABLE "__authrim_pk_copy_token_claim_rules" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","description","token_type","conditions_json","actions_json","priority","stop_processing","is_active","valid_from","valid_until","created_by","created_at","updated_at" FROM "token_claim_rules";

CREATE TABLE "__authrim_pk_copy_totp_backup_codes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","credential_id","code_hash","code_prefix","created_at","used_at" FROM "totp_backup_codes";

CREATE TABLE "__authrim_pk_copy_totp_credentials" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","secret_encrypted","secret_key_version","label","algorithm","digits","period","window","status","last_used_time_step","created_at","activated_at","last_used_at" FROM "totp_credentials";

CREATE TABLE "__authrim_pk_copy_trusted_issuers" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","issuer_did","display_name","credential_types","trust_level","jwks_uri","status","created_at","updated_at" FROM "trusted_issuers";

CREATE TABLE "__authrim_pk_copy_upstream_providers" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","name","provider_type","enabled","priority","issuer","client_id","client_secret_encrypted","authorization_endpoint","token_endpoint","userinfo_endpoint","jwks_uri","scopes","attribute_mapping","auto_link_email","jit_provisioning","require_email_verified","provider_quirks","icon_url","icon_name","button_color","button_color_dark","button_text","created_at","updated_at","slug","token_endpoint_auth_method","always_fetch_userinfo","enable_sso","use_request_object","request_object_signing_alg","private_key_jwk_encrypted","public_key_jwk" FROM "upstream_providers";

CREATE TABLE "__authrim_pk_copy_user_consent_records" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","statement_id","version_id","version","status","granted_at","withdrawn_at","expires_at","client_id","ip_address_hash","user_agent","receipt_id","created_at","updated_at","retain_until","consent_settings_snapshot_at","record_retention_days_snapshot","reconsent_interval_days_snapshot" FROM "user_consent_records";

CREATE TABLE "__authrim_pk_copy_user_roles" AS SELECT "rowid" AS "__authrim_original_rowid","user_id","role_id","created_at","tenant_id" FROM "user_roles";

CREATE TABLE "__authrim_pk_copy_user_token_families" AS SELECT "rowid" AS "__authrim_original_rowid","jti","tenant_id","user_id","client_id","generation","expires_at","is_revoked" FROM "user_token_families";

CREATE TABLE "__authrim_pk_copy_user_verified_attributes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","attribute_name","attribute_value","source_type","issuer_did","verification_id","verified_at","expires_at","revalidate_after","created_at","updated_at" FROM "user_verified_attributes";

CREATE TABLE "__authrim_pk_copy_users" AS SELECT "rowid" AS "__authrim_original_rowid","id","email","email_verified","name","given_name","family_name","middle_name","nickname","preferred_username","profile","picture","website","gender","birthdate","zoneinfo","locale","phone_number","phone_number_verified","address_json","custom_attributes_json","parent_user_id","identity_provider_id","password_hash","password_changed_at","failed_login_attempts","locked_until","created_at","updated_at","last_login_at","tenant_id","user_type","status","suspended_at","suspended_until","locked_at" FROM "users";

CREATE TABLE "__authrim_pk_copy_users_core" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","email_verified","phone_number_verified","email_domain_hash","password_hash","is_active","user_type","pii_partition","pii_status","created_at","updated_at","last_login_at","email_domain_hash_version","external_id","status","lifecycle_state","suspended_at","suspended_until","locked_at","locked_until" FROM "users_core";

CREATE TABLE "__authrim_pk_copy_value_provenance" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","owner_table","owner_id","source_id","source_record_id","source_field_ref","source_authority_contract_id","observed_at","confidence_score","provenance_json","created_at" FROM "value_provenance";

CREATE TABLE "__authrim_pk_copy_vp_requests" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","nonce","state","presentation_definition_id","response_uri","response_mode","status","error_code","error_description","created_at","expires_at","verified_at" FROM "vp_requests";

CREATE TABLE "__authrim_pk_copy_web_origin_registry" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","origin","cors_allowed","csp_frame_ancestors","handoff_allowed","iframe_allowed","environment","is_active","created_at","updated_at" FROM "web_origin_registry";

CREATE TABLE "__authrim_pk_copy_webhook_configs" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","scope","name","url","events","secret_encrypted","headers","retry_policy","timeout_ms","active","created_at","updated_at","last_success_at","last_failure_at","payload_fields","registration_states" FROM "webhook_configs";

CREATE TABLE "__authrim_pk_copy_webhook_deliveries" AS SELECT "rowid" AS "__authrim_original_rowid","id","webhook_id","tenant_id","event_type","event_id","status","status_code","request_headers","request_body","response_body","error_message","attempts","next_retry_at","created_at","completed_at","duration_ms","detail_object_catalog_id" FROM "webhook_deliveries";

CREATE TABLE "__authrim_pk_copy_webhook_delivery_logs" AS SELECT "rowid" AS "__authrim_original_rowid","id","webhook_id","event_id","event_type","tenant_id","attempt","status","status_code","error_message","duration_ms","created_at" FROM "webhook_delivery_logs";

CREATE TABLE "__authrim_pk_sequences" AS SELECT name, seq FROM sqlite_sequence WHERE name IN ('tenant_placement_migration_outbox');

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "account_webhook_contact_points_delete";

DROP TRIGGER "account_webhook_contact_points_insert";

DROP TRIGGER "account_webhook_contact_points_update";

DROP TRIGGER "account_webhook_created_activate";

DROP TRIGGER "account_webhook_created_insert";

DROP TRIGGER "account_webhook_deleted";

DROP TRIGGER "account_webhook_profile_attribute_values_delete";

DROP TRIGGER "account_webhook_profile_attribute_values_insert";

DROP TRIGGER "account_webhook_profile_attribute_values_update";

DROP TRIGGER "account_webhook_profiles_delete";

DROP TRIGGER "account_webhook_profiles_insert";

DROP TRIGGER "account_webhook_profiles_update";

DROP TRIGGER "account_webhook_registration";

DROP TRIGGER "account_webhook_updated";

DROP TRIGGER "sg_contact_points_delete";

DROP TRIGGER "sg_contact_points_insert";

DROP TRIGGER "sg_contact_points_update";

DROP TRIGGER "sg_epoch_custom_claim_schemas_delete";

DROP TRIGGER "sg_epoch_custom_claim_schemas_insert";

DROP TRIGGER "sg_epoch_custom_claim_schemas_update";

DROP TRIGGER "sg_epoch_roles_delete";

DROP TRIGGER "sg_epoch_roles_insert";

DROP TRIGGER "sg_epoch_roles_update";

DROP TRIGGER "sg_identity_accounts_delete";

DROP TRIGGER "sg_identity_accounts_insert";

DROP TRIGGER "sg_identity_accounts_update";

DROP TRIGGER "sg_user_roles_delete";

DROP TRIGGER "sg_user_roles_insert";

DROP TRIGGER "sg_user_roles_update";

DROP TRIGGER "sg_write_boundary_delete";

DROP TRIGGER "sg_write_boundary_insert";

DROP TRIGGER "trg_account_creation_operation_status_transition";

DROP TRIGGER "trg_account_lifecycle_event_outbox_initial_state";

DROP TRIGGER "trg_account_lifecycle_event_outbox_status_transition";

DROP TRIGGER "trg_account_routing_outbox_status_transition";

DROP TRIGGER "trg_account_support_context_account_immutable";

DROP TRIGGER "trg_account_support_context_account_tenant_insert";

DROP TRIGGER "trg_account_support_context_active_hold_delete";

DROP TRIGGER "trg_account_support_context_version";

DROP TRIGGER "trg_identity_accounts_active_hold_delete";

DROP TRIGGER "trg_identity_accounts_legal_hold_state_insert";

DROP TRIGGER "trg_legal_hold_events_immutable_delete";

DROP TRIGGER "trg_legal_hold_events_immutable_update";

DROP TRIGGER "trg_legal_holds_account_tenant_insert";

DROP TRIGGER "trg_legal_holds_account_tenant_update";

DROP TRIGGER "trg_legal_holds_immutable_delete";

DROP TRIGGER "trg_legal_holds_one_active_account_insert";

DROP TRIGGER "trg_legal_holds_projection_state_insert";

DROP TRIGGER "trg_legal_holds_projection_state_update";

DROP TRIGGER "trg_legal_holds_transition";

DROP TRIGGER "trg_notification_delivery_history_recipient_immutable";

DROP TRIGGER "trg_notification_delivery_intent_initial_state";

DROP TRIGGER "trg_notification_delivery_intent_payload_immutable";

DROP TRIGGER "trg_notification_delivery_intent_state_transition";

DROP TRIGGER "trg_plugin_hook_outbox_claim_fencing";

DROP TRIGGER "trg_plugin_hook_outbox_initial_state";

DROP TRIGGER "trg_plugin_hook_outbox_status_transition";

DROP TRIGGER "trg_tenant_placement_capture_identity_immutable";

DROP TRIGGER "trg_tenant_placement_capture_no_delete";

DROP TRIGGER "trg_tenant_placement_capture_one_active_insert";

DROP TRIGGER "trg_tenant_placement_capture_one_active_update";

DROP TRIGGER "trg_tenant_placement_capture_transition";

DROP TRIGGER "trg_tenant_placement_outbox_payload_immutable";

DROP TRIGGER "trg_tenant_placement_policy_no_scope_weakening";

DROP TRIGGER "trg_tenants_lookup_retention_policy_insert";

DROP TABLE "access_review_items";

DROP TABLE "account_creation_operations";

DROP TABLE "account_lifecycle_event_outbox";

DROP TABLE "account_routing_outbox";

DROP TABLE "account_support_contexts";

DROP TABLE "account_webhook_outbox";

DROP TABLE "admin_jobs";

DROP TABLE "assurance_evidence";

DROP TABLE "attribute_release_consents";

DROP TABLE "audit_log";

DROP TABLE "authrim_migrations";

DROP TABLE "authrim_runtime_probes";

DROP TABLE "branding_settings";

DROP TABLE "check_api_keys";

DROP TABLE "ciba_requests";

DROP TABLE "client_consent_overrides";

DROP TABLE "client_trust_policies";

DROP TABLE "compliance_reports";

DROP TABLE "consent_history";

DROP TABLE "consent_item_history";

DROP TABLE "consent_policy_items";

DROP TABLE "consent_policy_versions";

DROP TABLE "consent_records";

DROP TABLE "consent_statement_localizations";

DROP TABLE "contact_point_search_indexes";

DROP TABLE "contact_verifications";

DROP TABLE "credential_configurations";

DROP TABLE "credential_offers";

DROP TABLE "custom_claim_schema_history";

DROP TABLE "custom_claim_schemas";

DROP TABLE "data_export_requests";

DROP TABLE "delegations";

DROP TABLE "device_codes";

DROP TABLE "device_installations";

DROP TABLE "device_secrets";

DROP TABLE "did_document_cache";

DROP TABLE "directory_auth_config_history";

DROP TABLE "directory_auth_evidence_exports";

DROP TABLE "directory_auth_migration_campaigns";

DROP TABLE "directory_auth_migration_transaction_events";

DROP TABLE "directory_auth_migration_transactions";

DROP TABLE "directory_auth_migration_user_states";

DROP TABLE "directory_auth_release_advisories";

DROP TABLE "directory_auth_retention_policies";

DROP TABLE "directory_auth_support_bundles";

DROP TABLE "directory_auth_tenant_policies";

DROP TABLE "directory_connector_instances";

DROP TABLE "directory_connector_status_episodes";

DROP TABLE "directory_identity_links";

DROP TABLE "directory_jit_pending_users";

DROP TABLE "entitlements";

DROP TABLE "event_log";

DROP TABLE "external_idp_auth_states";

DROP TABLE "external_lifecycle_signal_decisions";

DROP TABLE "field_usage_bindings";

DROP TABLE "flow_assignments";

DROP TABLE "flow_audit_events";

DROP TABLE "flow_interaction_steps";

DROP TABLE "group_memberships";

DROP TABLE "guest_account_upgrades";

DROP TABLE "guest_deletion_audit_outbox";

DROP TABLE "guest_devices";

DROP TABLE "idempotency_keys";

DROP TABLE "identity_binding_lookup_indexes";

DROP TABLE "identity_resolution_candidates";

DROP TABLE "identity_resolution_events";

DROP TABLE "internal_notification_delivery_attempts";

DROP TABLE "internal_notification_delivery_routes";

DROP TABLE "internal_notification_events";

DROP TABLE "legal_hold_events";

DROP TABLE "legal_hold_projection_outbox";

DROP TABLE "log_chunk_manifests";

DROP TABLE "log_object_catalog";

DROP TABLE "logging_catalog_repair_jobs";

DROP TABLE "logging_quota_evaluations";

DROP TABLE "logging_quota_policies";

DROP TABLE "logging_usage_aggregates";

DROP TABLE "lookup_retention_policies";

DROP TABLE "lookup_retention_policy_projection_outbox";

DROP TABLE "migration_metadata";

DROP TABLE "notification_delivery_intents";

DROP TABLE "oauth_client_consents";

DROP TABLE "object_catalog_objects";

DROP TABLE "oidc_scopes";

DROP TABLE "operational_logs";

DROP TABLE "org_domain_mappings";

DROP TABLE "passkeys";

DROP TABLE "password_reset_tokens";

DROP TABLE "permission_change_audit";

DROP TABLE "permission_check_audit";

DROP TABLE "plugin_account_metadata";

DROP TABLE "plugin_hook_outbox";

DROP TABLE "profile_attribute_values";

DROP TABLE "provisioning_assignment_events";

DROP TABLE "provisioning_assignment_ownership";

DROP TABLE "provisioning_assignment_rules";

DROP TABLE "provisioning_revocation_events";

DROP TABLE "refresh_token_shard_configs";

DROP TABLE "relation_definitions";

DROP TABLE "relationship_closure";

DROP TABLE "relationships";

DROP TABLE "resource_permissions";

DROP TABLE "role_assignment_rules";

DROP TABLE "role_assignments";

DROP TABLE "saml_attribute_presets";

DROP TABLE "screens";

DROP TABLE "security_alerts";

DROP TABLE "security_threats";

DROP TABLE "sensitive_detail_chunk_index";

DROP TABLE "service_group_audit";

DROP TABLE "service_group_catalog";

DROP TABLE "service_group_epoch";

DROP TABLE "service_group_write_boundaries";

DROP TABLE "sessions";

DROP TABLE "settings_history";

DROP TABLE "sign_in_confirmation_policies";

DROP TABLE "structured_attribute_values";

DROP TABLE "subject_account_links";

DROP TABLE "subject_lifecycle_timeline_events";

DROP TABLE "subject_org_membership";

DROP TABLE "support_operation_actions";

DROP TABLE "support_operation_cohort_targets";

DROP TABLE "suspicious_activities";

DROP TABLE "tenant_consent_requirements";

DROP TABLE "tenant_database_migration_state";

DROP TABLE "tenant_database_probe_results";

DROP TABLE "tenant_domain_mappings";

DROP TABLE "tenant_invitations";

DROP TABLE "tenant_placement_migration_outbox";

DROP TABLE "tenant_vanity_domains";

DROP TABLE "token_claim_rules";

DROP TABLE "totp_backup_codes";

DROP TABLE "totp_credentials";

DROP TABLE "trusted_issuers";

DROP TABLE "user_consent_records";

DROP TABLE "user_roles";

DROP TABLE "user_token_families";

DROP TABLE "user_verified_attributes";

DROP TABLE "value_provenance";

DROP TABLE "web_origin_registry";

DROP TABLE "webhook_deliveries";

DROP TABLE "webhook_delivery_logs";

DROP TABLE "access_reviews";

DROP TABLE "attribute_verifications";

DROP TABLE "consent_policies";

DROP TABLE "consent_statement_versions";

DROP TABLE "contact_points";

DROP TABLE "external_lifecycle_signal_events";

DROP TABLE "flow_interactions";

DROP TABLE "groups";

DROP TABLE "identity_bindings";

DROP TABLE "issued_credentials";

DROP TABLE "legal_holds";

DROP TABLE "object_catalog";

DROP TABLE "organizations";

DROP TABLE "profiles";

DROP TABLE "roles";

DROP TABLE "support_operation_cohorts";

DROP TABLE "tenant_placement_migration_captures";

DROP TABLE "tenants";

DROP TABLE "upstream_providers";

DROP TABLE "users";

DROP TABLE "users_core";

DROP TABLE "webhook_configs";

DROP TABLE "consent_statements";

DROP TABLE "flow_versions";

DROP TABLE "identity_accounts";

DROP TABLE "identity_providers";

DROP TABLE "status_lists";

DROP TABLE "vp_requests";

DROP TABLE "identity_subjects";

DROP TABLE "presentation_definitions";

CREATE TABLE access_review_items (
  id TEXT PRIMARY KEY
 NOT NULL
,
  review_id TEXT NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,        -- User being reviewed
  permission_type TEXT NOT NULL, -- role, permission, group_membership
  permission_value TEXT NOT NULL, -- The specific permission/role/group
  decision TEXT,                -- approved, revoked, pending
  decided_by TEXT,              -- Reviewer who made decision
  decided_at TEXT,              -- When decision was made
  justification TEXT,           -- Reason for decision
  created_at TEXT NOT NULL
);

CREATE TABLE access_reviews (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,           -- Review campaign name
  description TEXT,             -- Campaign description
  scope TEXT NOT NULL,          -- all_users, role, organization, application
  scope_value TEXT,             -- Value for scope (role_id, org_id, client_id)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, cancelled
  reviewer_id TEXT,             -- User assigned to review
  total_items INTEGER NOT NULL DEFAULT 0,     -- Total items to review
  reviewed_items INTEGER NOT NULL DEFAULT 0,  -- Items reviewed
  approved_items INTEGER NOT NULL DEFAULT 0,  -- Items approved (access retained)
  revoked_items INTEGER NOT NULL DEFAULT 0,   -- Items revoked (access removed)
  created_at TEXT NOT NULL,
  started_at TEXT,              -- When review started
  completed_at TEXT,            -- When review completed
  due_date TEXT                 -- Review deadline
);

CREATE TABLE account_creation_operations (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  allocation_idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN (
      'preparing', 'reserved', 'writing', 'directory_pending',
      'succeeded', 'blocked', 'canceled'
    )),
  publication_json TEXT
    CHECK (publication_json IS NULL OR
      (json_valid(publication_json) AND length(publication_json) <= 16384)),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, actor_id, idempotency_key),
  UNIQUE (tenant_id, account_id),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE TABLE "account_lifecycle_event_outbox" (
  event_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'account.created'),
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 4096),
  plugin_targets_json TEXT
    CHECK (plugin_targets_json IS NULL OR
      (json_valid(plugin_targets_json) AND length(plugin_targets_json) <= 4096)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, operation_id, event_type),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL) OR
         status <> 'retry'),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE TABLE account_routing_outbox (
  outbox_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('account_created', 'identifier_added', 'identifier_replaced', 'identifier_removed', 'account_disabled', 'account_deleted')),
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  route_schema_version INTEGER NOT NULL CHECK (route_schema_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'pending', 'leased', 'retry', 'succeeded', 'blocked', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE TABLE account_support_contexts (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{"schema_version":1}'
    CHECK (json_valid(context_json) AND json_type(context_json) = 'object' AND
           length(context_json) BETWEEN 20 AND 32768),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(account_id) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
);

CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
);

CREATE TABLE admin_jobs (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL,

  -- Job type (e.g., 'users/import', 'users/bulk-update', 'reports/generate')
  job_type TEXT NOT NULL,

  -- Job status (pending, processing, completed, failed, partial_failure)
  status TEXT NOT NULL DEFAULT 'pending',

  -- Progress tracking (JSON)
  -- { "total": 100, "processed": 45, "succeeded": 43, "failed": 2 }
  progress TEXT,

  -- Job configuration (JSON)
  -- Input parameters for the job
  config TEXT,

  -- R2 key for input file (for import jobs)
  input_r2_key TEXT,

  -- R2 key for result file (for completed jobs with large results)
  result_r2_key TEXT,
  object_catalog_id TEXT,

  -- Result summary (JSON, for completed jobs)
  -- { "summary": {...}, "failures": [...] }
  result TEXT,

  -- Error information (for failed jobs)
  error_code TEXT,
  error_message TEXT,

  -- Actor who created the job
  created_by TEXT NOT NULL,

  -- Timestamps (Unix timestamp in seconds)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,

  -- Estimated completion time
  estimated_completion INTEGER,

  -- Generic job runner retry/dead-letter state
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  dead_lettered_at INTEGER
);

CREATE TABLE assurance_evidence (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  binding_id TEXT,
  evidence_type TEXT NOT NULL,
  issuer_ref TEXT,
  assurance_framework TEXT,
  assurance_level TEXT,
  evidence_hash TEXT,
  evidence_storage_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE attribute_release_consents (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  destination_type TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  attribute_set_hash TEXT NOT NULL,
  consent_mode TEXT NOT NULL,
  consent_state TEXT NOT NULL DEFAULT 'granted',
  consent_record_id TEXT,
  first_granted_at INTEGER,
  last_confirmed_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
);

CREATE TABLE attribute_verifications (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vp_request_id TEXT REFERENCES vp_requests(id),
    -- Issuer DID
    issuer_did TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- Verification result: 'verified' | 'failed' | 'expired'
    verification_result TEXT NOT NULL,
    -- Individual verification flags
    holder_binding_verified INTEGER DEFAULT 0,
    issuer_trusted INTEGER DEFAULT 0,
    status_valid INTEGER DEFAULT 0,
    -- JSON array of user_verified_attributes IDs
    mapped_attribute_ids TEXT,
    verified_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT
, credential_profile_id TEXT, credential_profile_version_id TEXT, mapping_version_id TEXT, mapping_snapshot_hash TEXT, policy_version TEXT, evidence_fingerprint TEXT, status_checked_at INTEGER, status_fresh_until INTEGER, revalidate_after INTEGER, invalidated_at INTEGER, invalidation_reason TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default', severity TEXT DEFAULT 'info');

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

CREATE TABLE branding_settings (
  id TEXT PRIMARY KEY DEFAULT 'default'
 NOT NULL
,
  custom_css TEXT,
  custom_html_header TEXT,
  custom_html_footer TEXT,
  logo_url TEXT,
  background_image_url TEXT,
  primary_color TEXT DEFAULT '#3B82F6',
  secondary_color TEXT DEFAULT '#10B981',
  font_family TEXT DEFAULT 'Inter',
  -- Authentication method settings
  enabled_auth_methods TEXT DEFAULT '["passkey","magic_link"]', -- JSON array
  password_policy_json TEXT, -- Password policy config (if password auth enabled)
  updated_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default');

CREATE TABLE check_api_keys (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,                    -- SHA-256 hash of the API key
    key_prefix TEXT NOT NULL,                  -- First 8 chars (chk_xxxx) for identification
    allowed_operations TEXT DEFAULT '["check"]', -- JSON array: check, batch, subscribe
    rate_limit_tier TEXT DEFAULT 'moderate',   -- strict, moderate, lenient
    is_active INTEGER DEFAULT 1,
    expires_at INTEGER,                        -- Unix timestamp, NULL = no expiry
    created_by TEXT,                           -- User ID who created this key
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE "ciba_requests" (
  auth_req_id TEXT PRIMARY KEY
 NOT NULL
,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  login_hint TEXT,
  login_hint_token TEXT,
  id_token_hint TEXT,
  binding_message TEXT,
  user_code TEXT,
  acr_values TEXT,
  requested_expiry INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('poll', 'ping', 'push')),
  client_notification_token TEXT,
  client_notification_endpoint TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  interval INTEGER NOT NULL DEFAULT 5,
  user_id TEXT,
  sub TEXT,
  nonce TEXT,
  token_issued INTEGER DEFAULT 0,
  token_issued_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE client_consent_overrides (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'inherit', -- 'required'|'optional'|'hidden'|'inherit'
  min_version TEXT,                      -- null = use tenant default
  enforcement TEXT,                      -- null = use tenant default
  conditional_rules_json TEXT,           -- null = use tenant default
  display_order INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, statement_id)
);

CREATE TABLE client_trust_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('oidc_client', 'saml_sp')),
  target_id TEXT NOT NULL,
  first_party INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 0,
  skip_authorization_consent INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, target_type, target_id)
);

CREATE TABLE compliance_reports (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- audit_log, access_report, user_activity, etc.
  name TEXT NOT NULL,           -- Report name/title
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, generating, completed, failed
  requested_by TEXT,            -- User who requested the report
  parameters TEXT,              -- JSON: Report generation parameters
  result_url TEXT,              -- URL to download completed report
  error_message TEXT,           -- Error message if failed
  created_at TEXT NOT NULL,
  completed_at TEXT,            -- When report generation completed
  expires_at TEXT               -- When report download expires
);

CREATE TABLE consent_history (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'granted' | 'updated' | 'revoked' | 'version_upgraded' | 'expired' | 'scopes_updated'
  scopes_before TEXT,    -- JSON array of previous scopes (null for initial grant)
  scopes_after TEXT,     -- JSON array of new scopes (null for revocation)
  privacy_policy_version TEXT,
  tos_version TEXT,
  ip_address_hash TEXT,  -- Hashed IP for privacy
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,    -- Additional context as JSON
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE "consent_item_history" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  version_id_before TEXT,
  version_id_after TEXT,
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER
);

CREATE TABLE consent_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE consent_policy_items (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'required', -- 'required'|'optional'|'hidden'
  version_mode TEXT NOT NULL DEFAULT 'current', -- 'current'|'fixed'|'minimum'
  version_id TEXT,
  min_version TEXT,
  checkbox_mode TEXT NOT NULL DEFAULT 'required', -- 'none'|'required'|'optional'
  checkbox_default_checked INTEGER NOT NULL DEFAULT 0,
  binding_type TEXT, -- 'scope'|'claim'|'saml_attribute'|'destination_field_set'
  binding_value TEXT,
  evidence_profile TEXT,
  language_fallback TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, policy_id, statement_id)
);

CREATE TABLE consent_policy_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL,
  policy_type TEXT NOT NULL,  -- 'privacy_policy' | 'terms_of_service' | 'cookie_policy'
  policy_uri TEXT,
  policy_hash TEXT,           -- SHA-256 hash of policy content for integrity verification
  effective_at INTEGER NOT NULL,  -- Unix timestamp when this version becomes effective
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_type, version)
);

CREATE TABLE consent_records (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  protocol TEXT NOT NULL CHECK (protocol IN ('oidc', 'saml', 'document', 'custom')),
  consent_kind TEXT NOT NULL CHECK (
    consent_kind IN (
      'terms',
      'privacy',
      'attribute_release',
      'scope_claim_release',
      'form_confirmation',
      'custom'
    )
  ),
  client_id TEXT,
  saml_sp_id TEXT,
  recipient_type TEXT CHECK (
    recipient_type IN ('oidc_client', 'saml_sp', 'tenant', 'external_party')
  ),
  recipient_id TEXT,
  binding_type TEXT NOT NULL CHECK (
    binding_type IN ('subject', 'identity_schema', 'destination_field_mapping_set', 'user_decision')
  ),
  binding_key TEXT,
  resource_type TEXT CHECK (
    resource_type IN ('userinfo', 'id_token', 'saml_attributes', 'document', 'custom')
  ),
  resource_id TEXT,
  purpose_key TEXT,
  statement_id TEXT NOT NULL,
  statement_version TEXT NOT NULL,
  policy_id TEXT,
  flow_id TEXT,
  flow_version_id TEXT,
  flow_node_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'once', 'always', 'selected')),
  selected_value TEXT,
  selected_options_json TEXT,
  released_scopes_json TEXT,
  released_claims_json TEXT,
  released_attributes_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'revoked', 'expired', 'superseded')
  ),
  expires_at INTEGER,
  revoked_at INTEGER,
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE consent_statement_localizations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version_id TEXT NOT NULL,
  language TEXT NOT NULL,                -- BCP 47: 'en', 'ja', 'de'
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  document_url TEXT,                     -- External document URL (content_type='url')
  inline_content TEXT,                   -- Inline text (content_type='inline')
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, processing_purpose TEXT, withdrawal_impact TEXT,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE CASCADE,
  UNIQUE (version_id, language)
);

CREATE TABLE consent_statement_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL,
  version TEXT NOT NULL,                 -- YYYYMMDD fixed: '20250206'
  content_type TEXT NOT NULL DEFAULT 'url', -- 'url' | 'inline'
  effective_at INTEGER NOT NULL,
  content_hash TEXT,                     -- SHA-256 integrity hash
  is_current INTEGER NOT NULL DEFAULT 0,
  current_statement_guard TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft'|'active'|'archived'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, effective_until INTEGER,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id, version)
);

CREATE TABLE consent_statements (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'custom',
  legal_basis TEXT NOT NULL DEFAULT 'consent',
  processing_purpose TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, record_retention_days INTEGER, withdrawal_allowed INTEGER NOT NULL DEFAULT 1, withdrawal_impact TEXT, reconsent_on_version_change INTEGER NOT NULL DEFAULT 1, reconsent_interval_days INTEGER,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE contact_point_search_indexes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_point_id TEXT NOT NULL,
  index_kind TEXT NOT NULL,
  index_value TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1,
  classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, index_kind, index_value, index_version),
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
);

CREATE TABLE contact_points (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  contact_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'primary',
  normalized_hash TEXT,
  value_storage_ref TEXT,
  display_label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE TABLE contact_verifications (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_point_id TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  evidence_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
);

CREATE TABLE credential_configurations (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    -- Configuration ID (used in metadata)
    configuration_id TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- Verifiable Credential Type
    vct TEXT NOT NULL,
    -- JSON of display information
    display TEXT,
    -- JSON of claims configuration
    claims TEXT,
    -- JSON of proof types supported
    proof_types_supported TEXT,
    -- Signing algorithm
    signing_alg TEXT DEFAULT 'ES256',
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(tenant_id, configuration_id)
);

CREATE TABLE credential_offers (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Credential configuration ID
    credential_configuration_id TEXT NOT NULL,
    -- Pre-authorized code
    pre_authorized_code TEXT,
    -- Transaction code (PIN)
    tx_code TEXT,
    -- JSON of grants configuration
    grants TEXT NOT NULL,
    -- Status: 'pending' | 'accepted' | 'issued' | 'failed' | 'expired'
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    issued_at TEXT,
    issued_credential_id TEXT,
    issued_credential_internal_id TEXT,
    FOREIGN KEY (issued_credential_internal_id) REFERENCES issued_credentials(internal_id)
);

CREATE TABLE custom_claim_schema_history (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE custom_claim_schemas (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
, ui_group_key TEXT, ui_group_label TEXT, ui_group_order INTEGER NOT NULL DEFAULT 0, ui_field_order INTEGER NOT NULL DEFAULT 0, examples_json TEXT CHECK(examples_json IS NULL OR json_valid(examples_json)), cardinality TEXT NOT NULL DEFAULT 'single'
  CHECK (cardinality IN ('single', 'multi')));

CREATE TABLE data_export_requests (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed' | 'expired'
  format TEXT NOT NULL DEFAULT 'json',     -- 'json' | 'csv'
  include_sections TEXT NOT NULL,          -- JSON array: ["profile", "consents", "sessions", "audit_log", "passkeys"]
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER,                      -- Download link expiration
  file_path TEXT,                          -- R2 object path (for async exports)
  object_catalog_id TEXT,                  -- object_catalog pointer for materialized export artifacts
  file_size INTEGER,
  error_message TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE delegations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  delegate_subject_id TEXT NOT NULL,
  parent_delegation_id TEXT,
  chain_id TEXT,
  delegation_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  scope_json TEXT,
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE "device_codes" (
  device_code TEXT PRIMARY KEY
 NOT NULL
,
  user_code TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  user_id TEXT,
  sub TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  token_issued INTEGER DEFAULT 0,
  token_issued_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (tenant_id, client_id)
    REFERENCES oauth_clients(tenant_id, client_id)
    ON DELETE CASCADE
);

CREATE TABLE device_installations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT,
  trust_group_id TEXT,
  source_installation_id TEXT,
  source_client_id TEXT,
  linked_device_secret_id TEXT,
  session_id TEXT,
  display_name TEXT,
  device_platform TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE device_secrets (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  device_name TEXT,
  device_platform TEXT,
  installation_id TEXT,
  client_id TEXT,
  trust_group_id TEXT,
  source_installation_id TEXT,
  source_client_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE did_document_cache (
    did TEXT PRIMARY KEY
 NOT NULL
,
    -- JSON of DID Document
    document TEXT NOT NULL,
    resolved_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL
);

CREATE TABLE directory_auth_config_history (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_auth_evidence_exports (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_auth_migration_campaigns (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_auth_migration_transaction_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  campaign_id TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  event_payload_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE directory_auth_migration_transactions (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_auth_migration_user_states (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_auth_release_advisories (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_auth_retention_policies (
  tenant_id TEXT PRIMARY KEY
 NOT NULL
,
  authrim_audit_retention_days INTEGER NOT NULL DEFAULT 365,
  wordwarden_local_retention_days INTEGER,
  artifact_delete_grace_hours INTEGER NOT NULL DEFAULT 72,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE directory_auth_support_bundles (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_auth_tenant_policies (
  tenant_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE directory_connector_instances (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT,
  transport TEXT NOT NULL,
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'disconnected', 'stale', 'version_mismatch', 'unhealthy', 'deactivated')),
  health_status TEXT NOT NULL,
  health_summary_json TEXT NOT NULL DEFAULT '{}',
  config_fingerprint TEXT NOT NULL,
  config_categories_json TEXT NOT NULL DEFAULT '[]',
  drift_severity TEXT NOT NULL DEFAULT 'none'
    CHECK (drift_severity IN ('none', 'warning', 'critical')),
  deactivated_at INTEGER,
  deactivated_by TEXT,
  deactivation_reason TEXT,
  updated_at INTEGER NOT NULL, release_channel TEXT NOT NULL DEFAULT 'stable',
  UNIQUE (tenant_id, connector_id, instance_id)
);

CREATE TABLE directory_connector_status_episodes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'disconnected', 'stale', 'version_mismatch', 'unhealthy', 'deactivated')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  reason TEXT,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE directory_identity_links (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  latest_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (tenant_id, connector_id, directory_subject)
);

CREATE TABLE directory_jit_pending_users (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  login_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'linked')),
  directory_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decision_reason TEXT,
  linked_user_id TEXT,
  UNIQUE (tenant_id, connector_id, directory_subject)
);

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  entitlement_type TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  source_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  value_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, entitlement_type, entitlement_key, subject_id, account_id)
);

CREATE TABLE event_log (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  event_category TEXT NOT NULL,
  result TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  error_code TEXT,
  error_message TEXT,
  anonymized_user_id TEXT,
  client_id TEXT,
  session_id TEXT,
  request_id TEXT,
  duration_ms INTEGER,
  details_r2_key TEXT,
  details_json TEXT,
  retention_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE external_idp_auth_states (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,                        -- Client ID from the original auth request
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  state TEXT UNIQUE NOT NULL,            -- OAuth state parameter
  nonce TEXT,                            -- OIDC nonce for ID token validation
  code_verifier TEXT,                    -- PKCE code verifier for Authrim ↔ External IdP
  code_challenge TEXT,                   -- PKCE code challenge from client ↔ Authrim
  flow_id TEXT,                          -- Flow ID for diagnostic logging correlation
  redirect_uri TEXT NOT NULL,            -- Where to redirect after auth

  -- For linking flow
  user_id TEXT,                          -- Set if linking to existing account
  session_id TEXT,                       -- Authrim session (for linking flow)

  -- For OIDC proxy flow (future)
  original_auth_request TEXT,            -- JSON of original OIDC auth request

  -- OIDC Core 1.0 parameters (for validation in callback)
  max_age INTEGER,                       -- max_age parameter for auth_time validation
  acr_values TEXT,                       -- acr_values parameter for acr validation

  -- Silent Auth & SSO control (Phase 1 & 2)
  prompt TEXT,                           -- OIDC prompt parameter (none, login, consent, select_account)
  enable_sso INTEGER NOT NULL DEFAULT 1, -- 1 = SSO enabled (handoff), 0 = SSO disabled (Direct Auth)

  -- Timestamps
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,                   -- When state was consumed (for single-use)

  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

CREATE TABLE external_lifecycle_signal_decisions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  signal_event_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  decision TEXT NOT NULL,
  propagation_targets_json TEXT,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (signal_event_id) REFERENCES external_lifecycle_signal_events(id) ON DELETE CASCADE
);

CREATE TABLE external_lifecycle_signal_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_timestamp INTEGER,
  observed_at INTEGER NOT NULL,
  binding_version TEXT,
  payload_ref TEXT,
  signal_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, source_type, source_id, dedupe_key)
);

CREATE TABLE field_usage_bindings (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE "flow_assignments" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  target_type TEXT NOT NULL CHECK (
    target_type IN ('tenant', 'oidc_client', 'saml_sp', 'credential_profile')
  ),
  target_id TEXT,
  flow_kind TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL)
    OR (target_type IN ('oidc_client', 'saml_sp', 'credential_profile') AND target_id IS NOT NULL)
  ),
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
);

CREATE TABLE flow_audit_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  node_id TEXT,
  branch_handle_id TEXT,
  event_type TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  contract_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE flow_interaction_steps (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'waiting_input', 'processing', 'completed', 'skipped', 'failed')
  ),
  selected_handle TEXT,
  state_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (interaction_id) REFERENCES flow_interactions(id) ON DELETE CASCADE
);

CREATE TABLE flow_interactions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'active', 'completed', 'expired', 'failed')),
  current_node_id TEXT,
  current_step_id TEXT,
  contract_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER, context_json TEXT,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  FOREIGN KEY (flow_version_id) REFERENCES flow_versions(id) ON DELETE CASCADE
);

CREATE TABLE flow_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  runtime_snapshot_json TEXT NOT NULL,
  editor_snapshot_json TEXT,
  validation_result_json TEXT NOT NULL,
  published_by TEXT,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, flow_id, version_number)
);

CREATE TABLE group_memberships (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  membership_type TEXT NOT NULL DEFAULT 'member',
  assignment_source TEXT NOT NULL DEFAULT 'manual',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_id, subject_id, account_id, membership_type),
  FOREIGN KEY (group_id) REFERENCES "groups"(id) ON DELETE CASCADE
);

CREATE TABLE "groups" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  parent_group_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
);

CREATE TABLE guest_account_upgrades (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  guest_user_id TEXT NOT NULL,
  upgraded_user_id TEXT NOT NULL,
  upgrade_method TEXT NOT NULL,
  provider_id TEXT,
  preserve_sub INTEGER NOT NULL DEFAULT 1 CHECK (preserve_sub = 1),
  upgraded_at BIGINT NOT NULL,
  data_migrated INTEGER NOT NULL DEFAULT 0 CHECK (data_migrated IN (0, 1))
);

CREATE TABLE guest_deletion_audit_outbox (
  audit_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE guest_devices (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  resume_credential_hash TEXT NOT NULL CHECK (length(resume_credential_hash) = 64),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE idempotency_keys (
    id TEXT PRIMARY KEY
 NOT NULL
,          -- Composite: tenant_id:actor_id:method:path:resource_id:key
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,       -- admin_id who made the request
    method TEXT NOT NULL,         -- HTTP method (POST, PUT, DELETE)
    path TEXT NOT NULL,           -- API path pattern
    resource_id TEXT,             -- Target resource ID (if applicable)
    idempotency_key TEXT NOT NULL,-- The Idempotency-Key header value
    body_hash TEXT NOT NULL,      -- SHA-256 hash of request body
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,  -- Sanitized response (PII removed)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE identity_accounts (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  account_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  legacy_user_id TEXT,
  primary_subject_id TEXT,
  display_label TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER, directory_publication_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (directory_publication_state IN ('pending', 'active_pending_directory', 'active', 'disabled')), account_route_generation INTEGER NOT NULL DEFAULT 1
  CHECK (account_route_generation >= 1), registration_state TEXT NOT NULL DEFAULT 'registered'
  CHECK (registration_state IN ('guest', 'registered')),
  FOREIGN KEY (primary_subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL
);

CREATE TABLE identity_binding_lookup_indexes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  identity_binding_id TEXT NOT NULL,
  lookup_kind TEXT NOT NULL,
  lookup_value TEXT NOT NULL,
  lookup_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lookup_kind, lookup_value, lookup_version),
  FOREIGN KEY (identity_binding_id) REFERENCES identity_bindings(id) ON DELETE CASCADE
);

CREATE TABLE identity_bindings (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  protocol TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider_subject_key_hash TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT 'external_subject',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  assurance_level TEXT,
  trust_context_snapshot_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  last_seen_at INTEGER,
  UNIQUE (tenant_id, protocol, source_id, provider_subject_key_hash),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL
);

CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY
 NOT NULL
,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default');

CREATE TABLE identity_resolution_candidates (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  candidate_subject_id TEXT,
  candidate_account_id TEXT,
  candidate_binding_id TEXT,
  candidate_score INTEGER NOT NULL DEFAULT 0,
  risk_tier TEXT,
  decision_state TEXT NOT NULL DEFAULT 'pending',
  reason_codes_json TEXT,
  review_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE identity_resolution_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  binding_id TEXT,
  source_id TEXT NOT NULL,
  resolution_method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (binding_id) REFERENCES identity_bindings(id) ON DELETE SET NULL
);

CREATE TABLE identity_subjects (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  display_label TEXT,
  primary_account_id TEXT,
  risk_tier TEXT,
  assurance_level TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
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

CREATE TABLE issued_credentials (
    internal_id TEXT PRIMARY KEY
 NOT NULL
,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- JSON of claims included in credential
    claims TEXT NOT NULL,
    -- Status: 'active' | 'suspended' | 'revoked'
    status TEXT DEFAULT 'active',
    -- Status list for revocation/suspension
    status_list_id TEXT,
    status_list_internal_id TEXT,
    status_list_index INTEGER,
    holder_binding TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT,
    UNIQUE (tenant_id, public_id),
    FOREIGN KEY (status_list_internal_id) REFERENCES status_lists(internal_id)
);

CREATE TABLE legal_hold_events (
  event_id TEXT PRIMARY KEY
 NOT NULL
,
  hold_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'extended', 'released', 'expired')),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  effective_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(event_id) BETWEEN 1 AND 256),
  CHECK (length(actor_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (created_at >= effective_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
);

CREATE TABLE legal_hold_projection_outbox (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_state TEXT NOT NULL CHECK (projection_state IN ('active', 'inactive')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded'),
  CHECK (updated_at >= created_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
);

CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'account' CHECK (subject_type = 'account'),
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'released', 'expired')),
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_by TEXT,
  released_at INTEGER,
  release_reason TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(subject_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (released_by IS NULL OR length(released_by) BETWEEN 1 AND 256),
  CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 256),
  CHECK (expires_at IS NULL OR expires_at >= created_at),
  CHECK (
    (state = 'active' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (state IN ('released', 'expired') AND released_by IS NOT NULL AND released_at IS NOT NULL AND
      release_reason IS NOT NULL)
  ),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (updated_at >= created_at)
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

CREATE TABLE logging_usage_aggregates (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE lookup_retention_policies (
  tenant_id TEXT PRIMARY KEY
 NOT NULL
,
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 3650),
  policy_generation INTEGER NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
);

CREATE TABLE lookup_retention_policy_projection_outbox (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded'),
  CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, policy_generation)
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

CREATE TABLE notification_delivery_intents (
  intent_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  provider_order_version INTEGER NOT NULL CHECK (provider_order_version >= 1),
  provider_installation_ids_json TEXT NOT NULL
    CHECK (json_valid(provider_installation_ids_json)
      AND json_type(provider_installation_ids_json) = 'array'
      AND json_array_length(provider_installation_ids_json) BETWEEN 1 AND 8),
  active_provider_index INTEGER NOT NULL DEFAULT 0 CHECK (active_provider_index BETWEEN 0 AND 7),
  provider_started_at INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  notification_kind TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  payload_key_id TEXT,
  payload_envelope_json TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB '*[^a-zA-Z0-9._:-]*'
      AND length(fingerprint_key_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'canceled', 'expired', 'dead_letter')),
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  canceled_at INTEGER,
  dead_lettered_at INTEGER,
  delete_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, account_id TEXT, recipient_masked TEXT, recipient_encrypted TEXT, recipient_encryption_key_version INTEGER, provider_message_id TEXT, provider_accepted_at INTEGER, delivery_status TEXT NOT NULL DEFAULT 'requested'
  CHECK (delivery_status IN (
    'requested', 'provider_accepted', 'delivered', 'deferred', 'bounced', 'failed',
    'rejected', 'complained', 'unknown'
  )), delivery_status_updated_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0), last_error_code TEXT,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (length(intent_id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (active_provider_index < json_array_length(provider_installation_ids_json)),
  CHECK (json_extract(provider_installation_ids_json, '$[0]') = plugin_installation_id),
  CHECK (notification_kind NOT GLOB '*[^a-z0-9._:-]*'
    AND length(notification_kind) BETWEEN 1 AND 128),
  CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CHECK (expires_at > created_at),
  CHECK (provider_started_at >= created_at),
  CHECK (delete_after >= expires_at),
  CHECK (
    (state = 'pending'
      AND payload_key_id IS NOT NULL
      AND payload_key_id NOT GLOB '*[^a-zA-Z0-9._:-]*'
      AND length(payload_key_id) BETWEEN 1 AND 128
      AND payload_envelope_json IS NOT NULL
      AND json_valid(payload_envelope_json)
      AND length(payload_envelope_json) BETWEEN 1 AND 196608
      AND delivered_at IS NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = 'delivered'
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND delivered_at IS NOT NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state IN ('canceled', 'expired')
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND canceled_at IS NOT NULL
      AND delivered_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = 'dead_letter'
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND dead_lettered_at IS NOT NULL
      AND delivered_at IS NULL
      AND canceled_at IS NULL)
  )
);

CREATE TABLE "oauth_client_consents" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  selected_scopes TEXT,
  privacy_policy_version TEXT,
  tos_version TEXT,
  consent_version INTEGER DEFAULT 1,
  UNIQUE (tenant_id, user_id, client_id)
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

CREATE TABLE oidc_scopes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  scope_type TEXT NOT NULL DEFAULT 'custom' CHECK (scope_type IN ('system', 'custom')),
  enabled INTEGER NOT NULL DEFAULT 1,
  localizations_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE operational_logs (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,  -- Code expects: 'user', 'client', 'session'
    subject_id TEXT NOT NULL,    -- Code expects this name, not 'resource_id'
    actor_id TEXT NOT NULL,      -- Who performed the operation
    action TEXT NOT NULL,        -- 'user.suspend', 'user.lock', etc.
    reason_detail_encrypted TEXT,-- AES-GCM encrypted reason_detail
    encryption_key_version INTEGER NOT NULL DEFAULT 1, -- Code expects this column
    detail_object_catalog_id TEXT,
    request_id TEXT,             -- X-Request-ID header value
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, -- When this log should be deleted

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE org_domain_mappings (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Domain identification (hashed for privacy)
  -- Algorithm: HMAC-SHA256(lowercase(domain), secret_key)
  domain_hash TEXT NOT NULL,

  -- Key rotation support
  domain_hash_version INTEGER DEFAULT 1,

  -- Target organization
  org_id TEXT NOT NULL,                   -- Reference to organizations.id

  -- Auto-join settings
  auto_join_enabled INTEGER DEFAULT 1,    -- 0 = mapping exists but auto-join disabled
  membership_type TEXT NOT NULL DEFAULT 'member',  -- member, admin, owner
  auto_assign_role_id TEXT,               -- Optional: auto-assign this role on join

  -- Verification status
  verified INTEGER DEFAULT 0,             -- 1 = domain ownership verified (DNS TXT, etc.)

  -- Priority for multiple mappings
  priority INTEGER DEFAULT 0,             -- Higher = preferred when multiple match

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, verification_token TEXT, verification_status TEXT DEFAULT 'unverified', verification_expires_at INTEGER, verification_method TEXT,

  -- Constraints
  -- Allow same domain to map to multiple orgs with different versions
  UNIQUE(tenant_id, domain_hash, domain_hash_version, org_id)
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  org_type TEXT NOT NULL DEFAULT 'enterprise',  -- distributor, enterprise, department
  parent_org_id TEXT REFERENCES organizations(id),
  plan TEXT DEFAULT 'free',  -- free, starter, professional, enterprise
  is_active INTEGER DEFAULT 1,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE "passkeys" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT 'default', aaguid TEXT, rp_id TEXT,
  UNIQUE(tenant_id, credential_id)
);

CREATE TABLE "password_reset_tokens" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE permission_change_audit (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    event_type TEXT NOT NULL,                  -- 'grant', 'revoke', 'modify'
    subject_id TEXT NOT NULL,
    resource TEXT,                             -- Resource affected (optional)
    relation TEXT,                             -- Relation affected (optional)
    permission TEXT,                           -- Permission affected (optional)
    timestamp INTEGER NOT NULL,                -- Event timestamp (Unix milliseconds)
    created_at INTEGER NOT NULL                -- Record creation time (Unix seconds)
);

CREATE TABLE permission_check_audit (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    subject_id TEXT NOT NULL,
    permission TEXT NOT NULL,                  -- Original permission string
    permission_json TEXT,                      -- Structured permission (if provided)
    allowed INTEGER NOT NULL,                  -- 1 = allowed, 0 = denied
    resolved_via_json TEXT NOT NULL,           -- JSON array: ["role", "rebac"]
    final_decision TEXT NOT NULL,              -- 'allow' | 'deny'
    reason TEXT,                               -- Denial reason (when denied)
    api_key_id TEXT,                           -- Which API key was used (if any)
    client_id TEXT,                            -- Client ID (from API key or token)
    checked_at INTEGER NOT NULL                -- Unix timestamp
);

CREATE TABLE plugin_account_metadata (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  value_json TEXT NOT NULL
    CHECK (json_valid(value_json) AND length(value_json) BETWEEN 1 AND 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id, plugin_id, metadata_key),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (metadata_key NOT GLOB '*[^a-z0-9._-]*' AND length(metadata_key) BETWEEN 1 AND 64)
);

CREATE TABLE plugin_hook_outbox (
  outbox_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  payload_class TEXT NOT NULL DEFAULT 'reference_v1' CHECK (payload_class = 'reference_v1'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'locked', 'waiting_retry', 'succeeded', 'dead_letter', 'canceled')),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  claim_owner TEXT,
  claim_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  dead_lettered_at INTEGER,
  canceled_at INTEGER,
  delete_after INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_installation_id, idempotency_key),
  CHECK (
    (status = 'locked' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL
      AND lease_until IS NOT NULL AND lease_until > updated_at AND attempt_no >= 1) OR
    (status <> 'locked' AND claim_owner IS NULL AND claim_token IS NULL AND lease_until IS NULL)
  ),
  CHECK ((status = 'waiting_retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL)
    OR status <> 'waiting_retry'),
  CHECK ((status = 'queued' AND attempt_no = 0 AND next_attempt_at IS NULL) OR status <> 'queued'),
  CHECK ((status IN ('succeeded', 'dead_letter') AND attempt_no >= 1)
    OR status NOT IN ('succeeded', 'dead_letter')),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL AND delete_after = succeeded_at + 604800) OR status <> 'succeeded'),
  CHECK ((status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND delete_after = dead_lettered_at + 7776000) OR status <> 'dead_letter'),
  CHECK ((status = 'canceled' AND canceled_at IS NOT NULL) OR status <> 'canceled')
);

CREATE TABLE presentation_definitions (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    purpose TEXT,
    -- JSON: {"dc+sd-jwt": {...}, "mso_mdoc": {...}}
    format TEXT NOT NULL,
    -- JSON array of input descriptors
    input_descriptors TEXT NOT NULL,
    -- JSON for complex submission requirements
    submission_requirements TEXT,
    -- DCQL query (preferred for HAIP)
    dcql_query TEXT,
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE profile_attribute_values (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT,
  value_storage_ref TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  purpose TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  profile_type TEXT NOT NULL DEFAULT 'person',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  locale TEXT,
  zoneinfo TEXT,
  display_name_ref TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, subject_id, profile_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE
);

CREATE TABLE provisioning_assignment_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT,
  subject_id TEXT,
  account_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE provisioning_assignment_ownership (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  assignment_type TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  source_id TEXT,
  ownership_policy TEXT NOT NULL DEFAULT 'source_owned',
  revoke_policy TEXT NOT NULL DEFAULT 'review',
  protected_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, assignment_type, assignment_id, source_id)
);

CREATE TABLE provisioning_assignment_rules (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  rule_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE provisioning_revocation_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  source_event_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE refresh_token_shard_configs (
  id TEXT PRIMARY KEY
 NOT NULL
,                -- UUID
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,                     -- NULL = global config
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,      -- When this config was activated (ms)
  deprecated_at INTEGER,              -- When this config was deprecated (ms)
  created_by TEXT,                    -- Admin user who created this config
  notes TEXT,                         -- Human-readable notes

  UNIQUE(tenant_id, client_id, generation)
);

CREATE TABLE relation_definitions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  -- Object type this definition applies to
  object_type TEXT NOT NULL,        -- 'document', 'folder', 'org', etc.
  -- Relation name being defined
  relation_name TEXT NOT NULL,      -- 'viewer', 'editor', 'owner', etc.
  -- Relation composition rule (JSON)
  definition_json TEXT NOT NULL,
  -- Description for documentation
  description TEXT,
  -- Evaluation priority (higher = evaluated first)
  priority INTEGER DEFAULT 0,
  -- Whether this definition is active
  is_active INTEGER DEFAULT 1,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE relationship_closure (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  -- Ancestor (source) entity
  ancestor_type TEXT NOT NULL,      -- 'subject', 'org', 'group'
  ancestor_id TEXT NOT NULL,
  -- Descendant (target) entity
  descendant_type TEXT NOT NULL,    -- 'document', 'folder', 'org', 'resource'
  descendant_id TEXT NOT NULL,
  -- Computed relation (derived from relationship chain)
  relation TEXT NOT NULL,           -- 'viewer', 'editor', 'owner'
  -- Path information
  depth INTEGER NOT NULL,           -- Number of hops (0 = direct)
  path_json TEXT,                   -- JSON array of relationship IDs in the path
  -- Computed metadata
  effective_permission TEXT,        -- Most restrictive permission in path
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE relationships (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  relationship_type TEXT NOT NULL,  -- parent_child, guardian, delegate, manager, reseller_of
  from_type TEXT NOT NULL DEFAULT 'subject',  -- subject, org (future)
  from_id TEXT NOT NULL,  -- subject_id or org_id
  to_type TEXT NOT NULL DEFAULT 'subject',  -- subject, org (future)
  to_id TEXT NOT NULL,  -- subject_id or org_id
  permission_level TEXT NOT NULL DEFAULT 'full',  -- full, limited, read_only
  expires_at INTEGER,  -- Optional expiration (UNIX seconds)
  is_bidirectional INTEGER DEFAULT 0,  -- Phase 1: always 0
  metadata_json TEXT,  -- Additional constraints, notes, etc.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, evidence_type TEXT DEFAULT 'manual', evidence_ref TEXT);

CREATE TABLE resource_permissions (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Subject (who has the permission)
  subject_type TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'role' | 'org'
  subject_id TEXT NOT NULL,                   -- user_id, role_id, or org_id

  -- Resource (what is being accessed)
  resource_type TEXT NOT NULL,                -- e.g., 'documents', 'projects'
  resource_id TEXT NOT NULL,                  -- e.g., 'doc_123', 'proj_456'

  -- Actions allowed (JSON array)
  -- Example: ["read", "write", "delete"]
  actions_json TEXT NOT NULL,

  -- Optional condition for permission (JSON)
  -- Example: {"time_restricted": true, "hours": [9, 17]}
  condition_json TEXT,

  -- Expiration (UNIX seconds)
  -- NULL = no expiration
  -- Evaluated at token generation time only
  expires_at INTEGER,

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Audit fields
  granted_by TEXT,                            -- Admin or system that granted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  -- Same subject can have only one permission entry per resource
  UNIQUE(tenant_id, subject_type, subject_id, resource_type, resource_id)
);

CREATE TABLE role_assignment_rules (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target role (reference only, no FK for flexibility)
  role_id TEXT NOT NULL,

  -- Scope for assigned role
  scope_type TEXT NOT NULL DEFAULT 'global',  -- global, org, resource
  scope_target TEXT NOT NULL DEFAULT '',      -- e.g., 'org:org_123' or '' for global

  -- Conditions (JSON format)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "email_domain_hash", "operator": "eq", "value": "abc123..."},
  --   {"field": "idp_claim", "claim_path": "groups", "operator": "contains", "value": "admin"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "assign_role", "role_id": "role_org_admin", "scope_type": "org", "scope_target": "auto"},
  --   {"type": "join_org", "org_id": "auto"}
  -- ]
  actions_json TEXT NOT NULL,

  -- Priority and control
  priority INTEGER NOT NULL DEFAULT 0,    -- Higher = evaluated first (DESC order)
  stop_processing INTEGER DEFAULT 0,      -- 1 = stop evaluating further rules after match
  is_active INTEGER DEFAULT 1,            -- 0 = disabled

  -- Validity period (optional, UNIX seconds)
  valid_from INTEGER,                     -- NULL = no start restriction
  valid_until INTEGER,                    -- NULL = no end restriction

  -- Audit fields
  created_by TEXT,                        -- Admin user ID who created
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, name)
);

CREATE TABLE "role_assignments" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'custom',
  hierarchy_level INTEGER DEFAULT 0,
  is_assignable INTEGER DEFAULT 1,
  parent_role_id TEXT REFERENCES roles(id),
  display_name TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER, external_id TEXT,
  UNIQUE(tenant_id, name)
);

CREATE TABLE saml_attribute_presets (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  applies_to TEXT NOT NULL DEFAULT 'sp_attribute_release',
  profile TEXT NOT NULL DEFAULT 'custom',
  stability TEXT NOT NULL DEFAULT 'custom',
  application_mode TEXT NOT NULL DEFAULT 'clone_edit',
  attribute_release_policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, label)
);

CREATE TABLE "screens" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  screen_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  screen_kind TEXT NOT NULL CHECK (
    screen_kind IN (
      'registration',
      'profile_completion',
      'login',
      'consent',
      'code_input',
      'account',
      'custom'
    )
  ),
  fields_json TEXT NOT NULL,
  localizations_json TEXT,
  settings_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, screen_key)
);

CREATE TABLE security_alerts (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        'brute_force',
        'credential_stuffing',
        'suspicious_login',
        'impossible_travel',
        'account_takeover',
        'mfa_bypass_attempt',
        'token_abuse',
        'rate_limit_exceeded',
        'config_change',
        'privilege_escalation',
        'data_exfiltration',
        'other'
    )),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    title TEXT NOT NULL,
    description TEXT,
    source_ip TEXT,
    user_id TEXT,
    client_id TEXT,
    metadata TEXT, -- JSON string for additional context
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    acknowledged_by TEXT,
    resolved_at INTEGER,
    resolved_by TEXT,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE security_threats (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- credential_compromise, attack_pattern, vulnerability, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  status TEXT NOT NULL DEFAULT 'active',  -- active, investigating, mitigated, resolved
  title TEXT NOT NULL,          -- Short title
  description TEXT,             -- Detailed description
  source TEXT,                  -- Detection source (system, external, manual)
  affected_resources TEXT,      -- JSON: List of affected resources
  indicators TEXT,              -- JSON: Indicators of compromise (IOCs)
  metadata TEXT,                -- JSON: Additional context
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,    -- When threat was detected
  mitigated_at TEXT             -- When threat was mitigated
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
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE
);

CREATE TABLE service_group_audit (
 id TEXT PRIMARY KEY
 NOT NULL
, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 rule_version INTEGER NOT NULL, generation INTEGER NOT NULL,
 event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE service_group_catalog (
 tenant_id TEXT PRIMARY KEY
 NOT NULL
, revision INTEGER NOT NULL DEFAULT 0, plan_json TEXT NOT NULL,
 updated_at INTEGER NOT NULL, write_token TEXT NOT NULL
);

CREATE TABLE service_group_epoch (
 tenant_id TEXT PRIMARY KEY
 NOT NULL
, revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY
 NOT NULL
, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE "sessions" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  external_provider_id TEXT,
  external_provider_sub TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default', external_provider_sid TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE settings_history (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Category (oauth, rate_limit, logout, webhook, feature_flags, etc.)
  category TEXT NOT NULL,

  -- Version number (auto-incremented per tenant+category)
  version INTEGER NOT NULL,

  -- Full configuration snapshot (JSON)
  -- This allows complete restoration without dependencies
  snapshot TEXT NOT NULL,

  -- Change summary (JSON)
  -- { "added": [...], "removed": [...], "modified": [...] }
  changes TEXT NOT NULL,

  -- Actor who made the change
  actor_id TEXT,           -- User ID or 'system'
  actor_type TEXT,         -- 'user', 'admin', 'system', 'api'

  -- Change metadata
  change_reason TEXT,      -- Optional reason for the change
  change_source TEXT,      -- 'admin_api', 'settings_ui', 'migration', 'rollback'

  -- Timestamps
  created_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, category, version)
);

CREATE TABLE sign_in_confirmation_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'login', -- 'login' for initial implementation
  mode TEXT NOT NULL DEFAULT 'disabled', -- 'disabled'|'first_time'|'every_time'
  remember_duration_days INTEGER NOT NULL DEFAULT 365,
  show_application_context INTEGER NOT NULL DEFAULT 1,
  show_tenant_context INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, trigger_type)
);

CREATE TABLE status_lists (
    internal_id TEXT PRIMARY KEY
 NOT NULL
,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    -- Purpose: 'revocation' | 'suspension'
    purpose TEXT NOT NULL DEFAULT 'revocation',
    -- Bitstring of status values (base64url encoded)
    encoded_list TEXT NOT NULL,
    -- Current index for new credentials
    current_index INTEGER DEFAULT 0,
    -- Total capacity
    capacity INTEGER DEFAULT 131072,
    used_count INTEGER DEFAULT 0,
    state TEXT DEFAULT 'active',
    sealed_at TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE (tenant_id, public_id)
);

CREATE TABLE structured_attribute_values (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  projected_index_json TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE subject_account_links (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'primary',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, subject_id, account_id, link_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE TABLE subject_lifecycle_timeline_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  event_type TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  summary_json TEXT,
  event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE "subject_org_membership" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  membership_type TEXT NOT NULL DEFAULT 'member',
  is_primary INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE support_operation_actions (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE support_operation_cohort_targets (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE support_operation_cohorts (
  id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE suspicious_activities (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- brute_force, credential_stuffing, anomalous_login, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  user_id TEXT,                 -- Associated user (nullable for pre-auth events)
  client_id TEXT,               -- Associated OAuth client
  source_ip TEXT,               -- Source IP address
  user_agent TEXT,              -- User agent string
  description TEXT,             -- Human-readable description
  metadata TEXT,                -- JSON: Additional context data
  created_at TEXT NOT NULL,     -- When detected
  resolved_at TEXT              -- When resolved/dismissed
);

CREATE TABLE tenant_consent_requirements (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 0,
  min_version TEXT,
  enforcement TEXT NOT NULL DEFAULT 'block',
  show_deletion_link INTEGER NOT NULL DEFAULT 0,
  deletion_url TEXT,
  conditional_rules_json TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id)
);

CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY
 NOT NULL
,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
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

CREATE TABLE tenant_domain_mappings (
  id                      TEXT PRIMARY KEY
 NOT NULL
,
  domain_hash             TEXT NOT NULL,
  hash_version            INTEGER NOT NULL DEFAULT 1,
  tenant_id               TEXT NOT NULL,
  priority                INTEGER NOT NULL DEFAULT 0,
  is_active               INTEGER NOT NULL DEFAULT 1,
  active_domain_hash      TEXT,
  verified                INTEGER NOT NULL DEFAULT 0,
  verification_token      TEXT,
  verification_expires_at INTEGER,
  created_by              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE tenant_invitations (
  id             TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE tenant_placement_migration_captures (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  capture_state TEXT NOT NULL DEFAULT 'capturing'
    CHECK (capture_state IN ('capturing', 'write_fenced', 'cutover_committed', 'canceled')),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  installed_at INTEGER NOT NULL,
  write_fenced_at INTEGER,
  cutover_committed_at INTEGER,
  canceled_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((capture_state = 'write_fenced' AND write_fenced_at IS NOT NULL)
    OR capture_state <> 'write_fenced'),
  CHECK ((capture_state = 'cutover_committed' AND cutover_committed_at IS NOT NULL)
    OR capture_state <> 'cutover_committed'),
  CHECK ((capture_state = 'canceled' AND canceled_at IS NOT NULL)
    OR capture_state <> 'canceled')
);

CREATE TABLE tenant_placement_migration_outbox (
  source_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (
    length(table_name) BETWEEN 1 AND 128 AND table_name NOT GLOB '*[^a-z0-9_]*'
  ),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('upsert', 'delete')),
  mutation_key_json TEXT NOT NULL CHECK (json_valid(mutation_key_json)),
  row_json TEXT CHECK (row_json IS NULL OR json_valid(row_json)),
  capture_fencing_token INTEGER NOT NULL CHECK (capture_fencing_token >= 1),
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'applied')),
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES tenant_placement_migration_captures(operation_id),
  CHECK ((mutation_kind = 'upsert' AND row_json IS NOT NULL) OR
         (mutation_kind = 'delete' AND row_json IS NULL)),
  CHECK ((delivery_state = 'applied' AND applied_at IS NOT NULL) OR
         (delivery_state = 'pending' AND applied_at IS NULL))
);

CREATE TABLE tenant_vanity_domains (
  id                             TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id                      TEXT NOT NULL,
  hostname                       TEXT NOT NULL,
  is_active                      INTEGER NOT NULL DEFAULT 1,
  active_hostname                TEXT,
  is_primary                     INTEGER NOT NULL DEFAULT 0,
  primary_active_tenant_key      TEXT,
  status                         TEXT NOT NULL DEFAULT 'pending',
  cloudflare_zone_id             TEXT,
  cloudflare_custom_hostname_id  TEXT,
  ssl_status                     TEXT,
  ownership_status               TEXT,
  validation_method              TEXT,
  validation_records_json        TEXT,
  last_sync_at                   INTEGER,
  created_by                     TEXT,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY
 NOT NULL
,           -- slug format: ^[a-z0-9-]+$, max 63chars
  tenant_code TEXT NOT NULL UNIQUE,       -- manual-entry/discovery code (globally unique)
  tenant_key  TEXT NOT NULL UNIQUE,       -- opaque key for logging/storage object paths
  name        TEXT NOT NULL,              -- display name
  description TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0, -- default tenant (only one)
  default_tenant_guard TEXT,              -- 'default' when is_default=1, NULL otherwise
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
, lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN (
    'provisioning',
    'active',
    'suspended',
    'frozen',
    'migration_read_only',
    'deleting',
    'deleted',
    'restore_pending',
    'restore_validating'
  )), isolation_policy TEXT NOT NULL DEFAULT 'tenant_exclusive'
  CHECK (isolation_policy IN ('shared_pool', 'tenant_exclusive')));

CREATE TABLE token_claim_rules (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target token type
  token_type TEXT NOT NULL DEFAULT 'access',  -- 'access' | 'id' | 'both'

  -- Conditions (JSON format, same structure as role_assignment_rules)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "has_role", "operator": "contains", "value": "premium_user"},
  --   {"field": "org_type", "operator": "eq", "value": "enterprise"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "add_claim", "claim_name": "tier", "claim_value": "premium"},
  --   {"type": "add_claim_template", "claim_name": "greeting", "template": "Hello {{user_type}}"},
  --   {"type": "copy_from_context", "claim_name": "org", "context_field": "org_id"}
  -- ]
  actions_json TEXT NOT NULL,

  -- Priority and control
  priority INTEGER NOT NULL DEFAULT 0,    -- Higher = evaluated first (DESC order)
  stop_processing INTEGER DEFAULT 0,      -- 1 = stop evaluating further rules after match
  is_active INTEGER DEFAULT 1,            -- 0 = disabled

  -- Validity period (optional, UNIX seconds)
  valid_from INTEGER,                     -- NULL = no start restriction
  valid_until INTEGER,                    -- NULL = no end restriction

  -- Audit fields
  created_by TEXT,                        -- Admin user ID who created
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, name)
);

CREATE TABLE totp_backup_codes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  credential_id TEXT,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  UNIQUE (tenant_id, user_id, code_hash)
);

CREATE TABLE totp_credentials (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  window INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  last_used_time_step INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_used_at INTEGER,
  CHECK (algorithm IN ('SHA1', 'SHA256')),
  CHECK (digits IN (6, 8)),
  CHECK (period BETWEEN 15 AND 300),
  CHECK (window BETWEEN 0 AND 2),
  CHECK (status IN ('pending', 'active', 'disabled'))
);

CREATE TABLE trusted_issuers (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    issuer_did TEXT NOT NULL,
    display_name TEXT,
    -- JSON array of accepted Verifiable Credential Types
    credential_types TEXT,
    -- Trust level: 'standard' | 'high' (HAIP-compliant)
    trust_level TEXT DEFAULT 'standard',
    -- JWKS URI for issuer public keys
    jwks_uri TEXT,
    -- Issuer status: 'active' | 'suspended' | 'revoked'
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(tenant_id, issuer_did)
);

CREATE TABLE upstream_providers (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,                    -- Display name: "Google", "GitHub"
  provider_type TEXT NOT NULL,           -- 'oidc' | 'oauth2'
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,            -- Display order (lower = higher priority)

  -- OIDC/OAuth2 endpoints
  issuer TEXT,                           -- OIDC issuer URL (for discovery)
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL, -- Encrypted with RP_TOKEN_ENCRYPTION_KEY
  authorization_endpoint TEXT,           -- Override for non-standard providers
  token_endpoint TEXT,
  userinfo_endpoint TEXT,
  jwks_uri TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid email profile', -- Space-separated

  -- Configuration
  attribute_mapping TEXT DEFAULT '{}',   -- JSON: {"sub": "sub", "email": "email"}
  auto_link_email INTEGER DEFAULT 1,     -- Enable email-based identity stitching
  jit_provisioning INTEGER DEFAULT 1,    -- Create user on first login
  require_email_verified INTEGER DEFAULT 1, -- Only link if email is verified

  -- Provider-specific settings
  provider_quirks TEXT DEFAULT '{}',     -- JSON for provider-specific handling

  -- UI customization
  icon_url TEXT,                         -- Provider icon for login button
  icon_name TEXT,                        -- Built-in icon name for login button
  button_color TEXT,                     -- Brand color for login button (hex, light theme)
  button_color_dark TEXT,                -- Brand color for login button (hex, dark theme)
  button_text TEXT,                      -- Custom button text (optional)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, slug TEXT, token_endpoint_auth_method TEXT DEFAULT 'client_secret_post', always_fetch_userinfo INTEGER DEFAULT 0, enable_sso INTEGER NOT NULL DEFAULT 1, use_request_object INTEGER DEFAULT 0, request_object_signing_alg TEXT, private_key_jwk_encrypted TEXT, public_key_jwk TEXT);

CREATE TABLE "user_consent_records" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  client_id TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  receipt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id),
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id),
  UNIQUE (tenant_id, user_id, statement_id)
);

CREATE TABLE "user_roles" (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE "user_token_families" (
  jti TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  is_revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE user_verified_attributes (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Attribute name: 'age_over_18', 'country', 'organization', etc.
    attribute_name TEXT NOT NULL,
    -- Attribute value: 'true', 'JP', 'Acme Corp', etc.
    attribute_value TEXT NOT NULL,
    -- Source type: 'vc' | 'saml' | 'oidc' | 'manual'
    source_type TEXT NOT NULL DEFAULT 'vc',
    -- Issuer DID (for VC-sourced attributes)
    issuer_did TEXT,
    -- Reference to verification record
    verification_id TEXT REFERENCES attribute_verifications(id),
    verified_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT, revalidate_after INTEGER, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    -- Each user can have only one value per attribute
    UNIQUE(tenant_id, user_id, attribute_name)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY
 NOT NULL
,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,
  profile TEXT,
  picture TEXT,
  website TEXT,
  gender TEXT,
  birthdate TEXT,
  zoneinfo TEXT,
  locale TEXT,
  phone_number TEXT,
  phone_number_verified INTEGER DEFAULT 0,
  address_json TEXT,
  custom_attributes_json TEXT,
  parent_user_id TEXT REFERENCES users(id),
  identity_provider_id TEXT REFERENCES identity_providers(id),
  -- Password authentication fields (optional, disabled by default)
  password_hash TEXT,
  password_changed_at INTEGER,
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until INTEGER,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
, tenant_id TEXT NOT NULL DEFAULT 'default', user_type TEXT NOT NULL DEFAULT 'end_user', status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked')), suspended_at INTEGER, suspended_until INTEGER, locked_at INTEGER);

CREATE TABLE users_core (
  -- Primary key (UUID, same as users_pii.id)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Verification status (not PII - just flags)
  email_verified INTEGER DEFAULT 0,
  phone_number_verified INTEGER DEFAULT 0,

  -- Blind index for domain-based role assignment (Phase 8)
  -- Stored as hash, cannot be reversed to original domain
  email_domain_hash TEXT,

  -- Authentication
  password_hash TEXT,

  -- Soft delete (1 = active, 0 = deleted)
  is_active INTEGER DEFAULT 1,

  -- User type: end_user | admin | m2m
  -- m2m is reserved for non-human service principals represented as user rows.
  -- Many OAuth client_credentials actors are modeled as OAuth clients instead.
  user_type TEXT NOT NULL DEFAULT 'end_user',

  -- PII partition info
  -- Which database contains this user's PII (e.g., 'default', 'eu', 'tenant-acme')
  pii_partition TEXT NOT NULL DEFAULT 'default',

  -- PII write status
  -- none: No PII (M2M clients)
  -- pending: Core created, PII write in progress
  -- active: Both Core and PII created successfully
  -- failed: PII write failed (requires retry via Admin UI)
  -- deleted: PII deleted (GDPR), tombstone created
  pii_status TEXT NOT NULL DEFAULT 'pending',

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
, email_domain_hash_version INTEGER DEFAULT 1, external_id TEXT DEFAULT NULL,
  -- Operational access control only. Keep separate from future lifecycle_state.
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked')),
  -- Account lifecycle stage. Keep separate from status and user_type.
  -- Values: invited, pending_verification, provisioning, incomplete,
  -- active, dormant, archived, deprovisioned.
  lifecycle_state TEXT DEFAULT 'active' CHECK (
    lifecycle_state IN (
      'invited',
      'pending_verification',
      'provisioning',
      'incomplete',
      'active',
      'dormant',
      'archived',
      'deprovisioned'
    )
  ),
  suspended_at INTEGER,
  suspended_until INTEGER,
  locked_at INTEGER,
  locked_until INTEGER
);

CREATE TABLE value_provenance (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_table TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_record_id TEXT,
  source_field_ref TEXT,
  source_authority_contract_id TEXT,
  observed_at INTEGER NOT NULL,
  confidence_score INTEGER,
  provenance_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE vp_requests (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    -- Nonce for replay protection (single-use, enforced by DO)
    nonce TEXT NOT NULL,
    state TEXT,
    -- Reference to presentation definition (optional, can use inline)
    presentation_definition_id TEXT REFERENCES presentation_definitions(id),
    response_uri TEXT NOT NULL,
    -- Response mode: 'direct_post' | 'direct_post.jwt' | 'fragment' | 'query'
    response_mode TEXT DEFAULT 'direct_post',
    -- Request status: 'pending' | 'submitted' | 'verified' | 'failed' | 'expired'
    status TEXT DEFAULT 'pending',
    -- Error information if failed
    error_code TEXT,
    error_description TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    verified_at TEXT
);

CREATE TABLE web_origin_registry (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  cors_allowed INTEGER NOT NULL DEFAULT 1,
  csp_frame_ancestors TEXT,
  handoff_allowed INTEGER NOT NULL DEFAULT 1,
  iframe_allowed INTEGER NOT NULL DEFAULT 0,
  environment TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, origin)
);

CREATE TABLE webhook_configs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  scope TEXT NOT NULL DEFAULT 'tenant',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_encrypted TEXT,
  headers TEXT,
  retry_policy TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT
, payload_fields TEXT NOT NULL DEFAULT '[]', registration_states TEXT NOT NULL DEFAULT '[]');

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY
 NOT NULL
,
  webhook_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
  status_code INTEGER,
  request_headers TEXT,
  request_body TEXT,
  response_body TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  detail_object_catalog_id TEXT,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
);

CREATE TABLE webhook_delivery_logs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
);

CREATE INDEX idx_access_review_items_decision ON access_review_items(review_id, decision);

CREATE INDEX idx_access_review_items_review ON access_review_items(review_id);

CREATE INDEX idx_access_review_items_user ON access_review_items(tenant_id, user_id);

CREATE INDEX idx_access_reviews_created ON access_reviews(tenant_id, created_at);

CREATE INDEX idx_access_reviews_due ON access_reviews(tenant_id, due_date);

CREATE INDEX idx_access_reviews_reviewer ON access_reviews(tenant_id, reviewer_id);

CREATE INDEX idx_access_reviews_status ON access_reviews(tenant_id, status);

CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id);

CREATE INDEX idx_account_creation_operations_status
  ON account_creation_operations(status, updated_at);

CREATE INDEX idx_account_lifecycle_event_outbox_due
  ON account_lifecycle_event_outbox(status, next_attempt_at, created_at, event_id);

CREATE INDEX idx_account_routing_outbox_account_event_route
  ON account_routing_outbox(
    tenant_id,
    account_id,
    event_kind,
    route_generation,
    status,
    outbox_id
  );

CREATE INDEX idx_account_routing_outbox_due
  ON account_routing_outbox(status, next_attempt_at, created_at);

CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until);

CREATE INDEX idx_admin_jobs_cleanup ON admin_jobs(
  status,
  completed_at
);

CREATE INDEX idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);

CREATE INDEX idx_admin_jobs_status ON admin_jobs(
  tenant_id,
  status,
  created_at DESC
);

CREATE INDEX idx_admin_jobs_tenant ON admin_jobs(
  tenant_id,
  created_at DESC
);

CREATE INDEX idx_admin_jobs_type ON admin_jobs(
  tenant_id,
  job_type,
  created_at DESC
);

CREATE INDEX idx_assurance_evidence_subject
  ON assurance_evidence(tenant_id, subject_id, evidence_type, expires_at);

CREATE INDEX idx_attribute_release_consents_destination
  ON attribute_release_consents(tenant_id, destination_type, destination_id, consent_state);

CREATE INDEX idx_attribute_verifications_result ON attribute_verifications(verification_result);

CREATE INDEX idx_attribute_verifications_runtime_validity
  ON attribute_verifications(tenant_id, verification_result, invalidated_at, revalidate_after);

CREATE INDEX idx_attribute_verifications_user ON attribute_verifications(tenant_id, user_id);

CREATE INDEX idx_audit_log_action ON audit_log(action);

CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);

CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);

CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);

CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id);

CREATE INDEX idx_ccs_operation ON custom_claim_schemas(operation_status);

CREATE INDEX idx_ccs_tenant_active ON custom_claim_schemas(tenant_id, is_active, display_order);

CREATE INDEX idx_ccs_tenant_key ON custom_claim_schemas(tenant_id, field_key);

CREATE INDEX idx_ccsh_cleanup ON custom_claim_schema_history(tenant_id, created_at);

CREATE INDEX idx_ccsh_schema ON custom_claim_schema_history(tenant_id, schema_id, version DESC);

CREATE INDEX idx_check_api_keys_client
    ON check_api_keys(client_id);

CREATE UNIQUE INDEX idx_check_api_keys_hash
    ON check_api_keys(key_hash);

CREATE INDEX idx_check_api_keys_prefix
    ON check_api_keys(key_prefix);

CREATE INDEX idx_check_api_keys_tenant_active
    ON check_api_keys(tenant_id, is_active);

CREATE INDEX idx_ciba_client ON ciba_requests(tenant_id, client_id);

CREATE INDEX idx_ciba_status ON ciba_requests(tenant_id, status);

CREATE INDEX idx_ciba_user ON ciba_requests(tenant_id, user_id);

CREATE INDEX idx_cih_retain_until ON consent_item_history(retain_until);

CREATE INDEX idx_cih_statement ON consent_item_history(statement_id, created_at);

CREATE INDEX idx_cih_tenant ON consent_item_history(tenant_id, created_at);

CREATE INDEX idx_cih_user ON consent_item_history(tenant_id, user_id, created_at);

CREATE INDEX idx_client_trust_policies_target
  ON client_trust_policies(tenant_id, target_type, target_id);

CREATE INDEX idx_closure_ancestor_lookup
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, relation);

CREATE INDEX idx_closure_depth
  ON relationship_closure(tenant_id, depth);

CREATE INDEX idx_closure_descendant_lookup
  ON relationship_closure(tenant_id, descendant_type, descendant_id, relation);

CREATE UNIQUE INDEX idx_closure_unique
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, descendant_type, descendant_id, relation);

CREATE INDEX idx_compliance_reports_created ON compliance_reports(tenant_id, created_at);

CREATE INDEX idx_compliance_reports_requested ON compliance_reports(tenant_id, requested_by);

CREATE INDEX idx_compliance_reports_status ON compliance_reports(tenant_id, status);

CREATE INDEX idx_compliance_reports_tenant ON compliance_reports(tenant_id);

CREATE INDEX idx_compliance_reports_type ON compliance_reports(tenant_id, type);

CREATE INDEX idx_consent_history_action
  ON consent_history(action, created_at);

CREATE INDEX idx_consent_history_client
  ON consent_history(client_id, created_at);

CREATE INDEX idx_consent_history_tenant
  ON consent_history(tenant_id, created_at);

CREATE INDEX idx_consent_history_user
  ON consent_history(user_id, created_at);

CREATE INDEX idx_consent_policy_items_policy
  ON consent_policy_items(tenant_id, policy_id, display_order);

CREATE INDEX idx_consent_policy_versions_effective
  ON consent_policy_versions(effective_at);

CREATE INDEX idx_consent_policy_versions_tenant
  ON consent_policy_versions(tenant_id, policy_type);

CREATE INDEX idx_consent_records_flow
  ON consent_records(tenant_id, flow_id, flow_version_id, created_at);

CREATE INDEX idx_consent_records_recipient
  ON consent_records(tenant_id, recipient_type, recipient_id, created_at);

CREATE INDEX idx_consent_records_statement
  ON consent_records(tenant_id, subject_user_id, statement_id, statement_version, status);

CREATE INDEX idx_consent_records_subject
  ON consent_records(tenant_id, subject_user_id, created_at);

CREATE INDEX idx_consent_statements_tenant ON consent_statements(tenant_id, is_active);

CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id);

CREATE INDEX idx_consents_expires_at_active ON oauth_client_consents(expires_at);

CREATE INDEX idx_consents_user ON oauth_client_consents(tenant_id, user_id);

CREATE INDEX idx_contact_points_lookup
  ON contact_points(tenant_id, contact_type, normalized_hash);

CREATE INDEX idx_contact_points_subject
  ON contact_points(tenant_id, subject_id, contact_type, lifecycle_state);

CREATE INDEX idx_contact_verifications_contact
  ON contact_verifications(tenant_id, contact_point_id, verification_state);

CREATE INDEX idx_credential_configurations_tenant ON credential_configurations(tenant_id);

CREATE INDEX idx_credential_offers_code ON credential_offers(pre_authorized_code);

CREATE INDEX idx_credential_offers_status ON credential_offers(tenant_id, status);

CREATE INDEX idx_csl_version ON consent_statement_localizations(version_id, language);

CREATE INDEX idx_csv_effective ON consent_statement_versions(effective_at);

CREATE INDEX idx_csv_statement ON consent_statement_versions(statement_id, is_current);

CREATE UNIQUE INDEX idx_csv_unique_current
  ON consent_statement_versions(tenant_id, current_statement_guard);

CREATE INDEX idx_data_export_expires
  ON data_export_requests(expires_at);

CREATE INDEX idx_data_export_object_catalog
  ON data_export_requests(object_catalog_id);

CREATE INDEX idx_data_export_status
  ON data_export_requests(status, requested_at);

CREATE INDEX idx_data_export_user
  ON data_export_requests(user_id, status);

CREATE INDEX idx_device_codes_client_id ON device_codes(tenant_id, client_id);

CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);

CREATE INDEX idx_device_codes_status ON device_codes(tenant_id, status);

CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);

CREATE INDEX idx_device_installations_client
  ON device_installations(tenant_id, client_id, is_active);

CREATE INDEX idx_device_installations_linked_secret
  ON device_installations(tenant_id, linked_device_secret_id);

CREATE INDEX idx_device_installations_source
  ON device_installations(tenant_id, source_installation_id, client_id);

CREATE INDEX idx_device_installations_trust_group
  ON device_installations(tenant_id, trust_group_id, is_active);

CREATE INDEX idx_device_installations_user
  ON device_installations(tenant_id, user_id, is_active);

CREATE INDEX idx_device_secrets_active_expires
  ON device_secrets(is_active, expires_at);

CREATE INDEX idx_device_secrets_client
  ON device_secrets(tenant_id, client_id);

CREATE INDEX idx_device_secrets_installation
  ON device_secrets(tenant_id, installation_id);

CREATE INDEX idx_device_secrets_secret_hash
  ON device_secrets(secret_hash);

CREATE INDEX idx_device_secrets_session_id
  ON device_secrets(session_id);

CREATE INDEX idx_device_secrets_tenant_user
  ON device_secrets(tenant_id, user_id);

CREATE INDEX idx_device_secrets_trust_group
  ON device_secrets(tenant_id, trust_group_id);

CREATE INDEX idx_did_document_cache_expires ON did_document_cache(expires_at);

CREATE INDEX idx_directory_auth_config_history_tenant_time
  ON directory_auth_config_history (tenant_id, created_at);

CREATE INDEX idx_directory_auth_evidence_exports_object_catalog
  ON directory_auth_evidence_exports (object_catalog_id);

CREATE INDEX idx_directory_auth_evidence_exports_retention
  ON directory_auth_evidence_exports (tenant_id, retention_expires_at);

CREATE INDEX idx_directory_auth_evidence_exports_status
  ON directory_auth_evidence_exports (tenant_id, status, updated_at);

CREATE INDEX idx_directory_auth_migration_campaigns_status
  ON directory_auth_migration_campaigns (tenant_id, status, updated_at);

CREATE INDEX idx_directory_auth_migration_transaction_events_txn
  ON directory_auth_migration_transaction_events (tenant_id, transaction_id, created_at);

CREATE INDEX idx_directory_auth_migration_transactions_state
  ON directory_auth_migration_transactions (tenant_id, state, expires_at);

CREATE INDEX idx_directory_auth_migration_transactions_user
  ON directory_auth_migration_transactions (tenant_id, user_id, created_at);

CREATE INDEX idx_directory_auth_migration_user_states_cohort
  ON directory_auth_migration_user_states (tenant_id, campaign_id, cohort_key, updated_at);

CREATE INDEX idx_directory_auth_migration_user_states_status
  ON directory_auth_migration_user_states (tenant_id, state, updated_at);

CREATE INDEX idx_directory_auth_migration_user_states_user
  ON directory_auth_migration_user_states (tenant_id, user_id, updated_at);

CREATE INDEX idx_directory_auth_release_advisories_channel_time
  ON directory_auth_release_advisories (channel, updated_at);

CREATE INDEX idx_directory_auth_support_bundles_object_catalog
  ON directory_auth_support_bundles (object_catalog_id);

CREATE INDEX idx_directory_auth_support_bundles_retention
  ON directory_auth_support_bundles (tenant_id, retention_expires_at);

CREATE INDEX idx_directory_auth_support_bundles_status
  ON directory_auth_support_bundles (tenant_id, status, updated_at);

CREATE INDEX idx_directory_connector_instances_connector
  ON directory_connector_instances (tenant_id, connector_id, status, last_seen_at);

CREATE INDEX idx_directory_connector_status_episodes_current
  ON directory_connector_status_episodes (tenant_id, connector_id, instance_id, ended_at);

CREATE INDEX idx_directory_connector_status_episodes_recent
  ON directory_connector_status_episodes (tenant_id, connector_id, started_at);

CREATE INDEX idx_directory_identity_links_user
  ON directory_identity_links (tenant_id, user_id);

CREATE INDEX idx_directory_jit_pending_users_status
  ON directory_jit_pending_users (tenant_id, status, updated_at);

CREATE INDEX idx_entitlements_subject
  ON entitlements(tenant_id, subject_id, entitlement_type, lifecycle_state);

CREATE INDEX idx_event_log_tenant_anon_created
    ON event_log(tenant_id, anonymized_user_id, created_at);

CREATE INDEX idx_event_log_tenant_category_created
    ON event_log(tenant_id, event_category, created_at);

CREATE INDEX idx_event_log_tenant_client_created
    ON event_log(tenant_id, client_id, created_at);

CREATE INDEX idx_event_log_tenant_created
    ON event_log(tenant_id, created_at);

CREATE INDEX idx_event_log_tenant_retention
    ON event_log(tenant_id, retention_until, created_at, id);

CREATE INDEX idx_event_log_tenant_type_created
    ON event_log(tenant_id, event_type, created_at);

CREATE INDEX idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at);

CREATE INDEX idx_external_idp_auth_states_expires_at
  ON external_idp_auth_states(expires_at);

CREATE INDEX idx_external_idp_auth_states_state
  ON external_idp_auth_states(state);

CREATE INDEX idx_field_usage_bindings_binding
  ON field_usage_bindings(tenant_id, binding_type, binding_id, is_active);

CREATE INDEX idx_field_usage_bindings_protection
  ON field_usage_bindings(tenant_id, protection, is_active);

CREATE INDEX idx_field_usage_bindings_tenant_field
  ON field_usage_bindings(tenant_id, field_key, is_active);

CREATE INDEX idx_flow_assignments_flow
  ON flow_assignments(tenant_id, flow_id);

CREATE INDEX idx_flow_assignments_target
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind);

CREATE UNIQUE INDEX idx_flow_assignments_target_unique
  ON flow_assignments(tenant_id, target_type, COALESCE(target_id, ''), flow_kind);

CREATE INDEX idx_flow_assignments_tenant_default
  ON flow_assignments(tenant_id, target_type, flow_kind, target_id);

CREATE INDEX idx_flow_audit_events_flow
  ON flow_audit_events(tenant_id, flow_id, flow_version_id, created_at);

CREATE INDEX idx_flow_audit_events_interaction
  ON flow_audit_events(tenant_id, interaction_id, created_at);

CREATE INDEX idx_flow_interaction_steps_node
  ON flow_interaction_steps(tenant_id, interaction_id, node_id);

CREATE INDEX idx_flow_interaction_steps_state
  ON flow_interaction_steps(tenant_id, interaction_id, state);

CREATE INDEX idx_flow_interactions_expiration
  ON flow_interactions(tenant_id, expires_at);

CREATE INDEX idx_flow_interactions_lookup
  ON flow_interactions(tenant_id, id);

CREATE INDEX idx_flow_interactions_state_expiration
  ON flow_interactions(tenant_id, state, expires_at);

CREATE INDEX idx_flow_interactions_state_updated
  ON flow_interactions(tenant_id, state, updated_at, id);

CREATE INDEX idx_flow_versions_lookup
  ON flow_versions(tenant_id, flow_id, version_number);

CREATE INDEX idx_flow_versions_published
  ON flow_versions(tenant_id, flow_id, published_at);

CREATE INDEX idx_group_memberships_subject
  ON group_memberships(tenant_id, subject_id, lifecycle_state);

CREATE INDEX idx_groups_tenant_state
  ON "groups"(tenant_id, lifecycle_state, display_name);

CREATE INDEX idx_guest_account_upgrades_target ON guest_account_upgrades (tenant_id, upgraded_user_id, upgraded_at);

CREATE INDEX idx_guest_account_upgrades_user ON guest_account_upgrades (tenant_id, guest_user_id, upgraded_at);

CREATE INDEX idx_guest_deletion_audit_outbox_due
  ON guest_deletion_audit_outbox (tenant_id, status, next_attempt_at, created_at);

CREATE UNIQUE INDEX idx_guest_devices_active_resume_credential ON guest_devices (tenant_id, resume_credential_hash);

CREATE INDEX idx_guest_devices_expiry ON guest_devices (tenant_id, is_active, expires_at);

CREATE INDEX idx_guest_devices_user ON guest_devices (tenant_id, user_id, is_active, last_used_at DESC);

CREATE INDEX idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);

CREATE INDEX idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key);

CREATE INDEX idx_identity_accounts_directory_publication
  ON identity_accounts(tenant_id, directory_publication_state, created_at, id);

CREATE INDEX idx_identity_accounts_legacy_user
  ON identity_accounts(tenant_id, legacy_user_id);

CREATE INDEX idx_identity_accounts_registration_state ON identity_accounts (tenant_id, registration_state);

CREATE INDEX idx_identity_accounts_tenant_state
  ON identity_accounts(tenant_id, account_type, lifecycle_state);

CREATE INDEX idx_identity_bindings_subject
  ON identity_bindings(tenant_id, subject_id, lifecycle_state);

CREATE UNIQUE INDEX idx_identity_providers_saml_entity_id
  ON identity_providers(
    tenant_id,
    provider_type,
    json_extract(config_json, '$.entityId')
  )
  WHERE provider_type IN ('saml_idp', 'saml_sp')
    AND json_valid(config_json)
    AND json_type(config_json, '$.entityId') = 'text';

CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type);

CREATE INDEX idx_identity_resolution_candidates_state
  ON identity_resolution_candidates(tenant_id, decision_state, created_at);

CREATE INDEX idx_identity_resolution_events_subject
  ON identity_resolution_events(tenant_id, subject_id, created_at);

CREATE INDEX idx_identity_subjects_tenant_type
  ON identity_subjects(tenant_id, subject_type, lifecycle_state);

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

CREATE INDEX idx_issued_credentials_status ON issued_credentials(tenant_id, status);

CREATE INDEX idx_issued_credentials_status_list
    ON issued_credentials(tenant_id, status_list_internal_id, status_list_index);

CREATE INDEX idx_issued_credentials_type ON issued_credentials(tenant_id, credential_type);

CREATE INDEX idx_issued_credentials_user ON issued_credentials(tenant_id, user_id);

CREATE INDEX idx_legal_hold_events_account
  ON legal_hold_events(tenant_id, account_id, created_at DESC, event_id DESC);

CREATE INDEX idx_legal_hold_projection_outbox_runnable
  ON legal_hold_projection_outbox(status, next_attempt_at, tenant_id, operation_id);

CREATE INDEX idx_legal_holds_account_history
  ON legal_holds(tenant_id, subject_id, created_at DESC, id DESC);

CREATE INDEX idx_legal_holds_expiry
  ON legal_holds(state, expires_at, tenant_id, id);

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

CREATE INDEX idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC);

CREATE INDEX idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind);

CREATE INDEX idx_logging_usage_aggregates_window
  ON logging_usage_aggregates(window_kind, window_start_at, metric_name);

CREATE INDEX idx_lookup_retention_policy_projection_outbox_runnable
  ON lookup_retention_policy_projection_outbox(
    status, next_attempt_at, tenant_id, policy_generation
  );

CREATE INDEX idx_membership_org ON subject_org_membership(tenant_id, org_id);

CREATE INDEX idx_membership_subject ON subject_org_membership(tenant_id, subject_id);

CREATE INDEX idx_notification_delivery_history_account_created
  ON notification_delivery_intents(tenant_id, account_id, created_at DESC, intent_id DESC);

CREATE INDEX idx_notification_delivery_history_tenant_created
  ON notification_delivery_intents(tenant_id, created_at DESC, intent_id DESC);

CREATE INDEX idx_notification_delivery_intents_pending
  ON notification_delivery_intents(tenant_id, state, expires_at, intent_id);

CREATE INDEX idx_notification_delivery_intents_retention
  ON notification_delivery_intents(delete_after, state, intent_id);

CREATE INDEX idx_object_catalog_deleted_at
  ON object_catalog(deleted_at);

CREATE INDEX idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC);

CREATE INDEX idx_odm_lookup ON org_domain_mappings(
  tenant_id,
  domain_hash,
  is_active,
  verified DESC,
  priority DESC
);

CREATE INDEX idx_odm_org ON org_domain_mappings(org_id);

CREATE INDEX idx_odm_verification_status ON org_domain_mappings(
  verification_status,
  verification_expires_at
);

CREATE INDEX idx_odm_version ON org_domain_mappings(domain_hash_version);

CREATE INDEX idx_oidc_scopes_enabled
  ON oidc_scopes(tenant_id, enabled, name);

CREATE INDEX idx_operational_logs_actor
    ON operational_logs(actor_id);

CREATE INDEX idx_operational_logs_detail_object_catalog
    ON operational_logs(detail_object_catalog_id);

CREATE INDEX idx_operational_logs_expires
    ON operational_logs(expires_at);

CREATE INDEX idx_operational_logs_subject
    ON operational_logs(subject_type, subject_id);

CREATE INDEX idx_operational_logs_tenant_created
    ON operational_logs(tenant_id, created_at DESC);

CREATE INDEX idx_organizations_is_active ON organizations(is_active);

CREATE INDEX idx_organizations_org_type ON organizations(org_type);

CREATE INDEX idx_organizations_parent_org_id ON organizations(parent_org_id);

CREATE INDEX idx_organizations_tenant_id ON organizations(tenant_id);

CREATE UNIQUE INDEX idx_organizations_tenant_name ON organizations(tenant_id, name);

CREATE INDEX idx_passkeys_credential ON passkeys(tenant_id, credential_id);

CREATE INDEX idx_passkeys_routing_authority
  ON passkeys(tenant_id, created_at, id);

CREATE INDEX idx_passkeys_tenant ON passkeys(tenant_id);

CREATE INDEX idx_passkeys_user ON passkeys(tenant_id, user_id);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(tenant_id, user_id);

CREATE INDEX idx_pca_api_key
    ON permission_check_audit(api_key_id);

CREATE INDEX idx_pca_checked_at
    ON permission_check_audit(checked_at);

CREATE INDEX idx_pca_denied
    ON permission_check_audit(tenant_id, final_decision);

CREATE INDEX idx_pca_tenant_subject
    ON permission_check_audit(tenant_id, subject_id);

CREATE INDEX idx_pcaudit_event_type
    ON permission_change_audit(tenant_id, event_type);

CREATE INDEX idx_pcaudit_tenant_subject
    ON permission_change_audit(tenant_id, subject_id);

CREATE INDEX idx_pcaudit_timestamp
    ON permission_change_audit(timestamp);

CREATE INDEX idx_plugin_account_metadata_installation
  ON plugin_account_metadata(tenant_id, plugin_installation_id, account_id);

CREATE INDEX idx_plugin_hook_outbox_due
  ON plugin_hook_outbox(status, next_attempt_at, created_at);

CREATE INDEX idx_plugin_hook_outbox_retention
  ON plugin_hook_outbox(delete_after, status);

CREATE INDEX idx_presentation_definitions_tenant ON presentation_definitions(tenant_id);

CREATE INDEX idx_profile_attribute_values_profile
  ON profile_attribute_values(tenant_id, profile_id, catalog_entry_id, lifecycle_state);

CREATE INDEX idx_rar_evaluation ON role_assignment_rules(
  tenant_id,
  is_active,
  priority DESC
);

CREATE INDEX idx_rar_role ON role_assignment_rules(role_id);

CREATE INDEX idx_relation_defs_active
  ON relation_definitions(tenant_id, is_active);

CREATE INDEX idx_relation_defs_lookup
  ON relation_definitions(tenant_id, object_type, relation_name);

CREATE INDEX idx_relation_defs_tenant_object
  ON relation_definitions(tenant_id, object_type);

CREATE UNIQUE INDEX idx_relation_defs_unique
  ON relation_definitions(tenant_id, object_type, relation_name);

CREATE INDEX idx_relationships_evidence_type
  ON relationships(tenant_id, evidence_type);

CREATE INDEX idx_relationships_expires_at ON relationships(expires_at);

CREATE INDEX idx_relationships_from ON relationships(tenant_id, from_type, from_id);

CREATE INDEX idx_relationships_tenant_id ON relationships(tenant_id);

CREATE INDEX idx_relationships_to ON relationships(tenant_id, to_type, to_id);

CREATE INDEX idx_relationships_type ON relationships(tenant_id, relationship_type);

CREATE UNIQUE INDEX idx_relationships_unique
  ON relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);

CREATE INDEX idx_role_assignments_role ON role_assignments(tenant_id, role_id);

CREATE INDEX idx_role_assignments_subject ON role_assignments(tenant_id, subject_id);

CREATE INDEX idx_roles_hierarchy_level ON roles(hierarchy_level);

CREATE INDEX idx_roles_name ON roles(tenant_id, name);

CREATE INDEX idx_roles_parent_role_id ON roles(tenant_id, parent_role_id);

CREATE INDEX idx_roles_role_type ON roles(role_type);

CREATE INDEX idx_roles_tenant_id ON roles(tenant_id);

CREATE INDEX idx_rp_expires ON resource_permissions(expires_at);

CREATE INDEX idx_rp_lookup ON resource_permissions(
  tenant_id,
  subject_type,
  subject_id,
  resource_type,
  is_active
);

CREATE INDEX idx_rp_resource ON resource_permissions(
  tenant_id,
  resource_type,
  resource_id,
  is_active
);

CREATE INDEX idx_rtsc_activated_at
  ON refresh_token_shard_configs(activated_at);

CREATE INDEX idx_rtsc_generation
  ON refresh_token_shard_configs(generation);

CREATE INDEX idx_rtsc_tenant_client
  ON refresh_token_shard_configs(tenant_id, client_id);

CREATE INDEX idx_saml_attribute_presets_applies_to ON saml_attribute_presets(tenant_id, applies_to);

CREATE INDEX idx_saml_attribute_presets_tenant ON saml_attribute_presets(tenant_id, created_at DESC);

CREATE INDEX idx_screens_kind
  ON screens(tenant_id, screen_kind, is_active);

CREATE INDEX idx_security_alerts_tenant_created
    ON security_alerts(tenant_id, created_at DESC);

CREATE INDEX idx_security_alerts_tenant_severity
    ON security_alerts(tenant_id, severity);

CREATE INDEX idx_security_alerts_tenant_status
    ON security_alerts(tenant_id, status);

CREATE INDEX idx_security_alerts_tenant_type
    ON security_alerts(tenant_id, type);

CREATE INDEX idx_security_alerts_user
    ON security_alerts(user_id);

CREATE INDEX idx_security_threats_detected ON security_threats(tenant_id, detected_at);

CREATE INDEX idx_security_threats_severity ON security_threats(tenant_id, severity);

CREATE INDEX idx_security_threats_status ON security_threats(tenant_id, status);

CREATE INDEX idx_security_threats_tenant ON security_threats(tenant_id);

CREATE INDEX idx_security_threats_type ON security_threats(tenant_id, type);

CREATE INDEX idx_service_group_audit_subject ON service_group_audit(tenant_id, user_id, created_at);

CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE INDEX idx_sessions_external_provider_sid
  ON sessions(tenant_id, external_provider_id, external_provider_sid)
  WHERE external_provider_sid IS NOT NULL;

CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);

CREATE INDEX idx_sessions_user ON sessions(tenant_id, user_id);

CREATE INDEX idx_settings_history_actor ON settings_history(
  actor_id,
  created_at DESC
);

CREATE INDEX idx_settings_history_category ON settings_history(
  tenant_id,
  category,
  version DESC
);

CREATE INDEX idx_settings_history_cleanup ON settings_history(
  tenant_id,
  category,
  created_at
);

CREATE INDEX idx_soa_approval_request
  ON support_operation_actions(tenant_id, approval_request_id);

CREATE INDEX idx_soa_cohort
  ON support_operation_actions(tenant_id, cohort_id);

CREATE INDEX idx_soa_tenant_created
  ON support_operation_actions(tenant_id, created_at DESC);

CREATE INDEX idx_soa_tenant_status
  ON support_operation_actions(tenant_id, status, updated_at DESC);

CREATE INDEX idx_soc_selector_hash
  ON support_operation_cohorts(tenant_id, resource, selector_hash);

CREATE INDEX idx_soc_snapshot_status
  ON support_operation_cohorts(tenant_id, snapshot_status, created_at DESC);

CREATE INDEX idx_soc_tenant_created
  ON support_operation_cohorts(tenant_id, created_at DESC);

CREATE INDEX idx_soc_tenant_expires
  ON support_operation_cohorts(tenant_id, expires_at);

CREATE INDEX idx_soct_cohort
  ON support_operation_cohort_targets(tenant_id, cohort_id);

CREATE INDEX idx_soct_cohort_block
  ON support_operation_cohort_targets(tenant_id, cohort_id, block_reason);

CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id);

CREATE INDEX idx_status_lists_tenant_public ON status_lists(tenant_id, public_id);

CREATE INDEX idx_structured_attribute_values_owner
  ON structured_attribute_values(tenant_id, owner_type, owner_id, catalog_entry_id);

CREATE INDEX idx_subject_account_links_account
  ON subject_account_links(tenant_id, account_id, lifecycle_state);

CREATE INDEX idx_subject_lifecycle_timeline_subject
  ON subject_lifecycle_timeline_events(tenant_id, subject_id, event_at);

CREATE INDEX idx_suspicious_activities_created ON suspicious_activities(tenant_id, created_at);

CREATE INDEX idx_suspicious_activities_severity ON suspicious_activities(tenant_id, severity);

CREATE INDEX idx_suspicious_activities_tenant ON suspicious_activities(tenant_id);

CREATE INDEX idx_suspicious_activities_type ON suspicious_activities(tenant_id, type);

CREATE INDEX idx_suspicious_activities_user ON suspicious_activities(tenant_id, user_id);

CREATE INDEX idx_tcr_evaluation ON token_claim_rules(
  tenant_id,
  token_type,
  is_active,
  priority DESC,
  created_at ASC
);

CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id);

CREATE UNIQUE INDEX idx_tdm_domain_hash ON tenant_domain_mappings(active_domain_hash);

CREATE INDEX idx_tdm_domain_lookup ON tenant_domain_mappings(domain_hash, is_active);

CREATE INDEX idx_tdm_tenant ON tenant_domain_mappings(tenant_id);

CREATE INDEX idx_tdm_verified ON tenant_domain_mappings(verified, is_active, priority DESC);

CREATE INDEX idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC);

CREATE INDEX idx_tenant_placement_capture_tenant_state
  ON tenant_placement_migration_captures(tenant_id, capture_state);

CREATE INDEX idx_tenant_placement_outbox_pending
  ON tenant_placement_migration_outbox(operation_id, delivery_state, source_sequence);

CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard);

CREATE INDEX idx_ti_tenant ON tenant_invitations(tenant_id, created_at DESC);

CREATE INDEX idx_ti_token ON tenant_invitations(token, expires_at);

CREATE INDEX idx_token_families_client ON user_token_families(tenant_id, client_id);

CREATE INDEX idx_token_families_user ON user_token_families(tenant_id, user_id);

CREATE INDEX idx_totp_backup_codes_unused
  ON totp_backup_codes(tenant_id, user_id, used_at);

CREATE INDEX idx_totp_backup_codes_user
  ON totp_backup_codes(tenant_id, user_id);

CREATE INDEX idx_totp_credentials_active_user
  ON totp_credentials(tenant_id, user_id, status);

CREATE INDEX idx_totp_credentials_tenant_user
  ON totp_credentials(tenant_id, user_id);

CREATE INDEX idx_trusted_issuers_did ON trusted_issuers(issuer_did);

CREATE INDEX idx_trusted_issuers_tenant ON trusted_issuers(tenant_id);

CREATE UNIQUE INDEX idx_tvd_hostname_active ON tenant_vanity_domains(active_hostname);

CREATE INDEX idx_tvd_hostname_lookup ON tenant_vanity_domains(hostname, is_active);

CREATE UNIQUE INDEX idx_tvd_primary_active ON tenant_vanity_domains(primary_active_tenant_key);

CREATE INDEX idx_tvd_primary_lookup ON tenant_vanity_domains(tenant_id, is_primary, is_active, status);

CREATE INDEX idx_tvd_status ON tenant_vanity_domains(status, is_active);

CREATE INDEX idx_tvd_tenant ON tenant_vanity_domains(tenant_id);

CREATE INDEX idx_ucr_expires ON user_consent_records(expires_at);

CREATE INDEX idx_ucr_retain_until ON user_consent_records(retain_until);

CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);

CREATE INDEX idx_ucr_status ON user_consent_records(status);

CREATE INDEX idx_ucr_user ON user_consent_records(tenant_id, user_id);

CREATE INDEX idx_upstream_providers_enable_sso
  ON upstream_providers(tenant_id, enable_sso);

CREATE INDEX idx_upstream_providers_enabled
  ON upstream_providers(tenant_id, enabled);

CREATE INDEX idx_upstream_providers_tenant_id
  ON upstream_providers(tenant_id);

CREATE UNIQUE INDEX idx_upstream_providers_tenant_name
  ON upstream_providers(tenant_id, name);

CREATE UNIQUE INDEX idx_upstream_providers_tenant_slug
  ON upstream_providers(tenant_id, slug);

CREATE INDEX idx_user_roles_role ON user_roles(tenant_id, role_id, created_at);

CREATE INDEX idx_user_verified_attributes_name ON user_verified_attributes(tenant_id, attribute_name);

CREATE INDEX idx_user_verified_attributes_user ON user_verified_attributes(tenant_id, user_id);

CREATE INDEX idx_users_core_email_domain ON users_core(email_domain_hash);

CREATE INDEX idx_users_core_partition ON users_core(pii_partition);

CREATE INDEX idx_users_core_pii_status ON users_core(pii_status);

CREATE INDEX idx_users_core_status ON users_core(tenant_id, status);

CREATE INDEX idx_users_core_tenant ON users_core(tenant_id);

CREATE INDEX idx_users_core_tenant_external_id ON users_core(tenant_id, external_id);

CREATE INDEX idx_users_core_type ON users_core(tenant_id, user_type);

CREATE INDEX idx_users_created_at ON users(created_at);

CREATE UNIQUE INDEX idx_users_tenant_email ON users(tenant_id, email);

CREATE INDEX idx_users_tenant_id ON users(tenant_id);

CREATE INDEX idx_users_tenant_status ON users(tenant_id, status);

CREATE INDEX idx_users_user_type ON users(user_type);

CREATE INDEX idx_value_provenance_owner
  ON value_provenance(tenant_id, owner_table, owner_id, observed_at);

CREATE INDEX idx_vp_requests_nonce ON vp_requests(nonce);

CREATE INDEX idx_vp_requests_tenant_status ON vp_requests(tenant_id, status);

CREATE INDEX idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active);

CREATE INDEX idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active);

CREATE INDEX idx_webhook_configs_active ON webhook_configs(tenant_id, active);

CREATE INDEX idx_webhook_configs_client ON webhook_configs(tenant_id, client_id);

CREATE INDEX idx_webhook_configs_scope ON webhook_configs(tenant_id, scope);

CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id);

CREATE INDEX idx_webhook_deliveries_detail_object_catalog
  ON webhook_deliveries(detail_object_catalog_id);

CREATE INDEX idx_webhook_deliveries_status_created
  ON webhook_deliveries(status, created_at DESC);

CREATE INDEX idx_webhook_deliveries_tenant_created
  ON webhook_deliveries(tenant_id, created_at DESC);

CREATE INDEX idx_webhook_deliveries_webhook_created
  ON webhook_deliveries(webhook_id, created_at DESC);

CREATE INDEX idx_webhook_delivery_logs_created ON webhook_delivery_logs(created_at);

CREATE INDEX idx_webhook_delivery_logs_event ON webhook_delivery_logs(event_id);

CREATE INDEX idx_webhook_delivery_logs_tenant ON webhook_delivery_logs(tenant_id);

CREATE INDEX idx_webhook_delivery_logs_webhook ON webhook_delivery_logs(webhook_id);

CREATE UNIQUE INDEX uniq_ccs_active_key
  ON custom_claim_schemas(tenant_id, active_field_key);

INSERT INTO "access_review_items" ("rowid","id","review_id","tenant_id","user_id","permission_type","permission_value","decision","decided_by","decided_at","justification","created_at") SELECT "__authrim_original_rowid","id","review_id","tenant_id","user_id","permission_type","permission_value","decision","decided_by","decided_at","justification","created_at" FROM "__authrim_pk_copy_access_review_items";

INSERT INTO "access_reviews" ("rowid","id","tenant_id","name","description","scope","scope_value","status","reviewer_id","total_items","reviewed_items","approved_items","revoked_items","created_at","started_at","completed_at","due_date") SELECT "__authrim_original_rowid","id","tenant_id","name","description","scope","scope_value","status","reviewer_id","total_items","reviewed_items","approved_items","revoked_items","created_at","started_at","completed_at","due_date" FROM "__authrim_pk_copy_access_reviews";

INSERT INTO "account_creation_operations" ("rowid","operation_id","tenant_id","actor_id","idempotency_key","allocation_idempotency_key","request_hash","user_id","account_id","status","publication_json","last_error_code","created_at","completed_at","updated_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","actor_id","idempotency_key","allocation_idempotency_key","request_hash","user_id","account_id","status","publication_json","last_error_code","created_at","completed_at","updated_at" FROM "__authrim_pk_copy_account_creation_operations";

INSERT INTO "account_lifecycle_event_outbox" ("rowid","event_id","tenant_id","account_id","operation_id","event_type","event_version","payload_json","plugin_targets_json","status","attempt_count","lease_owner","lease_expires_at","next_attempt_at","last_error_code","created_at","succeeded_at","updated_at") SELECT "__authrim_original_rowid","event_id","tenant_id","account_id","operation_id","event_type","event_version","payload_json","plugin_targets_json","status","attempt_count","lease_owner","lease_expires_at","next_attempt_at","last_error_code","created_at","succeeded_at","updated_at" FROM "__authrim_pk_copy_account_lifecycle_event_outbox";

INSERT INTO "account_routing_outbox" ("rowid","outbox_id","tenant_id","account_id","event_kind","route_generation","route_schema_version","hmac_key_generation","payload_json","status","attempt_count","lease_owner","lease_expires_at","next_attempt_at","last_error_code","created_at","succeeded_at","updated_at") SELECT "__authrim_original_rowid","outbox_id","tenant_id","account_id","event_kind","route_generation","route_schema_version","hmac_key_generation","payload_json","status","attempt_count","lease_owner","lease_expires_at","next_attempt_at","last_error_code","created_at","succeeded_at","updated_at" FROM "__authrim_pk_copy_account_routing_outbox";

INSERT INTO "account_support_contexts" ("rowid","tenant_id","account_id","context_json","version","created_by","updated_by","created_at","updated_at") SELECT "__authrim_original_rowid","tenant_id","account_id","context_json","version","created_by","updated_by","created_at","updated_at" FROM "__authrim_pk_copy_account_support_contexts";

INSERT INTO "account_webhook_outbox" ("rowid","id","tenant_id","user_id","event_type","registration_state","previous_registration_state","changed_field","occurred_at","attempts","next_attempt_at","lease_token","lease_until","delivered_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","event_type","registration_state","previous_registration_state","changed_field","occurred_at","attempts","next_attempt_at","lease_token","lease_until","delivered_at" FROM "__authrim_pk_copy_account_webhook_outbox";

INSERT INTO "admin_jobs" ("rowid","id","tenant_id","job_type","status","progress","config","input_r2_key","result_r2_key","object_catalog_id","result","error_code","error_message","created_by","created_at","updated_at","started_at","completed_at","estimated_completion","attempt_count","max_attempts","next_run_at","dead_lettered_at") SELECT "__authrim_original_rowid","id","tenant_id","job_type","status","progress","config","input_r2_key","result_r2_key","object_catalog_id","result","error_code","error_message","created_by","created_at","updated_at","started_at","completed_at","estimated_completion","attempt_count","max_attempts","next_run_at","dead_lettered_at" FROM "__authrim_pk_copy_admin_jobs";

INSERT INTO "assurance_evidence" ("rowid","id","tenant_id","subject_id","binding_id","evidence_type","issuer_ref","assurance_framework","assurance_level","evidence_hash","evidence_storage_ref","verified_at","expires_at","revoked_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","binding_id","evidence_type","issuer_ref","assurance_framework","assurance_level","evidence_hash","evidence_storage_ref","verified_at","expires_at","revoked_at","created_at","updated_at" FROM "__authrim_pk_copy_assurance_evidence";

INSERT INTO "attribute_release_consents" ("rowid","id","tenant_id","subject_id","account_id","destination_type","destination_id","attribute_set_hash","consent_mode","consent_state","consent_record_id","first_granted_at","last_confirmed_at","expires_at","revoked_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","destination_type","destination_id","attribute_set_hash","consent_mode","consent_state","consent_record_id","first_granted_at","last_confirmed_at","expires_at","revoked_at","created_at","updated_at" FROM "__authrim_pk_copy_attribute_release_consents";

INSERT INTO "attribute_verifications" ("rowid","id","tenant_id","user_id","vp_request_id","issuer_did","credential_type","format","verification_result","holder_binding_verified","issuer_trusted","status_valid","mapped_attribute_ids","verified_at","expires_at","credential_profile_id","credential_profile_version_id","mapping_version_id","mapping_snapshot_hash","policy_version","evidence_fingerprint","status_checked_at","status_fresh_until","revalidate_after","invalidated_at","invalidation_reason","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","vp_request_id","issuer_did","credential_type","format","verification_result","holder_binding_verified","issuer_trusted","status_valid","mapped_attribute_ids","verified_at","expires_at","credential_profile_id","credential_profile_version_id","mapping_version_id","mapping_snapshot_hash","policy_version","evidence_fingerprint","status_checked_at","status_fresh_until","revalidate_after","invalidated_at","invalidation_reason","created_at","updated_at" FROM "__authrim_pk_copy_attribute_verifications";

INSERT INTO "audit_log" ("rowid","id","user_id","action","resource_type","resource_id","ip_address","user_agent","metadata_json","created_at","tenant_id","severity") SELECT "__authrim_original_rowid","id","user_id","action","resource_type","resource_id","ip_address","user_agent","metadata_json","created_at","tenant_id","severity" FROM "__authrim_pk_copy_audit_log";

INSERT INTO "authrim_migrations" ("rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version") SELECT "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "__authrim_pk_copy_authrim_migrations";

INSERT INTO "authrim_runtime_probes" ("rowid","id","tenant_id","role","probe_kind","nonce","created_at") SELECT "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "__authrim_pk_copy_authrim_runtime_probes";

INSERT INTO "branding_settings" ("rowid","id","custom_css","custom_html_header","custom_html_footer","logo_url","background_image_url","primary_color","secondary_color","font_family","enabled_auth_methods","password_policy_json","updated_at","tenant_id") SELECT "__authrim_original_rowid","id","custom_css","custom_html_header","custom_html_footer","logo_url","background_image_url","primary_color","secondary_color","font_family","enabled_auth_methods","password_policy_json","updated_at","tenant_id" FROM "__authrim_pk_copy_branding_settings";

INSERT INTO "check_api_keys" ("rowid","id","tenant_id","client_id","name","key_hash","key_prefix","allowed_operations","rate_limit_tier","is_active","expires_at","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","client_id","name","key_hash","key_prefix","allowed_operations","rate_limit_tier","is_active","expires_at","created_by","created_at","updated_at" FROM "__authrim_pk_copy_check_api_keys";

INSERT INTO "ciba_requests" ("rowid","auth_req_id","client_id","scope","login_hint","login_hint_token","id_token_hint","binding_message","user_code","acr_values","requested_expiry","status","delivery_mode","client_notification_token","client_notification_endpoint","created_at","expires_at","last_poll_at","poll_count","interval","user_id","sub","nonce","token_issued","token_issued_at","tenant_id") SELECT "__authrim_original_rowid","auth_req_id","client_id","scope","login_hint","login_hint_token","id_token_hint","binding_message","user_code","acr_values","requested_expiry","status","delivery_mode","client_notification_token","client_notification_endpoint","created_at","expires_at","last_poll_at","poll_count","interval","user_id","sub","nonce","token_issued","token_issued_at","tenant_id" FROM "__authrim_pk_copy_ciba_requests";

INSERT INTO "client_consent_overrides" ("rowid","id","tenant_id","client_id","statement_id","requirement","min_version","enforcement","conditional_rules_json","display_order","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","client_id","statement_id","requirement","min_version","enforcement","conditional_rules_json","display_order","created_at","updated_at" FROM "__authrim_pk_copy_client_consent_overrides";

INSERT INTO "client_trust_policies" ("rowid","id","tenant_id","name","display_name","description","target_type","target_id","first_party","trusted","skip_authorization_consent","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","target_type","target_id","first_party","trusted","skip_authorization_consent","is_active","created_at","updated_at" FROM "__authrim_pk_copy_client_trust_policies";

INSERT INTO "compliance_reports" ("rowid","id","tenant_id","type","name","status","requested_by","parameters","result_url","error_message","created_at","completed_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_id","type","name","status","requested_by","parameters","result_url","error_message","created_at","completed_at","expires_at" FROM "__authrim_pk_copy_compliance_reports";

INSERT INTO "consent_history" ("rowid","id","tenant_id","user_id","client_id","action","scopes_before","scopes_after","privacy_policy_version","tos_version","ip_address_hash","user_agent","created_at","metadata_json") SELECT "__authrim_original_rowid","id","tenant_id","user_id","client_id","action","scopes_before","scopes_after","privacy_policy_version","tos_version","ip_address_hash","user_agent","created_at","metadata_json" FROM "__authrim_pk_copy_consent_history";

INSERT INTO "consent_item_history" ("rowid","id","tenant_id","user_id","statement_id","action","version_before","version_after","status_before","status_after","ip_address_hash","user_agent","client_id","metadata_json","created_at","version_id_before","version_id_after","granted_at","withdrawn_at","expires_at","retain_until","consent_settings_snapshot_at","record_retention_days_snapshot","reconsent_interval_days_snapshot") SELECT "__authrim_original_rowid","id","tenant_id","user_id","statement_id","action","version_before","version_after","status_before","status_after","ip_address_hash","user_agent","client_id","metadata_json","created_at","version_id_before","version_id_after","granted_at","withdrawn_at","expires_at","retain_until","consent_settings_snapshot_at","record_retention_days_snapshot","reconsent_interval_days_snapshot" FROM "__authrim_pk_copy_consent_item_history";

INSERT INTO "consent_policies" ("rowid","id","tenant_id","name","display_name","description","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","is_active","created_at","updated_at" FROM "__authrim_pk_copy_consent_policies";

INSERT INTO "consent_policy_items" ("rowid","id","tenant_id","policy_id","statement_id","requirement","version_mode","version_id","min_version","checkbox_mode","checkbox_default_checked","binding_type","binding_value","evidence_profile","language_fallback","display_order","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","policy_id","statement_id","requirement","version_mode","version_id","min_version","checkbox_mode","checkbox_default_checked","binding_type","binding_value","evidence_profile","language_fallback","display_order","created_at","updated_at" FROM "__authrim_pk_copy_consent_policy_items";

INSERT INTO "consent_policy_versions" ("rowid","id","tenant_id","version","policy_type","policy_uri","policy_hash","effective_at","created_at") SELECT "__authrim_original_rowid","id","tenant_id","version","policy_type","policy_uri","policy_hash","effective_at","created_at" FROM "__authrim_pk_copy_consent_policy_versions";

INSERT INTO "consent_records" ("rowid","id","tenant_id","subject_user_id","actor_user_id","protocol","consent_kind","client_id","saml_sp_id","recipient_type","recipient_id","binding_type","binding_key","resource_type","resource_id","purpose_key","statement_id","statement_version","policy_id","flow_id","flow_version_id","flow_node_id","decision","selected_value","selected_options_json","released_scopes_json","released_claims_json","released_attributes_json","status","expires_at","revoked_at","evidence_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_user_id","actor_user_id","protocol","consent_kind","client_id","saml_sp_id","recipient_type","recipient_id","binding_type","binding_key","resource_type","resource_id","purpose_key","statement_id","statement_version","policy_id","flow_id","flow_version_id","flow_node_id","decision","selected_value","selected_options_json","released_scopes_json","released_claims_json","released_attributes_json","status","expires_at","revoked_at","evidence_json","created_at","updated_at" FROM "__authrim_pk_copy_consent_records";

INSERT INTO "consent_statement_localizations" ("rowid","id","tenant_id","version_id","language","title","description","document_url","inline_content","created_at","updated_at","processing_purpose","withdrawal_impact") SELECT "__authrim_original_rowid","id","tenant_id","version_id","language","title","description","document_url","inline_content","created_at","updated_at","processing_purpose","withdrawal_impact" FROM "__authrim_pk_copy_consent_statement_localizations";

INSERT INTO "consent_statement_versions" ("rowid","id","tenant_id","statement_id","version","content_type","effective_at","content_hash","is_current","current_statement_guard","status","created_at","updated_at","effective_until") SELECT "__authrim_original_rowid","id","tenant_id","statement_id","version","content_type","effective_at","content_hash","is_current","current_statement_guard","status","created_at","updated_at","effective_until" FROM "__authrim_pk_copy_consent_statement_versions";

INSERT INTO "consent_statements" ("rowid","id","tenant_id","slug","category","legal_basis","processing_purpose","display_order","is_active","created_at","updated_at","record_retention_days","withdrawal_allowed","withdrawal_impact","reconsent_on_version_change","reconsent_interval_days") SELECT "__authrim_original_rowid","id","tenant_id","slug","category","legal_basis","processing_purpose","display_order","is_active","created_at","updated_at","record_retention_days","withdrawal_allowed","withdrawal_impact","reconsent_on_version_change","reconsent_interval_days" FROM "__authrim_pk_copy_consent_statements";

INSERT INTO "contact_point_search_indexes" ("rowid","id","tenant_id","contact_point_id","index_kind","index_value","index_version","classification","status","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","contact_point_id","index_kind","index_value","index_version","classification","status","created_at","updated_at" FROM "__authrim_pk_copy_contact_point_search_indexes";

INSERT INTO "contact_points" ("rowid","id","tenant_id","subject_id","account_id","contact_type","purpose","normalized_hash","value_storage_ref","display_label","is_primary","verification_state","lifecycle_state","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","contact_type","purpose","normalized_hash","value_storage_ref","display_label","is_primary","verification_state","lifecycle_state","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_contact_points";

INSERT INTO "contact_verifications" ("rowid","id","tenant_id","contact_point_id","verification_type","verification_state","evidence_ref","verified_at","expires_at","revoked_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","contact_point_id","verification_type","verification_state","evidence_ref","verified_at","expires_at","revoked_at","created_at","updated_at" FROM "__authrim_pk_copy_contact_verifications";

INSERT INTO "credential_configurations" ("rowid","id","tenant_id","configuration_id","format","vct","display","claims","proof_types_supported","signing_alg","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","configuration_id","format","vct","display","claims","proof_types_supported","signing_alg","is_active","created_at","updated_at" FROM "__authrim_pk_copy_credential_configurations";

INSERT INTO "credential_offers" ("rowid","id","tenant_id","user_id","credential_configuration_id","pre_authorized_code","tx_code","grants","status","created_at","expires_at","issued_at","issued_credential_id","issued_credential_internal_id") SELECT "__authrim_original_rowid","id","tenant_id","user_id","credential_configuration_id","pre_authorized_code","tx_code","grants","status","created_at","expires_at","issued_at","issued_credential_id","issued_credential_internal_id" FROM "__authrim_pk_copy_credential_offers";

INSERT INTO "custom_claim_schema_history" ("rowid","id","tenant_id","schema_id","version","operation","snapshot","changes","actor_id","actor_type","change_source","created_at") SELECT "__authrim_original_rowid","id","tenant_id","schema_id","version","operation","snapshot","changes","actor_id","actor_type","change_source","created_at" FROM "__authrim_pk_copy_custom_claim_schema_history";

INSERT INTO "custom_claim_schemas" ("rowid","id","tenant_id","field_key","active_field_key","display_label","field_type","is_pii","is_required","is_active","validation_rules","include_in_id_token","include_in_userinfo","include_in_introspection","required_scopes","scope_mode","is_searchable","is_exportable","is_vc_claim","claim_namespace","description","display_order","schema_version","operation_status","operation_detail","is_system","created_by","created_at","updated_at","show_on_registration","registration_required","registration_order","registration_placeholder","ui_group_key","ui_group_label","ui_group_order","ui_field_order","examples_json","cardinality") SELECT "__authrim_original_rowid","id","tenant_id","field_key","active_field_key","display_label","field_type","is_pii","is_required","is_active","validation_rules","include_in_id_token","include_in_userinfo","include_in_introspection","required_scopes","scope_mode","is_searchable","is_exportable","is_vc_claim","claim_namespace","description","display_order","schema_version","operation_status","operation_detail","is_system","created_by","created_at","updated_at","show_on_registration","registration_required","registration_order","registration_placeholder","ui_group_key","ui_group_label","ui_group_order","ui_field_order","examples_json","cardinality" FROM "__authrim_pk_copy_custom_claim_schemas";

INSERT INTO "data_export_requests" ("rowid","id","tenant_id","user_id","status","format","include_sections","requested_at","started_at","completed_at","expires_at","file_path","object_catalog_id","file_size","error_message") SELECT "__authrim_original_rowid","id","tenant_id","user_id","status","format","include_sections","requested_at","started_at","completed_at","expires_at","file_path","object_catalog_id","file_size","error_message" FROM "__authrim_pk_copy_data_export_requests";

INSERT INTO "delegations" ("rowid","id","tenant_id","subject_id","delegate_subject_id","parent_delegation_id","chain_id","delegation_type","lifecycle_state","scope_json","starts_at","expires_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","delegate_subject_id","parent_delegation_id","chain_id","delegation_type","lifecycle_state","scope_json","starts_at","expires_at","created_at","updated_at" FROM "__authrim_pk_copy_delegations";

INSERT INTO "device_codes" ("rowid","device_code","user_code","client_id","scope","status","user_id","sub","created_at","expires_at","last_poll_at","token_issued","token_issued_at","poll_count","tenant_id") SELECT "__authrim_original_rowid","device_code","user_code","client_id","scope","status","user_id","sub","created_at","expires_at","last_poll_at","token_issued","token_issued_at","poll_count","tenant_id" FROM "__authrim_pk_copy_device_codes";

INSERT INTO "device_installations" ("rowid","id","tenant_id","user_id","client_id","trust_group_id","source_installation_id","source_client_id","linked_device_secret_id","session_id","display_name","device_platform","created_at","updated_at","last_seen_at","revoked_at","revoke_reason","is_active") SELECT "__authrim_original_rowid","id","tenant_id","user_id","client_id","trust_group_id","source_installation_id","source_client_id","linked_device_secret_id","session_id","display_name","device_platform","created_at","updated_at","last_seen_at","revoked_at","revoke_reason","is_active" FROM "__authrim_pk_copy_device_installations";

INSERT INTO "device_secrets" ("rowid","id","tenant_id","user_id","session_id","secret_hash","device_name","device_platform","installation_id","client_id","trust_group_id","source_installation_id","source_client_id","created_at","updated_at","expires_at","last_used_at","use_count","revoked_at","revoke_reason","is_active") SELECT "__authrim_original_rowid","id","tenant_id","user_id","session_id","secret_hash","device_name","device_platform","installation_id","client_id","trust_group_id","source_installation_id","source_client_id","created_at","updated_at","expires_at","last_used_at","use_count","revoked_at","revoke_reason","is_active" FROM "__authrim_pk_copy_device_secrets";

INSERT INTO "did_document_cache" ("rowid","did","document","resolved_at","expires_at") SELECT "__authrim_original_rowid","did","document","resolved_at","expires_at" FROM "__authrim_pk_copy_did_document_cache";

INSERT INTO "directory_auth_config_history" ("rowid","id","tenant_id","actor_id","category","action","resource_type","resource_id","before_redacted_json","after_redacted_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","actor_id","category","action","resource_type","resource_id","before_redacted_json","after_redacted_json","created_at" FROM "__authrim_pk_copy_directory_auth_config_history";

INSERT INTO "directory_auth_evidence_exports" ("rowid","id","tenant_id","status","requested_by","period_start_at","period_end_at","size_estimate_bytes","artifact_key","artifact_sha256","object_catalog_id","manifest_signature_key_id","manifest_signature_alg","signed_url_expires_at","retention_expires_at","download_after_delete","error_code","created_at","updated_at","completed_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","status","requested_by","period_start_at","period_end_at","size_estimate_bytes","artifact_key","artifact_sha256","object_catalog_id","manifest_signature_key_id","manifest_signature_alg","signed_url_expires_at","retention_expires_at","download_after_delete","error_code","created_at","updated_at","completed_at","deleted_at" FROM "__authrim_pk_copy_directory_auth_evidence_exports";

INSERT INTO "directory_auth_migration_campaigns" ("rowid","id","tenant_id","name","description","status","mode","passkey_prompt_mode","email_code_fallback_mode","grace_period_days","transaction_ttl_seconds","enforcement_start_mode","target_policy_json","is_template","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","description","status","mode","passkey_prompt_mode","email_code_fallback_mode","grace_period_days","transaction_ttl_seconds","enforcement_start_mode","target_policy_json","is_template","created_by","created_at","updated_at" FROM "__authrim_pk_copy_directory_auth_migration_campaigns";

INSERT INTO "directory_auth_migration_transaction_events" ("rowid","id","tenant_id","transaction_id","campaign_id","user_id","event_type","event_payload_json","request_id","created_at") SELECT "__authrim_original_rowid","id","tenant_id","transaction_id","campaign_id","user_id","event_type","event_payload_json","request_id","created_at" FROM "__authrim_pk_copy_directory_auth_migration_transaction_events";

INSERT INTO "directory_auth_migration_transactions" ("rowid","id","tenant_id","campaign_id","user_id","connector_id","directory_subject","token_hash","scope","state","request_id","authorization_challenge_id","created_at","updated_at","expires_at","completed_at","blocked_reason") SELECT "__authrim_original_rowid","id","tenant_id","campaign_id","user_id","connector_id","directory_subject","token_hash","scope","state","request_id","authorization_challenge_id","created_at","updated_at","expires_at","completed_at","blocked_reason" FROM "__authrim_pk_copy_directory_auth_migration_transactions";

INSERT INTO "directory_auth_migration_user_states" ("rowid","id","tenant_id","campaign_id","user_id","connector_id","directory_subject","cohort_key","state","first_directory_login_at","prompted_at","deferred_until","passkey_required_at","enrolled_at","blocked_reason","recovery_reason","reset_count","last_reset_at","last_reset_by","last_reset_reason","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","campaign_id","user_id","connector_id","directory_subject","cohort_key","state","first_directory_login_at","prompted_at","deferred_until","passkey_required_at","enrolled_at","blocked_reason","recovery_reason","reset_count","last_reset_at","last_reset_by","last_reset_reason","created_at","updated_at" FROM "__authrim_pk_copy_directory_auth_migration_user_states";

INSERT INTO "directory_auth_release_advisories" ("rowid","id","channel","severity","affected_versions_json","fixed_version","summary","published_at","updated_at","release_url","created_at") SELECT "__authrim_original_rowid","id","channel","severity","affected_versions_json","fixed_version","summary","published_at","updated_at","release_url","created_at" FROM "__authrim_pk_copy_directory_auth_release_advisories";

INSERT INTO "directory_auth_retention_policies" ("rowid","tenant_id","authrim_audit_retention_days","wordwarden_local_retention_days","artifact_delete_grace_hours","updated_by","created_at","updated_at") SELECT "__authrim_original_rowid","tenant_id","authrim_audit_retention_days","wordwarden_local_retention_days","artifact_delete_grace_hours","updated_by","created_at","updated_at" FROM "__authrim_pk_copy_directory_auth_retention_policies";

INSERT INTO "directory_auth_support_bundles" ("rowid","id","tenant_id","requested_by","redaction_level","status","scope_json","consent_summary_json","artifact_key","artifact_sha256","object_catalog_id","retention_expires_at","created_at","updated_at","completed_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","requested_by","redaction_level","status","scope_json","consent_summary_json","artifact_key","artifact_sha256","object_catalog_id","retention_expires_at","created_at","updated_at","completed_at","deleted_at" FROM "__authrim_pk_copy_directory_auth_support_bundles";

INSERT INTO "directory_auth_tenant_policies" ("rowid","tenant_id","email_code_fallback_mode","updated_by","created_at","updated_at") SELECT "__authrim_original_rowid","tenant_id","email_code_fallback_mode","updated_by","created_at","updated_at" FROM "__authrim_pk_copy_directory_auth_tenant_policies";

INSERT INTO "directory_connector_instances" ("rowid","id","tenant_id","connector_id","instance_id","display_name","transport","version","started_at","first_seen_at","last_seen_at","status","health_status","health_summary_json","config_fingerprint","config_categories_json","drift_severity","deactivated_at","deactivated_by","deactivation_reason","updated_at","release_channel") SELECT "__authrim_original_rowid","id","tenant_id","connector_id","instance_id","display_name","transport","version","started_at","first_seen_at","last_seen_at","status","health_status","health_summary_json","config_fingerprint","config_categories_json","drift_severity","deactivated_at","deactivated_by","deactivation_reason","updated_at","release_channel" FROM "__authrim_pk_copy_directory_connector_instances";

INSERT INTO "directory_connector_status_episodes" ("rowid","id","tenant_id","connector_id","instance_id","status","started_at","ended_at","last_seen_at","reason","acknowledged_at","acknowledged_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","connector_id","instance_id","status","started_at","ended_at","last_seen_at","reason","acknowledged_at","acknowledged_by","created_at","updated_at" FROM "__authrim_pk_copy_directory_connector_status_episodes";

INSERT INTO "directory_identity_links" ("rowid","id","tenant_id","connector_id","directory_subject","user_id","latest_facts_json","created_at","updated_at","last_login_at") SELECT "__authrim_original_rowid","id","tenant_id","connector_id","directory_subject","user_id","latest_facts_json","created_at","updated_at","last_login_at" FROM "__authrim_pk_copy_directory_identity_links";

INSERT INTO "directory_jit_pending_users" ("rowid","id","tenant_id","connector_id","directory_subject","login_identifier","status","directory_facts_json","created_at","updated_at","decided_at","decided_by","decision_reason","linked_user_id") SELECT "__authrim_original_rowid","id","tenant_id","connector_id","directory_subject","login_identifier","status","directory_facts_json","created_at","updated_at","decided_at","decided_by","decision_reason","linked_user_id" FROM "__authrim_pk_copy_directory_jit_pending_users";

INSERT INTO "entitlements" ("rowid","id","tenant_id","subject_id","account_id","entitlement_type","entitlement_key","source_id","lifecycle_state","value_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","entitlement_type","entitlement_key","source_id","lifecycle_state","value_json","created_at","updated_at" FROM "__authrim_pk_copy_entitlements";

INSERT INTO "event_log" ("rowid","id","tenant_id","event_type","event_category","result","severity","error_code","error_message","anonymized_user_id","client_id","session_id","request_id","duration_ms","details_r2_key","details_json","retention_until","created_at") SELECT "__authrim_original_rowid","id","tenant_id","event_type","event_category","result","severity","error_code","error_message","anonymized_user_id","client_id","session_id","request_id","duration_ms","details_r2_key","details_json","retention_until","created_at" FROM "__authrim_pk_copy_event_log";

INSERT INTO "external_idp_auth_states" ("rowid","id","tenant_id","client_id","provider_id","state","nonce","code_verifier","code_challenge","flow_id","redirect_uri","user_id","session_id","original_auth_request","max_age","acr_values","prompt","enable_sso","expires_at","created_at","consumed_at") SELECT "__authrim_original_rowid","id","tenant_id","client_id","provider_id","state","nonce","code_verifier","code_challenge","flow_id","redirect_uri","user_id","session_id","original_auth_request","max_age","acr_values","prompt","enable_sso","expires_at","created_at","consumed_at" FROM "__authrim_pk_copy_external_idp_auth_states";

INSERT INTO "external_lifecycle_signal_decisions" ("rowid","id","tenant_id","signal_event_id","subject_id","account_id","decision","propagation_targets_json","reason_codes_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","signal_event_id","subject_id","account_id","decision","propagation_targets_json","reason_codes_json","created_at" FROM "__authrim_pk_copy_external_lifecycle_signal_decisions";

INSERT INTO "external_lifecycle_signal_events" ("rowid","id","tenant_id","source_type","source_id","source_event_id","source_timestamp","observed_at","binding_version","payload_ref","signal_type","dedupe_key","processing_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","source_type","source_id","source_event_id","source_timestamp","observed_at","binding_version","payload_ref","signal_type","dedupe_key","processing_state","created_at","updated_at" FROM "__authrim_pk_copy_external_lifecycle_signal_events";

INSERT INTO "field_usage_bindings" ("rowid","id","tenant_id","field_key","binding_type","binding_id","protection","reason","source","metadata_json","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","field_key","binding_type","binding_id","protection","reason","source","metadata_json","is_active","created_at","updated_at" FROM "__authrim_pk_copy_field_usage_bindings";

INSERT INTO "flow_assignments" ("rowid","id","tenant_id","target_type","target_id","flow_kind","flow_id","enabled","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","target_type","target_id","flow_kind","flow_id","enabled","created_at","updated_at" FROM "__authrim_pk_copy_flow_assignments";

INSERT INTO "flow_audit_events" ("rowid","id","tenant_id","interaction_id","flow_id","flow_version_id","user_id","client_id","saml_sp_id","node_id","branch_handle_id","event_type","result","error_code","contract_hash","metadata_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","interaction_id","flow_id","flow_version_id","user_id","client_id","saml_sp_id","node_id","branch_handle_id","event_type","result","error_code","contract_hash","metadata_json","created_at" FROM "__authrim_pk_copy_flow_audit_events";

INSERT INTO "flow_interaction_steps" ("rowid","id","tenant_id","interaction_id","node_id","step_id","state","selected_handle","state_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","interaction_id","node_id","step_id","state","selected_handle","state_json","created_at","updated_at" FROM "__authrim_pk_copy_flow_interaction_steps";

INSERT INTO "flow_interactions" ("rowid","id","tenant_id","flow_id","flow_version_id","user_id","client_id","saml_sp_id","state","current_node_id","current_step_id","contract_hash","signature","expires_at","created_at","updated_at","completed_at","context_json") SELECT "__authrim_original_rowid","id","tenant_id","flow_id","flow_version_id","user_id","client_id","saml_sp_id","state","current_node_id","current_step_id","contract_hash","signature","expires_at","created_at","updated_at","completed_at","context_json" FROM "__authrim_pk_copy_flow_interactions";

INSERT INTO "flow_versions" ("rowid","id","tenant_id","flow_id","version_number","schema_version","runtime_snapshot_json","editor_snapshot_json","validation_result_json","published_by","published_at","created_at") SELECT "__authrim_original_rowid","id","tenant_id","flow_id","version_number","schema_version","runtime_snapshot_json","editor_snapshot_json","validation_result_json","published_by","published_at","created_at" FROM "__authrim_pk_copy_flow_versions";

INSERT INTO "group_memberships" ("rowid","id","tenant_id","group_id","subject_id","account_id","membership_type","assignment_source","lifecycle_state","starts_at","expires_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","group_id","subject_id","account_id","membership_type","assignment_source","lifecycle_state","starts_at","expires_at","created_at","updated_at" FROM "__authrim_pk_copy_group_memberships";

INSERT INTO "groups" ("rowid","id","tenant_id","group_key","display_name","description","parent_group_id","lifecycle_state","metadata_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","group_key","display_name","description","parent_group_id","lifecycle_state","metadata_json","created_at","updated_at" FROM "__authrim_pk_copy_groups";

INSERT INTO "guest_account_upgrades" ("rowid","id","tenant_id","guest_user_id","upgraded_user_id","upgrade_method","provider_id","preserve_sub","upgraded_at","data_migrated") SELECT "__authrim_original_rowid","id","tenant_id","guest_user_id","upgraded_user_id","upgrade_method","provider_id","preserve_sub","upgraded_at","data_migrated" FROM "__authrim_pk_copy_guest_account_upgrades";

INSERT INTO "guest_deletion_audit_outbox" ("rowid","audit_id","tenant_id","user_id","operation_id","actor_user_id","ip_address","user_agent","metadata_json","status","attempt_count","next_attempt_at","last_error_code","created_at","updated_at","succeeded_at") SELECT "__authrim_original_rowid","audit_id","tenant_id","user_id","operation_id","actor_user_id","ip_address","user_agent","metadata_json","status","attempt_count","next_attempt_at","last_error_code","created_at","updated_at","succeeded_at" FROM "__authrim_pk_copy_guest_deletion_audit_outbox";

INSERT INTO "guest_devices" ("rowid","id","tenant_id","user_id","resume_credential_hash","expires_at","created_at","last_used_at","is_active") SELECT "__authrim_original_rowid","id","tenant_id","user_id","resume_credential_hash","expires_at","created_at","last_used_at","is_active" FROM "__authrim_pk_copy_guest_devices";

INSERT INTO "idempotency_keys" ("rowid","id","tenant_id","actor_id","method","path","resource_id","idempotency_key","body_hash","response_status","response_body","created_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_id","actor_id","method","path","resource_id","idempotency_key","body_hash","response_status","response_body","created_at","expires_at" FROM "__authrim_pk_copy_idempotency_keys";

INSERT INTO "identity_accounts" ("rowid","id","tenant_id","account_type","lifecycle_state","legacy_user_id","primary_subject_id","display_label","metadata_json","created_at","updated_at","deleted_at","directory_publication_state","account_route_generation","registration_state") SELECT "__authrim_original_rowid","id","tenant_id","account_type","lifecycle_state","legacy_user_id","primary_subject_id","display_label","metadata_json","created_at","updated_at","deleted_at","directory_publication_state","account_route_generation","registration_state" FROM "__authrim_pk_copy_identity_accounts";

INSERT INTO "identity_binding_lookup_indexes" ("rowid","id","tenant_id","identity_binding_id","lookup_kind","lookup_value","lookup_version","status","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","identity_binding_id","lookup_kind","lookup_value","lookup_version","status","created_at","updated_at" FROM "__authrim_pk_copy_identity_binding_lookup_indexes";

INSERT INTO "identity_bindings" ("rowid","id","tenant_id","subject_id","account_id","protocol","source_id","provider_subject_key_hash","binding_kind","lifecycle_state","assurance_level","trust_context_snapshot_id","metadata_json","created_at","updated_at","deleted_at","last_seen_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","protocol","source_id","provider_subject_key_hash","binding_kind","lifecycle_state","assurance_level","trust_context_snapshot_id","metadata_json","created_at","updated_at","deleted_at","last_seen_at" FROM "__authrim_pk_copy_identity_bindings";

INSERT INTO "identity_providers" ("rowid","id","name","provider_type","config_json","enabled","created_at","updated_at","tenant_id") SELECT "__authrim_original_rowid","id","name","provider_type","config_json","enabled","created_at","updated_at","tenant_id" FROM "__authrim_pk_copy_identity_providers";

INSERT INTO "identity_resolution_candidates" ("rowid","id","tenant_id","source_id","candidate_subject_id","candidate_account_id","candidate_binding_id","candidate_score","risk_tier","decision_state","reason_codes_json","review_task_id","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","source_id","candidate_subject_id","candidate_account_id","candidate_binding_id","candidate_score","risk_tier","decision_state","reason_codes_json","review_task_id","created_at","updated_at" FROM "__authrim_pk_copy_identity_resolution_candidates";

INSERT INTO "identity_resolution_events" ("rowid","id","tenant_id","subject_id","account_id","binding_id","source_id","resolution_method","outcome","reason_codes_json","trace_ref","metadata_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","binding_id","source_id","resolution_method","outcome","reason_codes_json","trace_ref","metadata_json","created_at" FROM "__authrim_pk_copy_identity_resolution_events";

INSERT INTO "identity_subjects" ("rowid","id","tenant_id","subject_type","lifecycle_state","display_label","primary_account_id","risk_tier","assurance_level","metadata_json","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_type","lifecycle_state","display_label","primary_account_id","risk_tier","assurance_level","metadata_json","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_identity_subjects";

INSERT INTO "internal_notification_delivery_attempts" ("rowid","id","event_id","route_id","provider","destination_id","status","attempt_count","response_status","error_class","error_message","next_attempt_at","payload_sha256","delivered_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","event_id","route_id","provider","destination_id","status","attempt_count","response_status","error_class","error_message","next_attempt_at","payload_sha256","delivered_at","created_at","updated_at" FROM "__authrim_pk_copy_internal_notification_delivery_attempts";

INSERT INTO "internal_notification_delivery_routes" ("rowid","id","name","scope_type","scope_id","provider","destination_id","categories_json","severities_json","min_severity","enabled","failure_policy","max_attempts","retry_after_seconds","suppression_key","created_by","updated_by","created_at","updated_at","version") SELECT "__authrim_original_rowid","id","name","scope_type","scope_id","provider","destination_id","categories_json","severities_json","min_severity","enabled","failure_policy","max_attempts","retry_after_seconds","suppression_key","created_by","updated_by","created_at","updated_at","version" FROM "__authrim_pk_copy_internal_notification_delivery_routes";

INSERT INTO "internal_notification_events" ("rowid","id","tenant_id","category","event_type","severity","status","deduplication_key","payload_json","attempts","last_error","next_attempt_at","created_at","updated_at","delivered_at") SELECT "__authrim_original_rowid","id","tenant_id","category","event_type","severity","status","deduplication_key","payload_json","attempts","last_error","next_attempt_at","created_at","updated_at","delivered_at" FROM "__authrim_pk_copy_internal_notification_events";

INSERT INTO "issued_credentials" ("rowid","internal_id","public_id","tenant_id","user_id","credential_type","format","claims","status","status_list_id","status_list_internal_id","status_list_index","holder_binding","created_at","updated_at","expires_at","revoked_at","revoked_reason") SELECT "__authrim_original_rowid","internal_id","public_id","tenant_id","user_id","credential_type","format","claims","status","status_list_id","status_list_internal_id","status_list_index","holder_binding","created_at","updated_at","expires_at","revoked_at","revoked_reason" FROM "__authrim_pk_copy_issued_credentials";

INSERT INTO "legal_hold_events" ("rowid","event_id","hold_id","tenant_id","account_id","event_type","hold_version","projection_generation","actor_id","reason_code","case_reference","effective_at","created_at") SELECT "__authrim_original_rowid","event_id","hold_id","tenant_id","account_id","event_type","hold_version","projection_generation","actor_id","reason_code","case_reference","effective_at","created_at" FROM "__authrim_pk_copy_legal_hold_events";

INSERT INTO "legal_hold_projection_outbox" ("rowid","operation_id","tenant_id","hold_id","account_id","projection_generation","hold_version","projection_state","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","last_error_code","created_at","updated_at","completed_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","hold_id","account_id","projection_generation","hold_version","projection_state","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","last_error_code","created_at","updated_at","completed_at" FROM "__authrim_pk_copy_legal_hold_projection_outbox";

INSERT INTO "legal_holds" ("rowid","id","tenant_id","subject_type","subject_id","state","reason_code","case_reference","expires_at","version","created_by","created_at","released_by","released_at","release_reason","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_type","subject_id","state","reason_code","case_reference","expires_at","version","created_by","created_at","released_by","released_at","release_reason","updated_at" FROM "__authrim_pk_copy_legal_holds";

INSERT INTO "log_chunk_manifests" ("rowid","id","tenant_key","log_type","plane","bucket_start_at","bucket_end_at","shard","manifest_object_key","chunk_count","record_count","checksum_sha256","status","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_key","log_type","plane","bucket_start_at","bucket_end_at","shard","manifest_object_key","chunk_count","record_count","checksum_sha256","status","created_at","updated_at" FROM "__authrim_pk_copy_log_chunk_manifests";

INSERT INTO "log_object_catalog" ("rowid","id","tenant_key","log_type","plane","surface","object_key","object_kind","status","record_count","byte_count","checksum_sha256","compression","encryption_scope","key_version","created_at","committed_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_key","log_type","plane","surface","object_key","object_kind","status","record_count","byte_count","checksum_sha256","compression","encryption_scope","key_version","created_at","committed_at","deleted_at" FROM "__authrim_pk_copy_log_object_catalog";

INSERT INTO "logging_catalog_repair_jobs" ("rowid","id","job_kind","status","tenant_key","log_type","plane","requested_action","progress_current","progress_total","preview_artifact_ref","result_json","error_class","last_error","requested_by","created_at","updated_at","started_at","completed_at","cancel_requested_at","cancel_requested_by","metadata_json") SELECT "__authrim_original_rowid","id","job_kind","status","tenant_key","log_type","plane","requested_action","progress_current","progress_total","preview_artifact_ref","result_json","error_class","last_error","requested_by","created_at","updated_at","started_at","completed_at","cancel_requested_at","cancel_requested_by","metadata_json" FROM "__authrim_pk_copy_logging_catalog_repair_jobs";

INSERT INTO "logging_quota_evaluations" ("rowid","id","quota_policy_id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","soft_limit","hard_limit","state","enforcement_action","evaluated_at","notification_event_id","metadata_json") SELECT "__authrim_original_rowid","id","quota_policy_id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","soft_limit","hard_limit","state","enforcement_action","evaluated_at","notification_event_id","metadata_json" FROM "__authrim_pk_copy_logging_quota_evaluations";

INSERT INTO "logging_quota_policies" ("rowid","id","scope_type","scope_id","log_type","plane","lane","metric_name","window_kind","soft_limit","hard_limit","warning_ratio","enforcement_mode","critical_behavior","status","created_by","updated_by","created_at","updated_at","deleted_at","version") SELECT "__authrim_original_rowid","id","scope_type","scope_id","log_type","plane","lane","metric_name","window_kind","soft_limit","hard_limit","warning_ratio","enforcement_mode","critical_behavior","status","created_by","updated_by","created_at","updated_at","deleted_at","version" FROM "__authrim_pk_copy_logging_quota_policies";

INSERT INTO "logging_usage_aggregates" ("rowid","id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","source_table","metadata_json","refreshed_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","tenant_key","log_type","plane","lane","metric_name","window_kind","window_start_at","window_end_at","value","source_table","metadata_json","refreshed_at","created_at","updated_at" FROM "__authrim_pk_copy_logging_usage_aggregates";

INSERT INTO "lookup_retention_policies" ("rowid","tenant_id","retention_days","policy_generation","updated_by","created_at","updated_at") SELECT "__authrim_original_rowid","tenant_id","retention_days","policy_generation","updated_by","created_at","updated_at" FROM "__authrim_pk_copy_lookup_retention_policies";

INSERT INTO "lookup_retention_policy_projection_outbox" ("rowid","operation_id","tenant_id","policy_generation","retention_days","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","last_error_code","created_at","updated_at","completed_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","policy_generation","retention_days","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","last_error_code","created_at","updated_at","completed_at" FROM "__authrim_pk_copy_lookup_retention_policy_projection_outbox";

INSERT INTO "migration_metadata" ("rowid","id","current_version","last_migration_at","environment","metadata_json") SELECT "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "__authrim_pk_copy_migration_metadata";

INSERT INTO "notification_delivery_intents" ("rowid","intent_id","tenant_id","plugin_installation_id","provider_order_version","provider_installation_ids_json","active_provider_index","provider_started_at","channel","notification_kind","payload_version","payload_key_id","payload_envelope_json","idempotency_key","request_fingerprint","fingerprint_key_id","state","expires_at","delivered_at","canceled_at","dead_lettered_at","delete_after","created_at","updated_at","account_id","recipient_masked","recipient_encrypted","recipient_encryption_key_version","provider_message_id","provider_accepted_at","delivery_status","delivery_status_updated_at","attempt_count","last_error_code") SELECT "__authrim_original_rowid","intent_id","tenant_id","plugin_installation_id","provider_order_version","provider_installation_ids_json","active_provider_index","provider_started_at","channel","notification_kind","payload_version","payload_key_id","payload_envelope_json","idempotency_key","request_fingerprint","fingerprint_key_id","state","expires_at","delivered_at","canceled_at","dead_lettered_at","delete_after","created_at","updated_at","account_id","recipient_masked","recipient_encrypted","recipient_encryption_key_version","provider_message_id","provider_accepted_at","delivery_status","delivery_status_updated_at","attempt_count","last_error_code" FROM "__authrim_pk_copy_notification_delivery_intents";

INSERT INTO "oauth_client_consents" ("rowid","id","user_id","client_id","scope","granted_at","expires_at","created_at","updated_at","tenant_id","selected_scopes","privacy_policy_version","tos_version","consent_version") SELECT "__authrim_original_rowid","id","user_id","client_id","scope","granted_at","expires_at","created_at","updated_at","tenant_id","selected_scopes","privacy_policy_version","tos_version","consent_version" FROM "__authrim_pk_copy_oauth_client_consents";

INSERT INTO "object_catalog" ("rowid","id","public_artifact_id","tenant_id","object_class","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","public_artifact_id","tenant_id","object_class","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_object_catalog";

INSERT INTO "object_catalog_objects" ("rowid","id","catalog_id","representation","object_kind","object_index","bucket_binding","object_key","key_version","checksum_sha256","total_bytes","created_at","deleted_at") SELECT "__authrim_original_rowid","id","catalog_id","representation","object_kind","object_index","bucket_binding","object_key","key_version","checksum_sha256","total_bytes","created_at","deleted_at" FROM "__authrim_pk_copy_object_catalog_objects";

INSERT INTO "oidc_scopes" ("rowid","id","tenant_id","name","display_name","description","scope_type","enabled","localizations_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","scope_type","enabled","localizations_json","created_at","updated_at" FROM "__authrim_pk_copy_oidc_scopes";

INSERT INTO "operational_logs" ("rowid","id","tenant_id","subject_type","subject_id","actor_id","action","reason_detail_encrypted","encryption_key_version","detail_object_catalog_id","request_id","created_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_type","subject_id","actor_id","action","reason_detail_encrypted","encryption_key_version","detail_object_catalog_id","request_id","created_at","expires_at" FROM "__authrim_pk_copy_operational_logs";

INSERT INTO "org_domain_mappings" ("rowid","id","tenant_id","domain_hash","domain_hash_version","org_id","auto_join_enabled","membership_type","auto_assign_role_id","verified","priority","is_active","created_at","updated_at","verification_token","verification_status","verification_expires_at","verification_method") SELECT "__authrim_original_rowid","id","tenant_id","domain_hash","domain_hash_version","org_id","auto_join_enabled","membership_type","auto_assign_role_id","verified","priority","is_active","created_at","updated_at","verification_token","verification_status","verification_expires_at","verification_method" FROM "__authrim_pk_copy_org_domain_mappings";

INSERT INTO "organizations" ("rowid","id","tenant_id","name","display_name","description","org_type","parent_org_id","plan","is_active","metadata_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","org_type","parent_org_id","plan","is_active","metadata_json","created_at","updated_at" FROM "__authrim_pk_copy_organizations";

INSERT INTO "passkeys" ("rowid","id","user_id","credential_id","public_key","counter","transports","device_name","created_at","last_used_at","tenant_id","aaguid","rp_id") SELECT "__authrim_original_rowid","id","user_id","credential_id","public_key","counter","transports","device_name","created_at","last_used_at","tenant_id","aaguid","rp_id" FROM "__authrim_pk_copy_passkeys";

INSERT INTO "password_reset_tokens" ("rowid","id","user_id","token_hash","expires_at","used","created_at","tenant_id") SELECT "__authrim_original_rowid","id","user_id","token_hash","expires_at","used","created_at","tenant_id" FROM "__authrim_pk_copy_password_reset_tokens";

INSERT INTO "permission_change_audit" ("rowid","id","tenant_id","event_type","subject_id","resource","relation","permission","timestamp","created_at") SELECT "__authrim_original_rowid","id","tenant_id","event_type","subject_id","resource","relation","permission","timestamp","created_at" FROM "__authrim_pk_copy_permission_change_audit";

INSERT INTO "permission_check_audit" ("rowid","id","tenant_id","subject_id","permission","permission_json","allowed","resolved_via_json","final_decision","reason","api_key_id","client_id","checked_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","permission","permission_json","allowed","resolved_via_json","final_decision","reason","api_key_id","client_id","checked_at" FROM "__authrim_pk_copy_permission_check_audit";

INSERT INTO "plugin_account_metadata" ("rowid","tenant_id","account_id","plugin_id","plugin_installation_id","metadata_key","value_json","version","created_at","updated_at") SELECT "__authrim_original_rowid","tenant_id","account_id","plugin_id","plugin_installation_id","metadata_key","value_json","version","created_at","updated_at" FROM "__authrim_pk_copy_plugin_account_metadata";

INSERT INTO "plugin_hook_outbox" ("rowid","outbox_id","tenant_id","plugin_installation_id","capability","event_type","event_version","idempotency_key","payload_json","payload_class","status","attempt_no","claim_owner","claim_token","lease_until","next_attempt_at","last_error_code","created_at","succeeded_at","dead_lettered_at","canceled_at","delete_after","updated_at") SELECT "__authrim_original_rowid","outbox_id","tenant_id","plugin_installation_id","capability","event_type","event_version","idempotency_key","payload_json","payload_class","status","attempt_no","claim_owner","claim_token","lease_until","next_attempt_at","last_error_code","created_at","succeeded_at","dead_lettered_at","canceled_at","delete_after","updated_at" FROM "__authrim_pk_copy_plugin_hook_outbox";

INSERT INTO "presentation_definitions" ("rowid","id","tenant_id","name","purpose","format","input_descriptors","submission_requirements","dcql_query","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","purpose","format","input_descriptors","submission_requirements","dcql_query","is_active","created_at","updated_at" FROM "__authrim_pk_copy_presentation_definitions";

INSERT INTO "profile_attribute_values" ("rowid","id","tenant_id","profile_id","catalog_entry_id","value_type","value_json","value_storage_ref","value_hash","classification","purpose","is_primary","display_order","lifecycle_state","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","profile_id","catalog_entry_id","value_type","value_json","value_storage_ref","value_hash","classification","purpose","is_primary","display_order","lifecycle_state","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_profile_attribute_values";

INSERT INTO "profiles" ("rowid","id","tenant_id","subject_id","profile_type","lifecycle_state","locale","zoneinfo","display_name_ref","metadata_json","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","profile_type","lifecycle_state","locale","zoneinfo","display_name_ref","metadata_json","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_profiles";

INSERT INTO "provisioning_assignment_events" ("rowid","id","tenant_id","rule_id","subject_id","account_id","target_type","target_id","outcome","reason_codes_json","trace_ref","created_at") SELECT "__authrim_original_rowid","id","tenant_id","rule_id","subject_id","account_id","target_type","target_id","outcome","reason_codes_json","trace_ref","created_at" FROM "__authrim_pk_copy_provisioning_assignment_events";

INSERT INTO "provisioning_assignment_ownership" ("rowid","id","tenant_id","assignment_type","assignment_id","source_id","ownership_policy","revoke_policy","protected_until","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","assignment_type","assignment_id","source_id","ownership_policy","revoke_policy","protected_until","created_at","updated_at" FROM "__authrim_pk_copy_provisioning_assignment_ownership";

INSERT INTO "provisioning_assignment_rules" ("rowid","id","tenant_id","scope_type","scope_id","rule_type","target_type","target_id","condition_json","priority","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","scope_type","scope_id","rule_type","target_type","target_id","condition_json","priority","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_provisioning_assignment_rules";

INSERT INTO "provisioning_revocation_events" ("rowid","id","tenant_id","subject_id","account_id","source_event_id","target_type","target_id","decision","reason_codes_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","source_event_id","target_type","target_id","decision","reason_codes_json","created_at" FROM "__authrim_pk_copy_provisioning_revocation_events";

INSERT INTO "refresh_token_shard_configs" ("rowid","id","tenant_id","client_id","generation","shard_count","activated_at","deprecated_at","created_by","notes") SELECT "__authrim_original_rowid","id","tenant_id","client_id","generation","shard_count","activated_at","deprecated_at","created_by","notes" FROM "__authrim_pk_copy_refresh_token_shard_configs";

INSERT INTO "relation_definitions" ("rowid","id","tenant_id","object_type","relation_name","definition_json","description","priority","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","object_type","relation_name","definition_json","description","priority","is_active","created_at","updated_at" FROM "__authrim_pk_copy_relation_definitions";

INSERT INTO "relationship_closure" ("rowid","id","tenant_id","ancestor_type","ancestor_id","descendant_type","descendant_id","relation","depth","path_json","effective_permission","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","ancestor_type","ancestor_id","descendant_type","descendant_id","relation","depth","path_json","effective_permission","created_at","updated_at" FROM "__authrim_pk_copy_relationship_closure";

INSERT INTO "relationships" ("rowid","id","tenant_id","relationship_type","from_type","from_id","to_type","to_id","permission_level","expires_at","is_bidirectional","metadata_json","created_at","updated_at","evidence_type","evidence_ref") SELECT "__authrim_original_rowid","id","tenant_id","relationship_type","from_type","from_id","to_type","to_id","permission_level","expires_at","is_bidirectional","metadata_json","created_at","updated_at","evidence_type","evidence_ref" FROM "__authrim_pk_copy_relationships";

INSERT INTO "resource_permissions" ("rowid","id","tenant_id","subject_type","subject_id","resource_type","resource_id","actions_json","condition_json","expires_at","is_active","granted_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_type","subject_id","resource_type","resource_id","actions_json","condition_json","expires_at","is_active","granted_by","created_at","updated_at" FROM "__authrim_pk_copy_resource_permissions";

INSERT INTO "role_assignment_rules" ("rowid","id","tenant_id","name","description","role_id","scope_type","scope_target","conditions_json","actions_json","priority","stop_processing","is_active","valid_from","valid_until","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","description","role_id","scope_type","scope_target","conditions_json","actions_json","priority","stop_processing","is_active","valid_from","valid_until","created_by","created_at","updated_at" FROM "__authrim_pk_copy_role_assignment_rules";

INSERT INTO "role_assignments" ("rowid","id","tenant_id","subject_id","role_id","scope_type","scope_target","expires_at","assigned_by","metadata_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","role_id","scope_type","scope_target","expires_at","assigned_by","metadata_json","created_at","updated_at" FROM "__authrim_pk_copy_role_assignments";

INSERT INTO "roles" ("rowid","id","tenant_id","name","description","permissions_json","created_at","role_type","hierarchy_level","is_assignable","parent_role_id","display_name","is_system","updated_at","external_id") SELECT "__authrim_original_rowid","id","tenant_id","name","description","permissions_json","created_at","role_type","hierarchy_level","is_assignable","parent_role_id","display_name","is_system","updated_at","external_id" FROM "__authrim_pk_copy_roles";

INSERT INTO "saml_attribute_presets" ("rowid","id","tenant_id","label","description","applies_to","profile","stability","application_mode","attribute_release_policy_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","label","description","applies_to","profile","stability","application_mode","attribute_release_policy_json","created_at","updated_at" FROM "__authrim_pk_copy_saml_attribute_presets";

INSERT INTO "screens" ("rowid","id","tenant_id","screen_key","display_name","description","screen_kind","fields_json","localizations_json","settings_json","is_active","is_system","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","screen_key","display_name","description","screen_kind","fields_json","localizations_json","settings_json","is_active","is_system","created_at","updated_at" FROM "__authrim_pk_copy_screens";

INSERT INTO "security_alerts" ("rowid","id","tenant_id","type","severity","status","title","description","source_ip","user_id","client_id","metadata","created_at","updated_at","acknowledged_at","acknowledged_by","resolved_at","resolved_by") SELECT "__authrim_original_rowid","id","tenant_id","type","severity","status","title","description","source_ip","user_id","client_id","metadata","created_at","updated_at","acknowledged_at","acknowledged_by","resolved_at","resolved_by" FROM "__authrim_pk_copy_security_alerts";

INSERT INTO "security_threats" ("rowid","id","tenant_id","type","severity","status","title","description","source","affected_resources","indicators","metadata","created_at","updated_at","detected_at","mitigated_at") SELECT "__authrim_original_rowid","id","tenant_id","type","severity","status","title","description","source","affected_resources","indicators","metadata","created_at","updated_at","detected_at","mitigated_at" FROM "__authrim_pk_copy_security_threats";

INSERT INTO "sensitive_detail_chunk_index" ("rowid","catalog_id","tenant_id","object_class","bucket_binding","object_key","content_encoding","line_number","byte_offset","byte_length","key_version","checksum_sha256","created_at","deleted_at") SELECT "__authrim_original_rowid","catalog_id","tenant_id","object_class","bucket_binding","object_key","content_encoding","line_number","byte_offset","byte_length","key_version","checksum_sha256","created_at","deleted_at" FROM "__authrim_pk_copy_sensitive_detail_chunk_index";

INSERT INTO "service_group_audit" ("rowid","id","tenant_id","user_id","rule_version","generation","event_type","detail_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","rule_version","generation","event_type","detail_json","created_at" FROM "__authrim_pk_copy_service_group_audit";

INSERT INTO "service_group_catalog" ("rowid","tenant_id","revision","plan_json","updated_at","write_token") SELECT "__authrim_original_rowid","tenant_id","revision","plan_json","updated_at","write_token" FROM "__authrim_pk_copy_service_group_catalog";

INSERT INTO "service_group_epoch" ("rowid","tenant_id","revision") SELECT "__authrim_original_rowid","tenant_id","revision" FROM "__authrim_pk_copy_service_group_epoch";

INSERT INTO "service_group_write_boundaries" ("rowid","id","tenant_id","user_id","operation","status","created_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","operation","status","created_at" FROM "__authrim_pk_copy_service_group_write_boundaries";

INSERT INTO "sessions" ("rowid","id","user_id","expires_at","created_at","external_provider_id","external_provider_sub","tenant_id","external_provider_sid") SELECT "__authrim_original_rowid","id","user_id","expires_at","created_at","external_provider_id","external_provider_sub","tenant_id","external_provider_sid" FROM "__authrim_pk_copy_sessions";

INSERT INTO "settings_history" ("rowid","id","tenant_id","category","version","snapshot","changes","actor_id","actor_type","change_reason","change_source","created_at") SELECT "__authrim_original_rowid","id","tenant_id","category","version","snapshot","changes","actor_id","actor_type","change_reason","change_source","created_at" FROM "__authrim_pk_copy_settings_history";

INSERT INTO "sign_in_confirmation_policies" ("rowid","id","tenant_id","name","display_name","description","trigger_type","mode","remember_duration_days","show_application_context","show_tenant_context","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","display_name","description","trigger_type","mode","remember_duration_days","show_application_context","show_tenant_context","is_active","created_at","updated_at" FROM "__authrim_pk_copy_sign_in_confirmation_policies";

INSERT INTO "status_lists" ("rowid","internal_id","public_id","tenant_id","purpose","encoded_list","current_index","capacity","used_count","state","sealed_at","created_at","updated_at") SELECT "__authrim_original_rowid","internal_id","public_id","tenant_id","purpose","encoded_list","current_index","capacity","used_count","state","sealed_at","created_at","updated_at" FROM "__authrim_pk_copy_status_lists";

INSERT INTO "structured_attribute_values" ("rowid","id","tenant_id","owner_type","owner_id","catalog_entry_id","canonical_json","projected_index_json","classification","lifecycle_state","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","owner_type","owner_id","catalog_entry_id","canonical_json","projected_index_json","classification","lifecycle_state","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_structured_attribute_values";

INSERT INTO "subject_account_links" ("rowid","id","tenant_id","subject_id","account_id","link_type","lifecycle_state","source_ref","created_at","updated_at","deleted_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","link_type","lifecycle_state","source_ref","created_at","updated_at","deleted_at" FROM "__authrim_pk_copy_subject_account_links";

INSERT INTO "subject_lifecycle_timeline_events" ("rowid","id","tenant_id","subject_id","account_id","event_type","source_type","source_id","summary_json","event_at","created_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","account_id","event_type","source_type","source_id","summary_json","event_at","created_at" FROM "__authrim_pk_copy_subject_lifecycle_timeline_events";

INSERT INTO "subject_org_membership" ("rowid","id","tenant_id","subject_id","org_id","membership_type","is_primary","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","org_id","membership_type","is_primary","created_at","updated_at" FROM "__authrim_pk_copy_subject_org_membership";

INSERT INTO "support_operation_actions" ("rowid","id","tenant_id","cohort_id","resource","action","status","reason","support_case_id","approval_request_id","job_id","result_summary_json","requested_by","approved_by","approved_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","cohort_id","resource","action","status","reason","support_case_id","approval_request_id","job_id","result_summary_json","requested_by","approved_by","approved_at","created_at","updated_at" FROM "__authrim_pk_copy_support_operation_actions";

INSERT INTO "support_operation_cohort_targets" ("rowid","id","cohort_id","tenant_id","resource","target_id","target_hash","block_reason","created_at") SELECT "__authrim_original_rowid","id","cohort_id","tenant_id","resource","target_id","target_hash","block_reason","created_at" FROM "__authrim_pk_copy_support_operation_cohort_targets";

INSERT INTO "support_operation_cohorts" ("rowid","id","tenant_id","resource","intended_action","selector_json","selector_hash","matched_count","actionable_count","blocked_count","blocked_summary_json","snapshot_status","snapshot_job_id","snapshot_error","risk_json","created_by","support_case_id","expires_at","created_at") SELECT "__authrim_original_rowid","id","tenant_id","resource","intended_action","selector_json","selector_hash","matched_count","actionable_count","blocked_count","blocked_summary_json","snapshot_status","snapshot_job_id","snapshot_error","risk_json","created_by","support_case_id","expires_at","created_at" FROM "__authrim_pk_copy_support_operation_cohorts";

INSERT INTO "suspicious_activities" ("rowid","id","tenant_id","type","severity","user_id","client_id","source_ip","user_agent","description","metadata","created_at","resolved_at") SELECT "__authrim_original_rowid","id","tenant_id","type","severity","user_id","client_id","source_ip","user_agent","description","metadata","created_at","resolved_at" FROM "__authrim_pk_copy_suspicious_activities";

INSERT INTO "tenant_consent_requirements" ("rowid","id","tenant_id","statement_id","is_required","min_version","enforcement","show_deletion_link","deletion_url","conditional_rules_json","display_order","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","statement_id","is_required","min_version","enforcement","show_deletion_link","deletion_url","conditional_rules_json","display_order","created_at","updated_at" FROM "__authrim_pk_copy_tenant_consent_requirements";

INSERT INTO "tenant_database_migration_state" ("rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at") SELECT "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "__authrim_pk_copy_tenant_database_migration_state";

INSERT INTO "tenant_database_probe_results" ("rowid","id","tenant_id","role","shard_group","shard_index","generation","probe_kind","status","latency_ms","binding_ref","connection_ref","provider","schema_version","error_class","error_message","metadata_json","created_by","created_at") SELECT "__authrim_original_rowid","id","tenant_id","role","shard_group","shard_index","generation","probe_kind","status","latency_ms","binding_ref","connection_ref","provider","schema_version","error_class","error_message","metadata_json","created_by","created_at" FROM "__authrim_pk_copy_tenant_database_probe_results";

INSERT INTO "tenant_domain_mappings" ("rowid","id","domain_hash","hash_version","tenant_id","priority","is_active","active_domain_hash","verified","verification_token","verification_expires_at","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","domain_hash","hash_version","tenant_id","priority","is_active","active_domain_hash","verified","verification_token","verification_expires_at","created_by","created_at","updated_at" FROM "__authrim_pk_copy_tenant_domain_mappings";

INSERT INTO "tenant_invitations" ("rowid","id","token","tenant_id","invited_email","invited_by","role_id","org_id","max_uses","use_count","expires_at","created_at","updated_at") SELECT "__authrim_original_rowid","id","token","tenant_id","invited_email","invited_by","role_id","org_id","max_uses","use_count","expires_at","created_at","updated_at" FROM "__authrim_pk_copy_tenant_invitations";

INSERT INTO "tenant_placement_migration_captures" ("rowid","operation_id","tenant_id","source_shard_id","migration_generation","capture_state","fencing_token","installed_at","write_fenced_at","cutover_committed_at","canceled_at","updated_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","source_shard_id","migration_generation","capture_state","fencing_token","installed_at","write_fenced_at","cutover_committed_at","canceled_at","updated_at" FROM "__authrim_pk_copy_tenant_placement_migration_captures";

INSERT INTO "tenant_placement_migration_outbox" ("source_sequence","operation_id","tenant_id","table_name","mutation_kind","mutation_key_json","row_json","capture_fencing_token","delivery_state","applied_at","created_at") SELECT "source_sequence","operation_id","tenant_id","table_name","mutation_kind","mutation_key_json","row_json","capture_fencing_token","delivery_state","applied_at","created_at" FROM "__authrim_pk_copy_tenant_placement_migration_outbox";

INSERT INTO "tenant_vanity_domains" ("rowid","id","tenant_id","hostname","is_active","active_hostname","is_primary","primary_active_tenant_key","status","cloudflare_zone_id","cloudflare_custom_hostname_id","ssl_status","ownership_status","validation_method","validation_records_json","last_sync_at","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","hostname","is_active","active_hostname","is_primary","primary_active_tenant_key","status","cloudflare_zone_id","cloudflare_custom_hostname_id","ssl_status","ownership_status","validation_method","validation_records_json","last_sync_at","created_by","created_at","updated_at" FROM "__authrim_pk_copy_tenant_vanity_domains";

INSERT INTO "tenants" ("rowid","id","tenant_code","tenant_key","name","description","is_default","default_tenant_guard","created_at","updated_at","lifecycle_state","isolation_policy") SELECT "__authrim_original_rowid","id","tenant_code","tenant_key","name","description","is_default","default_tenant_guard","created_at","updated_at","lifecycle_state","isolation_policy" FROM "__authrim_pk_copy_tenants";

INSERT INTO "token_claim_rules" ("rowid","id","tenant_id","name","description","token_type","conditions_json","actions_json","priority","stop_processing","is_active","valid_from","valid_until","created_by","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","name","description","token_type","conditions_json","actions_json","priority","stop_processing","is_active","valid_from","valid_until","created_by","created_at","updated_at" FROM "__authrim_pk_copy_token_claim_rules";

INSERT INTO "totp_backup_codes" ("rowid","id","tenant_id","user_id","credential_id","code_hash","code_prefix","created_at","used_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","credential_id","code_hash","code_prefix","created_at","used_at" FROM "__authrim_pk_copy_totp_backup_codes";

INSERT INTO "totp_credentials" ("rowid","id","tenant_id","user_id","secret_encrypted","secret_key_version","label","algorithm","digits","period","window","status","last_used_time_step","created_at","activated_at","last_used_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","secret_encrypted","secret_key_version","label","algorithm","digits","period","window","status","last_used_time_step","created_at","activated_at","last_used_at" FROM "__authrim_pk_copy_totp_credentials";

INSERT INTO "trusted_issuers" ("rowid","id","tenant_id","issuer_did","display_name","credential_types","trust_level","jwks_uri","status","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","issuer_did","display_name","credential_types","trust_level","jwks_uri","status","created_at","updated_at" FROM "__authrim_pk_copy_trusted_issuers";

INSERT INTO "upstream_providers" ("rowid","id","tenant_id","name","provider_type","enabled","priority","issuer","client_id","client_secret_encrypted","authorization_endpoint","token_endpoint","userinfo_endpoint","jwks_uri","scopes","attribute_mapping","auto_link_email","jit_provisioning","require_email_verified","provider_quirks","icon_url","icon_name","button_color","button_color_dark","button_text","created_at","updated_at","slug","token_endpoint_auth_method","always_fetch_userinfo","enable_sso","use_request_object","request_object_signing_alg","private_key_jwk_encrypted","public_key_jwk") SELECT "__authrim_original_rowid","id","tenant_id","name","provider_type","enabled","priority","issuer","client_id","client_secret_encrypted","authorization_endpoint","token_endpoint","userinfo_endpoint","jwks_uri","scopes","attribute_mapping","auto_link_email","jit_provisioning","require_email_verified","provider_quirks","icon_url","icon_name","button_color","button_color_dark","button_text","created_at","updated_at","slug","token_endpoint_auth_method","always_fetch_userinfo","enable_sso","use_request_object","request_object_signing_alg","private_key_jwk_encrypted","public_key_jwk" FROM "__authrim_pk_copy_upstream_providers";

INSERT INTO "user_consent_records" ("rowid","id","tenant_id","user_id","statement_id","version_id","version","status","granted_at","withdrawn_at","expires_at","client_id","ip_address_hash","user_agent","receipt_id","created_at","updated_at","retain_until","consent_settings_snapshot_at","record_retention_days_snapshot","reconsent_interval_days_snapshot") SELECT "__authrim_original_rowid","id","tenant_id","user_id","statement_id","version_id","version","status","granted_at","withdrawn_at","expires_at","client_id","ip_address_hash","user_agent","receipt_id","created_at","updated_at","retain_until","consent_settings_snapshot_at","record_retention_days_snapshot","reconsent_interval_days_snapshot" FROM "__authrim_pk_copy_user_consent_records";

INSERT INTO "user_roles" ("rowid","user_id","role_id","created_at","tenant_id") SELECT "__authrim_original_rowid","user_id","role_id","created_at","tenant_id" FROM "__authrim_pk_copy_user_roles";

INSERT INTO "user_token_families" ("rowid","jti","tenant_id","user_id","client_id","generation","expires_at","is_revoked") SELECT "__authrim_original_rowid","jti","tenant_id","user_id","client_id","generation","expires_at","is_revoked" FROM "__authrim_pk_copy_user_token_families";

INSERT INTO "user_verified_attributes" ("rowid","id","tenant_id","user_id","attribute_name","attribute_value","source_type","issuer_did","verification_id","verified_at","expires_at","revalidate_after","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","attribute_name","attribute_value","source_type","issuer_did","verification_id","verified_at","expires_at","revalidate_after","created_at","updated_at" FROM "__authrim_pk_copy_user_verified_attributes";

INSERT INTO "users" ("rowid","id","email","email_verified","name","given_name","family_name","middle_name","nickname","preferred_username","profile","picture","website","gender","birthdate","zoneinfo","locale","phone_number","phone_number_verified","address_json","custom_attributes_json","parent_user_id","identity_provider_id","password_hash","password_changed_at","failed_login_attempts","locked_until","created_at","updated_at","last_login_at","tenant_id","user_type","status","suspended_at","suspended_until","locked_at") SELECT "__authrim_original_rowid","id","email","email_verified","name","given_name","family_name","middle_name","nickname","preferred_username","profile","picture","website","gender","birthdate","zoneinfo","locale","phone_number","phone_number_verified","address_json","custom_attributes_json","parent_user_id","identity_provider_id","password_hash","password_changed_at","failed_login_attempts","locked_until","created_at","updated_at","last_login_at","tenant_id","user_type","status","suspended_at","suspended_until","locked_at" FROM "__authrim_pk_copy_users";

INSERT INTO "users_core" ("rowid","id","tenant_id","email_verified","phone_number_verified","email_domain_hash","password_hash","is_active","user_type","pii_partition","pii_status","created_at","updated_at","last_login_at","email_domain_hash_version","external_id","status","lifecycle_state","suspended_at","suspended_until","locked_at","locked_until") SELECT "__authrim_original_rowid","id","tenant_id","email_verified","phone_number_verified","email_domain_hash","password_hash","is_active","user_type","pii_partition","pii_status","created_at","updated_at","last_login_at","email_domain_hash_version","external_id","status","lifecycle_state","suspended_at","suspended_until","locked_at","locked_until" FROM "__authrim_pk_copy_users_core";

INSERT INTO "value_provenance" ("rowid","id","tenant_id","owner_table","owner_id","source_id","source_record_id","source_field_ref","source_authority_contract_id","observed_at","confidence_score","provenance_json","created_at") SELECT "__authrim_original_rowid","id","tenant_id","owner_table","owner_id","source_id","source_record_id","source_field_ref","source_authority_contract_id","observed_at","confidence_score","provenance_json","created_at" FROM "__authrim_pk_copy_value_provenance";

INSERT INTO "vp_requests" ("rowid","id","tenant_id","client_id","nonce","state","presentation_definition_id","response_uri","response_mode","status","error_code","error_description","created_at","expires_at","verified_at") SELECT "__authrim_original_rowid","id","tenant_id","client_id","nonce","state","presentation_definition_id","response_uri","response_mode","status","error_code","error_description","created_at","expires_at","verified_at" FROM "__authrim_pk_copy_vp_requests";

INSERT INTO "web_origin_registry" ("rowid","id","tenant_id","client_id","origin","cors_allowed","csp_frame_ancestors","handoff_allowed","iframe_allowed","environment","is_active","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","client_id","origin","cors_allowed","csp_frame_ancestors","handoff_allowed","iframe_allowed","environment","is_active","created_at","updated_at" FROM "__authrim_pk_copy_web_origin_registry";

INSERT INTO "webhook_configs" ("rowid","id","tenant_id","client_id","scope","name","url","events","secret_encrypted","headers","retry_policy","timeout_ms","active","created_at","updated_at","last_success_at","last_failure_at","payload_fields","registration_states") SELECT "__authrim_original_rowid","id","tenant_id","client_id","scope","name","url","events","secret_encrypted","headers","retry_policy","timeout_ms","active","created_at","updated_at","last_success_at","last_failure_at","payload_fields","registration_states" FROM "__authrim_pk_copy_webhook_configs";

INSERT INTO "webhook_deliveries" ("rowid","id","webhook_id","tenant_id","event_type","event_id","status","status_code","request_headers","request_body","response_body","error_message","attempts","next_retry_at","created_at","completed_at","duration_ms","detail_object_catalog_id") SELECT "__authrim_original_rowid","id","webhook_id","tenant_id","event_type","event_id","status","status_code","request_headers","request_body","response_body","error_message","attempts","next_retry_at","created_at","completed_at","duration_ms","detail_object_catalog_id" FROM "__authrim_pk_copy_webhook_deliveries";

INSERT INTO "webhook_delivery_logs" ("rowid","id","webhook_id","event_id","event_type","tenant_id","attempt","status","status_code","error_message","duration_ms","created_at") SELECT "__authrim_original_rowid","id","webhook_id","event_id","event_type","tenant_id","attempt","status","status_code","error_message","duration_ms","created_at" FROM "__authrim_pk_copy_webhook_delivery_logs";

DELETE FROM sqlite_sequence WHERE name IN ('tenant_placement_migration_outbox');

INSERT INTO sqlite_sequence (name,seq) SELECT name,seq FROM "__authrim_pk_sequences";

DROP TABLE "__authrim_pk_sequences";

CREATE TRIGGER account_webhook_contact_points_delete AFTER DELETE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND ((a.id = OLD.account_id OR a.primary_subject_id = OLD.subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_contact_points_insert AFTER INSERT ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND ((a.id = NEW.account_id OR a.primary_subject_id = NEW.subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_contact_points_update AFTER UPDATE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND ((a.id = NEW.account_id OR a.primary_subject_id = NEW.subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_created_activate AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.directory_publication_state <> 'active' AND NEW.directory_publication_state = 'active' AND OLD.directory_publication_state <> 'disabled'));
END;

CREATE TRIGGER account_webhook_created_insert AFTER INSERT ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.directory_publication_state = 'active'));
END;

CREATE TRIGGER account_webhook_deleted AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.deleted', a.registration_state, NULL, NULL, __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state = 'deleted' AND OLD.lifecycle_state <> 'deleted'));
END;

CREATE TRIGGER account_webhook_profile_attribute_values_delete AFTER DELETE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = OLD.profile_id AND p.tenant_id = OLD.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_profile_attribute_values_insert AFTER INSERT ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_profile_attribute_values_update AFTER UPDATE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_profiles_delete AFTER DELETE ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.primary_subject_id = OLD.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_profiles_insert AFTER INSERT ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_profiles_update AFTER UPDATE ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

CREATE TRIGGER account_webhook_registration AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.registration.changed', a.registration_state, OLD.registration_state, 'registration_state', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.registration_state <> NEW.registration_state AND (NEW.registration_state = 'guest' OR NOT EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id = NEW.tenant_id AND g.user_id = NEW.legacy_user_id AND g.phase <> 'registered'))));
END;

CREATE TRIGGER account_webhook_updated AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'account', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state NOT IN ('deleted', 'deleting') AND OLD.directory_publication_state = 'active' AND NEW.registration_state = OLD.registration_state AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.display_label IS DISTINCT FROM OLD.display_label OR NEW.metadata_json IS DISTINCT FROM OLD.metadata_json)));
END;

CREATE TRIGGER sg_contact_points_delete AFTER DELETE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id), 1 WHERE (OLD.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_contact_points_insert AFTER INSERT ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_contact_points_update AFTER UPDATE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_epoch_custom_claim_schemas_delete AFTER DELETE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;

CREATE TRIGGER sg_epoch_custom_claim_schemas_insert AFTER INSERT ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;

CREATE TRIGGER sg_epoch_custom_claim_schemas_update AFTER UPDATE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;

CREATE TRIGGER sg_epoch_roles_delete AFTER DELETE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;

CREATE TRIGGER sg_epoch_roles_insert AFTER INSERT ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;

CREATE TRIGGER sg_epoch_roles_update AFTER UPDATE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;

CREATE TRIGGER sg_identity_accounts_delete AFTER DELETE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.legacy_user_id, 1 WHERE (OLD.legacy_user_id IS NOT NULL) AND OLD.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_identity_accounts_insert AFTER INSERT ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_identity_accounts_update AFTER UPDATE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_user_roles_delete AFTER DELETE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_user_roles_insert AFTER INSERT ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_user_roles_update AFTER UPDATE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

CREATE TRIGGER trg_account_creation_operation_status_transition
BEFORE UPDATE OF status ON account_creation_operations
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'preparing' AND NEW.status IN ('reserved', 'blocked', 'canceled')) OR
  (OLD.status = 'reserved' AND NEW.status IN ('writing', 'blocked', 'canceled')) OR
  (OLD.status = 'writing' AND NEW.status IN ('directory_pending', 'succeeded', 'blocked')) OR
  (OLD.status = 'directory_pending' AND NEW.status IN ('succeeded', 'blocked')) OR
  (OLD.status = 'blocked' AND NEW.status IN ('reserved', 'writing', 'directory_pending', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_creation_operation_status_transition');
END;

CREATE TRIGGER trg_account_lifecycle_event_outbox_initial_state
BEFORE INSERT ON account_lifecycle_event_outbox
WHEN NEW.status <> 'pending' OR NEW.attempt_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_lifecycle_event_initial_state');
END;

CREATE TRIGGER trg_account_lifecycle_event_outbox_status_transition
BEFORE UPDATE OF status ON account_lifecycle_event_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'dead_letter')) OR
  (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'dead_letter')) OR
  (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_lifecycle_event_status_transition');
END;

CREATE TRIGGER trg_account_routing_outbox_status_transition
BEFORE UPDATE OF status ON account_routing_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'prepared' AND NEW.status IN ('pending', 'blocked')) OR
  (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'blocked')) OR
  (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'blocked', 'dead_letter')) OR
  (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'blocked', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_routing_outbox_status_transition');
END;

CREATE TRIGGER trg_account_support_context_account_immutable
BEFORE UPDATE OF tenant_id, account_id ON account_support_contexts
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.account_id <> NEW.account_id
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_account_immutable');
END;

CREATE TRIGGER trg_account_support_context_account_tenant_insert
BEFORE INSERT ON account_support_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_account_not_found');
END;

CREATE TRIGGER trg_account_support_context_active_hold_delete
BEFORE DELETE ON account_support_contexts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
     AND hold.subject_id = OLD.account_id AND hold.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_legal_hold_active');
END;

CREATE TRIGGER trg_account_support_context_version
BEFORE UPDATE ON account_support_contexts
WHEN NEW.version <> OLD.version + 1 OR NEW.created_by <> OLD.created_by OR
     NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_version_invalid');
END;

CREATE TRIGGER trg_identity_accounts_active_hold_delete
BEFORE DELETE ON identity_accounts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
     AND hold.subject_id = OLD.id AND hold.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'account_legal_hold_active');
END;

CREATE TRIGGER trg_identity_accounts_legal_hold_state_insert
AFTER INSERT ON identity_accounts
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.id, NULL, 'inactive', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO NOTHING;
END;

CREATE TRIGGER trg_legal_hold_events_immutable_delete
BEFORE DELETE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_event_immutable');
END;

CREATE TRIGGER trg_legal_hold_events_immutable_update
BEFORE UPDATE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_event_immutable');
END;

CREATE TRIGGER trg_legal_holds_account_tenant_insert
BEFORE INSERT ON legal_holds
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.subject_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_account_not_found');
END;

CREATE TRIGGER trg_legal_holds_account_tenant_update
BEFORE UPDATE OF tenant_id, subject_type, subject_id ON legal_holds
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.subject_type <> NEW.subject_type OR
     OLD.subject_id <> NEW.subject_id
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_subject_immutable');
END;

CREATE TRIGGER trg_legal_holds_immutable_delete
BEFORE DELETE ON legal_holds
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_delete_forbidden');
END;

CREATE TRIGGER trg_legal_holds_one_active_account_insert
BEFORE INSERT ON legal_holds
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = NEW.tenant_id AND hold.subject_type = NEW.subject_type
     AND hold.subject_id = NEW.subject_id AND hold.state = 'active' AND hold.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_active_conflict');
END;

CREATE TRIGGER trg_legal_holds_projection_state_insert
AFTER INSERT ON legal_holds
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.subject_id, NEW.id, 'active', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO UPDATE SET
    active_hold_id = excluded.active_hold_id,
    projection_state = 'active',
    projection_generation = account_legal_hold_states.projection_generation + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_legal_holds_projection_state_update
AFTER UPDATE OF state ON legal_holds
WHEN OLD.state = 'active' AND NEW.state IN ('released', 'expired')
BEGIN
  UPDATE account_legal_hold_states
     SET active_hold_id = NULL, projection_state = 'inactive',
         projection_generation = projection_generation + 1, updated_at = NEW.updated_at
   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.subject_id
     AND active_hold_id = NEW.id AND projection_state = 'active';
END;

CREATE TRIGGER trg_legal_holds_transition
BEFORE UPDATE ON legal_holds
WHEN NOT (
  OLD.state = 'active' AND NEW.state IN ('active', 'released', 'expired') AND
  NEW.version = OLD.version + 1 AND NEW.created_by = OLD.created_by AND
  NEW.created_at = OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_transition_invalid');
END;

CREATE TRIGGER trg_notification_delivery_history_recipient_immutable
BEFORE UPDATE OF account_id, recipient_masked, recipient_encrypted,
  recipient_encryption_key_version, created_at
ON notification_delivery_intents
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_history_recipient_immutable');
END;

CREATE TRIGGER trg_notification_delivery_intent_initial_state
BEFORE INSERT ON notification_delivery_intents
WHEN NEW.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'invalid_notification_delivery_intent_initial_state');
END;

CREATE TRIGGER trg_notification_delivery_intent_payload_immutable
BEFORE UPDATE OF payload_key_id, payload_envelope_json, tenant_id, plugin_installation_id,
  provider_order_version, provider_installation_ids_json, channel, notification_kind,
  payload_version, idempotency_key, request_fingerprint,
  fingerprint_key_id, expires_at, created_at
ON notification_delivery_intents
WHEN OLD.state <> 'pending'
  OR NEW.payload_key_id IS NOT NULL
  OR NEW.payload_envelope_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_intent_payload_immutable');
END;

CREATE TRIGGER trg_notification_delivery_intent_state_transition
BEFORE UPDATE OF state ON notification_delivery_intents
WHEN OLD.state <> NEW.state AND NOT (
  OLD.state = 'pending' AND NEW.state IN ('delivered', 'canceled', 'expired', 'dead_letter')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_notification_delivery_intent_state_transition');
END;

CREATE TRIGGER trg_plugin_hook_outbox_claim_fencing
BEFORE UPDATE ON plugin_hook_outbox
WHEN NEW.status = 'locked' AND (
  (OLD.status IN ('queued', 'waiting_retry') AND NEW.attempt_no <> OLD.attempt_no + 1) OR
  (OLD.status = 'locked' AND (
    NOT (
      (NEW.claim_token = OLD.claim_token AND NEW.attempt_no = OLD.attempt_no) OR
      (OLD.lease_until <= NEW.updated_at AND NEW.claim_token <> OLD.claim_token
        AND NEW.attempt_no = OLD.attempt_no + 1)
    )
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_claim_fencing');
END;

CREATE TRIGGER trg_plugin_hook_outbox_initial_state
BEFORE INSERT ON plugin_hook_outbox
WHEN NEW.status <> 'queued'
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_initial_state');
END;

CREATE TRIGGER trg_plugin_hook_outbox_status_transition
BEFORE UPDATE OF status ON plugin_hook_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('locked', 'canceled')) OR
  (OLD.status = 'locked' AND NEW.status IN ('waiting_retry', 'succeeded', 'dead_letter', 'canceled')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('locked', 'dead_letter', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_status_transition');
END;

CREATE TRIGGER trg_tenant_placement_capture_identity_immutable
BEFORE UPDATE OF operation_id, tenant_id, source_shard_id, migration_generation
ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_identity_immutable');
END;

CREATE TRIGGER trg_tenant_placement_capture_no_delete
BEFORE DELETE ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_delete_forbidden');
END;

CREATE TRIGGER trg_tenant_placement_capture_one_active_insert
BEFORE INSERT ON tenant_placement_migration_captures
WHEN NEW.capture_state IN ('capturing', 'write_fenced', 'cutover_committed') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND capture_state IN ('capturing', 'write_fenced', 'cutover_committed')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_active_conflict');
END;

CREATE TRIGGER trg_tenant_placement_capture_one_active_update
BEFORE UPDATE OF tenant_id, capture_state ON tenant_placement_migration_captures
WHEN NEW.capture_state IN ('capturing', 'write_fenced', 'cutover_committed') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND operation_id <> OLD.operation_id
     AND capture_state IN ('capturing', 'write_fenced', 'cutover_committed')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_active_conflict');
END;

CREATE TRIGGER trg_tenant_placement_capture_transition
BEFORE UPDATE OF capture_state ON tenant_placement_migration_captures
WHEN NOT (
  (OLD.capture_state = 'capturing' AND NEW.capture_state IN ('write_fenced', 'canceled')) OR
  (OLD.capture_state = 'write_fenced' AND NEW.capture_state IN ('capturing', 'cutover_committed', 'canceled')) OR
  OLD.capture_state = NEW.capture_state
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_transition_invalid');
END;

CREATE TRIGGER trg_tenant_placement_outbox_payload_immutable
BEFORE UPDATE OF source_sequence, operation_id, tenant_id, table_name, mutation_kind,
                 mutation_key_json, row_json, capture_fencing_token, created_at
ON tenant_placement_migration_outbox
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_outbox_payload_immutable');
END;

CREATE TRIGGER trg_tenant_placement_policy_no_scope_weakening
BEFORE UPDATE OF isolation_policy ON tenants
WHEN OLD.isolation_policy = 'tenant_exclusive'
  AND NEW.isolation_policy <> 'tenant_exclusive'
  AND NOT (
    OLD.id = 'default'
    AND OLD.created_at = OLD.updated_at
    AND (SELECT COUNT(*) FROM tenants) = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_policy_scope_weakening');
END;

CREATE TRIGGER trg_tenants_lookup_retention_policy_insert
AFTER INSERT ON tenants
BEGIN
  INSERT INTO lookup_retention_policies (
    tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
  ) VALUES (NEW.id, 180, 1, 'tenant-default', NEW.created_at, NEW.updated_at)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO lookup_retention_policy_projection_outbox (
    operation_id, tenant_id, policy_generation, retention_days,
    next_attempt_at, created_at, updated_at
  )
  SELECT 'lookup-retention-policy:init:' || lower(hex(randomblob(16))),
         tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
    FROM lookup_retention_policies WHERE tenant_id = NEW.id
  ON CONFLICT (tenant_id, policy_generation) DO NOTHING;
END;

INSERT INTO "__authrim_pk_guard" VALUES ('foreign-key-check', (SELECT count(*) FROM pragma_foreign_key_check));

DROP TABLE "__authrim_pk_copy_access_review_items";

DROP TABLE "__authrim_pk_copy_access_reviews";

DROP TABLE "__authrim_pk_copy_account_creation_operations";

DROP TABLE "__authrim_pk_copy_account_lifecycle_event_outbox";

DROP TABLE "__authrim_pk_copy_account_routing_outbox";

DROP TABLE "__authrim_pk_copy_account_support_contexts";

DROP TABLE "__authrim_pk_copy_account_webhook_outbox";

DROP TABLE "__authrim_pk_copy_admin_jobs";

DROP TABLE "__authrim_pk_copy_assurance_evidence";

DROP TABLE "__authrim_pk_copy_attribute_release_consents";

DROP TABLE "__authrim_pk_copy_attribute_verifications";

DROP TABLE "__authrim_pk_copy_audit_log";

DROP TABLE "__authrim_pk_copy_authrim_migrations";

DROP TABLE "__authrim_pk_copy_authrim_runtime_probes";

DROP TABLE "__authrim_pk_copy_branding_settings";

DROP TABLE "__authrim_pk_copy_check_api_keys";

DROP TABLE "__authrim_pk_copy_ciba_requests";

DROP TABLE "__authrim_pk_copy_client_consent_overrides";

DROP TABLE "__authrim_pk_copy_client_trust_policies";

DROP TABLE "__authrim_pk_copy_compliance_reports";

DROP TABLE "__authrim_pk_copy_consent_history";

DROP TABLE "__authrim_pk_copy_consent_item_history";

DROP TABLE "__authrim_pk_copy_consent_policies";

DROP TABLE "__authrim_pk_copy_consent_policy_items";

DROP TABLE "__authrim_pk_copy_consent_policy_versions";

DROP TABLE "__authrim_pk_copy_consent_records";

DROP TABLE "__authrim_pk_copy_consent_statement_localizations";

DROP TABLE "__authrim_pk_copy_consent_statement_versions";

DROP TABLE "__authrim_pk_copy_consent_statements";

DROP TABLE "__authrim_pk_copy_contact_point_search_indexes";

DROP TABLE "__authrim_pk_copy_contact_points";

DROP TABLE "__authrim_pk_copy_contact_verifications";

DROP TABLE "__authrim_pk_copy_credential_configurations";

DROP TABLE "__authrim_pk_copy_credential_offers";

DROP TABLE "__authrim_pk_copy_custom_claim_schema_history";

DROP TABLE "__authrim_pk_copy_custom_claim_schemas";

DROP TABLE "__authrim_pk_copy_data_export_requests";

DROP TABLE "__authrim_pk_copy_delegations";

DROP TABLE "__authrim_pk_copy_device_codes";

DROP TABLE "__authrim_pk_copy_device_installations";

DROP TABLE "__authrim_pk_copy_device_secrets";

DROP TABLE "__authrim_pk_copy_did_document_cache";

DROP TABLE "__authrim_pk_copy_directory_auth_config_history";

DROP TABLE "__authrim_pk_copy_directory_auth_evidence_exports";

DROP TABLE "__authrim_pk_copy_directory_auth_migration_campaigns";

DROP TABLE "__authrim_pk_copy_directory_auth_migration_transaction_events";

DROP TABLE "__authrim_pk_copy_directory_auth_migration_transactions";

DROP TABLE "__authrim_pk_copy_directory_auth_migration_user_states";

DROP TABLE "__authrim_pk_copy_directory_auth_release_advisories";

DROP TABLE "__authrim_pk_copy_directory_auth_retention_policies";

DROP TABLE "__authrim_pk_copy_directory_auth_support_bundles";

DROP TABLE "__authrim_pk_copy_directory_auth_tenant_policies";

DROP TABLE "__authrim_pk_copy_directory_connector_instances";

DROP TABLE "__authrim_pk_copy_directory_connector_status_episodes";

DROP TABLE "__authrim_pk_copy_directory_identity_links";

DROP TABLE "__authrim_pk_copy_directory_jit_pending_users";

DROP TABLE "__authrim_pk_copy_entitlements";

DROP TABLE "__authrim_pk_copy_event_log";

DROP TABLE "__authrim_pk_copy_external_idp_auth_states";

DROP TABLE "__authrim_pk_copy_external_lifecycle_signal_decisions";

DROP TABLE "__authrim_pk_copy_external_lifecycle_signal_events";

DROP TABLE "__authrim_pk_copy_field_usage_bindings";

DROP TABLE "__authrim_pk_copy_flow_assignments";

DROP TABLE "__authrim_pk_copy_flow_audit_events";

DROP TABLE "__authrim_pk_copy_flow_interaction_steps";

DROP TABLE "__authrim_pk_copy_flow_interactions";

DROP TABLE "__authrim_pk_copy_flow_versions";

DROP TABLE "__authrim_pk_copy_group_memberships";

DROP TABLE "__authrim_pk_copy_groups";

DROP TABLE "__authrim_pk_copy_guest_account_upgrades";

DROP TABLE "__authrim_pk_copy_guest_deletion_audit_outbox";

DROP TABLE "__authrim_pk_copy_guest_devices";

DROP TABLE "__authrim_pk_copy_idempotency_keys";

DROP TABLE "__authrim_pk_copy_identity_accounts";

DROP TABLE "__authrim_pk_copy_identity_binding_lookup_indexes";

DROP TABLE "__authrim_pk_copy_identity_bindings";

DROP TABLE "__authrim_pk_copy_identity_providers";

DROP TABLE "__authrim_pk_copy_identity_resolution_candidates";

DROP TABLE "__authrim_pk_copy_identity_resolution_events";

DROP TABLE "__authrim_pk_copy_identity_subjects";

DROP TABLE "__authrim_pk_copy_internal_notification_delivery_attempts";

DROP TABLE "__authrim_pk_copy_internal_notification_delivery_routes";

DROP TABLE "__authrim_pk_copy_internal_notification_events";

DROP TABLE "__authrim_pk_copy_issued_credentials";

DROP TABLE "__authrim_pk_copy_legal_hold_events";

DROP TABLE "__authrim_pk_copy_legal_hold_projection_outbox";

DROP TABLE "__authrim_pk_copy_legal_holds";

DROP TABLE "__authrim_pk_copy_log_chunk_manifests";

DROP TABLE "__authrim_pk_copy_log_object_catalog";

DROP TABLE "__authrim_pk_copy_logging_catalog_repair_jobs";

DROP TABLE "__authrim_pk_copy_logging_quota_evaluations";

DROP TABLE "__authrim_pk_copy_logging_quota_policies";

DROP TABLE "__authrim_pk_copy_logging_usage_aggregates";

DROP TABLE "__authrim_pk_copy_lookup_retention_policies";

DROP TABLE "__authrim_pk_copy_lookup_retention_policy_projection_outbox";

DROP TABLE "__authrim_pk_copy_migration_metadata";

DROP TABLE "__authrim_pk_copy_notification_delivery_intents";

DROP TABLE "__authrim_pk_copy_oauth_client_consents";

DROP TABLE "__authrim_pk_copy_object_catalog";

DROP TABLE "__authrim_pk_copy_object_catalog_objects";

DROP TABLE "__authrim_pk_copy_oidc_scopes";

DROP TABLE "__authrim_pk_copy_operational_logs";

DROP TABLE "__authrim_pk_copy_org_domain_mappings";

DROP TABLE "__authrim_pk_copy_organizations";

DROP TABLE "__authrim_pk_copy_passkeys";

DROP TABLE "__authrim_pk_copy_password_reset_tokens";

DROP TABLE "__authrim_pk_copy_permission_change_audit";

DROP TABLE "__authrim_pk_copy_permission_check_audit";

DROP TABLE "__authrim_pk_copy_plugin_account_metadata";

DROP TABLE "__authrim_pk_copy_plugin_hook_outbox";

DROP TABLE "__authrim_pk_copy_presentation_definitions";

DROP TABLE "__authrim_pk_copy_profile_attribute_values";

DROP TABLE "__authrim_pk_copy_profiles";

DROP TABLE "__authrim_pk_copy_provisioning_assignment_events";

DROP TABLE "__authrim_pk_copy_provisioning_assignment_ownership";

DROP TABLE "__authrim_pk_copy_provisioning_assignment_rules";

DROP TABLE "__authrim_pk_copy_provisioning_revocation_events";

DROP TABLE "__authrim_pk_copy_refresh_token_shard_configs";

DROP TABLE "__authrim_pk_copy_relation_definitions";

DROP TABLE "__authrim_pk_copy_relationship_closure";

DROP TABLE "__authrim_pk_copy_relationships";

DROP TABLE "__authrim_pk_copy_resource_permissions";

DROP TABLE "__authrim_pk_copy_role_assignment_rules";

DROP TABLE "__authrim_pk_copy_role_assignments";

DROP TABLE "__authrim_pk_copy_roles";

DROP TABLE "__authrim_pk_copy_saml_attribute_presets";

DROP TABLE "__authrim_pk_copy_screens";

DROP TABLE "__authrim_pk_copy_security_alerts";

DROP TABLE "__authrim_pk_copy_security_threats";

DROP TABLE "__authrim_pk_copy_sensitive_detail_chunk_index";

DROP TABLE "__authrim_pk_copy_service_group_audit";

DROP TABLE "__authrim_pk_copy_service_group_catalog";

DROP TABLE "__authrim_pk_copy_service_group_epoch";

DROP TABLE "__authrim_pk_copy_service_group_write_boundaries";

DROP TABLE "__authrim_pk_copy_sessions";

DROP TABLE "__authrim_pk_copy_settings_history";

DROP TABLE "__authrim_pk_copy_sign_in_confirmation_policies";

DROP TABLE "__authrim_pk_copy_status_lists";

DROP TABLE "__authrim_pk_copy_structured_attribute_values";

DROP TABLE "__authrim_pk_copy_subject_account_links";

DROP TABLE "__authrim_pk_copy_subject_lifecycle_timeline_events";

DROP TABLE "__authrim_pk_copy_subject_org_membership";

DROP TABLE "__authrim_pk_copy_support_operation_actions";

DROP TABLE "__authrim_pk_copy_support_operation_cohort_targets";

DROP TABLE "__authrim_pk_copy_support_operation_cohorts";

DROP TABLE "__authrim_pk_copy_suspicious_activities";

DROP TABLE "__authrim_pk_copy_tenant_consent_requirements";

DROP TABLE "__authrim_pk_copy_tenant_database_migration_state";

DROP TABLE "__authrim_pk_copy_tenant_database_probe_results";

DROP TABLE "__authrim_pk_copy_tenant_domain_mappings";

DROP TABLE "__authrim_pk_copy_tenant_invitations";

DROP TABLE "__authrim_pk_copy_tenant_placement_migration_captures";

DROP TABLE "__authrim_pk_copy_tenant_placement_migration_outbox";

DROP TABLE "__authrim_pk_copy_tenant_vanity_domains";

DROP TABLE "__authrim_pk_copy_tenants";

DROP TABLE "__authrim_pk_copy_token_claim_rules";

DROP TABLE "__authrim_pk_copy_totp_backup_codes";

DROP TABLE "__authrim_pk_copy_totp_credentials";

DROP TABLE "__authrim_pk_copy_trusted_issuers";

DROP TABLE "__authrim_pk_copy_upstream_providers";

DROP TABLE "__authrim_pk_copy_user_consent_records";

DROP TABLE "__authrim_pk_copy_user_roles";

DROP TABLE "__authrim_pk_copy_user_token_families";

DROP TABLE "__authrim_pk_copy_user_verified_attributes";

DROP TABLE "__authrim_pk_copy_users";

DROP TABLE "__authrim_pk_copy_users_core";

DROP TABLE "__authrim_pk_copy_value_provenance";

DROP TABLE "__authrim_pk_copy_vp_requests";

DROP TABLE "__authrim_pk_copy_web_origin_registry";

DROP TABLE "__authrim_pk_copy_webhook_configs";

DROP TABLE "__authrim_pk_copy_webhook_deliveries";

DROP TABLE "__authrim_pk_copy_webhook_delivery_logs";

DROP TABLE "__authrim_pk_guard";

PRAGMA defer_foreign_keys = OFF;
