/**
 * Admin API Types
 *
 * This module contains type definitions for admin operations including:
 * - Authentication context
 * - Audit logging
 * - Signing key management
 */

import type { UserType } from './rbac';

export type AdminTransportPrincipalType =
  | 'setup_tool'
  | 'admin_ui_bff'
  | 'automation'
  | 'ci'
  | 'mcp_server'
  | 'ai_agent'
  | 'internal_service'
  | 'integration';

export interface AdminTransportAuthContext {
  /** Transport authentication method used by a trusted proxy/workload hop */
  authMethod: 'machine_access_token';
  /** Workload actor type */
  actorType: 'machine';
  /** Stable machine principal identifier */
  actorId: string;
  /** Machine principal type */
  principalType?: AdminTransportPrincipalType;
  /** Machine credential identifier */
  credentialId: string;
  /** OAuth client_id bound to the machine principal */
  clientId?: string;
  /** Client authentication method used before issuing this access token */
  clientAuthMethod?: 'private_key_jwt' | 'service_binding' | 'none';
  /** Credential strength classification */
  credentialStrength?: 'asymmetric_key' | 'service_binding' | 'none';
  /** Whether the token is sender constrained with DPoP/mTLS */
  senderConstrained?: boolean;
  /** Tenant scope carried by the machine access token */
  tenantScope?: string[];
  /** Machine token permissions/scopes */
  permissions?: string[];
}

/**
 * Admin authentication context
 * Contains authenticated user information and authentication method
 *
 * For Admin/EndUser separation, this context is populated from DB_ADMIN:
 * - admin_users table
 * - admin_sessions table (for session auth)
 * - admin_role_assignments + admin_roles (for permissions)
 */
export interface AdminAuthContext {
  /** Admin user ID (from admin_users table) */
  userId: string;
  /** Authentication method used (Bearer token or session) */
  authMethod: 'bearer' | 'session' | 'machine_access_token';
  /** Authenticated actor type for audit and policy decisions */
  actorType?: 'human' | 'machine' | 'agent' | 'internal_service' | 'bootstrap';
  /** Stable actor identifier */
  actorId?: string;
  /** Credential identifier for machine actors */
  credentialId?: string;
  /** Machine principal type */
  principalType?: AdminTransportPrincipalType;
  /** OAuth client_id bound to the machine principal */
  clientId?: string;
  /** Transport/workload authentication context for BFF or service-binding hops */
  transportAuth?: AdminTransportAuthContext;
  /** Client authentication method used before issuing this access token */
  clientAuthMethod?: 'private_key_jwt' | 'service_binding' | 'none';
  /** Credential strength classification */
  credentialStrength?: 'asymmetric_key' | 'service_binding' | 'none';
  /** Whether the token is sender constrained with DPoP/mTLS */
  senderConstrained?: boolean;
  /** Agent authorization evidence attached by the Admin API token owner. */
  agentMode?: 'mode_a' | 'mode_b';
  agentAssurance?: 'public_client_transaction' | 'confidential_client' | 'machine_key';
  agentGrantId?: string;
  agentGrantGeneration?: number;
  agentConsentVersion?: number;
  sourceTokenJti?: string;
  correlationId?: string;
  /** Tenant scope carried by a machine access token */
  tenantScope?: string[];
  /** User roles (e.g., ['admin', 'super_admin']) */
  roles: string[];
  // ==========================================================================
  // Admin/EndUser Separation Extensions
  // ==========================================================================
  /** Tenant ID for multi-tenant support */
  tenantId?: string;
  /** Admin user email (for audit logging) */
  email?: string;
  /** Aggregated permissions from all assigned roles */
  permissions?: string[];
  /** Highest hierarchy level among assigned roles */
  hierarchyLevel?: number;
  /** Whether MFA has been verified for this session */
  mfaVerified?: boolean;
  /** Most recent primary/MFA authentication instant in epoch milliseconds. */
  authenticationTimeMs?: number;
  /** Admin session ID (for session auth) */
  sessionId?: string;
  /** Absolute expiry of the backing Admin session in epoch milliseconds. */
  sessionExpiresAt?: number;
  // ==========================================================================
  // RBAC Extensions (Phase 1) - Legacy, kept for backward compatibility
  // ==========================================================================
  /** User type classification (for UI/logging purposes) */
  user_type?: UserType;
  /** Primary organization ID */
  org_id?: string;
}

/**
 * Audit log entry for tracking admin operations
 */
export interface AuditLogEntry {
  /** Unique identifier for this audit log entry */
  id: string;
  /** Tenant ID for multi-tenant isolation (default: 'default') */
  tenantId: string;
  /** User ID who performed the action */
  userId: string;
  /** Action performed (e.g., 'signing_keys.rotate.emergency') */
  action: string;
  /** Resource affected (e.g., 'signing_keys') */
  resource: string;
  /** Resource ID (e.g., kid of the key) */
  resourceId: string;
  /** IP address of the client */
  ipAddress: string;
  /** User agent of the client */
  userAgent: string;
  /** Additional metadata as JSON string */
  metadata: string;
  /** Severity level: info, warning, critical */
  severity: 'info' | 'warning' | 'critical';
  /** Timestamp of the action (Unix milliseconds) */
  createdAt: number;
}

/**
 * Key status enumeration
 * - active: Currently used for signing new tokens
 * - overlap: Grace period for verifying old tokens (24h after rotation)
 * - revoked: Immediately invalid, removed from JWKS
 */
export type KeyStatus = 'active' | 'overlap' | 'revoked';

/**
 * Signing key information response
 */
export interface SigningKeyInfo {
  /** Key ID (kid) */
  kid: string;
  /** Current status of the key */
  status: KeyStatus;
  /** When the key was created (Unix milliseconds) */
  createdAt: number;
  /** When the key expires (Unix milliseconds), undefined for active keys */
  expiresAt?: number;
  /** When the key was revoked (Unix milliseconds), only for revoked keys */
  revokedAt?: number;
  /** Reason for revocation, only for revoked keys */
  revokedReason?: string;
}

/**
 * Request body for normal key rotation
 */
export interface KeyRotationRequest {
  // No parameters needed for normal rotation
}

/**
 * Request body for emergency key rotation
 */
export interface EmergencyRotationRequest {
  /** Reason for emergency rotation (minimum 10 characters) */
  reason: string;
}

/**
 * Response for key rotation operations
 */
export interface KeyRotationResponse {
  /** Whether the operation was successful */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** ID of the revoked key */
  revokedKeyId: string;
  /** ID of the new active key */
  newKeyId: string;
  /** Optional warning message */
  warning?: string;
}

/**
 * Response for key status endpoint
 */
export interface SigningKeysStatusResponse {
  /** List of all keys (active, overlap, and recently revoked) */
  keys: SigningKeyInfo[];
  /** ID of the currently active key */
  activeKeyId: string;
  /** When the last rotation occurred (Unix milliseconds) */
  lastRotation: number;
}
