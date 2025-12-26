/**
 * Common Contract Types
 *
 * Shared types used across TenantContract and ClientContract.
 */

import type { SecurityTier, ComplianceModule } from '../../schemas/flow-ui';

// Re-export for convenience
export type { SecurityTier, ComplianceModule };

// =============================================================================
// Contract Lifecycle
// =============================================================================

/**
 * Contract lifecycle status.
 *
 * Status flow:
 * draft → pending_review → active → deprecated → archived
 *                ↓
 *              draft (rejection)
 */
export type ContractStatus =
  | 'draft' // Being edited, not yet in use
  | 'pending_review' // Awaiting approval
  | 'active' // Currently in use
  | 'deprecated' // Scheduled for removal
  | 'archived'; // No longer in use

/**
 * Valid status transitions.
 * Maps current status to allowed next statuses.
 */
export const CONTRACT_STATUS_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  draft: ['pending_review', 'archived'],
  pending_review: ['draft', 'active', 'archived'],
  active: ['deprecated'],
  deprecated: ['active', 'archived'],
  archived: [],
} as const;

/**
 * Record of a status transition.
 */
export interface StatusTransition {
  /** Previous status */
  from: ContractStatus;
  /** New status */
  to: ContractStatus;
  /** When the transition occurred (ISO 8601) */
  timestamp: string;
  /** User who made the transition */
  actor: string;
  /** Optional reason for the transition */
  reason?: string;
}

// =============================================================================
// Contract Metadata
// =============================================================================

/**
 * Contract metadata - common to all contract types.
 * Includes lifecycle management fields.
 */
export interface ContractMetadata {
  // --- Basic fields ---
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Creator user ID or 'system' for preset-based */
  createdBy: string;
  /** Last modifier user ID */
  updatedBy?: string;
  /** Optional notes */
  notes?: string;

  // --- Lifecycle fields ---
  /** Current lifecycle status */
  status: ContractStatus;
  /** History of status transitions */
  statusHistory?: StatusTransition[];
  /** When the contract was activated (ISO 8601) */
  activatedAt?: string;
  /** When the contract was deprecated (ISO 8601) */
  deprecatedAt?: string;
  /** When the contract was archived (ISO 8601) */
  archivedAt?: string;
}

// =============================================================================
// Status Transition Types
// =============================================================================

/**
 * Request to transition contract status.
 */
export interface StatusTransitionRequest {
  /** Target status */
  targetStatus: ContractStatus;
  /** Reason for transition */
  reason?: string;
  /** Schedule transition for later (ISO 8601) */
  scheduledAt?: string;
}

/**
 * Result of a status transition.
 */
export interface StatusTransitionResult {
  /** Whether transition succeeded */
  success: boolean;
  /** Previous status */
  previousStatus: ContractStatus;
  /** New status (same as previous if failed) */
  newStatus: ContractStatus;
  /** Error message if failed */
  error?: string;
  /** Transition record */
  transition?: StatusTransition;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: ContractStatus, to: ContractStatus): boolean {
  return CONTRACT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Get allowed transitions from a status.
 */
export function getAllowedTransitions(status: ContractStatus): ContractStatus[] {
  return [...CONTRACT_STATUS_TRANSITIONS[status]];
}

/**
 * Create default metadata for a new contract.
 */
export function createDefaultMetadata(createdBy: string): ContractMetadata {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    updatedAt: now,
    createdBy,
    status: 'draft',
    statusHistory: [],
  };
}

// =============================================================================
// Scope and Claim Definitions
// =============================================================================

/**
 * Custom scope definition.
 */
export interface CustomScopeDefinition {
  /** Scope name (e.g., 'organization:read') */
  name: string;
  /** Display name for consent screen */
  displayName: string;
  /** Description for consent screen */
  description: string;
  /** Claims included in this scope */
  claims?: string[];
  /** Whether this scope is required */
  required?: boolean;
}

/**
 * Custom claim definition.
 */
export interface CustomClaimDefinition {
  /** Claim name (e.g., 'department') */
  name: string;
  /** Display name */
  displayName: string;
  /** Description */
  description?: string;
  /** Value type */
  valueType: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** Source of claim value */
  source: ClaimSource;
  /** Whether this claim contains PII */
  isPii?: boolean;
}

/**
 * Claim source configuration.
 */
export type ClaimSource =
  | { type: 'user_attribute'; attribute: string }
  | { type: 'organization_attribute'; attribute: string }
  | { type: 'static'; value: unknown }
  | { type: 'computed'; expression: string };

/**
 * Claim mapping for token customization.
 */
export interface ClaimMapping {
  /** Source claim name */
  source: string;
  /** Target claim name in token */
  target: string;
  /** Optional transformation */
  transform?: ClaimTransform;
}

/**
 * Claim transformation.
 */
export type ClaimTransform =
  | { type: 'rename' }
  | { type: 'format'; pattern: string }
  | { type: 'prefix'; value: string }
  | { type: 'map'; mapping: Record<string, unknown> };

// =============================================================================
// Auth Method Types
// =============================================================================

/**
 * Authentication method availability at tenant level.
 */
export type AuthMethodAvailability =
  | 'enabled' // Available for clients to use
  | 'disabled' // Not available
  | 'required'; // Must be used by all clients

/**
 * MFA method types.
 */
export type MfaMethod = 'totp' | 'passkey' | 'sms' | 'email';

// =============================================================================
// Algorithm Types
// =============================================================================

/**
 * JWT signing algorithms.
 */
export type SigningAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'PS256'
  | 'PS384'
  | 'PS512';

/**
 * JWE key encryption algorithms.
 */
export type KeyEncryptionAlgorithm =
  | 'RSA-OAEP'
  | 'RSA-OAEP-256'
  | 'ECDH-ES'
  | 'ECDH-ES+A128KW'
  | 'ECDH-ES+A256KW';

/**
 * JWE content encryption algorithms.
 */
export type ContentEncryptionAlgorithm =
  | 'A128GCM'
  | 'A192GCM'
  | 'A256GCM'
  | 'A128CBC-HS256'
  | 'A256CBC-HS512';

// =============================================================================
// OIDC Types
// =============================================================================

/**
 * OAuth 2.0 response types.
 */
export type ResponseType = 'code' | 'token' | 'id_token';

/**
 * Client authentication methods.
 */
export type ClientAuthMethod =
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'private_key_jwt'
  | 'tls_client_auth'
  | 'none';

// =============================================================================
// Requirement Levels
// =============================================================================

/**
 * Feature requirement level.
 */
export type RequirementLevel = 'required' | 'recommended' | 'optional' | 'disabled';

/**
 * PII storage policy.
 */
export type PiiStoragePolicy = 'local_only' | 'replicated' | 'encrypted_replicated';

/**
 * Audit log detail level.
 */
export type AuditDetailLevel = 'minimal' | 'standard' | 'detailed';

// =============================================================================
// Contract Extensions
// =============================================================================

/**
 * Extension categories for future features.
 *
 * This allows adding new configuration categories without breaking changes.
 * New features like AI Agent, Verifiable Credentials, etc. can be added here.
 */
export interface ContractExtensions {
  /**
   * Verifiable Credentials settings.
   * For W3C VC / DID-based credential issuance and verification.
   */
  vc?: VerifiableCredentialsExtension;

  /**
   * AI Agent settings.
   * For AI-powered authentication and authorization features.
   */
  aiAgent?: AiAgentExtension;

  /**
   * Custom tenant-specific extensions.
   * Allows tenants to store arbitrary configuration.
   */
  custom?: Record<string, unknown>;
}

/**
 * Verifiable Credentials extension settings.
 */
export interface VerifiableCredentialsExtension {
  /** VC issuance enabled */
  issuanceEnabled?: boolean;
  /** VC verification enabled */
  verificationEnabled?: boolean;
  /** Supported credential types */
  supportedCredentialTypes?: string[];
  /** DID methods supported */
  supportedDidMethods?: string[];
  /** Credential format */
  credentialFormat?: 'jwt_vc' | 'ldp_vc' | 'sd_jwt';
}

/**
 * AI Agent extension settings.
 */
export interface AiAgentExtension {
  /** AI-powered risk scoring enabled */
  riskScoringEnabled?: boolean;
  /** AI-powered fraud detection enabled */
  fraudDetectionEnabled?: boolean;
  /** AI model version */
  modelVersion?: string;
  /** Custom prompts/rules */
  customRules?: string[];
}
