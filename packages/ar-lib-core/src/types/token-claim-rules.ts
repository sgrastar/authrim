/**
 * Token Claim Rules Type Definitions
 *
 * This module contains type definitions for:
 * - Custom claim embedding rules for access/ID tokens
 * - ID-level resource permissions
 * - Token claim evaluation context and results
 *
 * Architecture:
 * - Token Embedding is an Authorization Result Cache, NOT Source of Truth
 * - Real-time permission changes require Phase 8.3 Check API
 * - All data is Non-PII (roles, permissions, metadata only)
 *
 * Evaluation Order:
 * - Rules are evaluated in ORDER BY priority DESC, created_at ASC
 * - Claim collision uses Last-Write-Wins policy
 */

import type { RuleCondition, CompoundCondition, ConditionOperator } from './policy-rules';

// =============================================================================
// Condition Fields for Token Claims
// =============================================================================

/**
 * Condition fields specific to token claim rules
 *
 * These extend the base condition fields from policy-rules:
 * - has_role: Check if user has a specific role
 * - has_permission: Check if user has a specific type-level permission
 * - org_type: Organization type classification
 * - org_id: Specific organization ID
 * - user_type: User type classification
 * - scope_contains: Check if requested scope contains a value
 * - idp_claim: Claim from IdP (evaluated in memory)
 * - email_domain_hash: Blind index of email domain
 */
export type ClaimConditionField =
  | 'has_role'
  | 'has_permission'
  | 'org_type'
  | 'org_id'
  | 'user_type'
  | 'scope_contains'
  | 'idp_claim'
  | 'email_domain_hash';

/**
 * Extended condition for token claim rules
 * Allows ClaimConditionField in addition to base fields
 */
export interface TokenClaimCondition {
  /** Field to evaluate */
  field: ClaimConditionField;
  /**
   * Path to IdP claim (for idp_claim field only)
   * Supports dot notation: "groups", "address.country"
   */
  claim_path?: string;
  /** Comparison operator */
  operator: ConditionOperator;
  /** Expected value to compare against */
  value: string | string[] | boolean | number;
}

/**
 * Compound condition for token claim rules
 */
export interface TokenClaimCompoundCondition {
  type: 'and' | 'or';
  conditions: (TokenClaimCondition | TokenClaimCompoundCondition)[];
}

// =============================================================================
// Action Types for Token Claims
// =============================================================================

/**
 * Action types for token claim rules
 *
 * @description
 * - add_claim: Add a static claim value
 * - add_claim_template: Add a claim with template interpolation ({{variable}})
 * - transform_idp_claim: Copy and transform IdP claim to token claim
 * - copy_from_context: Copy value from evaluation context
 * - conditional_value: Add claim with conditional value (if-then-else)
 */
export type TokenClaimActionType =
  | 'add_claim'
  | 'add_claim_template'
  | 'transform_idp_claim'
  | 'copy_from_context'
  | 'conditional_value';

/**
 * Token claim action definition
 */
export interface TokenClaimAction {
  /** Action type */
  type: TokenClaimActionType;

  /** Target claim name (for all action types) */
  claim_name: string;

  // For add_claim
  /** Static claim value (for add_claim) */
  claim_value?: string | number | boolean | string[];

  // For add_claim_template
  /**
   * Template string with {{variable}} placeholders
   * Available variables: user_type, org_id, org_type, client_id
   * Example: "Hello {{user_type}} from {{org_type}}"
   */
  template?: string;

  // For transform_idp_claim
  /**
   * Path to source IdP claim (dot notation)
   * Example: "groups", "address.country"
   */
  source_path?: string;
  /**
   * Optional transformation function
   * - lowercase: Convert to lowercase
   * - uppercase: Convert to uppercase
   * - prefix: Add prefix (requires transform_value)
   * - suffix: Add suffix (requires transform_value)
   * - join: Join array with delimiter (requires transform_value)
   */
  transform?: 'lowercase' | 'uppercase' | 'prefix' | 'suffix' | 'join';
  /** Value for transformation (e.g., prefix string, delimiter) */
  transform_value?: string;

  // For copy_from_context
  /**
   * Context field to copy
   * Available: org_id, org_type, user_type, roles, permissions
   */
  context_field?: string;

  // For conditional_value
  /** Condition for conditional_value action */
  condition?: TokenClaimCondition;
  /** Value if condition is true */
  if_true?: string | number | boolean;
  /** Value if condition is false */
  if_false?: string | number | boolean;
}

// =============================================================================
// Reserved Claims Protection
// =============================================================================

/**
 * OIDC/JWT reserved claims that cannot be overwritten by custom rules
 */
export const RESERVED_CLAIMS = [
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'jti',
  'nbf',
  'auth_time',
  'nonce',
  'at_hash',
  'c_hash',
  'acr',
  'amr',
  'azp',
] as const;

export type ReservedClaim = (typeof RESERVED_CLAIMS)[number];

/**
 * PII claim patterns that trigger warnings
 * These are not blocked but logged for audit
 */
export const PII_CLAIM_PATTERNS = [
  'email',
  'name',
  'phone',
  'address',
  'birthdate',
  'given_name',
  'family_name',
  'picture',
] as const;

// =============================================================================
// Token Claim Rule Definition
// =============================================================================

/**
 * Token type for rule targeting
 */
export type TokenType = 'access' | 'id' | 'both';

/**
 * Token claim rule definition
 *
 * Rules are evaluated in priority order (DESC), then created_at (ASC).
 * Each matching rule's actions are applied.
 * If stop_processing is true, evaluation stops after that rule.
 *
 * Claim Collision Policy:
 * - Last-Write-Wins: Same claim name is overwritten by later rule
 * - Collision is logged: [CLAIM_OVERRIDE] claim=X, old=Y, new=Z, rule=R
 */
export interface TokenClaimRule {
  /** Unique rule ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Rule name (unique within tenant) */
  name: string;
  /** Rule description */
  description?: string;

  /** Target token type */
  token_type: TokenType;

  /** Rule conditions (single or compound) */
  condition: TokenClaimCondition | TokenClaimCompoundCondition | RuleCondition | CompoundCondition;
  /** Actions to apply when conditions match */
  actions: TokenClaimAction[];

  /** Priority (higher = evaluated first, DESC order) */
  priority: number;
  /** Whether rule is active */
  is_active: boolean;
  /** Stop evaluating further rules after this one matches */
  stop_processing: boolean;

  /** Optional validity period start (UNIX seconds) */
  valid_from?: number;
  /** Optional validity period end (UNIX seconds) */
  valid_until?: number;

  /** Admin user ID who created */
  created_by?: string;
  /** Creation timestamp (UNIX seconds) */
  created_at: number;
  /** Last update timestamp (UNIX seconds) */
  updated_at: number;
}

/**
 * Token claim rule row from D1 database
 */
export interface TokenClaimRuleRow extends Omit<
  TokenClaimRule,
  'condition' | 'actions' | 'is_active' | 'stop_processing'
> {
  conditions_json: string;
  actions_json: string;
  is_active: number;
  stop_processing: number;
}

// =============================================================================
// ID-Level Resource Permission
// =============================================================================

/**
 * Subject type for resource permissions
 * - user: Direct user permission
 * - role: Permission inherited from role
 * - org: Permission inherited from organization membership
 */
export type ResourcePermissionSubjectType = 'user' | 'role' | 'org';

/**
 * Resource permission definition
 *
 * Enables fine-grained ID-level permissions like:
 * - documents:doc_123:read
 * - projects:proj_456:manage
 *
 * Note: ID-level scope format (resource:id:action) is a non-standard
 * OAuth 2.0 extension. Standard-compliant clients should read from
 * the authrim_resource_permissions claim.
 */
export interface ResourcePermission {
  /** Unique permission ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;

  /** Subject type (who has permission) */
  subject_type: ResourcePermissionSubjectType;
  /** Subject ID (user_id, role_id, or org_id) */
  subject_id: string;

  /** Resource type (e.g., 'documents', 'projects') */
  resource_type: string;
  /** Resource ID (e.g., 'doc_123', 'proj_456') */
  resource_id: string;

  /** Allowed actions (e.g., ['read', 'write', 'delete']) */
  actions: string[];

  /** Optional condition (JSON) */
  condition?: Record<string, unknown>;

  /** Expiration timestamp (UNIX seconds) */
  expires_at?: number;

  /** Whether permission is active */
  is_active: boolean;

  /** Admin or system that granted */
  granted_by?: string;
  /** Creation timestamp (UNIX seconds) */
  created_at: number;
  /** Last update timestamp (UNIX seconds) */
  updated_at: number;
}

/**
 * Resource permission row from D1 database
 */
export interface ResourcePermissionRow extends Omit<
  ResourcePermission,
  'actions' | 'condition' | 'is_active' | 'expires_at'
> {
  actions_json: string;
  condition_json: string | null;
  is_active: number;
  expires_at: number | null;
}

// =============================================================================
// Evaluation Context and Results
// =============================================================================

/**
 * Context for token claim evaluation
 * Contains all attributes available for condition evaluation
 */
export interface TokenClaimEvaluationContext {
  /** Tenant ID */
  tenant_id: string;
  /** User ID (subject) */
  subject_id: string;
  /** Client ID */
  client_id: string;
  /** Requested scope (space-separated) */
  scope: string;

  // RBAC context (from Phase 8.1)
  /** User's roles */
  roles: string[];
  /** User's type-level permissions */
  permissions: string[];

  // Organization context
  /** Current organization ID (if scoped) */
  org_id?: string;
  /** Organization type */
  org_type?: string;

  // User attributes
  /** User type classification */
  user_type?: string;
  /** Hashed email domain */
  email_domain_hash?: string;

  // IdP claims (evaluated in memory, not stored)
  /** Raw claims from IdP */
  idp_claims?: Record<string, unknown>;
}

/**
 * Result of token claim evaluation
 */
export interface TokenClaimEvaluationResult {
  /** IDs of rules that matched */
  matched_rules: string[];

  /** Custom claims to add to token */
  claims_to_add: Record<string, unknown>;

  /** Claim overrides that occurred (for audit) */
  claim_overrides: Array<{
    claim_name: string;
    old_value: unknown;
    new_value: unknown;
    rule_id: string;
  }>;

  /** Whether evaluation was truncated due to limits */
  truncated: boolean;
  /** Reason for truncation */
  truncation_reason?: string;
}

/**
 * Combined result for permission embedding
 */
export interface PermissionEmbeddingResult {
  /** Type-level permissions (2-part: resource:action) */
  type_permissions: string[];
  /** ID-level permissions (3-part: resource:id:action) */
  resource_permissions: string[];
  /** Whether results were truncated */
  truncated: boolean;
  /** Truncation details */
  truncation_details?: {
    type_limit: number;
    resource_limit: number;
    type_actual: number;
    resource_actual: number;
  };
}

// =============================================================================
// Token Bloat Protection Settings
// =============================================================================

/**
 * Token embedding limits configuration
 */
export interface TokenEmbeddingLimits {
  /** Maximum type-level permissions per token (default: 50) */
  max_embedded_permissions: number;
  /** Maximum ID-level permissions per token (default: 100) */
  max_resource_permissions: number;
  /** Maximum custom claims per token (default: 20) */
  max_custom_claims: number;
}

/**
 * Default token embedding limits
 */
export const DEFAULT_TOKEN_EMBEDDING_LIMITS: TokenEmbeddingLimits = {
  max_embedded_permissions: 50,
  max_resource_permissions: 100,
  max_custom_claims: 20,
};

// =============================================================================
// API Types
// =============================================================================

/**
 * Input for creating/updating a token claim rule
 */
export interface TokenClaimRuleInput {
  name: string;
  description?: string;
  token_type?: TokenType;
  condition: TokenClaimCondition | TokenClaimCompoundCondition | RuleCondition | CompoundCondition;
  actions: TokenClaimAction[];
  priority?: number;
  is_active?: boolean;
  stop_processing?: boolean;
  valid_from?: number;
  valid_until?: number;
}

/**
 * Input for creating/updating a resource permission
 */
export interface ResourcePermissionInput {
  subject_type: ResourcePermissionSubjectType;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  actions: string[];
  condition?: Record<string, unknown>;
  expires_at?: number;
  is_active?: boolean;
}

/**
 * Test context for token claim rule evaluation (Admin API)
 */
export interface TokenClaimRuleTestContext {
  subject_id: string;
  client_id: string;
  scope: string;
  roles?: string[];
  permissions?: string[];
  org_id?: string;
  org_type?: string;
  user_type?: string;
  email_domain_hash?: string;
  idp_claims?: Record<string, unknown>;
}

/**
 * Result of single token claim rule test
 */
export interface TokenClaimRuleTestResult {
  /** Whether the rule matched */
  matched: boolean;
  /** Condition evaluation details */
  condition_results: Array<{
    field: string;
    matched: boolean;
    actual?: unknown;
    expected?: unknown;
  }>;
  /** Claims that would be added if rule matched */
  would_add_claims: Record<string, unknown>;
}

/**
 * Permission check request
 */
export interface ResourcePermissionCheckRequest {
  subject_type: ResourcePermissionSubjectType;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  action: string;
}

/**
 * Permission check response
 */
export interface ResourcePermissionCheckResponse {
  allowed: boolean;
  permission_id?: string;
  reason?: string;
}
