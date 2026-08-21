-- Authrim 0.4.0 pre-1.0 semantic fresh-install baseline.
-- Logical stream: d1-admin.
-- Generated from the final database state; do not append historical migration SQL here.
-- Pre-1.0 databases are not upgrade-compatible and must be recreated.
PRAGMA foreign_keys = OFF;

CREATE TABLE admin_users (
  -- Primary key (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_sessions (
  -- Session ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_passkeys (
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
);
CREATE TABLE admin_roles (
  -- Role ID (UUID v4)
  id TEXT PRIMARY KEY,

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
INSERT INTO admin_roles VALUES('role_super_admin','default','super_admin','Super Administrator','Full system access - all permissions granted','["*"]',100,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_security_admin','default','security_admin','Security Administrator','Security settings, audit logs, IP restrictions','["admin:audit:*", "admin:security:*", "admin:ip_allowlist:*", "admin:sessions:read", "admin:sessions:revoke", "admin:users:read"]',90,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_admin','default','admin','Administrator','User and client management, basic operations','["admin:users:*", "admin:clients:*", "admin:scopes:*", "admin:roles:read", "admin:settings:read", "admin:audit:read"]',80,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_support','default','support','Support','Read access with limited write for support tasks','["admin:users:read", "admin:users:unlock", "admin:sessions:read", "admin:sessions:revoke", "admin:clients:read", "admin:audit:read"]',40,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_viewer','default','viewer','Viewer','Read-only access to admin dashboard','["admin:users:read", "admin:clients:read", "admin:roles:read", "admin:settings:read"]',20,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_storage_destination_viewer','default','storage_destination_viewer','Storage Destination Viewer','View tenant storage destinations and usage without credential management privileges.','["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:usage:read"]',32,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_storage_destination_admin','default','storage_destination_admin','Storage Destination Admin','Manage tenant storage destinations and allow feature owners to select approved destinations.','["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:create","admin:storage_destinations:update","admin:storage_destinations:delete","admin:storage_destinations:credentials:write","admin:storage_destinations:test","admin:storage_destinations:usage:read","admin:diagnostic_logging:destination:select","admin:jobs:destination:select","admin:dr_backup:destination:select"]',55,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_platform_database_viewer','default','platform_database_viewer','Platform Database Viewer','View platform database connections and routing state without changing runtime storage.','["admin:database_connections:list","admin:database_connections:read","admin:database_connections:test","admin:database_routing:read"]',60,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_platform_database_admin','default','platform_database_admin','Platform Database Admin','Manage platform database connections and perform controlled database routing changes.','["admin:database_connections:list","admin:database_connections:read","admin:database_connections:create","admin:database_connections:update","admin:database_connections:delete","admin:database_connections:credentials:write","admin:database_connections:test","admin:database_routing:read","admin:database_routing:write","admin:database_routing:switch","admin:database_routing:rollback"]',85,'builtin',0,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
CREATE TABLE admin_role_assignments (
  -- Assignment ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_audit_log (
  -- Audit entry ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_ip_allowlist (
  -- Entry ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_login_attempts (
  -- Attempt ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_attributes (
  -- Attribute ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_attribute_values (
  -- Value assignment ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_relationships (
  -- Relationship ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_policies (
  -- Policy ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_setup_tokens (
  -- Token ID (the actual token value, UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_rebac_definitions (
  -- Definition ID (UUID v4)
  id TEXT PRIMARY KEY,

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
CREATE TABLE admin_storage_destinations (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_storage_destination_usages (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_database_connections (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_database_connection_usages (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_machine_principals (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_machine_credentials (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_machine_credential_permissions (
  credential_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (credential_id, permission),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
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
CREATE TABLE admin_machine_resource_scopes (
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
CREATE TABLE admin_external_token_refresh_runs (
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
CREATE TABLE tenant_database_migration_state (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  migration_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'applied', 'failed', 'skipped')
  ),
  started_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    tenant_id,
    role,
    generation,
    shard_group,
    shard_index,
    migration_version
  )
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
CREATE TABLE internal_notification_delivery_routes (
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
CREATE TABLE internal_notification_delivery_attempts (
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
CREATE TABLE tenant_database_migration_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_storage_profile_id TEXT NOT NULL,
  target_storage_profile_id TEXT NOT NULL,
  migration_method TEXT NOT NULL CHECK (
    migration_method IN (
      'export_import',
      'batch_copy',
      'dual_write_read_compare',
      'cdc_style'
    )
  ),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (
    status IN (
      'requested',
      'approved',
      'preparing',
      'validating',
      'ready_for_cutover',
      'cutting_over',
      'completed',
      'failed',
      'rolled_back'
    )
  ),
  write_policy TEXT NOT NULL DEFAULT 'maintenance_read_only' CHECK (
    write_policy IN (
      'maintenance_read_only',
      'affected_data_class_freeze',
      'online_dual_write'
    )
  ),
  source_of_truth TEXT NOT NULL DEFAULT 'source_before_cutover' CHECK (
    source_of_truth IN (
      'source_before_cutover',
      'target_after_cutover'
    )
  ),
  scheduled_window_not_before TEXT,
  scheduled_window_not_after TEXT,
  validation_policy_json TEXT,
  validation_result_json TEXT,
  cache_cutover_generation INTEGER,
  rollback_plan_json TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'system_admin_break_glass' CHECK (
    approval_mode IN (
      'system_admin_break_glass',
      'two_person_approval',
      'storage_operator_approval'
    )
  ),
  dangerous_operation_confirmation TEXT,
  break_glass_reason TEXT,
  impact_summary_json TEXT,
  two_person_approval_required INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  approved_by TEXT,
  started_at TEXT,
  cutover_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tenant_database_migration_job_targets (
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  source_generation INTEGER,
  target_generation INTEGER,
  source_schema_version INTEGER,
  target_schema_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'copying',
      'validating',
      'ready_for_cutover',
      'cutting_over',
      'completed',
      'failed',
      'rolled_back'
    )
  ),
  row_count_source INTEGER,
  row_count_target INTEGER,
  checksum_sample_json TEXT,
  validation_result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, tenant_id, role, shard_group, shard_index),
  FOREIGN KEY (job_id) REFERENCES tenant_database_migration_jobs(id) ON DELETE CASCADE
);
CREATE TABLE admin_jobs (
  id TEXT PRIMARY KEY,
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
CREATE TABLE tenant_database_slots (
  slot_id TEXT PRIMARY KEY,
  slot_number INTEGER NOT NULL UNIQUE,
  core_binding_ref TEXT NOT NULL UNIQUE,
  pii_binding_ref TEXT NOT NULL UNIQUE,
  core_database_name TEXT NOT NULL,
  pii_database_name TEXT NOT NULL,
  core_database_id TEXT NOT NULL,
  pii_database_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'available',
      'reserved',
      'assigned',
      'pending_binding',
      'unavailable',
      'reset_required',
      'retired'
    )
  ),
  assigned_tenant_id TEXT,
  reserved_by TEXT,
  reserved_at INTEGER,
  assigned_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE tenant_database_slot_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  slot_id TEXT,
  stage TEXT NOT NULL,
  actor TEXT,
  result TEXT NOT NULL CHECK (result IN ('started', 'succeeded', 'failed', 'skipped')),
  error_code TEXT,
  request_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE admin_destinations (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_destination_capabilities (
  destination_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider_default', 'platform_override')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (destination_id, capability)
);
CREATE TABLE admin_destination_health_events (
  id TEXT PRIMARY KEY,
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
CREATE TABLE credential_secret_metadata (
  credential_ref TEXT PRIMARY KEY,
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
CREATE TABLE credential_secret_bodies (
  credential_ref TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE logging_fallback_policies (
  id TEXT PRIMARY KEY,
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
CREATE TABLE storage_destination_assignments (
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
);
CREATE TABLE logging_destination_overrides (
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_destination_override_history (
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
);
CREATE TABLE logging_policy_snapshots (
  id TEXT PRIMARY KEY,
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
CREATE TABLE log_object_catalog (
  id TEXT PRIMARY KEY,
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
CREATE TABLE log_chunk_manifests (
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
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE logging_delivery_events (
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_usage_aggregates (
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_quota_policies (
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_quota_evaluations (
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
CREATE TABLE tenant_database_probe_results (
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
CREATE TABLE logging_dlq_items (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_key_registry (
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_key_material_bodies (
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
);
CREATE TABLE logging_rewrap_jobs (
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_catalog_repair_jobs (
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
CREATE TABLE admin_audit_coverage_status (
  operation_id TEXT PRIMARY KEY,
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
CREATE TABLE admin_logging_critical_policies (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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
  deleted_at INTEGER
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
CREATE TABLE logging_message_export_builds (
  id TEXT PRIMARY KEY,
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
CREATE TABLE logging_message_repair_findings (
  id TEXT PRIMARY KEY,
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
CREATE TABLE field_mapping_sets (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_rules (
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_rule_edges (
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_transform_steps (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_release_rules (
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_conflict_rules (
  id TEXT PRIMARY KEY,
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
CREATE TABLE field_mapping_activations (
  id TEXT PRIMARY KEY,
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
CREATE TABLE compiled_mapping_snapshots (
  id TEXT PRIMARY KEY,
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
CREATE TABLE field_catalogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_key)
);
CREATE TABLE field_catalog_versions (
  id TEXT PRIMARY KEY,
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
CREATE TABLE field_catalog_entries (
  id TEXT PRIMARY KEY,
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
CREATE TABLE custom_field_catalog_entries (
  id TEXT PRIMARY KEY,
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
CREATE TABLE protocol_schema_catalogs (
  id TEXT PRIMARY KEY,
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
CREATE TABLE external_schema_catalogs (
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_templates (
  id TEXT PRIMARY KEY,
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
CREATE TABLE source_authority_contracts (
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_events (
  id TEXT PRIMARY KEY,
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
CREATE TABLE projection_outbox (
  id TEXT PRIMARY KEY,
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
CREATE TABLE projection_jobs (
  id TEXT PRIMARY KEY,
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
CREATE TABLE replay_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  replay_type TEXT NOT NULL,
  impact_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  result_summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE dependency_graph_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_mapping_version_id TEXT,
  snapshot_hash TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE admin_search_projections (
  id TEXT PRIMARY KEY,
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
CREATE TABLE review_tasks (
  id TEXT PRIMARY KEY,
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
CREATE TABLE review_task_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
);
CREATE TABLE operational_notification_states (
  id TEXT PRIMARY KEY,
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
CREATE TABLE mapping_activation_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  lease_key TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lease_key)
);
CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
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
CREATE TABLE key_registries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_purpose TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  active_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE key_versions (
  id TEXT PRIMARY KEY,
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
CREATE TABLE key_material_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_version_id TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  material_ref TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (key_version_id) REFERENCES key_versions(id) ON DELETE CASCADE
);
CREATE TABLE key_access_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  key_version_id TEXT,
  actor_id TEXT,
  access_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE blind_index_rotation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE rewrap_jobs (
  id TEXT PRIMARY KEY,
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
CREATE TABLE recovery_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  recovery_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  manifest_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE recovery_set_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  recovery_set_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  checksum TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (recovery_set_id) REFERENCES recovery_sets(id) ON DELETE CASCADE
);
CREATE TABLE restore_validation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  recovery_set_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE quota_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  artifact_class TEXT NOT NULL,
  quota_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, artifact_class)
);
CREATE TABLE quota_usage_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  artifact_class TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE retention_cleanup_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  retention_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_trust_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  protocol_payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, source_type, source_key)
);
CREATE TABLE federation_trust_anchors (
  id TEXT PRIMARY KEY,
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
CREATE TABLE federation_metadata_documents (
  id TEXT PRIMARY KEY,
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
CREATE TABLE federation_entity_statements (
  id TEXT PRIMARY KEY,
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
CREATE TABLE federation_trust_chains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  subject TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  chain_json TEXT,
  validation_state TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_metadata_refresh_jobs (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  metadata_document_id TEXT,
  validation_state TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE federation_trust_context_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  trust_context_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE TABLE federation_trust_rank_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  rank_model_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);
CREATE TABLE federation_trust_fail_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_key TEXT NOT NULL,
  state_policy_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_key)
);
CREATE TABLE federation_trust_scope_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE federation_metadata_entity_summaries (
  id TEXT PRIMARY KEY,
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
CREATE TABLE federation_selected_entity_import_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  metadata_entity_summary_id TEXT,
  provider_id TEXT,
  import_action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE source_profiles (
  id TEXT PRIMARY KEY,
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
CREATE TABLE source_profile_versions (
  id TEXT PRIMARY KEY,
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
CREATE TABLE source_profile_parse_drafts (
  id TEXT PRIMARY KEY,
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
CREATE TABLE destination_profiles (
  id TEXT PRIMARY KEY,
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
CREATE TABLE destination_profile_versions (
  id TEXT PRIMARY KEY,
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
CREATE TABLE attribute_group_registry (
  id TEXT PRIMARY KEY,
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
CREATE TABLE attribute_field_registry (
  id TEXT PRIMARY KEY,
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
CREATE TABLE persistent_identifier_profiles (
  id TEXT PRIMARY KEY,
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
CREATE TABLE persistent_identifier_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  audience_key TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  value_source TEXT NOT NULL DEFAULT 'imported',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_id, subject_key, audience_key),
  FOREIGN KEY (profile_id) REFERENCES persistent_identifier_profiles(id) ON DELETE CASCADE
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
      'directory_auth_evidence_export',
      'directory_auth_support_bundle',
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
CREATE TABLE IF NOT EXISTS "approval_requests" (
  id TEXT PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS "approval_request_approvals" (
  id TEXT PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS "elevation_grants" (
  id TEXT PRIMARY KEY,
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
CREATE TABLE credential_profiles (
  id TEXT PRIMARY KEY,
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
CREATE TABLE credential_profile_versions (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_agent_grants (
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
CREATE TABLE agent_consents (
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
CREATE TABLE agent_elevation_challenges (
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
CREATE TABLE admin_agent_delegation_jtis (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  machine_principal_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id)
);
CREATE TABLE admin_agent_token_families (
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
  updated_at INTEGER NOT NULL, revocation_outbox_id TEXT,
  FOREIGN KEY (grant_id) REFERENCES admin_agent_grants(id),
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),
  CHECK (expires_at > created_at)
);
CREATE TABLE admin_agent_token_revocation_outbox (
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
CREATE TABLE agent_task_sets (
  id TEXT PRIMARY KEY,
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
CREATE TABLE agent_scope_policies (
  id TEXT PRIMARY KEY,
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
CREATE TABLE agent_plan_confirmations (
  id TEXT PRIMARY KEY,
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
CREATE TABLE agent_secret_refs (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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
CREATE TABLE agent_template_copies (
  id TEXT PRIMARY KEY,
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
CREATE TABLE agent_baseline_assignments (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(assignment_id) REFERENCES agent_baseline_assignments(id)
);
CREATE TABLE admin_agent_login_handoffs (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_invitations (
  id TEXT PRIMARY KEY,
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
CREATE TABLE admin_invitation_enrollments (
  token_hash TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(phase IN ('redeemed', 'registration', 'authentication'))
);
CREATE TABLE admin_agent_mcp_sessions (
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
);
CREATE TABLE IF NOT EXISTS "internal_notification_events" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
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
CREATE TABLE provider_reprojection_jobs (
  job_id TEXT PRIMARY KEY,
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
CREATE TABLE tenant_provisioning_operations (
  operation_id TEXT PRIMARY KEY,
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
CREATE TABLE tenant_placement_migration_jobs (
  operation_id TEXT PRIMARY KEY,
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
CREATE TABLE logging_message_jobs (
  id TEXT PRIMARY KEY,
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
CREATE TRIGGER trg_tenant_provisioning_placement_policy_immutable
BEFORE UPDATE OF isolation_policy ON tenant_provisioning_operations
BEGIN
  SELECT RAISE(ABORT, 'tenant_provisioning_placement_policy_immutable');
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
CREATE INDEX idx_admin_users_tenant_email ON admin_users(tenant_id, email);
CREATE INDEX idx_admin_users_active ON admin_users(tenant_id, is_active);
CREATE INDEX idx_admin_users_status ON admin_users(tenant_id, status);
CREATE INDEX idx_admin_users_last_login ON admin_users(last_login_at);
CREATE INDEX idx_admin_sessions_user ON admin_sessions(admin_user_id);
CREATE INDEX idx_admin_sessions_tenant ON admin_sessions(tenant_id);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX idx_admin_sessions_activity ON admin_sessions(last_activity_at);
CREATE INDEX idx_admin_passkeys_user ON admin_passkeys(admin_user_id);
CREATE INDEX idx_admin_passkeys_credential ON admin_passkeys(credential_id);
CREATE INDEX idx_admin_roles_tenant ON admin_roles(tenant_id);
CREATE INDEX idx_admin_roles_name ON admin_roles(tenant_id, name);
CREATE INDEX idx_admin_roles_type ON admin_roles(role_type);
CREATE INDEX idx_admin_roles_hierarchy ON admin_roles(hierarchy_level);
CREATE INDEX idx_admin_role_assignments_user ON admin_role_assignments(admin_user_id);
CREATE INDEX idx_admin_role_assignments_role ON admin_role_assignments(admin_role_id);
CREATE INDEX idx_admin_role_assignments_tenant ON admin_role_assignments(tenant_id);
CREATE INDEX idx_admin_role_assignments_scope ON admin_role_assignments(scope_type, scope_id);
CREATE INDEX idx_admin_role_assignments_expires ON admin_role_assignments(expires_at);
CREATE INDEX idx_admin_audit_log_tenant_time ON admin_audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_user ON admin_audit_log(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_action ON admin_audit_log(action, created_at DESC);
CREATE INDEX idx_admin_audit_log_resource ON admin_audit_log(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_request ON admin_audit_log(request_id);
CREATE INDEX idx_admin_ip_allowlist_tenant ON admin_ip_allowlist(tenant_id, enabled);
CREATE INDEX idx_admin_ip_allowlist_version ON admin_ip_allowlist(tenant_id, ip_version, enabled);
CREATE INDEX idx_admin_ip_allowlist_enabled ON admin_ip_allowlist(enabled, tenant_id);
CREATE INDEX idx_admin_login_attempts_email ON admin_login_attempts(tenant_id, email, created_at DESC);
CREATE INDEX idx_admin_login_attempts_ip ON admin_login_attempts(ip_address, created_at DESC);
CREATE INDEX idx_admin_login_attempts_time ON admin_login_attempts(created_at);
CREATE INDEX idx_admin_login_attempts_success ON admin_login_attempts(success, created_at DESC);
CREATE INDEX idx_admin_attributes_tenant ON admin_attributes(tenant_id);
CREATE INDEX idx_admin_attributes_name ON admin_attributes(tenant_id, name);
CREATE INDEX idx_admin_attributes_type ON admin_attributes(attribute_type);
CREATE INDEX idx_admin_attr_values_user ON admin_attribute_values(admin_user_id);
CREATE INDEX idx_admin_attr_values_attr ON admin_attribute_values(admin_attribute_id);
CREATE INDEX idx_admin_attr_values_tenant ON admin_attribute_values(tenant_id);
CREATE INDEX idx_admin_attr_values_expires ON admin_attribute_values(expires_at);
CREATE INDEX idx_admin_attr_values_lookup
  ON admin_attribute_values(admin_user_id, admin_attribute_id, value);
CREATE INDEX idx_admin_rel_tenant ON admin_relationships(tenant_id);
CREATE INDEX idx_admin_rel_from ON admin_relationships(from_type, from_id);
CREATE INDEX idx_admin_rel_to ON admin_relationships(to_type, to_id);
CREATE INDEX idx_admin_rel_type ON admin_relationships(relationship_type);
CREATE INDEX idx_admin_rel_expires ON admin_relationships(expires_at);
CREATE UNIQUE INDEX idx_admin_rel_unique
  ON admin_relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);
CREATE INDEX idx_admin_policies_tenant ON admin_policies(tenant_id);
CREATE INDEX idx_admin_policies_name ON admin_policies(tenant_id, name);
CREATE INDEX idx_admin_policies_resource ON admin_policies(resource_pattern);
CREATE INDEX idx_admin_policies_active ON admin_policies(is_active);
CREATE INDEX idx_admin_policies_priority ON admin_policies(priority DESC);
CREATE INDEX idx_admin_setup_tokens_user ON admin_setup_tokens(admin_user_id);
CREATE INDEX idx_admin_setup_tokens_tenant ON admin_setup_tokens(tenant_id);
CREATE INDEX idx_admin_setup_tokens_status ON admin_setup_tokens(status);
CREATE INDEX idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at);
CREATE INDEX idx_admin_roles_inherits ON admin_roles(inherits_from);
CREATE INDEX idx_admin_rebac_def_tenant ON admin_rebac_definitions(tenant_id);
CREATE INDEX idx_admin_rebac_def_name ON admin_rebac_definitions(tenant_id, relation_name);
CREATE INDEX idx_admin_audit_log_detail_object_catalog
  ON admin_audit_log(detail_object_catalog_id);
CREATE INDEX idx_admin_storage_destinations_scope
  ON admin_storage_destinations(scope_type, scope_id, is_active, name);
CREATE INDEX idx_admin_storage_destinations_provider
  ON admin_storage_destinations(provider, status);
CREATE INDEX idx_admin_storage_destination_usages_destination
  ON admin_storage_destination_usages(destination_id, is_active);
CREATE INDEX idx_admin_storage_destination_usages_feature
  ON admin_storage_destination_usages(tenant_id, feature, is_active);
CREATE INDEX idx_admin_database_connections_provider
  ON admin_database_connections(provider, status, is_active);
CREATE INDEX idx_admin_database_connection_usages_connection
  ON admin_database_connection_usages(connection_id, is_active);
CREATE INDEX idx_admin_machine_principals_status
  ON admin_machine_principals(status);
CREATE INDEX idx_admin_machine_credentials_principal
  ON admin_machine_credentials(principal_id);
CREATE INDEX idx_admin_machine_credentials_status
  ON admin_machine_credentials(status);
CREATE INDEX idx_admin_machine_principal_tenant_scopes_principal
  ON admin_machine_principal_tenant_scopes(principal_id);
CREATE INDEX idx_admin_machine_credential_tenant_scopes_credential
  ON admin_machine_credential_tenant_scopes(credential_id);
CREATE INDEX idx_admin_machine_resource_scopes_principal
  ON admin_machine_resource_scopes(principal_id);
CREATE INDEX idx_admin_machine_resource_scopes_credential
  ON admin_machine_resource_scopes(credential_id);
CREATE INDEX idx_admin_machine_assertion_jti_expires
  ON admin_machine_assertion_jti(expires_at);
CREATE INDEX idx_external_token_refresh_runs_started
  ON admin_external_token_refresh_runs(started_at DESC);
CREATE INDEX idx_external_token_refresh_runs_requested_tenant
  ON admin_external_token_refresh_runs(requested_tenant_id, started_at DESC);
CREATE INDEX idx_external_token_refresh_tenant_runs_tenant
  ON admin_external_token_refresh_tenant_runs(tenant_id, completed_at DESC);
CREATE INDEX idx_tenant_database_registry_status
  ON tenant_database_registry(status, provider, role);
CREATE INDEX idx_tenant_database_registry_binding_ref
  ON tenant_database_registry(binding_ref);
CREATE INDEX idx_tenant_database_registry_deployment_target
  ON tenant_database_registry(deployment_target, worker_shard);
CREATE INDEX idx_tenant_database_active_pointers_generation
  ON tenant_database_active_pointers(tenant_id, generation);
CREATE INDEX idx_tenant_database_migration_state_status
  ON tenant_database_migration_state(status, role, migration_version);
CREATE INDEX idx_tenant_database_stats_warning
  ON tenant_database_stats(warning_state, role);
CREATE INDEX idx_tenant_database_stats_checked_at
  ON tenant_database_stats(stats_checked_at);
CREATE INDEX idx_tenant_discovery_indexes_subject
  ON tenant_discovery_indexes(tenant_id, subject_id, index_kind);
CREATE INDEX idx_tenant_discovery_indexes_freshness
  ON tenant_discovery_indexes(status, indexed_at, source_updated_at);
CREATE INDEX idx_internal_notification_delivery_routes_lookup
  ON internal_notification_delivery_routes(scope_type, scope_id, enabled, provider);
CREATE INDEX idx_internal_notification_delivery_attempts_event
  ON internal_notification_delivery_attempts(event_id, provider, status);
CREATE INDEX idx_internal_notification_delivery_attempts_retry
  ON internal_notification_delivery_attempts(status, next_attempt_at, updated_at);
CREATE INDEX idx_tenant_database_migration_jobs_tenant_status
  ON tenant_database_migration_jobs(tenant_id, status, created_at DESC);
CREATE INDEX idx_tenant_database_migration_jobs_status_window
  ON tenant_database_migration_jobs(status, scheduled_window_not_before, scheduled_window_not_after);
CREATE INDEX idx_tenant_database_migration_job_targets_status
  ON tenant_database_migration_job_targets(status, role);
CREATE INDEX idx_admin_jobs_cleanup
  ON admin_jobs(status, completed_at);
CREATE INDEX idx_admin_jobs_status
  ON admin_jobs(tenant_id, status, created_at DESC);
CREATE INDEX idx_admin_jobs_tenant
  ON admin_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_admin_jobs_type
  ON admin_jobs(tenant_id, job_type, created_at DESC);
CREATE INDEX idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);
CREATE INDEX idx_admin_jobs_next_run
  ON admin_jobs(status, next_run_at, updated_at);
CREATE INDEX idx_tenant_database_slots_state
  ON tenant_database_slots(state, slot_number);
CREATE INDEX idx_tenant_database_slots_assigned_tenant
  ON tenant_database_slots(assigned_tenant_id);
CREATE INDEX idx_tenant_database_slot_audit_tenant
  ON tenant_database_slot_audit_events(tenant_id, created_at);
CREATE INDEX idx_tenant_database_slot_audit_slot
  ON tenant_database_slot_audit_events(slot_id, created_at);
CREATE INDEX idx_admin_destinations_scope_name_active
  ON admin_destinations(scope_type, scope_id, name, deleted_at);
CREATE INDEX idx_admin_destinations_scope_status
  ON admin_destinations(scope_type, scope_id, lifecycle_status);
CREATE INDEX idx_admin_destinations_kind_provider
  ON admin_destinations(destination_kind, provider);
CREATE INDEX idx_admin_destinations_health
  ON admin_destinations(health_status, last_health_check_at);
CREATE INDEX idx_admin_destination_capabilities_lookup
  ON admin_destination_capabilities(capability, enabled);
CREATE INDEX idx_admin_destination_health_events_destination
  ON admin_destination_health_events(destination_id, checked_at);
CREATE INDEX idx_admin_destination_health_events_status
  ON admin_destination_health_events(next_health_status, checked_at);
CREATE INDEX idx_credential_secret_metadata_destination
  ON credential_secret_metadata(destination_id, status, version);
CREATE INDEX idx_credential_secret_bodies_destination
  ON credential_secret_bodies(destination_id, version);
CREATE UNIQUE INDEX idx_logging_fallback_policies_scope
  ON logging_fallback_policies(scope_type, scope_id, log_type, plane);
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
CREATE INDEX idx_logging_destination_overrides_effective
  ON logging_destination_overrides(COALESCE(tenant_id, 'platform'), log_type, plane, enabled);
CREATE INDEX idx_logging_destination_overrides_destination
  ON logging_destination_overrides(destination_id, enabled, updated_at);
CREATE INDEX idx_logging_destination_override_history_override
  ON logging_destination_override_history(override_id, changed_at);
CREATE INDEX idx_logging_destination_override_history_scope
  ON logging_destination_override_history(COALESCE(tenant_id, 'platform'), log_type, plane, changed_at);
CREATE UNIQUE INDEX idx_logging_policy_snapshots_scope_version
  ON logging_policy_snapshots(scope_type, scope_id, version);
CREATE INDEX idx_logging_policy_snapshots_status
  ON logging_policy_snapshots(scope_type, scope_id, status, version);
CREATE UNIQUE INDEX idx_log_object_catalog_object_key
  ON log_object_catalog(object_key);
CREATE INDEX idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at);
CREATE INDEX idx_log_object_catalog_status
  ON log_object_catalog(status, created_at);
CREATE INDEX idx_log_chunk_record_index_time
  ON log_chunk_record_index(tenant_key, log_type, plane, event_at);
CREATE INDEX idx_log_chunk_record_index_object
  ON log_chunk_record_index(object_catalog_id);
CREATE INDEX idx_log_chunk_record_index_status
  ON log_chunk_record_index(status, created_at);
CREATE UNIQUE INDEX idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);
CREATE INDEX idx_logging_delivery_events_tenant_status
  ON logging_delivery_events(tenant_key, status, created_at);
CREATE INDEX idx_logging_delivery_events_destination
  ON logging_delivery_events(destination_id, status, created_at);
CREATE INDEX idx_logging_delivery_event_aggregates_summary
  ON logging_delivery_event_aggregates(bucket_start_at, bucket_shard, lane, status);
CREATE INDEX idx_logging_delivery_event_aggregates_tenant
  ON logging_delivery_event_aggregates(tenant_key, bucket_start_at, bucket_shard, lane, status);
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
CREATE INDEX idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind);
CREATE INDEX idx_logging_quota_evaluations_policy_time
  ON logging_quota_evaluations(quota_policy_id, evaluated_at DESC);
CREATE INDEX idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC);
CREATE INDEX idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC);
CREATE INDEX idx_tenant_database_probe_results_status
  ON tenant_database_probe_results(status, created_at DESC);
CREATE INDEX idx_logging_dlq_items_tenant_status
  ON logging_dlq_items(tenant_key, status, created_at);
CREATE INDEX idx_logging_dlq_items_lane_status
  ON logging_dlq_items(lane, status, created_at);
CREATE INDEX idx_logging_export_jobs_status
  ON logging_export_jobs(status, created_at);
CREATE INDEX idx_logging_export_jobs_tenant
  ON logging_export_jobs(tenant_key, created_at);
CREATE UNIQUE INDEX idx_logging_key_registry_scope
  ON logging_key_registry(tenant_key, COALESCE(surface, ''), log_type, plane);
CREATE INDEX idx_logging_key_registry_status
  ON logging_key_registry(status, updated_at);
CREATE INDEX idx_logging_key_versions_status
  ON logging_key_versions(status, created_at);
CREATE INDEX idx_logging_key_material_bodies_scope
  ON logging_key_material_bodies(tenant_key, COALESCE(surface, ''), log_type, plane, version);
CREATE INDEX idx_logging_rewrap_jobs_queue
  ON logging_rewrap_jobs(status, priority, created_at);
CREATE INDEX idx_logging_rewrap_jobs_registry
  ON logging_rewrap_jobs(key_registry_id, status);
CREATE INDEX idx_logging_catalog_repair_jobs_queue
  ON logging_catalog_repair_jobs(status, created_at);
CREATE INDEX idx_logging_catalog_repair_jobs_scope
  ON logging_catalog_repair_jobs(COALESCE(tenant_key, ''), COALESCE(log_type, ''), COALESCE(plane, ''), created_at DESC);
CREATE INDEX idx_admin_audit_coverage_status_state
  ON admin_audit_coverage_status(status, criticality, updated_at);
CREATE INDEX idx_admin_logging_critical_policies_status
  ON admin_logging_critical_policies(status, updated_at);
CREATE INDEX idx_admin_logging_critical_policies_destination
  ON admin_logging_critical_policies(destination_id, status);
CREATE INDEX idx_admin_logging_sensitive_detail_policy_scope
  ON admin_logging_sensitive_detail_policies(log_type, plane, deleted_at);
CREATE INDEX idx_admin_logging_sensitive_detail_policy_status
  ON admin_logging_sensitive_detail_policies(status, updated_at);
CREATE INDEX idx_sensitive_detail_chunk_index_tenant_class
  ON sensitive_detail_chunk_index(tenant_id, object_class, created_at);
CREATE INDEX idx_sensitive_detail_chunk_index_object
  ON sensitive_detail_chunk_index(object_key, line_number);
CREATE INDEX idx_logging_message_idempotency_expiry
  ON logging_message_idempotency_keys(status, dedupe_until);
CREATE INDEX idx_logging_message_idempotency_job
  ON logging_message_idempotency_keys(message_job_id);
CREATE INDEX idx_logging_message_export_builds_job
  ON logging_message_export_builds(message_job_id, phase, partition_index);
CREATE INDEX idx_logging_message_export_builds_export
  ON logging_message_export_builds(export_job_id, phase, partition_index);
CREATE INDEX idx_logging_message_repair_findings_status
  ON logging_message_repair_findings(status, severity, detected_at);
CREATE INDEX idx_logging_message_repair_findings_job
  ON logging_message_repair_findings(message_job_id, status);
CREATE INDEX idx_field_mapping_versions_state
  ON field_mapping_versions(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_compiled_mapping_snapshots_state
  ON compiled_mapping_snapshots(tenant_id, lifecycle_state, activated_at);
CREATE INDEX idx_source_profiles_type_state
  ON source_profiles(tenant_id, source_type, lifecycle_state, updated_at);
CREATE INDEX idx_source_profile_versions_state
  ON source_profile_versions(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_source_profile_parse_drafts_expiry
  ON source_profile_parse_drafts(tenant_id, expires_at);
CREATE INDEX idx_destination_profiles_type_state
  ON destination_profiles(tenant_id, destination_type, lifecycle_state, updated_at);
CREATE INDEX idx_destination_profiles_owner
  ON destination_profiles(owner_scope_type, owner_scope_id, destination_type);
CREATE UNIQUE INDEX ux_destination_profiles_scope_key
  ON destination_profiles(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    destination_type,
    profile_key
  );
CREATE INDEX idx_destination_profile_versions_state
  ON destination_profile_versions(tenant_id, lifecycle_state, updated_at);
CREATE UNIQUE INDEX ux_destination_profile_versions_label
  ON destination_profile_versions(tenant_id, profile_id, version_label);
CREATE UNIQUE INDEX ux_attribute_group_registry_key
  ON attribute_group_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    protocol,
    group_type,
    group_key
  );
CREATE UNIQUE INDEX ux_attribute_field_registry_key
  ON attribute_field_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    protocol,
    field_key
  );
CREATE INDEX idx_persistent_identifier_profiles_tenant_state
  ON persistent_identifier_profiles(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_persistent_identifier_values_lookup
  ON persistent_identifier_values(tenant_id, profile_id, subject_key, audience_key);
CREATE INDEX idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC);
CREATE INDEX idx_object_catalog_deleted_at
  ON object_catalog(deleted_at);
CREATE INDEX idx_object_catalog_objects_catalog_repr
  ON object_catalog_objects(catalog_id, representation, object_index);
CREATE INDEX idx_object_catalog_objects_bucket_key
  ON object_catalog_objects(bucket_binding, object_key);
CREATE INDEX idx_object_catalog_objects_deleted_at
  ON object_catalog_objects(deleted_at);
CREATE INDEX idx_approval_requests_tenant_status_requested
  ON approval_requests(tenant_id, status, requested_at DESC);
CREATE INDEX idx_approval_requests_investigation
  ON approval_requests(investigation_id, created_at DESC);
CREATE INDEX idx_approval_requests_requester
  ON approval_requests(requester_subject_type, requester_subject_id, created_at DESC);
CREATE INDEX idx_approval_requests_target
  ON approval_requests(target_subject_type, target_subject_id, created_at DESC);
CREATE INDEX idx_approval_requests_expires
  ON approval_requests(expires_at);
CREATE INDEX idx_approval_requests_detail_object_catalog
  ON approval_requests(detail_object_catalog_id);
CREATE UNIQUE INDEX idx_approval_request_approvals_unique_subject
  ON approval_request_approvals(
    approval_request_id,
    step_key,
    subject_type,
    COALESCE(subject_id, '')
  );
CREATE INDEX idx_approval_request_approvals_request_status
  ON approval_request_approvals(approval_request_id, status, created_at ASC);
CREATE INDEX idx_approval_request_approvals_subject
  ON approval_request_approvals(subject_type, subject_id, created_at DESC);
CREATE INDEX idx_approval_request_approvals_expires
  ON approval_request_approvals(expires_at);
CREATE INDEX idx_elevation_grants_tenant_status_issued
  ON elevation_grants(tenant_id, status, issued_at DESC);
CREATE INDEX idx_elevation_grants_request
  ON elevation_grants(approval_request_id, issued_at DESC);
CREATE INDEX idx_elevation_grants_actor
  ON elevation_grants(actor_subject_type, actor_subject_id, issued_at DESC);
CREATE INDEX idx_elevation_grants_expires
  ON elevation_grants(expires_at);
CREATE INDEX idx_credential_profiles_state
  ON credential_profiles(tenant_id, lifecycle_state, updated_at);
CREATE INDEX idx_credential_profile_versions_state
  ON credential_profile_versions(tenant_id, credential_profile_id, lifecycle_state, version_number);
CREATE INDEX idx_admin_agent_grants_delegator
  ON admin_agent_grants(tenant_id, delegator_id, status);
CREATE INDEX idx_admin_agent_grants_client
  ON admin_agent_grants(tenant_id, client_id, status);
CREATE INDEX idx_admin_agent_grants_principal
  ON admin_agent_grants(machine_principal_id, status);
CREATE UNIQUE INDEX idx_admin_agent_grants_active_unique
  ON admin_agent_grants(tenant_id, delegator_id, client_id, active_uniqueness_key);
CREATE INDEX idx_agent_consents_user
  ON agent_consents(tenant_id, user_id, revoked_at);
CREATE INDEX idx_agent_consents_grant
  ON agent_consents(grant_id, consent_type, revoked_at);
CREATE INDEX idx_agent_elevation_recovery
  ON agent_elevation_challenges(status, execution_lease_expires_at);
CREATE INDEX idx_agent_elevation_grant
  ON agent_elevation_challenges(tenant_id, grant_id, created_at);
CREATE UNIQUE INDEX idx_agent_elevation_args_active
  ON agent_elevation_challenges(
    tenant_id,
    grant_id,
    actor_sub,
    tool_name,
    args_hash,
    active_args_key
  );
CREATE INDEX idx_agent_management_execution_lease
  ON agent_management_executions(status, lease_expires_at);
CREATE INDEX idx_admin_agent_delegation_jti_expiry
  ON admin_agent_delegation_jtis(expires_at);
CREATE INDEX idx_admin_agent_token_families_grant
  ON admin_agent_token_families(tenant_id, grant_id, grant_generation, status);
CREATE INDEX idx_admin_agent_token_families_client
  ON admin_agent_token_families(tenant_id, client_id, status);
CREATE INDEX idx_admin_agent_token_families_finalization
  ON admin_agent_token_families(status, created_at);
CREATE INDEX idx_admin_agent_token_revocation_pending
  ON admin_agent_token_revocation_outbox(status, next_attempt_at, processing_lease_expires_at);
CREATE INDEX idx_admin_audit_grant
  ON admin_audit_log(grant_id, created_at DESC);
CREATE INDEX idx_admin_audit_actor_type
  ON admin_audit_log(tenant_id, actor_type, created_at DESC);
CREATE UNIQUE INDEX idx_agent_elevation_approval_request
  ON agent_elevation_challenges(approval_request_id);
CREATE UNIQUE INDEX idx_agent_elevation_approval_artifact
  ON agent_elevation_challenges(approval_artifact_id);
CREATE INDEX idx_agent_configuration_plans_context
  ON agent_configuration_plans(tenant_id, grant_id, actor_sub, created_at);
CREATE INDEX idx_agent_configuration_plans_retention
  ON agent_configuration_plans(payload_purge_at, payload_purged_at);
CREATE UNIQUE INDEX idx_agent_configuration_plans_transition
  ON agent_configuration_plans(last_transition_id);
CREATE UNIQUE INDEX idx_agent_plan_confirmations_transition
  ON agent_plan_confirmations(last_transition_id);
CREATE UNIQUE INDEX idx_agent_secret_refs_transition
  ON agent_secret_refs(last_transition_id);
CREATE UNIQUE INDEX idx_agent_task_sets_transition
  ON agent_task_sets(last_transition_id);
CREATE UNIQUE INDEX idx_agent_scope_policies_transition
  ON agent_scope_policies(last_transition_id);
CREATE UNIQUE INDEX idx_agent_task_set_versions_transition
  ON agent_task_set_versions(last_transition_id);
CREATE UNIQUE INDEX idx_agent_scope_policy_versions_transition
  ON agent_scope_policy_versions(last_transition_id);
CREATE UNIQUE INDEX idx_agent_bulk_plans_transition
  ON agent_bulk_plans(last_transition_id);
CREATE INDEX idx_agent_bulk_plans_control
  ON agent_bulk_plans(control_tenant_id, status, created_at);
CREATE INDEX idx_agent_bulk_plans_retention
  ON agent_bulk_plans(payload_purge_at, payload_purged_at);
CREATE UNIQUE INDEX idx_agent_bulk_tenant_transition
  ON agent_bulk_tenant_executions(last_transition_id);
CREATE INDEX idx_agent_bulk_tenant_claim
  ON agent_bulk_tenant_executions(bulk_plan_id, bulk_plan_version, status, is_canary, wave_number);
CREATE INDEX idx_agent_bulk_tenant_lease
  ON agent_bulk_tenant_executions(status, execution_lease_expires_at);
CREATE UNIQUE INDEX idx_agent_baseline_assignments_transition
  ON agent_baseline_assignments(last_transition_id);
CREATE UNIQUE INDEX idx_agent_baseline_assignments_remediation_plan
  ON agent_baseline_assignments(remediation_bulk_plan_id, remediation_bulk_plan_version);
CREATE INDEX idx_agent_bulk_plans_actor
  ON agent_bulk_plans(control_tenant_id, grant_id, actor_sub, status);
CREATE INDEX idx_agent_bulk_children_capability
  ON agent_bulk_tenant_executions(
    bulk_plan_id, bulk_plan_version, target_tenant_id,
    execution_attempt, execution_fence, child_capability_digest
  );
CREATE INDEX idx_admin_agent_token_families_revocation_outbox
  ON admin_agent_token_families(tenant_id, revocation_outbox_id, family_id);
CREATE INDEX idx_admin_agent_grants_management_mode
  ON admin_agent_grants(tenant_id, management_mode, status);
CREATE INDEX idx_agent_task_sets_management_mode
  ON agent_task_sets(tenant_id, management_mode, status);
CREATE INDEX idx_agent_scope_policies_management_mode
  ON agent_scope_policies(tenant_id, management_mode, status);
CREATE INDEX idx_admin_sessions_parent
  ON admin_sessions(parent_session_id, expires_at);
CREATE INDEX idx_admin_agent_login_handoffs_pending
  ON admin_agent_login_handoffs(status, expires_at);
CREATE INDEX idx_admin_agent_login_handoffs_target
  ON admin_agent_login_handoffs(target_tenant_id, created_at DESC);
CREATE INDEX idx_admin_sessions_derived_target
  ON admin_sessions(derived_target_tenant_id, expires_at);
CREATE INDEX idx_admin_invitations_tenant_status
  ON admin_invitations(tenant_id, status, created_at DESC);
CREATE INDEX idx_admin_invitations_code_hash
  ON admin_invitations(code_hash, status, expires_at);
CREATE INDEX idx_admin_invitations_email
  ON admin_invitations(tenant_id, email, status);
CREATE INDEX idx_admin_invitation_enrollments_expiry
  ON admin_invitation_enrollments(expires_at);
CREATE INDEX idx_admin_invitation_enrollments_invitation
  ON admin_invitation_enrollments(invitation_id, expires_at);
CREATE INDEX idx_admin_agent_mcp_sessions_admission
  ON admin_agent_mcp_sessions(tenant_id, grant_id, client_id, expires_at);
CREATE INDEX idx_admin_agent_mcp_sessions_expiration
  ON admin_agent_mcp_sessions(expires_at, absolute_expires_at);
CREATE UNIQUE INDEX idx_internal_notification_events_dedup
  ON internal_notification_events(deduplication_key);
CREATE INDEX idx_internal_notification_events_pending
  ON internal_notification_events(status, severity, created_at);
CREATE INDEX idx_internal_notification_events_tenant_created
  ON internal_notification_events(tenant_id, created_at DESC);
CREATE INDEX idx_provider_reprojection_jobs_due
  ON provider_reprojection_jobs(status, next_run_at, updated_at);
CREATE INDEX idx_provider_reprojection_jobs_plugin
  ON provider_reprojection_jobs(plugin_id, created_at DESC);
CREATE INDEX idx_provider_reprojection_tenant_status
  ON provider_reprojection_tenant_state(plugin_id, desired_revision, status, tenant_id);
CREATE INDEX idx_tenant_provisioning_operations_runnable
  ON tenant_provisioning_operations(status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX idx_tenant_provisioning_steps_status
  ON tenant_provisioning_operation_steps(status, next_attempt_at, updated_at);
CREATE INDEX idx_tenant_placement_migration_jobs_runnable
  ON tenant_placement_migration_jobs(status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX idx_tenant_runtime_registry_snapshots_active
  ON tenant_runtime_registry_snapshots(
    status,
    expires_at,
    backend_provider,
    placement_policy
  );
CREATE INDEX idx_logging_message_jobs_due
  ON logging_message_jobs(status, not_before, priority, created_at);
CREATE INDEX idx_logging_message_jobs_claimed
  ON logging_message_jobs(status, claimed_until, lane, priority);
CREATE INDEX idx_logging_message_jobs_scope_status
  ON logging_message_jobs(scope_key, status, created_at);
CREATE INDEX idx_logging_message_jobs_tenant
  ON logging_message_jobs(tenant_key, kind, status, created_at);
CREATE INDEX idx_logging_message_jobs_source
  ON logging_message_jobs(source_type, source_id);
CREATE INDEX idx_logging_message_jobs_chain
  ON logging_message_jobs(root_job_id, parent_job_id, depth);
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

CREATE TABLE scheduled_task_leases (
  task_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

PRAGMA foreign_keys = ON;
