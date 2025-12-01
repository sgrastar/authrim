/**
 * Policy Core Types
 *
 * Type definitions for the policy evaluation engine.
 * Phase 1: Role-based access control with scoped roles.
 */

import type { ScopeType, UserType, PlanType, OrganizationType } from '@authrim/shared';

/**
 * Subject context for policy evaluation
 * Contains all RBAC-relevant information about the subject (user/service)
 */
export interface PolicySubject {
  /** Subject identifier (user ID) */
  id: string;

  /** User type classification */
  userType?: UserType;

  /** Roles assigned to the subject */
  roles: SubjectRole[];

  /** Primary organization ID */
  orgId?: string;

  /** Organization plan (for plan-based policies) */
  plan?: PlanType;

  /** Organization type */
  orgType?: OrganizationType;

  /** Relationships where this subject is the parent/guardian */
  relationships?: SubjectRelationship[];
}

/**
 * Role assigned to a subject with scope information
 */
export interface SubjectRole {
  /** Role name (e.g., 'system_admin', 'org_admin', 'end_user') */
  name: string;

  /** Scope of the role */
  scope: ScopeType;

  /** Scope target (e.g., 'org:org_123', 'resource:doc_456') */
  scopeTarget?: string;

  /** Expiration timestamp (UNIX milliseconds) */
  expiresAt?: number;
}

/**
 * Relationship between subjects
 */
export interface SubjectRelationship {
  /** Related subject ID */
  relatedSubjectId: string;

  /** Type of relationship */
  relationshipType: RelationshipType;

  /** Expiration timestamp (UNIX milliseconds) */
  expiresAt?: number;
}

/**
 * Types of relationships between subjects
 */
export type RelationshipType =
  | 'parent_of'
  | 'guardian_of'
  | 'manager_of'
  | 'assistant_of'
  | 'delegate_of';

/**
 * Resource context for policy evaluation
 */
export interface PolicyResource {
  /** Resource type (e.g., 'organization', 'document', 'user') */
  type: string;

  /** Resource identifier */
  id: string;

  /** Owner subject ID */
  ownerId?: string;

  /** Organization ID this resource belongs to */
  orgId?: string;

  /** Additional attributes for policy evaluation */
  attributes?: Record<string, unknown>;
}

/**
 * Action being requested
 */
export interface PolicyAction {
  /** Action name (e.g., 'read', 'write', 'delete', 'manage') */
  name: string;

  /** Optional sub-action or operation */
  operation?: string;
}

/**
 * Context for policy evaluation request
 */
export interface PolicyContext {
  /** Subject requesting access */
  subject: PolicySubject;

  /** Resource being accessed */
  resource: PolicyResource;

  /** Action being performed */
  action: PolicyAction;

  /** Request timestamp */
  timestamp: number;

  /** Additional environment context */
  environment?: Record<string, unknown>;
}

/**
 * Result of policy evaluation
 */
export interface PolicyDecision {
  /** Whether access is allowed */
  allowed: boolean;

  /** Reason for the decision */
  reason: string;

  /** Which policy/rule made this decision */
  decidedBy?: string;

  /** Additional details about the decision */
  details?: Record<string, unknown>;
}

/**
 * Policy rule definition
 */
export interface PolicyRule {
  /** Unique rule identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Rule description */
  description?: string;

  /** Priority (higher = evaluated first) */
  priority: number;

  /** Effect when rule matches */
  effect: 'allow' | 'deny';

  /** Conditions that must be met */
  conditions: PolicyCondition[];
}

/**
 * Policy condition definition
 */
export interface PolicyCondition {
  /** Condition type */
  type: ConditionType;

  /** Condition parameters */
  params: Record<string, unknown>;
}

/**
 * Types of policy conditions
 */
export type ConditionType =
  // Role-based conditions (RBAC)
  | 'has_role' // Subject has specific role
  | 'has_any_role' // Subject has any of specified roles
  | 'has_all_roles' // Subject has all specified roles
  // Ownership conditions
  | 'is_resource_owner' // Subject owns the resource
  | 'same_organization' // Subject and resource in same org
  // Relationship conditions
  | 'has_relationship' // Subject has relationship with resource owner
  // User type conditions
  | 'user_type_is' // Subject's user type matches
  | 'plan_allows' // Organization plan allows action
  // Attribute-based conditions (ABAC) - Phase 3
  | 'attribute_equals' // Subject has attribute with specific value
  | 'attribute_exists' // Subject has attribute (any value)
  | 'attribute_in'; // Subject attribute value is in a list

/**
 * Verified attribute for ABAC evaluation
 * Stored in verified_attributes table, populated by manual entry or VC (Phase 4+)
 */
export interface VerifiedAttribute {
  /** Attribute name (e.g., 'age_over_18', 'subscription_tier') */
  name: string;
  /** Attribute value */
  value: string | null;
  /** Source of the attribute (manual, vc, jwt_sd) */
  source: string;
  /** Issuer (DID or URL) for VC-sourced attributes */
  issuer?: string;
  /** Expiration timestamp (UNIX seconds) */
  expiresAt?: number;
}

/**
 * Extended PolicySubject with verified attributes for ABAC
 */
export interface PolicySubjectWithAttributes extends PolicySubject {
  /** Verified attributes for ABAC evaluation */
  verifiedAttributes?: VerifiedAttribute[];
}
