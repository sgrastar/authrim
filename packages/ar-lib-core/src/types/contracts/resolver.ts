/**
 * Policy Resolver Types
 *
 * Interfaces and types for resolving policies from TenantContract + ClientContract.
 * The PolicyResolver service merges these contracts into a ResolvedPolicy at runtime.
 */

import type { TenantContract } from './tenant';
import type { ClientContract } from './client';
import type { ResolvedPolicy } from './resolved';
import type { ContractError, ContractWarning, PolicyConflict } from './errors';

// =============================================================================
// Resolution Options
// =============================================================================

/**
 * Options for policy resolution.
 */
export interface PolicyResolutionOptions {
  /** Include debug information in result */
  includeDebug?: boolean;
  /** Override scopes for testing */
  scopeOverride?: string[];
  /** Use cached policy if available */
  useCache?: boolean;
  /** Force cache refresh */
  forceRefresh?: boolean;
  /** Requested ACR values */
  acrValues?: string[];
  /** Requested scopes from authorize request */
  requestedScopes?: string[];
}

// =============================================================================
// Resolution Results
// =============================================================================

/**
 * Result of policy resolution.
 * Discriminated union based on success.
 */
export type PolicyResolutionResult = PolicyResolutionSuccess | PolicyResolutionFailure;

/**
 * Successful policy resolution.
 */
export interface PolicyResolutionSuccess {
  success: true;
  /** Resolved policy */
  policy: ResolvedPolicy;
  /** Debug information (if requested) */
  debug?: PolicyResolutionDebug;
  /** Warnings during resolution */
  warnings?: ContractWarning[];
}

/**
 * Failed policy resolution.
 */
export interface PolicyResolutionFailure {
  success: false;
  /** Error that caused the failure */
  error: ContractError;
  /** Partial policy (if partially resolved) */
  partialPolicy?: Partial<ResolvedPolicy>;
}

/**
 * Debug information for policy resolution.
 */
export interface PolicyResolutionDebug {
  /** Resolution steps executed */
  steps: PolicyResolutionStep[];
  /** Total resolution time in milliseconds */
  durationMs: number;
  /** Whether result was from cache */
  cacheHit: boolean;
  /** Cache key used */
  cacheKey?: string;
  /** Conflicts detected during resolution */
  conflicts?: PolicyConflict[];
}

/**
 * Single step in policy resolution.
 */
export interface PolicyResolutionStep {
  /** Step name/description */
  step: string;
  /** Input values for this step */
  input: Record<string, unknown>;
  /** Output values from this step */
  output: Record<string, unknown>;
  /** Duration of this step in milliseconds */
  durationMs: number;
  /** Whether this step made changes */
  changed: boolean;
}

// =============================================================================
// Validation Results
// =============================================================================

/**
 * Result of validating client against tenant.
 */
export interface ContractValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validation errors */
  errors: ContractError[];
  /** Validation warnings */
  warnings: ContractWarning[];
  /** Fields that were validated */
  validatedFields?: string[];
  /** Fields that were skipped */
  skippedFields?: string[];
}

/**
 * Result of validating a flow against policy.
 */
export interface FlowPolicyValidationResult {
  /** Whether flow is valid against policy */
  valid: boolean;
  /** Policy violations found */
  violations: PolicyViolation[];
  /** Warnings (non-blocking issues) */
  warnings: PolicyViolationWarning[];
}

/**
 * Policy violation in a flow.
 */
export interface PolicyViolation {
  /** Violation type */
  type: PolicyViolationType;
  /** Node ID that caused the violation */
  nodeId?: string;
  /** Node type */
  nodeType?: string;
  /** Violation message (user-friendly) */
  message: string;
  /** Source of the policy constraint */
  source: 'tenant' | 'client' | 'security_tier';
  /** Suggested fix */
  suggestion?: string;
  /** Severity */
  severity: 'error' | 'critical';
}

/**
 * Types of policy violations.
 */
export type PolicyViolationType =
  | 'forbidden_auth_method'
  | 'forbidden_capability'
  | 'missing_mfa'
  | 'missing_consent'
  | 'security_tier_mismatch'
  | 'scope_not_allowed'
  | 'forbidden_response_type'
  | 'pkce_required'
  | 'par_required'
  | 'missing_required_node';

/**
 * Policy violation warning (non-blocking).
 */
export interface PolicyViolationWarning {
  /** Warning type */
  type: string;
  /** Node ID (if applicable) */
  nodeId?: string;
  /** Warning message */
  message: string;
  /** Suggestion */
  suggestion?: string;
}

// =============================================================================
// PolicyResolver Interface
// =============================================================================

/**
 * PolicyResolver service interface.
 *
 * Responsible for:
 * 1. Resolving TenantContract + ClientContract into ResolvedPolicy
 * 2. Validating client settings against tenant policy
 * 3. Validating flows against resolved policy
 */
export interface PolicyResolver {
  /**
   * Resolve policy from tenant and client contracts.
   *
   * @param tenant - Tenant contract (policy)
   * @param client - Client contract (profile)
   * @param options - Resolution options
   * @returns Resolved policy or error
   */
  resolve(
    tenant: TenantContract,
    client: ClientContract,
    options?: PolicyResolutionOptions
  ): Promise<PolicyResolutionResult>;

  /**
   * Validate client contract against tenant contract.
   *
   * @param tenant - Tenant contract
   * @param client - Client contract to validate
   * @returns Validation result
   */
  validateClientAgainstTenant(
    tenant: TenantContract,
    client: ClientContract
  ): Promise<ContractValidationResult>;

  /**
   * Validate a flow against resolved policy.
   *
   * @param policy - Resolved policy
   * @param flowId - Flow ID to validate
   * @returns Flow validation result
   */
  validateFlowAgainstPolicy(
    policy: ResolvedPolicy,
    flowId: string
  ): Promise<FlowPolicyValidationResult>;

  /**
   * Get available options for flow designer based on policy.
   *
   * @param policy - Resolved policy
   * @returns Available nodes, actions, and constraints
   */
  getAvailableOptions(policy: ResolvedPolicy): Promise<FlowDesignerOptions>;

  /**
   * Preview the impact of a policy change.
   *
   * @param currentPolicy - Current resolved policy
   * @param proposedChanges - Proposed changes
   * @returns Impact analysis
   */
  previewPolicyChange(
    currentPolicy: ResolvedPolicy,
    proposedChanges: Partial<TenantContract | ClientContract>
  ): Promise<PolicyChangeImpact>;
}

// =============================================================================
// Flow Designer Options
// =============================================================================

/**
 * Available options for flow designer based on policy.
 */
export interface FlowDesignerOptions {
  /** Available authentication methods */
  availableAuthMethods: AuthMethodOption[];
  /** Available capability types */
  availableCapabilities: CapabilityOption[];
  /** Available scopes */
  availableScopes: ScopeOption[];
  /** Required nodes that must be in the flow */
  requiredNodes: RequiredNode[];
  /** Forbidden nodes that cannot be used */
  forbiddenNodes: ForbiddenNode[];
  /** Security constraints */
  securityConstraints: SecurityConstraint[];
}

/**
 * Authentication method option.
 */
export interface AuthMethodOption {
  /** Method ID */
  id: string;
  /** Display name */
  displayName: string;
  /** Whether available */
  available: boolean;
  /** Reason if not available */
  disabledReason?: string;
  /** Whether required */
  required: boolean;
  /** Priority/preference order */
  priority?: number;
}

/**
 * Capability option.
 */
export interface CapabilityOption {
  /** Capability type */
  type: string;
  /** Display name */
  displayName: string;
  /** Whether available */
  available: boolean;
  /** Reason if not available */
  disabledReason?: string;
  /** Category */
  category: string;
}

/**
 * Scope option.
 */
export interface ScopeOption {
  /** Scope name */
  name: string;
  /** Display name */
  displayName: string;
  /** Whether available */
  available: boolean;
  /** Whether included by default */
  default: boolean;
  /** Whether requires consent */
  requiresConsent: boolean;
}

/**
 * Required node in flow.
 */
export interface RequiredNode {
  /** Node type */
  type: string;
  /** Reason required */
  reason: string;
  /** Constraint source */
  source: 'tenant' | 'client' | 'security_tier';
}

/**
 * Forbidden node in flow.
 */
export interface ForbiddenNode {
  /** Node type */
  type: string;
  /** Reason forbidden */
  reason: string;
  /** Constraint source */
  source: 'tenant' | 'client' | 'security_tier';
}

/**
 * Security constraint.
 */
export interface SecurityConstraint {
  /** Constraint type */
  type: 'pkce_required' | 'par_required' | 'mfa_required' | 'consent_required';
  /** Whether enforced */
  enforced: boolean;
  /** Reason for constraint */
  reason?: string;
}

// =============================================================================
// Policy Change Impact
// =============================================================================

/**
 * Impact analysis of a policy change.
 */
export interface PolicyChangeImpact {
  /** Whether change is safe to apply */
  safe: boolean;
  /** Breaking changes */
  breakingChanges: BreakingChange[];
  /** Affected clients */
  affectedClients: AffectedClientSummary[];
  /** Total affected users estimate */
  estimatedAffectedUsers: number;
  /** Warnings */
  warnings: string[];
  /** Recommended actions */
  recommendations: string[];
}

/**
 * Breaking change in policy.
 */
export interface BreakingChange {
  /** Field path */
  field: string;
  /** Change type */
  changeType: 'removed' | 'restricted' | 'required';
  /** Old value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** Impact description */
  impact: string;
}

/**
 * Summary of affected client.
 */
export interface AffectedClientSummary {
  /** Client ID */
  clientId: string;
  /** Client name */
  clientName?: string;
  /** Impact level */
  impactLevel: 'none' | 'low' | 'medium' | 'high' | 'breaking';
  /** Affected settings */
  affectedSettings: string[];
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if resolution result is successful.
 */
export function isResolutionSuccess(
  result: PolicyResolutionResult
): result is PolicyResolutionSuccess {
  return result.success === true;
}

/**
 * Check if resolution result is a failure.
 */
export function isResolutionFailure(
  result: PolicyResolutionResult
): result is PolicyResolutionFailure {
  return result.success === false;
}
