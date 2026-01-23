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
}

/**
 * Admin role update input
 */
export interface AdminRoleUpdateInput {
  display_name?: string | null;
  description?: string | null;
  permissions?: string[];
  hierarchy_level?: number;
}

// =============================================================================
// Admin Role Assignment
// =============================================================================

/**
 * Scope type for role assignment
 * - global: Role applies to all tenants (super_admin only)
 * - tenant: Role applies to specific tenant
 * - org: Role applies to specific organization within tenant
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
  /** Scope ID (org_id if scope_type = 'org') */
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
  /** Timestamp (Unix milliseconds) */
  created_at: number;
}

/**
 * Admin audit log creation input
 */
export interface AdminAuditLogCreateInput {
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
  USERS_DELETE: 'admin:users:delete',
  USERS_UNLOCK: 'admin:users:unlock',
  USERS_ALL: 'admin:users:*',

  // Client management
  CLIENTS_READ: 'admin:clients:read',
  CLIENTS_WRITE: 'admin:clients:write',
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
  SETTINGS_ALL: 'admin:settings:*',

  // Audit log (EndUser audit)
  AUDIT_READ: 'admin:audit:read',
  AUDIT_ALL: 'admin:audit:*',

  // Admin audit log (Admin operations in DB_ADMIN)
  ADMIN_AUDIT_READ: 'admin:admin_audit:read',
  ADMIN_AUDIT_ALL: 'admin:admin_audit:*',

  // Security settings
  SECURITY_READ: 'admin:security:read',
  SECURITY_WRITE: 'admin:security:write',
  SECURITY_ALL: 'admin:security:*',

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
