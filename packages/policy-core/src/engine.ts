/**
 * Policy Engine
 *
 * Core policy evaluation engine for RBAC.
 * Phase 1 focuses on role-based access control with scoped roles.
 */

import type {
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  PolicyCondition,
  SubjectRole,
  ConditionType,
  VerifiedAttribute,
  PolicySubjectWithAttributes,
} from './types';

/**
 * Policy Engine configuration
 */
export interface PolicyEngineConfig {
  /** Default decision when no rules match */
  defaultDecision: 'allow' | 'deny';

  /** Log evaluation details */
  verbose?: boolean;
}

/**
 * Policy Evaluation Engine
 *
 * Evaluates policy rules against a given context to make access decisions.
 * Supports role-based access control with scoped roles.
 */
export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private config: PolicyEngineConfig;

  constructor(config: Partial<PolicyEngineConfig> = {}) {
    this.config = {
      defaultDecision: 'deny', // Secure by default
      verbose: false,
      ...config,
    };
  }

  /**
   * Add a policy rule
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    // Sort by priority (higher first)
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Add multiple policy rules
   */
  addRules(rules: PolicyRule[]): void {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  /**
   * Clear all rules
   */
  clearRules(): void {
    this.rules = [];
  }

  /**
   * Evaluate policy for a given context
   *
   * Rules are evaluated in priority order. First matching rule determines the decision.
   * If no rules match, the default decision is used.
   */
  evaluate(context: PolicyContext): PolicyDecision {
    for (const rule of this.rules) {
      const matches = this.evaluateConditions(rule.conditions, context);

      if (matches) {
        return {
          allowed: rule.effect === 'allow',
          reason: rule.description || `Rule '${rule.name}' matched`,
          decidedBy: rule.id,
          details: this.config.verbose
            ? {
                ruleName: rule.name,
                effect: rule.effect,
                priority: rule.priority,
              }
            : undefined,
        };
      }
    }

    // No rules matched, use default decision
    return {
      allowed: this.config.defaultDecision === 'allow',
      reason: `No matching rules found, using default decision: ${this.config.defaultDecision}`,
      decidedBy: 'default',
    };
  }

  /**
   * Evaluate all conditions for a rule
   * All conditions must match (AND logic)
   */
  private evaluateConditions(conditions: PolicyCondition[], context: PolicyContext): boolean {
    return conditions.every((condition) => this.evaluateCondition(condition, context));
  }

  /**
   * Evaluate a single condition
   */
  private evaluateCondition(condition: PolicyCondition, context: PolicyContext): boolean {
    const evaluator = conditionEvaluators[condition.type];
    if (!evaluator) {
      console.warn(`Unknown condition type: ${condition.type}`);
      return false;
    }
    return evaluator(condition.params, context);
  }
}

/**
 * Condition evaluator functions
 */
type ConditionEvaluator = (params: Record<string, unknown>, context: PolicyContext) => boolean;

const conditionEvaluators: Record<ConditionType, ConditionEvaluator> = {
  /**
   * Check if subject has a specific role
   */
  has_role: (params, context) => {
    const requiredRole = params.role as string;
    const scope = (params.scope as string) || 'global';
    const scopeTarget = params.scopeTarget as string | undefined;

    return hasRole(context.subject.roles, requiredRole, scope, scopeTarget);
  },

  /**
   * Check if subject has any of the specified roles
   */
  has_any_role: (params, context) => {
    const requiredRoles = params.roles as string[];
    const scope = (params.scope as string) || 'global';
    const scopeTarget = params.scopeTarget as string | undefined;

    return requiredRoles.some((role) => hasRole(context.subject.roles, role, scope, scopeTarget));
  },

  /**
   * Check if subject has all specified roles
   */
  has_all_roles: (params, context) => {
    const requiredRoles = params.roles as string[];
    const scope = (params.scope as string) || 'global';
    const scopeTarget = params.scopeTarget as string | undefined;

    return requiredRoles.every((role) => hasRole(context.subject.roles, role, scope, scopeTarget));
  },

  /**
   * Check if subject owns the resource
   */
  is_resource_owner: (_params, context) => {
    return context.subject.id === context.resource.ownerId;
  },

  /**
   * Check if subject and resource are in the same organization
   */
  same_organization: (_params, context) => {
    if (!context.subject.orgId || !context.resource.orgId) {
      return false;
    }
    return context.subject.orgId === context.resource.orgId;
  },

  /**
   * Check if subject has a relationship with the resource owner
   */
  has_relationship: (params, context) => {
    const relationshipTypes = params.types as string[];

    if (!context.subject.relationships || !context.resource.ownerId) {
      return false;
    }

    const now = Date.now();
    return context.subject.relationships.some(
      (rel) =>
        rel.relatedSubjectId === context.resource.ownerId &&
        relationshipTypes.includes(rel.relationshipType) &&
        (!rel.expiresAt || rel.expiresAt > now)
    );
  },

  /**
   * Check if subject's user type matches
   */
  user_type_is: (params, context) => {
    const allowedTypes = params.types as string[];
    return (
      context.subject.userType !== undefined && allowedTypes.includes(context.subject.userType)
    );
  },

  /**
   * Check if organization plan allows the action
   */
  plan_allows: (params, context) => {
    const allowedPlans = params.plans as string[];
    return context.subject.plan !== undefined && allowedPlans.includes(context.subject.plan);
  },

  // ==========================================================================
  // ABAC Conditions (Phase 3)
  // ==========================================================================

  /**
   * Check if subject has a verified attribute with a specific value
   *
   * Params:
   * - name: Attribute name (required)
   * - value: Expected value (required)
   * - checkExpiry: Whether to check expiration (default: true)
   *
   * Example:
   * { type: 'attribute_equals', params: { name: 'subscription_tier', value: 'premium' } }
   */
  attribute_equals: (params, context) => {
    const attributeName = params.name as string;
    const expectedValue = params.value as string;
    const checkExpiry = params.checkExpiry !== false;

    const attributes = getVerifiedAttributes(context);
    if (!attributes) return false;

    const now = Math.floor(Date.now() / 1000);

    return attributes.some((attr) => {
      if (attr.name !== attributeName) return false;
      if (attr.value !== expectedValue) return false;
      if (checkExpiry && attr.expiresAt && attr.expiresAt <= now) return false;
      return true;
    });
  },

  /**
   * Check if subject has a verified attribute (any value)
   *
   * Params:
   * - name: Attribute name (required)
   * - checkExpiry: Whether to check expiration (default: true)
   *
   * Example:
   * { type: 'attribute_exists', params: { name: 'medical_license' } }
   */
  attribute_exists: (params, context) => {
    const attributeName = params.name as string;
    const checkExpiry = params.checkExpiry !== false;

    const attributes = getVerifiedAttributes(context);
    if (!attributes) return false;

    const now = Math.floor(Date.now() / 1000);

    return attributes.some((attr) => {
      if (attr.name !== attributeName) return false;
      if (checkExpiry && attr.expiresAt && attr.expiresAt <= now) return false;
      return true;
    });
  },

  /**
   * Check if subject's attribute value is in a list of allowed values
   *
   * Params:
   * - name: Attribute name (required)
   * - values: Array of allowed values (required)
   * - checkExpiry: Whether to check expiration (default: true)
   *
   * Example:
   * { type: 'attribute_in', params: { name: 'role_level', values: ['senior', 'lead', 'manager'] } }
   */
  attribute_in: (params, context) => {
    const attributeName = params.name as string;
    const allowedValues = params.values as string[];
    const checkExpiry = params.checkExpiry !== false;

    const attributes = getVerifiedAttributes(context);
    if (!attributes) return false;

    const now = Math.floor(Date.now() / 1000);

    return attributes.some((attr) => {
      if (attr.name !== attributeName) return false;
      if (attr.value === null) return false;
      if (!allowedValues.includes(attr.value)) return false;
      if (checkExpiry && attr.expiresAt && attr.expiresAt <= now) return false;
      return true;
    });
  },
};

/**
 * Get verified attributes from context
 * Handles both PolicySubject and PolicySubjectWithAttributes
 */
function getVerifiedAttributes(context: PolicyContext): VerifiedAttribute[] | undefined {
  const subject = context.subject as PolicySubjectWithAttributes;
  return subject.verifiedAttributes;
}

/**
 * Check if subject has a role with optional scope matching
 */
function hasRole(
  roles: SubjectRole[],
  requiredRole: string,
  scope: string,
  scopeTarget?: string
): boolean {
  const now = Date.now();

  return roles.some((role) => {
    // Check role name
    if (role.name !== requiredRole) {
      return false;
    }

    // Check expiration
    if (role.expiresAt && role.expiresAt <= now) {
      return false;
    }

    // Global scope matches everything
    if (role.scope === 'global') {
      return true;
    }

    // Check scope match
    // At this point role.scope is not 'global' (handled above)
    if (scope === 'global') {
      // When requiring global, only global scope matches
      // Since role.scope is not 'global' here, return false
      return false;
    }

    // Scope must match
    if (role.scope !== scope) {
      return false;
    }

    // If scope target is specified, it must match
    if (scopeTarget && role.scopeTarget !== scopeTarget) {
      return false;
    }

    return true;
  });
}

/**
 * Create a default policy engine with common RBAC rules
 */
export function createDefaultPolicyEngine(): PolicyEngine {
  const engine = new PolicyEngine({ defaultDecision: 'deny' });

  // System admin can do anything
  engine.addRule({
    id: 'system_admin_full_access',
    name: 'System Admin Full Access',
    description: 'System administrators have full access to all resources',
    priority: 1000,
    effect: 'allow',
    conditions: [{ type: 'has_role', params: { role: 'system_admin' } }],
  });

  // Distributor admin has high-level access
  engine.addRule({
    id: 'distributor_admin_access',
    name: 'Distributor Admin Access',
    description: 'Distributor administrators have broad access',
    priority: 900,
    effect: 'allow',
    conditions: [{ type: 'has_role', params: { role: 'distributor_admin' } }],
  });

  // Org admin can manage their organization
  engine.addRule({
    id: 'org_admin_same_org',
    name: 'Org Admin Same Organization',
    description: 'Organization administrators can manage resources in their organization',
    priority: 800,
    effect: 'allow',
    conditions: [
      { type: 'has_role', params: { role: 'org_admin' } },
      { type: 'same_organization', params: {} },
    ],
  });

  // Resource owners can manage their own resources
  engine.addRule({
    id: 'owner_full_access',
    name: 'Resource Owner Access',
    description: 'Resource owners have full access to their own resources',
    priority: 700,
    effect: 'allow',
    conditions: [{ type: 'is_resource_owner', params: {} }],
  });

  // Parents/guardians can act on behalf of their children
  engine.addRule({
    id: 'guardian_access',
    name: 'Guardian Access',
    description: 'Parents and guardians can access resources owned by their children',
    priority: 600,
    effect: 'allow',
    conditions: [{ type: 'has_relationship', params: { types: ['parent_of', 'guardian_of'] } }],
  });

  return engine;
}
