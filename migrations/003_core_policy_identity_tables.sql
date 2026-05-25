-- =============================================================================
-- Authrim Core Baseline: Policy and Identity Tables
-- Consolidated baseline for fresh Authrim core database installs.
-- =============================================================================
CREATE TABLE operational_logs (
    id TEXT PRIMARY KEY,
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
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
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
  updated_at INTEGER,
  UNIQUE(tenant_id, name)
);

CREATE TABLE schema_migrations (
  -- Migration version (from filename: 001_core_foundation.sql -> version = 1)
  version INTEGER PRIMARY KEY,

  -- Human-readable migration name (from filename: 001_core_foundation.sql -> name = "core_foundation")
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
  created_at INTEGER NOT NULL, tenant_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, claim_name)
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
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_token_at INTEGER NOT NULL,
  last_token_at INTEGER NOT NULL,
  last_seen_at INTEGER,

  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,

  UNIQUE (tenant_id, session_id, client_id)
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

CREATE TABLE profile_registry (
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('storage', 'audit', 'residency')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (kind, id)
);

CREATE TABLE status_lists (
    internal_id TEXT PRIMARY KEY,
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

CREATE TABLE tenant_consent_requirements (
  id TEXT PRIMARY KEY,
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
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(tenant_id, issuer_did)
);
