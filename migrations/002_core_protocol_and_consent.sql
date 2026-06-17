-- =============================================================================
-- Authrim Core Baseline: Protocol and Consent Tables
-- Consolidated baseline for fresh Authrim core database installs.
-- =============================================================================
CREATE TABLE access_review_items (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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

CREATE TABLE admin_jobs (
  -- Primary key
  id TEXT PRIMARY KEY,

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

CREATE TABLE ai_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  ai_principal TEXT NOT NULL,
  scopes TEXT NOT NULL,
  scope_targets TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  UNIQUE(tenant_id, client_id, ai_principal)
);

CREATE TABLE attribute_verifications (
    id TEXT PRIMARY KEY,
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
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default', severity TEXT DEFAULT 'info');

CREATE TABLE branding_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
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
    id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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

CREATE TABLE compliance_reports (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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

CREATE TABLE consent_item_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,                  -- 'granted'|'denied'|'withdrawn'|'version_upgraded'|'expired'
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE consent_policy_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL,
  policy_type TEXT NOT NULL,  -- 'privacy_policy' | 'terms_of_service' | 'cookie_policy'
  policy_uri TEXT,
  policy_hash TEXT,           -- SHA-256 hash of policy content for integrity verification
  effective_at INTEGER NOT NULL,  -- Unix timestamp when this version becomes effective
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_type, version)
);

CREATE TABLE consent_statement_localizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version_id TEXT NOT NULL,
  language TEXT NOT NULL,                -- BCP 47: 'en', 'ja', 'de'
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  document_url TEXT,                     -- External document URL (content_type='url')
  inline_content TEXT,                   -- Inline text (content_type='inline')
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE CASCADE,
  UNIQUE (version_id, language)
);

CREATE TABLE consent_statement_versions (
  id TEXT PRIMARY KEY,
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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id, version)
);

CREATE TABLE consent_statements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'custom',
  legal_basis TEXT NOT NULL DEFAULT 'consent',
  processing_purpose TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE credential_configurations (
    id TEXT PRIMARY KEY,
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
    -- Status: 'pending' | 'accepted' | 'issued' | 'failed' | 'expired'
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    issued_at TEXT,
    issued_credential_id TEXT,
    issued_credential_internal_id TEXT,
    FOREIGN KEY (issued_credential_internal_id) REFERENCES issued_credentials(internal_id)
);

CREATE TABLE data_export_requests (
  id TEXT PRIMARY KEY,
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

CREATE TABLE object_catalog (
  id TEXT PRIMARY KEY,
  public_artifact_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  object_class TEXT NOT NULL CHECK (
    object_class IN (
      'admin_audit_detail',
      'webhook_delivery_payload',
      'operational_log_detail',
      'user_export',
      'user_import_input',
      'user_import_result',
      'admin_job_result',
      'dr_bundle',
      'approval_transport_detail'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE object_catalog_objects (
  id TEXT PRIMARY KEY,
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

CREATE TABLE sensitive_detail_chunk_index (
  catalog_id TEXT PRIMARY KEY,
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

CREATE TABLE device_codes (
  device_code TEXT PRIMARY KEY,
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
  poll_count INTEGER DEFAULT 0, tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_secrets (
  id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_device_secrets_secret_hash
  ON device_secrets(secret_hash);

CREATE INDEX IF NOT EXISTS idx_device_secrets_tenant_user
  ON device_secrets(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_device_secrets_session_id
  ON device_secrets(session_id);

CREATE INDEX IF NOT EXISTS idx_device_secrets_active_expires
  ON device_secrets(is_active, expires_at);

CREATE INDEX IF NOT EXISTS idx_device_secrets_installation
  ON device_secrets(tenant_id, installation_id);

CREATE INDEX IF NOT EXISTS idx_device_secrets_client
  ON device_secrets(tenant_id, client_id);

CREATE INDEX IF NOT EXISTS idx_device_secrets_trust_group
  ON device_secrets(tenant_id, trust_group_id);

CREATE TABLE IF NOT EXISTS device_installations (
  id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_device_installations_user
  ON device_installations(tenant_id, user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_device_installations_client
  ON device_installations(tenant_id, client_id, is_active);

CREATE INDEX IF NOT EXISTS idx_device_installations_trust_group
  ON device_installations(tenant_id, trust_group_id, is_active);

CREATE INDEX IF NOT EXISTS idx_device_installations_source
  ON device_installations(tenant_id, source_installation_id, client_id);

CREATE INDEX IF NOT EXISTS idx_device_installations_linked_secret
  ON device_installations(tenant_id, linked_device_secret_id);

CREATE TABLE did_document_cache (
    did TEXT PRIMARY KEY,
    -- JSON of DID Document
    document TEXT NOT NULL,
    resolved_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL
);

CREATE TABLE external_idp_auth_states (
  id TEXT PRIMARY KEY,
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

CREATE TABLE "flows" (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  graph_definition TEXT NOT NULL,
  compiled_plan TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE idempotency_keys (
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
);

CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default');

CREATE TABLE saml_attribute_presets (
  id TEXT PRIMARY KEY,
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

CREATE TABLE issued_credentials (
    internal_id TEXT PRIMARY KEY,
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

CREATE TABLE "linked_identities" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  email_verified INTEGER DEFAULT 0,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at INTEGER,
  raw_claims TEXT,
  profile_data TEXT,
  linked_at INTEGER NOT NULL,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, provider_id, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

CREATE TABLE "oauth_client_consents" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  tenant_id TEXT NOT NULL DEFAULT 'default', selected_scopes TEXT, privacy_policy_version TEXT, tos_version TEXT, consent_version INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, client_id)
);

CREATE TABLE oauth_clients (
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  description TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT,
  logo_uri TEXT,
  client_uri TEXT,
  policy_uri TEXT,
  tos_uri TEXT,
  contacts TEXT,
  subject_type TEXT DEFAULT 'public',
  sector_identifier_uri TEXT,
  token_endpoint_auth_method TEXT DEFAULT 'client_secret_basic',
  -- RFC 8693: Token Exchange settings
  token_exchange_allowed INTEGER DEFAULT 0,
  allowed_subject_token_clients TEXT,  -- JSON array of client IDs
  allowed_token_exchange_resources TEXT,  -- JSON array of resource URIs
  delegation_mode TEXT DEFAULT 'delegation',  -- 'none' | 'delegation' | 'impersonation'
  -- RFC 6749 Section 4.4: Client Credentials settings
  client_credentials_allowed INTEGER DEFAULT 0,
  allowed_scopes TEXT,  -- JSON array of allowed scopes
  default_scope TEXT,  -- Default scope for Client Credentials
  default_audience TEXT,  -- Default audience for Client Credentials
  default_resource TEXT,  -- Default resource target for access tokens
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, is_trusted INTEGER DEFAULT 0, skip_consent INTEGER DEFAULT 0, allow_claims_without_scope INTEGER DEFAULT 0, claims_parameter_policy TEXT, asc_enabled INTEGER DEFAULT 1, asc_protected_request_required INTEGER DEFAULT 1, asc_sao_enabled INTEGER DEFAULT 1, asc_transformed_claims_enabled INTEGER DEFAULT 1, asc_allowed_transformed_claims TEXT, backchannel_token_delivery_mode TEXT, backchannel_client_notification_endpoint TEXT, backchannel_authentication_request_signing_alg TEXT, backchannel_user_code_parameter INTEGER DEFAULT 0, tenant_id TEXT NOT NULL DEFAULT 'default', jwks TEXT, jwks_uri TEXT, userinfo_signed_response_alg TEXT, post_logout_redirect_uris TEXT, allowed_redirect_origins TEXT, backchannel_logout_uri TEXT, backchannel_logout_session_required INTEGER DEFAULT 0, frontchannel_logout_uri TEXT, frontchannel_logout_session_required INTEGER DEFAULT 0, logout_webhook_uri TEXT, logout_webhook_secret_encrypted TEXT, registration_access_token_hash TEXT, initiate_login_uri TEXT, login_ui_url TEXT, id_token_signed_response_alg TEXT, request_object_signing_alg TEXT, client_secret_hash TEXT, software_id TEXT, software_version TEXT, requestable_scopes TEXT, require_pkce INTEGER DEFAULT 0, application_type TEXT DEFAULT 'web', trust_group TEXT, trust_group_id TEXT, browser_public_client_mode TEXT, browser_refresh_token_policy TEXT NOT NULL DEFAULT 'disabled', native_sso_enabled INTEGER, native_channel_allowed INTEGER, allowed_channels TEXT, device_secret_revoke_enabled INTEGER, device_secret_revoke_trust_groups TEXT, device_secret_introspection_enabled INTEGER, device_secret_introspection_trust_groups TEXT, PRIMARY KEY (tenant_id, client_id));

CREATE INDEX idx_oauth_clients_trust_group ON oauth_clients(tenant_id, trust_group);
CREATE INDEX idx_oauth_clients_application_type ON oauth_clients(tenant_id, application_type);

CREATE TABLE web_origin_registry (
  id TEXT PRIMARY KEY,
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

CREATE INDEX idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active);

CREATE INDEX idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active);
