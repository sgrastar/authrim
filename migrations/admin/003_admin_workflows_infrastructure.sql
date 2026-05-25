-- =============================================================================
-- Authrim Admin Baseline: Workflows and Infrastructure
-- Consolidated for fresh Authrim installs from admin/009_optimize_admin_audit_indexes.sql, admin/010_admin_object_catalog.sql, admin/011_admin_approval_elevation.sql, admin/012_admin_approval_notifications.sql, admin/013_admin_storage_database_resources.sql, admin/014_admin_infrastructure_role_templates.sql, admin/015_admin_machine_access.sql, admin/016_admin_role_assignment_scope_normalization.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/009_optimize_admin_audit_indexes.sql
-- -----------------------------------------------------------------------------

-- D1 Write Amplification Optimization for admin_audit_log
-- All queries filter by tenant_id, so idx_admin_audit_log_tenant_time covers most cases
--
-- Redundant: all queries include tenant_id filter
-- idx_admin_audit_log_tenant_time(tenant_id, created_at DESC) covers this
DROP INDEX IF EXISTS idx_admin_audit_log_created_at;

-- Never searched alone - always combined with tenant_id (admin-audit-log.ts:218,347)
DROP INDEX IF EXISTS idx_admin_audit_log_severity;

-- Never searched alone - always combined with tenant_id (admin-audit-log.ts:214,322)
DROP INDEX IF EXISTS idx_admin_audit_log_result;

-- Low-frequency optional admin filter, not on critical path (admin-audit-log.ts:222)
DROP INDEX IF EXISTS idx_admin_audit_log_ip;

-- -----------------------------------------------------------------------------
-- Source: admin/010_admin_object_catalog.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin Object Catalog Foundation
-- =============================================================================
-- Created: 2026-05-01
-- Description:
--   Adds object catalog tables to DB_ADMIN and a pointer column on
--   admin_audit_log for future externalized detail payloads.
-- =============================================================================

CREATE TABLE IF NOT EXISTS object_catalog (
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
      'approval_transport_detail'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_object_catalog_deleted_at
  ON object_catalog(deleted_at);

CREATE TABLE IF NOT EXISTS object_catalog_objects (
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

CREATE INDEX IF NOT EXISTS idx_object_catalog_objects_catalog_repr
  ON object_catalog_objects(catalog_id, representation, object_index);

CREATE INDEX IF NOT EXISTS idx_object_catalog_objects_bucket_key
  ON object_catalog_objects(bucket_binding, object_key);

CREATE INDEX IF NOT EXISTS idx_object_catalog_objects_deleted_at
  ON object_catalog_objects(deleted_at);

ALTER TABLE admin_audit_log ADD COLUMN detail_object_catalog_id TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_detail_object_catalog
  ON admin_audit_log(detail_object_catalog_id);

-- -----------------------------------------------------------------------------
-- Source: admin/011_admin_approval_elevation.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin Approval / Elevation Governance
-- =============================================================================
-- Created: 2026-05-02
-- Description:
--   Adds DB_ADMIN tables for mixed approval workflows, per-approver decisions,
--   and short-lived elevation grant metadata used by delegated support and
--   break-glass style access flows.
-- =============================================================================

CREATE TABLE IF NOT EXISTS approval_requests (
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

CREATE INDEX IF NOT EXISTS idx_approval_requests_tenant_status_requested
  ON approval_requests(tenant_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_investigation
  ON approval_requests(investigation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_requester
  ON approval_requests(requester_subject_type, requester_subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_target
  ON approval_requests(target_subject_type, target_subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_expires
  ON approval_requests(expires_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_detail_object_catalog
  ON approval_requests(detail_object_catalog_id);

CREATE TABLE IF NOT EXISTS approval_request_approvals (
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
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_request_approvals_unique_subject
  ON approval_request_approvals(
    approval_request_id,
    step_key,
    subject_type,
    COALESCE(subject_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_approval_request_approvals_request_status
  ON approval_request_approvals(approval_request_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_approval_request_approvals_subject
  ON approval_request_approvals(subject_type, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_request_approvals_expires
  ON approval_request_approvals(expires_at);

CREATE TABLE IF NOT EXISTS elevation_grants (
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

CREATE INDEX IF NOT EXISTS idx_elevation_grants_tenant_status_issued
  ON elevation_grants(tenant_id, status, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_request
  ON elevation_grants(approval_request_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_actor
  ON elevation_grants(actor_subject_type, actor_subject_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_expires
  ON elevation_grants(expires_at);

-- -----------------------------------------------------------------------------
-- Source: admin/012_admin_approval_notifications.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Approval Notification State
-- =============================================================================
-- Created: 2026-05-02
-- Description:
--   Adds reminder/resend notification summary fields to approval steps so the
--   operator surface can enforce cooldowns and show notification progress.
-- =============================================================================

ALTER TABLE approval_request_approvals
  ADD COLUMN last_notification_action TEXT
    CHECK (last_notification_action IN ('initial', 'resend', 'remind'));

ALTER TABLE approval_request_approvals
  ADD COLUMN last_notified_at INTEGER;

ALTER TABLE approval_request_approvals
  ADD COLUMN notification_count INTEGER NOT NULL DEFAULT 1;

UPDATE approval_request_approvals
   SET last_notification_action = COALESCE(last_notification_action, 'initial'),
       last_notified_at = COALESCE(last_notified_at, requested_at),
       notification_count = COALESCE(notification_count, 1)
 WHERE last_notification_action IS NULL
    OR last_notified_at IS NULL
    OR notification_count IS NULL;

-- -----------------------------------------------------------------------------
-- Source: admin/013_admin_storage_database_resources.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin Storage And Database Resources
-- =============================================================================
-- Created: 2026-05-13
-- Description:
--   Adds RBAC-managed storage destination and database connection metadata.
--   Credentials are stored as encrypted write-only blobs and must not be
--   returned by Admin APIs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_storage_destinations (
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

CREATE INDEX IF NOT EXISTS idx_admin_storage_destinations_scope
  ON admin_storage_destinations(scope_type, scope_id, is_active, name);

CREATE INDEX IF NOT EXISTS idx_admin_storage_destinations_provider
  ON admin_storage_destinations(provider, status);

CREATE TABLE IF NOT EXISTS admin_storage_destination_usages (
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

CREATE INDEX IF NOT EXISTS idx_admin_storage_destination_usages_destination
  ON admin_storage_destination_usages(destination_id, is_active);

CREATE INDEX IF NOT EXISTS idx_admin_storage_destination_usages_feature
  ON admin_storage_destination_usages(tenant_id, feature, is_active);

CREATE TABLE IF NOT EXISTS admin_database_connections (
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

CREATE INDEX IF NOT EXISTS idx_admin_database_connections_provider
  ON admin_database_connections(provider, status, is_active);

CREATE TABLE IF NOT EXISTS admin_database_connection_usages (
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

CREATE INDEX IF NOT EXISTS idx_admin_database_connection_usages_connection
  ON admin_database_connection_usages(connection_id, is_active);

-- -----------------------------------------------------------------------------
-- Source: admin/014_admin_infrastructure_role_templates.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Admin Infrastructure Role Templates
-- =============================================================================
-- Description: Adds built-in Admin roles for storage destinations and platform
-- database connection operations.

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_storage_destination_viewer',
  'default',
  'storage_destination_viewer',
  'Storage Destination Viewer',
  'View tenant storage destinations and usage without credential management privileges.',
  '["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:usage:read"]',
  32,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'storage_destination_viewer'
);

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_storage_destination_admin',
  'default',
  'storage_destination_admin',
  'Storage Destination Admin',
  'Manage tenant storage destinations and allow feature owners to select approved destinations.',
  '["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:create","admin:storage_destinations:update","admin:storage_destinations:delete","admin:storage_destinations:credentials:write","admin:storage_destinations:test","admin:storage_destinations:usage:read","admin:diagnostic_logging:destination:select","admin:jobs:destination:select","admin:dr_backup:destination:select"]',
  55,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'storage_destination_admin'
);

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_platform_database_viewer',
  'default',
  'platform_database_viewer',
  'Platform Database Viewer',
  'View platform database connections and routing state without changing runtime storage.',
  '["admin:database_connections:list","admin:database_connections:read","admin:database_connections:test","admin:database_routing:read"]',
  60,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'platform_database_viewer'
);

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_platform_database_admin',
  'default',
  'platform_database_admin',
  'Platform Database Admin',
  'Manage platform database connections and perform controlled database routing changes.',
  '["admin:database_connections:list","admin:database_connections:read","admin:database_connections:create","admin:database_connections:update","admin:database_connections:delete","admin:database_connections:credentials:write","admin:database_connections:test","admin:database_routing:read","admin:database_routing:write","admin:database_routing:switch","admin:database_routing:rollback"]',
  85,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'platform_database_admin'
);

-- -----------------------------------------------------------------------------
-- Source: admin/015_admin_machine_access.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Admin Machine Access
-- =============================================================================
-- Description: Adds DB_ADMIN tables for scoped machine access to Admin API using
--              client_credentials with private_key_jwt client authentication.

CREATE TABLE IF NOT EXISTS admin_machine_principals (
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

CREATE TABLE IF NOT EXISTS admin_machine_credentials (
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

CREATE TABLE IF NOT EXISTS admin_machine_principal_permissions (
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (principal_id, permission),
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_machine_credential_permissions (
  credential_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (credential_id, permission),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_machine_principal_tenant_scopes (
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

CREATE TABLE IF NOT EXISTS admin_machine_credential_tenant_scopes (
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

CREATE TABLE IF NOT EXISTS admin_machine_resource_scopes (
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

CREATE TABLE IF NOT EXISTS admin_machine_assertion_jti (
  client_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, credential_id, jti),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_machine_principals_status
  ON admin_machine_principals(status);

CREATE INDEX IF NOT EXISTS idx_admin_machine_credentials_principal
  ON admin_machine_credentials(principal_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_credentials_status
  ON admin_machine_credentials(status);

CREATE INDEX IF NOT EXISTS idx_admin_machine_principal_tenant_scopes_principal
  ON admin_machine_principal_tenant_scopes(principal_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_credential_tenant_scopes_credential
  ON admin_machine_credential_tenant_scopes(credential_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_resource_scopes_principal
  ON admin_machine_resource_scopes(principal_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_resource_scopes_credential
  ON admin_machine_resource_scopes(credential_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_assertion_jti_expires
  ON admin_machine_assertion_jti(expires_at);

-- -----------------------------------------------------------------------------
-- Source: admin/016_admin_role_assignment_scope_normalization.sql
-- -----------------------------------------------------------------------------

-- Normalize tenant-scoped Admin role assignment scope IDs.
--
-- Older Admin assignment paths created tenant-scoped records with NULL/empty scope_id.
-- New AdminUI/API paths store scope_id explicitly as tenant_id so duplicate checks and
-- future scope enforcement can use one canonical representation.

UPDATE admin_role_assignments
SET scope_id = tenant_id
WHERE scope_type = 'tenant'
  AND (scope_id IS NULL OR scope_id = '');
