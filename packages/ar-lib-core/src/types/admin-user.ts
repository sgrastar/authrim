/**
 * Admin User Types
 *
 * Type definitions for Admin/EndUser separation architecture.
 * Admin users are stored in DB_ADMIN, completely separate from EndUsers in DB_CORE.
 *
 * This module contains:
 * - AdminUser: Admin user account
 * - AdminRole: Role definitions for Admin RBAC
 * - AdminRoleAssignment: Links admin users to roles
 * - AdminSession: Admin login sessions
 * - AdminPasskey: WebAuthn credentials for Admin
 * - AdminAuditLogEntry: Admin operation audit trail
 * - AdminIpAllowlistEntry: IP-based access control
 */

// =============================================================================
// Admin User
// =============================================================================

/**
 * Admin account status
 * - active: Normal active account
 * - suspended: Temporarily suspended (can be reactivated)
 * - locked: Locked due to failed login attempts (auto-unlock possible)
 */
export type AdminUserStatus = 'active' | 'suspended' | 'locked';

/**
 * MFA method for Admin users
 * - totp: Time-based One-Time Password (Google Authenticator, etc.)
 * - passkey: WebAuthn/Passkey
 * - both: Both TOTP and Passkey required
 */
export type AdminMfaMethod = 'totp' | 'passkey' | 'both';

/**
 * Admin user account stored in DB_ADMIN
 * GDPR exempt - no PII separation required
 */
export interface AdminUser {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Tenant ID for multi-tenant support */
  tenant_id: string;
  /** Admin email address */
  email: string;
  /** Whether email is verified */
  email_verified: boolean;
  /** Display name */
  name: string | null;
  /** Password hash (Argon2) */
  password_hash: string | null;
  /** Whether the account is active */
  is_active: boolean;
  /** Account status */
  status: AdminUserStatus;
  /** Whether MFA is enabled */
  mfa_enabled: boolean;
  /** MFA method */
  mfa_method: AdminMfaMethod | null;
  /** Encrypted TOTP secret (if TOTP enabled) */
  totp_secret_encrypted: string | null;
  /** Last login timestamp (Unix milliseconds) */
  last_login_at: number | null;
  /** Last login IP address */
  last_login_ip: string | null;
  /** Failed login attempt count */
  failed_login_count: number;
  /** Account locked until timestamp (Unix milliseconds) */
  locked_until: number | null;
  /** ID of admin who created this account */
  created_by: string | null;
  /** Creation timestamp (Unix milliseconds) */
  created_at: number;
  /** Last update timestamp (Unix milliseconds) */
  updated_at: number;
}

/**
 * Admin user creation input
 */
export interface AdminUserCreateInput {
  /** Optional ID (auto-generated if not provided) */
  id?: string;
  tenant_id?: string;
  email: string;
  name?: string;
  password?: string;
  mfa_enabled?: boolean;
  mfa_method?: AdminMfaMethod;
  created_by?: string;
}

/**
 * Admin user update input
 */
export interface AdminUserUpdateInput {
  email?: string;
  name?: string | null;
  password?: string;
  is_active?: boolean;
  status?: AdminUserStatus;
  mfa_enabled?: boolean;
  mfa_method?: AdminMfaMethod | null;
  totp_secret_encrypted?: string | null;
}

// =============================================================================
// Admin Role
// =============================================================================

/**
 * Role type for Admin RBAC
 * - system: Built-in system roles (cannot be modified/deleted)
 * - builtin: Default roles (can be modified but not deleted)
 * - custom: User-created roles (fully customizable)
 */
export type AdminRoleType = 'system' | 'builtin' | 'custom';

/**
 * Admin role definition stored in DB_ADMIN
 */
export interface AdminRole {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Tenant ID for multi-tenant support */
  tenant_id: string;
  /** Machine-readable name (e.g., 'super_admin') */
  name: string;
  /** Human-readable name (e.g., 'Super Administrator') */
  display_name: string | null;
  /** Description of the role */
  description: string | null;
  /** Permissions granted by this role */
  permissions: string[];
  /** Hierarchy level (higher = more privilege) */
  hierarchy_level: number;
  /** Role type */
  role_type: AdminRoleType;
  /** Whether this is a system role (cannot be modified) */
  is_system: boolean;
  /** Parent role ID for inheritance (nullable) */
  inherits_from: string | null;
  /** Creation timestamp (Unix milliseconds) */
  created_at: number;
  /** Last update timestamp (Unix milliseconds) */
  updated_at: number;
}

/**
 * Admin role creation input
 */
export interface AdminRoleCreateInput {
  tenant_id?: string;
  name: string;
  display_name?: string;
  description?: string;
  permissions: string[];
  hierarchy_level?: number;
  role_type?: AdminRoleType;
  inherits_from?: string | null;
}

/**
 * Admin role update input
 */
export interface AdminRoleUpdateInput {
  display_name?: string | null;
  description?: string | null;
  permissions?: string[];
  hierarchy_level?: number;
  inherits_from?: string | null;
}

// =============================================================================
// Admin Role Assignment
// =============================================================================

/**
 * Scope type for role assignment
 * - global: Role applies to all tenants (super_admin only)
 * - tenant: Role applies to specific tenant
 * - org: Reserved for future Admin scope binding; current Admin APIs do not create it
 */
export type AdminRoleAssignmentScopeType = 'global' | 'tenant' | 'org';

/**
 * Admin role assignment linking admin users to roles
 */
export interface AdminRoleAssignment {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Tenant ID for multi-tenant support */
  tenant_id: string;
  /** Admin user ID */
  admin_user_id: string;
  /** Admin role ID */
  admin_role_id: string;
  /** Scope type */
  scope_type: AdminRoleAssignmentScopeType;
  /** Scope ID (tenant_id for tenant scope; reserved for future scoped modes) */
  scope_id: string | null;
  /** Expiration timestamp (Unix milliseconds), null for permanent */
  expires_at: number | null;
  /** ID of admin who made this assignment */
  assigned_by: string | null;
  /** Creation timestamp (Unix milliseconds) */
  created_at: number;
}

/**
 * Admin role assignment creation input
 */
export interface AdminRoleAssignmentCreateInput {
  tenant_id?: string;
  admin_user_id: string;
  admin_role_id: string;
  scope_type?: AdminRoleAssignmentScopeType;
  scope_id?: string;
  expires_at?: number;
  assigned_by?: string;
}

// =============================================================================
// Admin Session
// =============================================================================

/**
 * Admin session stored in DB_ADMIN
 * Separate from EndUser sessions in SessionStore Durable Object
 */
export interface AdminSession {
  /** Session ID (UUID v4) */
  id: string;
  /** Tenant ID for multi-tenant support */
  tenant_id: string;
  /** Admin user ID */
  admin_user_id: string;
  /** Client IP address */
  ip_address: string | null;
  /** User agent string */
  user_agent: string | null;
  /** Creation timestamp (Unix milliseconds) */
  created_at: number;
  /** Expiration timestamp (Unix milliseconds) */
  expires_at: number;
  /** Last activity timestamp (Unix milliseconds) */
  last_activity_at: number | null;
  /** Whether MFA has been verified for this session */
  mfa_verified: boolean;
  /** When MFA was verified (Unix milliseconds) */
  mfa_verified_at: number | null;
}

/**
 * Admin session creation input
 */
export interface AdminSessionCreateInput {
  /** Optional session ID (if not provided, will be auto-generated) */
  id?: string;
  tenant_id?: string;
  admin_user_id: string;
  ip_address?: string;
  user_agent?: string;
  expires_at: number;
  mfa_verified?: boolean;
}

// =============================================================================
// Admin Passkey
// =============================================================================

/**
 * WebAuthn/Passkey credential for Admin users
 */
export interface AdminPasskey {
  /** Passkey ID (UUID v4) */
  id: string;
  /** Admin user ID */
  admin_user_id: string;
  /** Base64url-encoded credential ID */
  credential_id: string;
  /** COSE public key (Base64url-encoded) */
  public_key: string;
  /** Signature counter for replay protection */
  counter: number;
  /** User-friendly name for this passkey */
  device_name: string | null;
  /** Transports (usb, ble, nfc, internal, hybrid) */
  transports: string[] | null;
  /** Attestation type */
  attestation_type: string | null;
  /** Authenticator Attestation GUID */
  aaguid: string | null;
  /** Creation timestamp (Unix milliseconds) */
  created_at: number;
  /** Last used timestamp (Unix milliseconds) */
  last_used_at: number | null;
}

/**
 * Admin passkey creation input
 */
export interface AdminPasskeyCreateInput {
  admin_user_id: string;
  credential_id: string;
  public_key: string;
  counter?: number;
  device_name?: string;
  transports?: string[];
  attestation_type?: string;
  aaguid?: string;
}

// =============================================================================
// Admin Audit Log
// =============================================================================

/**
 * Severity level for Admin audit log entries
 */
export type AdminAuditLogSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

/**
 * Result of an audited action
 */
export type AdminAuditLogResult = 'success' | 'failure' | 'error';

/**
 * Admin audit log entry stored in DB_ADMIN
 */
export interface AdminAuditLogEntry {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Tenant ID for multi-tenant support */
  tenant_id: string;
  /** Admin user ID (may be null for system actions) */
  admin_user_id: string | null;
  /** Admin email (denormalized for easier querying) */
  admin_email: string | null;
  /** Action performed (e.g., 'admin.login.success') */
  action: string;
  /** Resource type (e.g., 'admin_user', 'client') */
  resource_type: string | null;
  /** Resource ID */
  resource_id: string | null;
  /** Result of the action */
  result: AdminAuditLogResult;
  /** Error code (if result is 'failure' or 'error') */
  error_code: string | null;
  /** Error message */
  error_message: string | null;
  /** Severity level */
  severity: AdminAuditLogSeverity;
  /** Client IP address */
  ip_address: string | null;
  /** User agent string */
  user_agent: string | null;
  /** Request correlation ID */
  request_id: string | null;
  /** Admin session ID */
  session_id: string | null;
  /** JSON snapshot before change */
  before: Record<string, unknown> | null;
  /** JSON snapshot after change */
  after: Record<string, unknown> | null;
  /** Additional metadata */
  metadata: Record<string, unknown> | null;
  /** Whether full detail is stored in the object plane */
  has_detail: boolean;
  /** Public artifact identifier for externalized detail payloads */
  detail_artifact_id?: string | null;
  /** Timestamp (Unix milliseconds) */
  created_at: number;
}

/**
 * Admin audit log creation input
 */
export interface AdminAuditLogCreateInput {
  id?: string;
  tenant_id?: string;
  admin_user_id?: string;
  admin_email?: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  result: AdminAuditLogResult;
  error_code?: string;
  error_message?: string;
  severity?: AdminAuditLogSeverity;
  ip_address?: string;
  user_agent?: string;
  request_id?: string;
  session_id?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  detail_object_catalog_id?: string;
}

// =============================================================================
// Admin IP Allowlist
// =============================================================================

/**
 * Admin IP allowlist entry for IP-based access control
 */
export interface AdminIpAllowlistEntry {
  /** Entry ID (UUID v4) */
  id: string;
  /** Tenant ID for multi-tenant support */
  tenant_id: string;
  /** IP address or CIDR range */
  ip_range: string;
  /** IP version (4 or 6) */
  ip_version: 4 | 6;
  /** Human-readable description */
  description: string | null;
  /** Whether this entry is enabled */
  enabled: boolean;
  /** ID of admin who created this entry */
  created_by: string | null;
  /** Creation timestamp (Unix milliseconds) */
  created_at: number;
  /** Last update timestamp (Unix milliseconds) */
  updated_at: number;
}

/**
 * Admin IP allowlist creation input
 */
export interface AdminIpAllowlistCreateInput {
  tenant_id?: string;
  ip_range: string;
  ip_version?: 4 | 6;
  description?: string;
  enabled?: boolean;
  created_by?: string;
}

/**
 * Admin IP allowlist update input
 */
export interface AdminIpAllowlistUpdateInput {
  ip_range?: string;
  ip_version?: 4 | 6;
  description?: string | null;
  enabled?: boolean;
}

// =============================================================================
// Admin Login Attempt
// =============================================================================

/**
 * Admin login attempt record for rate limiting
 */
export interface AdminLoginAttempt {
  /** Attempt ID (UUID v4) */
  id: string;
  /** Tenant ID for multi-tenant support */
  tenant_id: string;
  /** Target email (even if user doesn't exist) */
  email: string;
  /** Client IP address */
  ip_address: string;
  /** User agent string */
  user_agent: string | null;
  /** Whether the login was successful */
  success: boolean;
  /** Failure reason (if not successful) */
  failure_reason: string | null;
  /** Timestamp (Unix milliseconds) */
  created_at: number;
}

// =============================================================================
// Admin Permissions
// =============================================================================

/**
 * Admin permission constants
 *
 * Format: admin:<resource>:<action>
 * Special: "*" grants all permissions
 */
export const ADMIN_PERMISSIONS = {
  // Wildcard
  ALL: '*',

  // Admin user management
  ADMIN_USERS_READ: 'admin:admin_users:read',
  ADMIN_USERS_WRITE: 'admin:admin_users:write',
  ADMIN_USERS_DELETE: 'admin:admin_users:delete',
  ADMIN_USERS_ALL: 'admin:admin_users:*',

  // End user management
  USERS_READ: 'admin:users:read',
  USERS_WRITE: 'admin:users:write',
  USERS_SUSPEND: 'admin:users:suspend',
  USERS_DELETE: 'admin:users:delete',
  USERS_UNLOCK: 'admin:users:unlock',
  USERS_ALL: 'admin:users:*',

  // Client management
  CLIENTS_READ: 'admin:clients:read',
  CLIENTS_WRITE: 'admin:clients:write',
  CLIENTS_CREATE: 'admin:clients:create',
  CLIENTS_UPDATE: 'admin:clients:update',
  CLIENTS_SECRET_ROTATE: 'admin:clients:secret:rotate',
  CLIENTS_DELETE: 'admin:clients:delete',
  CLIENTS_ALL: 'admin:clients:*',

  // Role management (EndUser roles)
  ROLES_READ: 'admin:roles:read',
  ROLES_WRITE: 'admin:roles:write',
  ROLES_DELETE: 'admin:roles:delete',
  ROLES_ALL: 'admin:roles:*',

  // Admin role management (Admin roles in DB_ADMIN)
  ADMIN_ROLES_READ: 'admin:admin_roles:read',
  ADMIN_ROLES_WRITE: 'admin:admin_roles:write',
  ADMIN_ROLES_DELETE: 'admin:admin_roles:delete',
  ADMIN_ROLES_ALL: 'admin:admin_roles:*',

  // Scope management
  SCOPES_READ: 'admin:scopes:read',
  SCOPES_WRITE: 'admin:scopes:write',
  SCOPES_DELETE: 'admin:scopes:delete',
  SCOPES_ALL: 'admin:scopes:*',

  // Settings management
  SETTINGS_READ: 'admin:settings:read',
  SETTINGS_WRITE: 'admin:settings:write',
  SETTINGS_ASSURANCE_UPDATE: 'admin:settings:assurance:update',
  SETTINGS_SECURITY_UPDATE: 'admin:settings:security:update',
  SETTINGS_TOKEN_EXCHANGE_UPDATE: 'admin:settings:token_exchange:update',
  SETTINGS_OAUTH_UPDATE: 'admin:settings:oauth:update',
  SETTINGS_SESSION_UPDATE: 'admin:settings:session:update',
  SETTINGS_LOGIN_UI_UPDATE: 'admin:settings:login_ui:update',
  SETTINGS_ALL: 'admin:settings:*',

  // Tenant vanity domain management
  TENANT_DOMAINS_READ: 'admin:tenant_domains:read',
  TENANT_DOMAINS_WRITE: 'admin:tenant_domains:write',
  TENANT_DOMAINS_DELETE: 'admin:tenant_domains:delete',
  TENANT_DOMAINS_ALL: 'admin:tenant_domains:*',

  // Tenant lifecycle operations
  TENANT_LIFECYCLE_STANDARD: 'admin:tenants:lifecycle:standard',
  TENANT_LIFECYCLE_RECOVERY: 'admin:tenants:lifecycle:recovery',
  TENANT_LIFECYCLE_BREAK_GLASS: 'admin:tenants:lifecycle:break_glass',

  // Audit log (EndUser audit)
  AUDIT_READ: 'admin:audit:read',
  AUDIT_ALL: 'admin:audit:*',

  // Admin audit log (Admin operations in DB_ADMIN)
  ADMIN_AUDIT_READ: 'admin:admin_audit:read',
  ADMIN_AUDIT_DETAIL_READ: 'admin:admin_audit:detail:read',
  ADMIN_AUDIT_ALL: 'admin:admin_audit:*',

  // Webhook management
  WEBHOOKS_READ: 'admin:webhooks:read',
  WEBHOOKS_WRITE: 'admin:webhooks:write',
  WEBHOOKS_DELETE: 'admin:webhooks:delete',
  WEBHOOKS_PAYLOAD_READ: 'admin:webhooks:payload:read',
  WEBHOOKS_ALL: 'admin:webhooks:*',

  // External IdP provider management
  EXTERNAL_PROVIDERS_READ: 'admin:external_providers:read',
  EXTERNAL_PROVIDERS_WRITE: 'admin:external_providers:write',
  EXTERNAL_PROVIDERS_DELETE: 'admin:external_providers:delete',
  EXTERNAL_PROVIDERS_ALL: 'admin:external_providers:*',

  // External IdP token refresh operations
  EXTERNAL_TOKEN_REFRESH_READ: 'admin:external_token_refresh:read',
  EXTERNAL_TOKEN_REFRESH_WRITE: 'admin:external_token_refresh:write',
  EXTERNAL_TOKEN_REFRESH_RUN: 'admin:external_token_refresh:run',
  EXTERNAL_TOKEN_REFRESH_ALL: 'admin:external_token_refresh:*',

  // SAML provider management
  SAML_PROVIDERS_LIST: 'admin:saml_providers:list',
  SAML_PROVIDERS_READ: 'admin:saml_providers:read',
  SAML_PROVIDERS_CREATE: 'admin:saml_providers:create',
  SAML_PROVIDERS_UPDATE: 'admin:saml_providers:update',
  SAML_PROVIDERS_DELETE: 'admin:saml_providers:delete',
  SAML_PROVIDERS_METADATA_IMPORT: 'admin:saml_providers:metadata:import',
  SAML_PROVIDERS_METADATA_REFRESH: 'admin:saml_providers:metadata:refresh',
  SAML_PROVIDERS_SIGNING_PUBLISH_NEXT: 'admin:saml_providers:signing:publish_next',
  SAML_PROVIDERS_SIGNING_PROMOTE: 'admin:saml_providers:signing:promote',
  SAML_PROVIDERS_SIGNING_RETIRE_BACKUP: 'admin:saml_providers:signing:retire_backup',
  SAML_PROVIDERS_SIGNING_DR_BUNDLE_EXPORT: 'admin:saml_providers:signing:dr_bundle:export',
  SAML_PROVIDERS_SIGNING_DR_BUNDLE_IMPORT: 'admin:saml_providers:signing:dr_bundle:import',
  SAML_PROVIDERS_ALL: 'admin:saml_providers:*',
  SAML_ATTRIBUTE_PRESETS_READ: 'admin:saml_attribute_presets:read',
  SAML_ATTRIBUTE_PRESETS_WRITE: 'admin:saml_attribute_presets:write',
  SAML_ATTRIBUTE_PRESETS_DELETE: 'admin:saml_attribute_presets:delete',

  // Directory Authentication / Authrim Wordwarden
  DIRECTORY_AUTH_READ: 'admin:directory_auth:read',
  DIRECTORY_AUTH_WRITE: 'admin:directory_auth:write',
  DIRECTORY_AUTH_MIGRATION_WRITE: 'admin:directory_auth:migration:write',
  DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE: 'admin:directory_auth:evidence_export:create',
  DIRECTORY_AUTH_ALL: 'admin:directory_auth:*',

  // Admin jobs / artifacts
  JOBS_READ: 'admin:jobs:read',
  JOBS_WRITE: 'admin:jobs:write',
  JOBS_ARTIFACT_READ: 'admin:jobs:artifact:read',
  JOBS_DESTINATION_SELECT: 'admin:jobs:destination:select',
  JOBS_ALL: 'admin:jobs:*',

  // Storage destination management
  STORAGE_DESTINATIONS_LIST: 'admin:storage_destinations:list',
  STORAGE_DESTINATIONS_READ: 'admin:storage_destinations:read',
  STORAGE_DESTINATIONS_CREATE: 'admin:storage_destinations:create',
  STORAGE_DESTINATIONS_UPDATE: 'admin:storage_destinations:update',
  STORAGE_DESTINATIONS_DELETE: 'admin:storage_destinations:delete',
  STORAGE_DESTINATIONS_CREDENTIALS_WRITE: 'admin:storage_destinations:credentials:write',
  STORAGE_DESTINATIONS_HEALTH_CHECK: 'admin:storage_destinations:health:check',
  STORAGE_DESTINATIONS_TEST: 'admin:storage_destinations:test',
  STORAGE_DESTINATIONS_USAGE_READ: 'admin:storage_destinations:usage:read',
  STORAGE_DESTINATIONS_ALL: 'admin:storage_destinations:*',

  // Logging control plane
  LOGGING_OVERVIEW_READ: 'admin:logging:overview:read',
  LOGGING_PLATFORM_DEFAULTS_READ: 'admin:logging:platform_defaults:read',
  LOGGING_PLATFORM_DEFAULTS_UPDATE: 'admin:logging:platform_defaults:update',
  LOGGING_TENANT_OVERRIDES_READ: 'admin:logging:tenant_overrides:read',
  LOGGING_TENANT_OVERRIDES_UPDATE: 'admin:logging:tenant_overrides:update',
  LOGGING_CRITICAL_UPDATE: 'admin:logging:critical:update',
  LOGGING_DELIVERY_EVENTS_READ: 'admin:logging:delivery_events:read',
  LOGGING_DELIVERY_RETRY: 'admin:logging:delivery:retry',
  LOGGING_EXPORT_CREATE: 'admin:logging:exports:create',
  LOGGING_SENSITIVE_DETAIL_EXPORT: 'admin:logging:sensitive_detail:export',
  LOGGING_DLQ_REPLAY: 'admin:logging:dlq:replay',
  LOGGING_DLQ_DELETE: 'admin:logging:dlq:delete',
  LOGGING_DLQ_PURGE: 'admin:logging:dlq:purge',
  LOGGING_SNAPSHOTS_PUBLISH: 'admin:logging:snapshots:publish',
  LOGGING_ROLLBACK: 'admin:logging:rollback',
  LOGGING_ALL: 'admin:logging:*',

  // Admin logging control plane
  ADMIN_LOGGING_OVERVIEW_READ: 'admin:admin_logging:overview:read',
  ADMIN_LOGGING_COVERAGE_READ: 'admin:admin_logging:coverage:read',
  ADMIN_LOGGING_COVERAGE_UPDATE: 'admin:admin_logging:coverage:update',
  ADMIN_LOGGING_REPAIR_READ: 'admin:admin_logging:repair:read',
  ADMIN_LOGGING_REPAIR_RUN: 'admin:admin_logging:repair:run',
  ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ: 'admin:admin_logging:sensitive_detail_policy:read',
  ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_UPDATE:
    'admin:admin_logging:sensitive_detail_policy:update',
  ADMIN_LOGGING_CRITICAL_UPDATE: 'admin:admin_logging:critical:update',
  ADMIN_LOGGING_ALL: 'admin:admin_logging:*',

  // Feature storage destination selection
  DIAGNOSTIC_LOGGING_DESTINATION_SELECT: 'admin:diagnostic_logging:destination:select',
  DR_BACKUP_DESTINATION_SELECT: 'admin:dr_backup:destination:select',

  // Platform database connection management
  DATABASE_CONNECTIONS_LIST: 'admin:database_connections:list',
  DATABASE_CONNECTIONS_READ: 'admin:database_connections:read',
  DATABASE_CONNECTIONS_CREATE: 'admin:database_connections:create',
  DATABASE_CONNECTIONS_UPDATE: 'admin:database_connections:update',
  DATABASE_CONNECTIONS_DELETE: 'admin:database_connections:delete',
  DATABASE_CONNECTIONS_CREDENTIALS_WRITE: 'admin:database_connections:credentials:write',
  DATABASE_CONNECTIONS_TEST: 'admin:database_connections:test',
  DATABASE_CONNECTIONS_ALL: 'admin:database_connections:*',

  // Platform database routing and cutover
  DATABASE_ROUTING_READ: 'admin:database_routing:read',
  DATABASE_ROUTING_WRITE: 'admin:database_routing:write',
  DATABASE_ROUTING_SWITCH: 'admin:database_routing:switch',
  DATABASE_ROUTING_ROLLBACK: 'admin:database_routing:rollback',
  DATABASE_ROUTING_ALL: 'admin:database_routing:*',

  // Approval / elevation workflows
  APPROVALS_READ: 'admin:approvals:read',
  APPROVALS_DETAIL_READ: 'admin:approvals:detail:read',
  APPROVALS_WRITE: 'admin:approvals:write',
  APPROVALS_APPROVE: 'admin:approvals:approve',
  APPROVALS_GRANT_ISSUE: 'admin:approvals:grant:issue',
  APPROVALS_ALL: 'admin:approvals:*',

  // Agent Access delegation and orchestration
  AGENT_USE: 'admin:agent:use',
  AGENT_GRANTS_READ: 'admin:agent_grants:read',
  AGENT_GRANTS_WRITE: 'admin:agent_grants:write',
  AGENT_GRANTS_REVOKE: 'admin:agent_grants:revoke',
  AGENT_GRANTS_ALL: 'admin:agent_grants:*',
  AGENT_SETTINGS_READ: 'admin:agent_settings:read',
  AGENT_SETTINGS_WRITE: 'admin:agent_settings:write',
  AGENT_ELEVATION_RECONCILE: 'admin:agent_elevation:reconcile',
  AGENT_TASK_SETS_READ: 'admin:agent_task_sets:read',
  AGENT_TASK_SETS_WRITE: 'admin:agent_task_sets:write',
  AGENT_SCOPE_POLICIES_READ: 'admin:agent_scope_policies:read',
  AGENT_SCOPE_POLICIES_WRITE: 'admin:agent_scope_policies:write',
  AGENT_TEMPLATES_PUBLISH: 'admin:agent_templates:publish',
  AGENT_BASELINES_READ: 'admin:agent_baselines:read',
  AGENT_BASELINES_WRITE: 'admin:agent_baselines:write',
  AGENT_BASELINES_APPLY: 'admin:agent_baselines:apply',
  AUTH_CONFIG_PLANS_READ: 'admin:auth_config_plans:read',
  AUTH_CONFIG_PLANS_CREATE: 'admin:auth_config_plans:create',
  AUTH_CONFIG_PLANS_APPLY: 'admin:auth_config_plans:apply',
  AUTH_CONFIG_PLANS_CANCEL: 'admin:auth_config_plans:cancel',
  BULK_PLANS_READ: 'admin:bulk_plans:read',
  BULK_PLANS_CREATE: 'admin:bulk_plans:create',
  BULK_PLANS_APPLY: 'admin:bulk_plans:apply',
  BULK_PLANS_PAUSE: 'admin:bulk_plans:pause',
  BULK_PLANS_RESUME: 'admin:bulk_plans:resume',

  // Admin Machine Access
  ADMIN_MACHINE_ACCESS_READ: 'admin:machine_access:read',
  ADMIN_MACHINE_ACCESS_WRITE: 'admin:machine_access:write',
  ADMIN_MACHINE_ACCESS_DELETE: 'admin:machine_access:delete',
  ADMIN_MACHINE_ACCESS_ALL: 'admin:machine_access:*',

  // Operational logs
  OPERATIONAL_LOGS_READ: 'admin:operational_logs:read',
  OPERATIONAL_LOGS_DETAIL_READ: 'admin:operational_logs:detail:read',
  OPERATIONAL_LOGS_ALL: 'admin:operational_logs:*',

  // Privacy-preserving support operations
  SUPPORT_OPS_REGISTRY_READ: 'admin:support_ops:registry:read',
  SUPPORT_OPS_AGGREGATE_READ: 'admin:support_ops:aggregate:read',
  SUPPORT_OPS_COHORTS_PREVIEW: 'admin:support_ops:cohorts:preview',
  SUPPORT_OPS_COHORTS_CREATE: 'admin:support_ops:cohorts:create',
  SUPPORT_OPS_ACTIONS_REQUEST: 'admin:support_ops:actions:request',
  SUPPORT_OPS_ACTIONS_APPROVE: 'admin:support_ops:actions:approve',
  SUPPORT_OPS_ACTIONS_EXECUTE: 'admin:support_ops:actions:execute',
  SUPPORT_OPS_ACTIONS_READ: 'admin:support_ops:actions:read',
  SUPPORT_OPS_BREAK_GLASS_REQUEST: 'admin:support_ops:break_glass:request',
  SUPPORT_OPS_BREAK_GLASS_REVEAL: 'admin:support_ops:break_glass:reveal',
  SUPPORT_OPS_ALL: 'admin:support_ops:*',

  // Security settings
  SECURITY_READ: 'admin:security:read',
  SECURITY_WRITE: 'admin:security:write',
  SECURITY_ALL: 'admin:security:*',

  // Verifiable Credential control plane
  VC_CREDENTIAL_PROFILES_READ: 'admin:vc:credential_profiles:read',
  VC_CREDENTIAL_PROFILES_WRITE: 'admin:vc:credential_profiles:write',
  VC_CREDENTIAL_PROFILES_PUBLISH: 'admin:vc:credential_profiles:publish',
  VC_CREDENTIAL_OFFERS_CREATE: 'admin:vc:credential_offers:create',
  VC_ALL: 'admin:vc:*',

  // Policy control plane
  POLICY_SIMULATE: 'admin:policy:simulate',
  FLOWS_VALIDATE: 'admin:flows:validate',
  FLOWS_COMPILE: 'admin:flows:compile',
  FLOWS_PUBLISH: 'admin:flows:publish',
  POLICY_REBAC_WRITE: 'admin:policy:rebac:write',
  POLICY_ALL: 'admin:policy:*',

  // IP allowlist
  IP_ALLOWLIST_READ: 'admin:ip_allowlist:read',
  IP_ALLOWLIST_WRITE: 'admin:ip_allowlist:write',
  IP_ALLOWLIST_DELETE: 'admin:ip_allowlist:delete',
  IP_ALLOWLIST_ALL: 'admin:ip_allowlist:*',

  // Session management
  SESSIONS_READ: 'admin:sessions:read',
  SESSIONS_REVOKE: 'admin:sessions:revoke',
  SESSIONS_ALL: 'admin:sessions:*',
} as const;

/**
 * Admin permission type (all possible values)
 */
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS] | string;

/**
 * Check if a set of permissions includes a specific permission
 *
 * Supports wildcard matching:
 * - "*" matches everything
 * - "admin:users:*" matches "admin:users:read", "admin:users:write", etc.
 */
export function hasAdminPermission(permissions: string[], required: string): boolean {
  // Check for wildcard
  if (permissions.includes('*')) {
    return true;
  }

  // Check exact match
  if (permissions.includes(required)) {
    return true;
  }

  // Compatibility ceilings for operation-level permissions. New route gates and Agent Grants
  // use the fine-grained permission, while existing coarse write roles remain an explicit upper
  // bound until role definitions are migrated.
  const compatibilityParent: Readonly<Record<string, string>> = {
    [ADMIN_PERMISSIONS.USERS_SUSPEND]: ADMIN_PERMISSIONS.USERS_WRITE,
    [ADMIN_PERMISSIONS.CLIENTS_CREATE]: ADMIN_PERMISSIONS.CLIENTS_WRITE,
    [ADMIN_PERMISSIONS.CLIENTS_UPDATE]: ADMIN_PERMISSIONS.CLIENTS_WRITE,
    [ADMIN_PERMISSIONS.CLIENTS_SECRET_ROTATE]: ADMIN_PERMISSIONS.CLIENTS_WRITE,
    [ADMIN_PERMISSIONS.SETTINGS_ASSURANCE_UPDATE]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
    [ADMIN_PERMISSIONS.SETTINGS_SECURITY_UPDATE]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
    [ADMIN_PERMISSIONS.SETTINGS_TOKEN_EXCHANGE_UPDATE]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
    [ADMIN_PERMISSIONS.SETTINGS_OAUTH_UPDATE]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
    [ADMIN_PERMISSIONS.SETTINGS_SESSION_UPDATE]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
    [ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
    [ADMIN_PERMISSIONS.POLICY_SIMULATE]: ADMIN_PERMISSIONS.ROLES_READ,
    [ADMIN_PERMISSIONS.FLOWS_VALIDATE]: ADMIN_PERMISSIONS.SETTINGS_READ,
    [ADMIN_PERMISSIONS.FLOWS_COMPILE]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
    [ADMIN_PERMISSIONS.FLOWS_PUBLISH]: ADMIN_PERMISSIONS.SETTINGS_WRITE,
  };
  const parent = compatibilityParent[required];
  if (parent && permissions.includes(parent)) return true;

  // Check wildcard patterns
  const parts = required.split(':');
  for (let i = parts.length - 1; i >= 0; i--) {
    const wildcardPattern = [...parts.slice(0, i), '*'].join(':');
    if (permissions.includes(wildcardPattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a set of permissions includes all of the required permissions
 */
export function hasAllAdminPermissions(permissions: string[], required: string[]): boolean {
  return required.every((perm) => hasAdminPermission(permissions, perm));
}

/**
 * Check if a set of permissions includes any of the required permissions
 */
export function hasAnyAdminPermission(permissions: string[], required: string[]): boolean {
  return required.some((perm) => hasAdminPermission(permissions, perm));
}
