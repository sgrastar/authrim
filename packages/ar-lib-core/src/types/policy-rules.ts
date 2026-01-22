/**
 * Policy Rules Type Definitions
 *
 * This module contains type definitions for dynamic role assignment rules
 * and policy evaluation:
 * - Rule conditions and operators
 * - Rule actions (assign_role, join_org, deny)
 * - OIDC error codes for deny actions
 * - Role assignment rule structure
 * - Organization domain mapping
 */

import type { ScopeType } from './rbac';

// =============================================================================
// Condition Types
// =============================================================================

/**
 * Condition operators for rule evaluation
 */
export type ConditionOperator =
  | 'eq' // Equals
  | 'ne' // Not equals
  | 'in' // Value in array
  | 'not_in' // Value not in array
  | 'contains' // Array contains value
  | 'exists' // Attribute exists (non-null)
  | 'not_exists' // Attribute does not exist (null)
  | 'regex'; // Regex match (for strings)

/**
 * Condition field types (all Non-PII)
 *
 * These are the fields that can be used in rule conditions:
 * - email_domain_hash: Blind index of email domain
 * - idp_claim: Claim from IdP (evaluated in memory from raw_attributes)
 * - email_verified: Boolean flag from users_core
 * - provider_id: External IdP provider identifier
 * - user_type: User type classification
 */
export type ConditionField =
  | 'email_domain_hash'
  | 'idp_claim'
  | 'email_verified'
  | 'provider_id'
  | 'user_type';

/**
 * Single rule condition
 */
export interface RuleCondition {
  /** Field to evaluate */
  field: ConditionField;
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
 * Compound condition (AND/OR)
 * Supports recursive nesting for complex logic
 */
export interface CompoundCondition {
  /** Logical operator */
  type: 'and' | 'or';
  /** Child conditions (can be nested) */
  conditions: (RuleCondition | CompoundCondition)[];
}

// =============================================================================
// Action Types
// =============================================================================

/**
 * OIDC error codes for deny actions
 * Maps to standard OIDC/OAuth2 error responses
 */
export type DenyErrorCode =
  | 'access_denied' // RFC 6749 - Resource owner denied request
  | 'interaction_required' // OIDC Core - Requires user interaction
  | 'login_required'; // OIDC Core - Requires re-authentication

/**
 * Rule action definition
 */
export interface RuleAction {
  /** Action type */
  type: 'assign_role' | 'join_org' | 'set_attribute' | 'deny';

  // For assign_role
  /** Role ID to assign */
  role_id?: string;
  /** Scope type for the role */
  scope_type?: ScopeType;
  /**
   * Scope target
   * - 'auto': Use matched organization from org_domain_mappings
   * - Specific value: e.g., 'org:org_123'
   */
  scope_target?: string | 'auto';

  // For join_org
  /**
   * Organization ID to join
   * - 'auto': Use matched organization from email_domain_hash
   * - Specific value: e.g., 'org_123'
   */
  org_id?: string | 'auto';
  /** Membership type when joining */
  membership_type?: 'member' | 'admin' | 'owner';

  // For set_attribute
  /** Attribute name to set */
  attribute_name?: string;
  /** Attribute value to set */
  attribute_value?: string;

  // For deny
  /**
   * OIDC error code for deny action
   * Default: 'access_denied'
   */
  deny_code?: DenyErrorCode;
  /** Human-readable error description */
  deny_description?: string;
}

// =============================================================================
// Role Assignment Rule
// =============================================================================

/**
 * Role assignment rule definition
 *
 * Rules are evaluated in priority order (DESC).
 * Each matching rule's actions are applied.
 * If stop_processing is true, evaluation stops after that rule.
 */
export interface RoleAssignmentRule {
  /** Unique rule ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Rule name (unique within tenant) */
  name: string;
  /** Rule description */
  description?: string;

  /** Target role ID (for backward compatibility) */
  role_id: string;
  /** Default scope type */
  scope_type: ScopeType;
  /** Default scope target */
  scope_target: string;

  /** Rule conditions (single or compound) */
  condition: RuleCondition | CompoundCondition;
  /** Actions to apply when conditions match */
  actions: RuleAction[];

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
 * Role assignment rule row from D1 database
 * JSON fields are stored as strings
 */
export interface RoleAssignmentRuleRow extends Omit<
  RoleAssignmentRule,
  'condition' | 'actions' | 'is_active' | 'stop_processing'
> {
  conditions_json: string;
  actions_json: string;
  is_active: number;
  stop_processing: number;
}

// =============================================================================
// Organization Domain Mapping
// =============================================================================

/**
 * Organization domain mapping
 * Links email domains (hashed) to organizations for JIT auto-join
 */
export interface OrgDomainMapping {
  /** Unique mapping ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;

  /** Hashed email domain (HMAC-SHA256) */
  domain_hash: string;
  /** Key version used for hashing (for rotation) */
  domain_hash_version: number;

  /** Target organization ID */
  org_id: string;

  /** Whether auto-join is enabled */
  auto_join_enabled: boolean;
  /** Default membership type on join */
  membership_type: 'member' | 'admin' | 'owner';
  /** Optional: auto-assign this role on join */
  auto_assign_role_id?: string;

  /** Whether domain ownership is verified */
  verified: boolean;
  /** Priority for multiple mappings */
  priority: number;
  /** Whether mapping is active */
  is_active: boolean;

  /** Creation timestamp (UNIX seconds) */
  created_at: number;
  /** Last update timestamp (UNIX seconds) */
  updated_at: number;
}

/**
 * Organization domain mapping row from D1 database
 */
export interface OrgDomainMappingRow extends Omit<
  OrgDomainMapping,
  'auto_join_enabled' | 'verified' | 'is_active' | 'auto_assign_role_id'
> {
  auto_join_enabled: number;
  verified: number;
  is_active: number;
  auto_assign_role_id: string | null;
}

// =============================================================================
// Rule Evaluation Types
// =============================================================================

/**
 * Context for rule evaluation
 * Contains all attributes available for condition evaluation
 */
export interface RuleEvaluationContext {
  /** Hashed email domain (from users_core or computed) */
  email_domain_hash?: string;
  /** Email domain hash key version */
  email_domain_hash_version?: number;
  /** Email verification status */
  email_verified: boolean;
  /** Raw claims from IdP (from linked_identities.raw_attributes) */
  idp_claims: Record<string, unknown>;
  /** Provider ID */
  provider_id: string;
  /** User type classification */
  user_type?: string;
  /** Tenant ID */
  tenant_id: string;
}

/**
 * Result of rule evaluation
 */
export interface RuleEvaluationResult {
  /** IDs of rules that matched */
  matched_rules: string[];
  /** Roles to assign with scope info */
  roles_to_assign: Array<{
    role_id: string;
    scope_type: ScopeType;
    scope_target: string;
  }>;
  /** Organization IDs to join */
  orgs_to_join: string[];
  /** Attributes to set */
  attributes_to_set: Array<{
    name: string;
    value: string;
  }>;
  /** Whether access was denied */
  denied: boolean;
  /** OIDC error code if denied */
  deny_code?: DenyErrorCode;
  /** Error description if denied */
  deny_description?: string;
}

// =============================================================================
// API Types
// =============================================================================

/**
 * Input for creating/updating a role assignment rule
 */
export interface RoleAssignmentRuleInput {
  name: string;
  description?: string;
  role_id: string;
  scope_type?: ScopeType;
  scope_target?: string;
  condition: RuleCondition | CompoundCondition;
  actions: RuleAction[];
  priority?: number;
  is_active?: boolean;
  stop_processing?: boolean;
  valid_from?: number;
  valid_until?: number;
}

/**
 * Input for creating/updating an organization domain mapping
 */
export interface OrgDomainMappingInput {
  /** Raw email domain (will be hashed) */
  domain: string;
  org_id: string;
  auto_join_enabled?: boolean;
  membership_type?: 'member' | 'admin' | 'owner';
  auto_assign_role_id?: string;
  verified?: boolean;
  priority?: number;
  is_active?: boolean;
}

/**
 * Test context for rule evaluation (Admin API)
 */
export interface RuleTestContext {
  /** Email address (will be hashed for testing) */
  email?: string;
  email_verified?: boolean;
  provider_id?: string;
  idp_claims?: Record<string, unknown>;
  user_type?: string;
}

/**
 * Result of single rule test
 */
export interface RuleTestResult {
  matched: boolean;
  condition_results: Array<{
    field: string;
    matched: boolean;
    actual?: unknown;
  }>;
  would_apply_actions: RuleAction[];
}
