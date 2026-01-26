-- =============================================================================
-- Fresh Schema for Authrim Core DB
-- Generated from conformance environment
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
  estimated_completion INTEGER
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
    verified_at TEXT DEFAULT (datetime('now')),
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
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
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
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    issued_at TEXT,
    issued_credential_id TEXT REFERENCES issued_credentials(id)
);

CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
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
  file_size INTEGER,
  error_message TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
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
  poll_count INTEGER DEFAULT 0, tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE did_document_cache (
    did TEXT PRIMARY KEY,
    -- JSON of DID Document
    document TEXT NOT NULL,
    resolved_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE TABLE external_idp_auth_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  state TEXT UNIQUE NOT NULL,            -- OAuth state parameter
  nonce TEXT,                            -- OIDC nonce for ID token validation
  code_verifier TEXT,                    -- PKCE code verifier
  redirect_uri TEXT NOT NULL,            -- Where to redirect after auth

  -- For linking flow
  user_id TEXT,                          -- Set if linking to existing account
  session_id TEXT,                       -- Authrim session (for linking flow)

  -- For OIDC proxy flow (future)
  original_auth_request TEXT,            -- JSON of original OIDC auth request

  -- OIDC Core 1.0 parameters (for validation in callback)
  max_age INTEGER,                       -- max_age parameter for auth_time validation
  acr_values TEXT,                       -- acr_values parameter for acr validation

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

CREATE TABLE issued_credentials (
    id TEXT PRIMARY KEY,
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
    -- Status list index for revocation
    status_list_index INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT
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
  UNIQUE(provider_id, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global',

  -- Current schema version (highest applied migration version)
  current_version INTEGER NOT NULL DEFAULT 0,

  -- Last migration applied timestamp
  last_migration_at INTEGER,

  -- Environment (development, staging, production)
  environment TEXT DEFAULT 'development',

  -- Additional metadata as JSON
  metadata_json TEXT
, tenant_id TEXT NOT NULL DEFAULT 'default');

CREATE TABLE "oauth_client_consents" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  tenant_id TEXT NOT NULL DEFAULT 'default', selected_scopes TEXT, privacy_policy_version TEXT, tos_version TEXT, consent_version INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  UNIQUE (user_id, client_id)
);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, is_trusted INTEGER DEFAULT 0, skip_consent INTEGER DEFAULT 0, allow_claims_without_scope INTEGER DEFAULT 0, backchannel_token_delivery_mode TEXT, backchannel_client_notification_endpoint TEXT, backchannel_authentication_request_signing_alg TEXT, backchannel_user_code_parameter INTEGER DEFAULT 0, tenant_id TEXT NOT NULL DEFAULT 'default', jwks TEXT, jwks_uri TEXT, userinfo_signed_response_alg TEXT, post_logout_redirect_uris TEXT, allowed_redirect_origins TEXT, backchannel_logout_uri TEXT, backchannel_logout_session_required INTEGER DEFAULT 0, frontchannel_logout_uri TEXT, frontchannel_logout_session_required INTEGER DEFAULT 0, logout_webhook_uri TEXT, logout_webhook_secret_encrypted TEXT, registration_access_token_hash TEXT, initiate_login_uri TEXT, id_token_signed_response_alg TEXT, request_object_signing_alg TEXT, client_secret_hash TEXT, software_id TEXT, software_version TEXT, requestable_scopes TEXT);

CREATE TABLE operational_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,  -- Code expects: 'user', 'client', 'session'
    subject_id TEXT NOT NULL,    -- Code expects this name, not 'resource_id'
    actor_id TEXT NOT NULL,      -- Who performed the operation
    action TEXT NOT NULL,        -- 'user.suspend', 'user.lock', etc.
    reason_detail_encrypted TEXT,-- AES-GCM encrypted reason_detail
    encryption_key_version INTEGER NOT NULL DEFAULT 1, -- Code expects this column
    request_id TEXT,             -- X-Request-ID header value
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, -- When this log should be deleted

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE org_domain_mappings (
  -- Primary key
  id TEXT PRIMARY KEY,

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
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE "password_reset_tokens" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE permission_change_audit (
    id TEXT PRIMARY KEY,
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
    id TEXT PRIMARY KEY,
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

CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Rule configuration
  priority INTEGER NOT NULL DEFAULT 100,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),

  -- Target matching (JSON arrays)
  resource_types TEXT, -- JSON array of resource types to match
  actions TEXT,        -- JSON array of actions to match

  -- Conditions (JSON array of PolicyCondition objects)
  conditions TEXT NOT NULL DEFAULT '[]',

  -- Status
  enabled INTEGER NOT NULL DEFAULT 1,

  -- Audit
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,

  -- Indexes
  UNIQUE(tenant_id, name)
);

CREATE TABLE policy_simulations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,

  -- Simulation input (JSON)
  context TEXT NOT NULL,

  -- Simulation result
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  decided_by TEXT,

  -- Details (JSON)
  details TEXT,
  matched_rules TEXT, -- JSON array of rule IDs that were evaluated

  -- Audit
  simulated_by TEXT,
  simulated_at INTEGER NOT NULL
);

CREATE TABLE presentation_definitions (
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE refresh_token_shard_configs (
  id TEXT PRIMARY KEY,                -- UUID
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
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,

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
  id TEXT PRIMARY KEY,

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
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default', role_type TEXT NOT NULL DEFAULT 'custom', hierarchy_level INTEGER DEFAULT 0, is_assignable INTEGER DEFAULT 1, parent_role_id TEXT REFERENCES roles(id), display_name TEXT, is_system INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);

CREATE TABLE schema_migrations (
  -- Migration version (from filename: 001_initial_schema.sql -> version = 1)
  version INTEGER PRIMARY KEY,

  -- Human-readable migration name (from filename: 001_initial_schema.sql -> name = "initial_schema")
  name TEXT NOT NULL,

  -- When the migration was applied (Unix timestamp in seconds)
  applied_at INTEGER NOT NULL,

  -- SHA-256 checksum of the migration SQL file (detects file modifications)
  checksum TEXT NOT NULL,

  -- How long the migration took to execute (milliseconds)
  execution_time_ms INTEGER,

  -- Optional: SQL for rolling back this migration
  rollback_sql TEXT
);

CREATE TABLE scope_mappings (
  scope TEXT NOT NULL,
  claim_name TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_column TEXT NOT NULL,
  transformation TEXT,
  condition TEXT,
  created_at INTEGER NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (scope, claim_name)
);

CREATE TABLE security_alerts (
    id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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

CREATE TABLE "session_clients" (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_token_at INTEGER NOT NULL,
  last_token_at INTEGER NOT NULL,
  last_seen_at INTEGER,

  -- Only keep the client_id foreign key
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,

  UNIQUE (session_id, client_id)
);

CREATE TABLE "sessions" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  external_provider_id TEXT,
  external_provider_sub TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE settings_history (
  -- Primary key
  id TEXT PRIMARY KEY,

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

CREATE TABLE status_lists (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    -- Purpose: 'revocation' | 'suspension'
    purpose TEXT NOT NULL DEFAULT 'revocation',
    -- Bitstring of status values (base64url encoded)
    encoded_list TEXT NOT NULL,
    -- Current index for new credentials
    current_index INTEGER DEFAULT 0,
    -- Total capacity
    capacity INTEGER DEFAULT 131072,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE subject_identifiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- User this identifier belongs to
  subject_id TEXT NOT NULL,         -- References users(id)
  -- Identifier details
  identifier_type TEXT NOT NULL,    -- 'email', 'did', 'phone', 'username'
  identifier_value TEXT NOT NULL,   -- 'user@example.com', 'did:key:z6Mk...'
  -- Flags
  is_primary INTEGER DEFAULT 0,     -- Whether this is the primary identifier
  -- Verification
  verified_at INTEGER,              -- When the identifier was verified
  verification_method TEXT,         -- 'email_verification', 'did_auth', 'phone_sms'
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE "subject_org_membership" (
  id TEXT PRIMARY KEY,
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

CREATE TABLE suspicious_activities (
  id TEXT PRIMARY KEY,
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

CREATE TABLE token_claim_rules (
  -- Primary key
  id TEXT PRIMARY KEY,

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

CREATE TABLE trusted_issuers (
    id TEXT PRIMARY KEY,
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tenant_id, issuer_did)
);

CREATE TABLE upstream_providers (
  id TEXT PRIMARY KEY,
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
  button_color TEXT,                     -- Brand color for login button (hex)
  button_text TEXT,                      -- Custom button text (optional)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, slug TEXT, token_endpoint_auth_method TEXT DEFAULT 'client_secret_post', always_fetch_userinfo INTEGER DEFAULT 0, use_request_object INTEGER DEFAULT 0, request_object_signing_alg TEXT, private_key_jwk_encrypted TEXT, public_key_jwk TEXT);

CREATE TABLE "user_custom_fields" (
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT,
  field_type TEXT,
  searchable INTEGER DEFAULT 1,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (user_id, field_name),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE "user_roles" (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE "user_token_families" (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  is_revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE TABLE user_verified_attributes (
    id TEXT PRIMARY KEY,
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
    verified_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    -- Each user can have only one value per attribute
    UNIQUE(tenant_id, user_id, attribute_name)
);

CREATE TABLE users (
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
, tenant_id TEXT NOT NULL DEFAULT 'default', user_type TEXT NOT NULL DEFAULT 'end_user', status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked')), suspended_at INTEGER, suspended_until INTEGER, locked_at INTEGER);

CREATE TABLE users_core (
  -- Primary key (UUID, same as users_pii.id)
  id TEXT PRIMARY KEY,

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
, email_domain_hash_version INTEGER DEFAULT 1, external_id TEXT DEFAULT NULL, status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked')), suspended_at INTEGER, suspended_until INTEGER, locked_at INTEGER, locked_until INTEGER);

CREATE TABLE verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Subject this attribute belongs to
  subject_id TEXT NOT NULL,         -- References users(id)
  -- Attribute details
  attribute_name TEXT NOT NULL,     -- 'age_over_18', 'medical_license', 'subscription_tier'
  attribute_value TEXT,             -- 'true', 'MD12345', 'premium'
  -- Source information (for auditing and trust evaluation)
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual', 'vc', 'jwt_sd', 'kyc_provider'
  issuer TEXT,                      -- Issuer DID or URL (Phase 4+)
  credential_id TEXT,               -- VC ID for traceability (Phase 4+)
  -- Validity
  verified_at INTEGER NOT NULL,     -- When the attribute was verified/extracted
  expires_at INTEGER,               -- When the attribute expires (from VC exp)
  revoked_at INTEGER,               -- When the attribute was revoked
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vp_requests (
    id TEXT PRIMARY KEY,
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
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    verified_at TEXT
);

CREATE TABLE webhook_configs (
  id TEXT PRIMARY KEY,
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
);

CREATE TABLE webhook_delivery_logs (
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
);

CREATE TABLE websocket_subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    connection_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    watched_subjects TEXT DEFAULT '[]',        -- JSON array of subject IDs to watch
    watched_resources TEXT DEFAULT '[]',       -- JSON array of resource patterns
    watched_relations TEXT DEFAULT '[]',       -- JSON array of relation types
    connected_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1
);

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX idx_access_review_items_decision ON access_review_items(review_id, decision);

CREATE INDEX idx_access_review_items_review ON access_review_items(review_id);

CREATE INDEX idx_access_review_items_user ON access_review_items(tenant_id, user_id);

CREATE INDEX idx_access_reviews_created ON access_reviews(tenant_id, created_at);

CREATE INDEX idx_access_reviews_due ON access_reviews(tenant_id, due_date);

CREATE INDEX idx_access_reviews_reviewer ON access_reviews(tenant_id, reviewer_id);

CREATE INDEX idx_access_reviews_status ON access_reviews(tenant_id, status);

CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id);

CREATE INDEX idx_admin_jobs_cleanup ON admin_jobs(
  status,
  completed_at
);

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

CREATE INDEX idx_ai_grants_active ON ai_grants(is_active) WHERE is_active = 1;

CREATE INDEX idx_ai_grants_client ON ai_grants(client_id);

CREATE INDEX idx_ai_grants_expires ON ai_grants(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_ai_grants_principal ON ai_grants(ai_principal);

CREATE INDEX idx_ai_grants_tenant ON ai_grants(tenant_id);

CREATE INDEX idx_attribute_verifications_result ON attribute_verifications(verification_result);

CREATE INDEX idx_attribute_verifications_user ON attribute_verifications(tenant_id, user_id);

CREATE INDEX idx_audit_log_action ON audit_log(action);

CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);

CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);

CREATE INDEX idx_audit_log_severity ON audit_log(severity);

CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);

CREATE INDEX idx_check_api_keys_client
    ON check_api_keys(client_id);

CREATE UNIQUE INDEX idx_check_api_keys_hash
    ON check_api_keys(key_hash);

CREATE INDEX idx_check_api_keys_prefix
    ON check_api_keys(key_prefix);

CREATE INDEX idx_check_api_keys_tenant_active
    ON check_api_keys(tenant_id, is_active);

CREATE INDEX idx_ciba_client ON ciba_requests(client_id);

CREATE INDEX idx_ciba_status ON ciba_requests(status);

CREATE INDEX idx_ciba_user ON ciba_requests(user_id);

CREATE INDEX idx_clients_claims_setting ON oauth_clients(allow_claims_without_scope);

CREATE INDEX idx_clients_created_at ON oauth_clients(created_at);

CREATE INDEX idx_clients_software_id_tenant ON oauth_clients(software_id, tenant_id);

CREATE INDEX idx_clients_trusted ON oauth_clients(is_trusted);

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

CREATE INDEX idx_consent_policy_versions_effective
  ON consent_policy_versions(effective_at);

CREATE INDEX idx_consent_policy_versions_tenant
  ON consent_policy_versions(tenant_id, policy_type);

CREATE INDEX idx_consents_client ON oauth_client_consents(client_id);

CREATE INDEX idx_consents_expires_at_active
  ON oauth_client_consents(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_consents_user ON oauth_client_consents(user_id);

CREATE INDEX idx_credential_configurations_tenant ON credential_configurations(tenant_id);

CREATE INDEX idx_credential_offers_code ON credential_offers(pre_authorized_code);

CREATE INDEX idx_credential_offers_status ON credential_offers(tenant_id, status);

CREATE INDEX idx_data_export_expires
  ON data_export_requests(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_data_export_status
  ON data_export_requests(status, requested_at);

CREATE INDEX idx_data_export_user
  ON data_export_requests(user_id, status);

CREATE INDEX idx_device_codes_client_id ON device_codes(client_id);

CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);

CREATE INDEX idx_device_codes_status ON device_codes(status);

CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);

CREATE INDEX idx_did_document_cache_expires ON did_document_cache(expires_at);

CREATE INDEX idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at);

CREATE INDEX idx_external_idp_auth_states_expires_at
  ON external_idp_auth_states(expires_at);

CREATE INDEX idx_external_idp_auth_states_state
  ON external_idp_auth_states(state);

CREATE INDEX idx_flows_builtin ON flows(is_builtin);

CREATE INDEX idx_flows_client ON flows(tenant_id, client_id);

CREATE INDEX idx_flows_lookup ON flows(tenant_id, client_id, profile_id, is_active);

CREATE INDEX idx_flows_profile ON flows(tenant_id, profile_id);

CREATE INDEX idx_flows_tenant ON flows(tenant_id, is_active);

CREATE INDEX idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);

CREATE INDEX idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key);

CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type);

CREATE INDEX idx_issued_credentials_status ON issued_credentials(status);

CREATE INDEX idx_issued_credentials_type ON issued_credentials(credential_type);

CREATE INDEX idx_issued_credentials_user ON issued_credentials(tenant_id, user_id);

CREATE INDEX idx_linked_identities_provider ON linked_identities(provider_id);

CREATE INDEX idx_linked_identities_user ON linked_identities(user_id);

CREATE INDEX idx_membership_org ON subject_org_membership(org_id);

CREATE INDEX idx_membership_subject ON subject_org_membership(subject_id);

CREATE INDEX idx_oauth_clients_tenant_id ON oauth_clients(tenant_id);

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

CREATE INDEX idx_operational_logs_actor
    ON operational_logs(actor_id);

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

CREATE INDEX idx_passkeys_tenant ON passkeys(tenant_id);

CREATE INDEX idx_passkeys_user ON passkeys(user_id);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);

CREATE INDEX idx_pca_api_key
    ON permission_check_audit(api_key_id)
    WHERE api_key_id IS NOT NULL;

CREATE INDEX idx_pca_checked_at
    ON permission_check_audit(checked_at);

CREATE INDEX idx_pca_denied
    ON permission_check_audit(tenant_id, final_decision)
    WHERE final_decision = 'deny';

CREATE INDEX idx_pca_tenant_subject
    ON permission_check_audit(tenant_id, subject_id);

CREATE INDEX idx_pcaudit_event_type
    ON permission_change_audit(tenant_id, event_type);

CREATE INDEX idx_pcaudit_tenant_subject
    ON permission_change_audit(tenant_id, subject_id);

CREATE INDEX idx_pcaudit_timestamp
    ON permission_change_audit(timestamp);

CREATE INDEX idx_policy_rules_priority ON policy_rules(tenant_id, priority DESC);

CREATE INDEX idx_policy_rules_tenant ON policy_rules(tenant_id, enabled);

CREATE INDEX idx_policy_simulations_tenant ON policy_simulations(tenant_id, simulated_at DESC);

CREATE INDEX idx_presentation_definitions_tenant ON presentation_definitions(tenant_id);

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

CREATE INDEX idx_relationships_from ON relationships(from_type, from_id);

CREATE INDEX idx_relationships_tenant_id ON relationships(tenant_id);

CREATE INDEX idx_relationships_to ON relationships(to_type, to_id);

CREATE INDEX idx_relationships_type ON relationships(relationship_type);

CREATE UNIQUE INDEX idx_relationships_unique
  ON relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);

CREATE INDEX idx_role_assignments_role ON role_assignments(role_id);

CREATE INDEX idx_role_assignments_subject ON role_assignments(subject_id);

CREATE INDEX idx_roles_hierarchy_level ON roles(hierarchy_level);

CREATE INDEX idx_roles_name ON roles(name);

CREATE INDEX idx_roles_parent_role_id ON roles(parent_role_id);

CREATE INDEX idx_roles_role_type ON roles(role_type);

CREATE INDEX idx_roles_tenant_id ON roles(tenant_id);

CREATE INDEX idx_rp_expires ON resource_permissions(expires_at)
WHERE expires_at IS NOT NULL;

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

CREATE INDEX idx_schema_migrations_applied_at ON schema_migrations(applied_at DESC);

CREATE INDEX idx_schema_migrations_checksum ON schema_migrations(checksum);

CREATE INDEX idx_scope_mappings_scope ON scope_mappings(scope);

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

CREATE INDEX idx_session_clients_client_id ON session_clients(client_id);

CREATE INDEX idx_session_clients_last_seen_at ON session_clients(last_seen_at);

CREATE INDEX idx_session_clients_session_id ON session_clients(session_id);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);

CREATE INDEX idx_sessions_user ON sessions(user_id);

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

CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id);

CREATE INDEX idx_subject_identifiers_lookup
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

CREATE INDEX idx_subject_identifiers_primary
  ON subject_identifiers(tenant_id, subject_id, is_primary);

CREATE INDEX idx_subject_identifiers_tenant_subject
  ON subject_identifiers(tenant_id, subject_id);

CREATE UNIQUE INDEX idx_subject_identifiers_unique
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

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

CREATE INDEX idx_token_families_client ON user_token_families(client_id);

CREATE INDEX idx_token_families_user ON user_token_families(user_id);

CREATE INDEX idx_trusted_issuers_did ON trusted_issuers(issuer_did);

CREATE INDEX idx_trusted_issuers_tenant ON trusted_issuers(tenant_id);

CREATE INDEX idx_upstream_providers_enabled
  ON upstream_providers(tenant_id, enabled);

CREATE INDEX idx_upstream_providers_tenant_id
  ON upstream_providers(tenant_id);

CREATE UNIQUE INDEX idx_upstream_providers_tenant_name
  ON upstream_providers(tenant_id, name);

CREATE UNIQUE INDEX idx_upstream_providers_tenant_slug
  ON upstream_providers(tenant_id, slug)
  WHERE slug IS NOT NULL;

CREATE INDEX idx_user_verified_attributes_name ON user_verified_attributes(tenant_id, attribute_name);

CREATE INDEX idx_user_verified_attributes_user ON user_verified_attributes(tenant_id, user_id);

CREATE INDEX idx_users_core_active ON users_core(is_active);

CREATE INDEX idx_users_core_email_domain ON users_core(email_domain_hash);

CREATE INDEX idx_users_core_hash_version ON users_core(email_domain_hash_version);

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

CREATE INDEX idx_verified_attributes_expires
  ON verified_attributes(tenant_id, expires_at);

CREATE INDEX idx_verified_attributes_lookup
  ON verified_attributes(tenant_id, subject_id, attribute_name);

CREATE INDEX idx_verified_attributes_source
  ON verified_attributes(tenant_id, source);

CREATE INDEX idx_verified_attributes_tenant_subject
  ON verified_attributes(tenant_id, subject_id);

CREATE INDEX idx_verified_attributes_unique_check
  ON verified_attributes(tenant_id, subject_id, attribute_name, source);

CREATE INDEX idx_vp_requests_nonce ON vp_requests(nonce);

CREATE INDEX idx_vp_requests_tenant_status ON vp_requests(tenant_id, status);

CREATE INDEX idx_webhook_configs_active ON webhook_configs(tenant_id, active) WHERE active = 1;

CREATE INDEX idx_webhook_configs_client ON webhook_configs(tenant_id, client_id);

CREATE INDEX idx_webhook_configs_scope ON webhook_configs(tenant_id, scope);

CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id);

CREATE INDEX idx_webhook_delivery_logs_created ON webhook_delivery_logs(created_at);

CREATE INDEX idx_webhook_delivery_logs_event ON webhook_delivery_logs(event_id);

CREATE INDEX idx_webhook_delivery_logs_tenant ON webhook_delivery_logs(tenant_id);

CREATE INDEX idx_webhook_delivery_logs_webhook ON webhook_delivery_logs(webhook_id);

CREATE INDEX idx_ws_subs_active
    ON websocket_subscriptions(is_active)
    WHERE is_active = 1;

CREATE INDEX idx_ws_subs_connection
    ON websocket_subscriptions(connection_id);

CREATE INDEX idx_ws_subs_subject
    ON websocket_subscriptions(subject_id, is_active);

