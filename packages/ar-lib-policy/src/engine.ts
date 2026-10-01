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
  RequestCountData,
} from './types';
import { createLogger } from '@authrim/ar-lib-core';

// Module-level logger for policy engine
const log = createLogger().module('POLICY_ENGINE');

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
      log.warn('Unknown condition type', { conditionType: condition.type });
      return false;
    }
    return evaluator(condition.params, context);
  }
}

/** Whether the engine knows a condition type (a condition of an unknown type is never met). */
export function isKnownConditionType(type: unknown): boolean {
  return (
    typeof type === 'string' && Object.prototype.hasOwnProperty.call(conditionEvaluators, type)
  );
}

type ParamCheck = (value: unknown) => boolean;

const text: ParamCheck = (v) => typeof v === 'string' && v !== '';
const texts: ParamCheck = (v) => Array.isArray(v) && v.length > 0 && v.every(text);
const number: ParamCheck = (v) => typeof v === 'number' && Number.isFinite(v);
const flag: ParamCheck = (v) => typeof v === 'boolean';
const optional =
  (check: ParamCheck): ParamCheck =>
  (v) =>
    v === undefined || check(v);
const integerIn =
  (min: number, max: number): ParamCheck =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
/** A time in UNIX seconds (0 or less is no real bound: a range ending in 1970 never applies). */
const epochSeconds: ParamCheck = (v) => Number.isSafeInteger(v) && (v as number) > 0;
const scope: ParamCheck = (v) => v === 'global' || v === 'org' || v === 'resource';
/** An IANA time zone the runtime knows (an unknown one would silently be read as UTC). */
const timeZone: ParamCheck = (v) => {
  if (!text(v)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v as string });
    return true;
  } catch {
    return false;
  }
};
const days: ParamCheck = (v) => Array.isArray(v) && v.length > 0 && v.every(integerIn(0, 6));

const ROLE_PARAMS = { scope: optional(scope), scopeTarget: optional(text) };
const NUMERIC_PARAMS = { name: text, value: number };

/**
 * The parameters each condition type reads, and what each must be. A missing or mistyped one
 * makes the condition never met, and one of another name (such as `start` for `from`) would be
 * ignored, so only these names are accepted.
 */
const CONDITION_PARAMS: Record<ConditionType, Record<string, ParamCheck>> = {
  has_role: { role: text, ...ROLE_PARAMS },
  has_any_role: { roles: texts, ...ROLE_PARAMS },
  has_all_roles: { roles: texts, ...ROLE_PARAMS },
  is_resource_owner: {},
  same_organization: {},
  has_relationship: { types: texts },
  user_type_is: { types: texts },
  plan_allows: { plans: texts },
  attribute_equals: {
    name: text,
    value: (v) => typeof v === 'string',
    checkExpiry: optional(flag),
  },
  attribute_exists: { name: text, checkExpiry: optional(flag) },
  attribute_in: { name: text, values: texts, checkExpiry: optional(flag) },
  time_in_range: {
    startHour: integerIn(0, 23),
    endHour: integerIn(0, 24),
    timezone: optional(timeZone),
  },
  day_of_week: { allowedDays: days, timezone: optional(timeZone) },
  valid_during: { from: optional(epochSeconds), to: optional(epochSeconds) },
  numeric_gt: NUMERIC_PARAMS,
  numeric_gte: NUMERIC_PARAMS,
  numeric_lt: NUMERIC_PARAMS,
  numeric_lte: NUMERIC_PARAMS,
  numeric_eq: NUMERIC_PARAMS,
  numeric_between: { name: text, min: number, max: number },
  country_in: { countries: texts },
  country_not_in: { countries: texts },
  ip_in_range: { ranges: texts },
  request_count_lt: { key: text, limit: number },
  request_count_lte: { key: text, limit: number },
  request_count_gt: { key: text, threshold: number },
  request_count_gte: { key: text, threshold: number },
};

/** Condition types that read the subject's verified attributes. */
export const ATTRIBUTE_CONDITION_TYPES: ReadonlySet<string> = new Set<ConditionType>([
  'attribute_equals',
  'attribute_exists',
  'attribute_in',
  'numeric_gt',
  'numeric_gte',
  'numeric_lt',
  'numeric_lte',
  'numeric_eq',
  'numeric_between',
]);

/**
 * Condition types the Check API can evaluate: it knows the subject's roles and verified
 * attributes, the resource and the time, but not the subject's user type, organization, plan or
 * relationships, nor the request's country, IP or rate counts.
 */
export const CHECK_API_CONDITION_TYPES: ReadonlySet<string> = new Set<ConditionType>([
  'has_role',
  'has_any_role',
  'has_all_roles',
  'is_resource_owner',
  'attribute_equals',
  'attribute_exists',
  'attribute_in',
  'time_in_range',
  'day_of_week',
  'valid_during',
  'numeric_gt',
  'numeric_gte',
  'numeric_lt',
  'numeric_lte',
  'numeric_eq',
  'numeric_between',
]);

/**
 * Why a rule's conditions cannot be evaluated as written, or null when they can: they must be an
 * array of conditions of known types (limited to `allowedTypes` when given), each with an object
 * of the parameters its type needs. A condition that cannot be evaluated is never met, so a deny
 * rule holding one would silently never apply.
 */
export function validatePolicyConditions(
  conditions: unknown,
  allowedTypes?: ReadonlySet<string>,
  options: {
    /**
     * False where expired attributes never reach the evaluator (the Check API loads only valid
     * ones): `checkExpiry: false` could then not mean what it says, so it is refused.
     */
    expiredAttributesKnown?: boolean;
  } = {}
): string | null {
  if (!Array.isArray(conditions)) return 'conditions must be an array';
  for (const [index, condition] of conditions.entries()) {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
      return `conditions[${index}] must be an object`;
    }
    const { type, params } = condition as { type?: unknown; params?: unknown };
    if (!isKnownConditionType(type)) {
      return `conditions[${index}].type is not a known condition type`;
    }
    if (allowedTypes && !allowedTypes.has(type as string)) {
      return `conditions[${index}].type ${String(type)} cannot be evaluated here`;
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return `conditions[${index}].params must be an object`;
    }
    const expected = CONDITION_PARAMS[type as ConditionType];
    for (const name of Object.keys(params)) {
      if (!Object.prototype.hasOwnProperty.call(expected, name)) {
        return `conditions[${index}].params.${name} is not a parameter of ${String(type)}`;
      }
    }
    for (const [name, check] of Object.entries(expected)) {
      if (!check((params as Record<string, unknown>)[name])) {
        return `conditions[${index}].params.${name} is missing or not valid for ${String(type)}`;
      }
    }
    if (
      options.expiredAttributesKnown === false &&
      (params as { checkExpiry?: unknown }).checkExpiry === false
    ) {
      return `conditions[${index}].params.checkExpiry cannot be false here: expired attributes are not available`;
    }
    // Ranges whose bounds are the wrong way round would never apply.
    const values = params as Record<string, number | undefined>;
    if (
      type === 'valid_during' &&
      values.from !== undefined &&
      values.to !== undefined &&
      values.from > values.to
    ) {
      return `conditions[${index}].params.from is after params.to`;
    }
    if (type === 'numeric_between' && (values.min as number) > (values.max as number)) {
      return `conditions[${index}].params.min is above params.max`;
    }
  }
  return null;
}

/**
 * The moment a request is evaluated at, in UNIX milliseconds: its timestamp, so that every
 * condition (time ranges as well as role and attribute expiry) is judged at the same moment;
 * now when the request does not say.
 */
function evaluatedAt(context: PolicyContext): number {
  return Number.isFinite(context.timestamp) ? context.timestamp : Date.now();
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

    return hasRole(context.subject.roles, requiredRole, scope, scopeTarget, evaluatedAt(context));
  },

  /**
   * Check if subject has any of the specified roles
   */
  has_any_role: (params, context) => {
    const requiredRoles = params.roles as string[];
    const scope = (params.scope as string) || 'global';
    const scopeTarget = params.scopeTarget as string | undefined;

    return requiredRoles.some((role) =>
      hasRole(context.subject.roles, role, scope, scopeTarget, evaluatedAt(context))
    );
  },

  /**
   * Check if subject has all specified roles
   */
  has_all_roles: (params, context) => {
    const requiredRoles = params.roles as string[];
    const scope = (params.scope as string) || 'global';
    const scopeTarget = params.scopeTarget as string | undefined;

    return requiredRoles.every((role) =>
      hasRole(context.subject.roles, role, scope, scopeTarget, evaluatedAt(context))
    );
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

    const now = evaluatedAt(context);
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

    const now = Math.floor(evaluatedAt(context) / 1000);

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

    const now = Math.floor(evaluatedAt(context) / 1000);

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

    const now = Math.floor(evaluatedAt(context) / 1000);

    return attributes.some((attr) => {
      if (attr.name !== attributeName) return false;
      if (attr.value === null) return false;
      if (!allowedValues.includes(attr.value)) return false;
      if (checkExpiry && attr.expiresAt && attr.expiresAt <= now) return false;
      return true;
    });
  },

  // ==========================================================================
  // Time-based Conditions (Phase 4)
  // ==========================================================================

  /**
   * Check if current time is within a specific hour range
   *
   * Params:
   * - startHour: Start hour (0-23, required)
   * - endHour: End hour (0-23, required)
   * - timezone: IANA timezone (optional, defaults to UTC)
   *
   * Example:
   * { type: 'time_in_range', params: { startHour: 9, endHour: 17, timezone: 'America/New_York' } }
   */
  time_in_range: (params, context) => {
    const startHour = params.startHour as number;
    const endHour = params.endHour as number;
    const timezone = (params.timezone as string) || context.environment?.timezone || 'UTC';

    const now = new Date(context.timestamp);
    let hour: number;

    try {
      // Get hour in the specified timezone
      const timeString = now.toLocaleString('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone,
      });
      hour = parseInt(timeString, 10);
    } catch {
      // Invalid timezone, fall back to UTC
      hour = now.getUTCHours();
    }

    // Handle overnight ranges (e.g., 22-6 means 22:00 to 06:00)
    if (startHour <= endHour) {
      return hour >= startHour && hour < endHour;
    } else {
      return hour >= startHour || hour < endHour;
    }
  },

  /**
   * Check if current day matches allowed days of the week
   *
   * Params:
   * - allowedDays: Array of day numbers (0=Sunday, 6=Saturday)
   * - timezone: IANA timezone (optional, defaults to UTC)
   *
   * Example:
   * { type: 'day_of_week', params: { allowedDays: [1, 2, 3, 4, 5], timezone: 'America/New_York' } }
   */
  day_of_week: (params, context) => {
    const allowedDays = params.allowedDays as number[];
    const timezone = (params.timezone as string) || context.environment?.timezone || 'UTC';

    const now = new Date(context.timestamp);
    let day: number;

    try {
      // Get day in the specified timezone
      const dateString = now.toLocaleString('en-US', {
        weekday: 'short',
        timeZone: timezone,
      });
      // Map weekday name to number
      const dayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      day = dayMap[dateString] ?? now.getUTCDay();
    } catch {
      // Invalid timezone, fall back to UTC
      day = now.getUTCDay();
    }

    return allowedDays.includes(day);
  },

  /**
   * Check if current time is within a date range
   *
   * Params:
   * - from: Start timestamp (Unix seconds, optional)
   * - to: End timestamp (Unix seconds, optional)
   *
   * Example:
   * { type: 'valid_during', params: { from: 1704067200, to: 1735603200 } }
   */
  valid_during: (params, context) => {
    const from = params.from as number | undefined;
    const to = params.to as number | undefined;
    const now = Math.floor(context.timestamp / 1000);

    if (from !== undefined && now < from) return false;
    if (to !== undefined && now > to) return false;
    return true;
  },

  // ==========================================================================
  // Numeric Comparisons (Phase 4)
  // ==========================================================================

  /**
   * Check if attribute value is greater than a threshold
   */
  numeric_gt: (params, context) => {
    const attributeName = params.name as string;
    const value = params.value as number;
    const numVal = getNumericAttribute(context, attributeName);
    return numVal !== null && numVal > value;
  },

  /**
   * Check if attribute value is greater than or equal to a threshold
   */
  numeric_gte: (params, context) => {
    const attributeName = params.name as string;
    const value = params.value as number;
    const numVal = getNumericAttribute(context, attributeName);
    return numVal !== null && numVal >= value;
  },

  /**
   * Check if attribute value is less than a threshold
   */
  numeric_lt: (params, context) => {
    const attributeName = params.name as string;
    const value = params.value as number;
    const numVal = getNumericAttribute(context, attributeName);
    return numVal !== null && numVal < value;
  },

  /**
   * Check if attribute value is less than or equal to a threshold
   */
  numeric_lte: (params, context) => {
    const attributeName = params.name as string;
    const value = params.value as number;
    const numVal = getNumericAttribute(context, attributeName);
    return numVal !== null && numVal <= value;
  },

  /**
   * Check if attribute value equals a numeric value
   */
  numeric_eq: (params, context) => {
    const attributeName = params.name as string;
    const value = params.value as number;
    const numVal = getNumericAttribute(context, attributeName);
    return numVal !== null && numVal === value;
  },

  /**
   * Check if attribute value is between min and max (inclusive)
   *
   * Params:
   * - name: Attribute name (required)
   * - min: Minimum value (required)
   * - max: Maximum value (required)
   *
   * Example:
   * { type: 'numeric_between', params: { name: 'age', min: 18, max: 65 } }
   */
  numeric_between: (params, context) => {
    const attributeName = params.name as string;
    const min = params.min as number;
    const max = params.max as number;
    const numVal = getNumericAttribute(context, attributeName);
    return numVal !== null && numVal >= min && numVal <= max;
  },

  // ==========================================================================
  // Geographic Conditions (Phase 4)
  // ==========================================================================

  /**
   * Check if request country is in the allowed list
   *
   * Params:
   * - countries: Array of ISO 3166-1 alpha-2 country codes (e.g., ['US', 'CA', 'GB'])
   *
   * Example:
   * { type: 'country_in', params: { countries: ['US', 'CA'] } }
   */
  country_in: (params, context) => {
    const countries = params.countries as string[];
    const countryCode = context.environment?.countryCode;
    if (!countryCode) return false;
    return countries.includes(countryCode.toUpperCase());
  },

  /**
   * Check if request country is NOT in the blocked list
   *
   * Params:
   * - countries: Array of ISO 3166-1 alpha-2 country codes to block
   *
   * Example:
   * { type: 'country_not_in', params: { countries: ['RU', 'CN', 'IR'] } }
   */
  country_not_in: (params, context) => {
    const countries = params.countries as string[];
    const countryCode = context.environment?.countryCode;
    if (!countryCode) return true; // If no country code, not in blocked list
    return !countries.includes(countryCode.toUpperCase());
  },

  /**
   * Check if request IP is within a CIDR range
   *
   * Params:
   * - ranges: Array of CIDR ranges (e.g., ['10.0.0.0/8', '192.168.0.0/16'])
   *
   * Example:
   * { type: 'ip_in_range', params: { ranges: ['192.168.1.0/24', '10.0.0.0/8'] } }
   */
  ip_in_range: (params, context) => {
    const ranges = params.ranges as string[];
    const clientIp = context.environment?.clientIp;
    if (!clientIp) return false;

    return ranges.some((range) => isIpInCidr(clientIp, range));
  },

  // ==========================================================================
  // Rate-based Conditions (Phase 5)
  // ==========================================================================

  /**
   * Check if request count is less than a limit
   *
   * Params:
   * - key: Count key pattern (required) - matches against requestCounts[].key
   *        Supports wildcards: 'user:user_123:*' matches 'user:user_123:api:read'
   * - limit: Maximum allowed count (required)
   *
   * Example:
   * { type: 'request_count_lt', params: { key: 'user:*:api:read', limit: 100 } }
   *
   * The requestCounts data must be populated in context.environment.requestCounts
   * by the caller (e.g., from Durable Objects or KV).
   */
  request_count_lt: (params, context) => {
    const keyPattern = params.key as string;
    const limit = params.limit as number;
    const count = getRequestCount(context, keyPattern);
    return count !== null && count < limit;
  },

  /**
   * Check if request count is less than or equal to a limit
   *
   * Params:
   * - key: Count key pattern (required)
   * - limit: Maximum allowed count (required)
   */
  request_count_lte: (params, context) => {
    const keyPattern = params.key as string;
    const limit = params.limit as number;
    const count = getRequestCount(context, keyPattern);
    return count !== null && count <= limit;
  },

  /**
   * Check if request count is greater than a threshold
   *
   * Params:
   * - key: Count key pattern (required)
   * - threshold: Minimum required count (required)
   *
   * Useful for "power user" policies: allow premium features after N requests
   */
  request_count_gt: (params, context) => {
    const keyPattern = params.key as string;
    const threshold = params.threshold as number;
    const count = getRequestCount(context, keyPattern);
    return count !== null && count > threshold;
  },

  /**
   * Check if request count is greater than or equal to a threshold
   *
   * Params:
   * - key: Count key pattern (required)
   * - threshold: Minimum required count (required)
   */
  request_count_gte: (params, context) => {
    const keyPattern = params.key as string;
    const threshold = params.threshold as number;
    const count = getRequestCount(context, keyPattern);
    return count !== null && count >= threshold;
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
 * Get request count from context for rate-based conditions
 *
 * @param context - Policy context with environment.requestCounts
 * @param keyPattern - Key pattern to match (supports * wildcard)
 * @returns Request count or null if not found
 */
function getRequestCount(context: PolicyContext, keyPattern: string): number | null {
  const requestCounts = context.environment?.requestCounts;
  if (!requestCounts || requestCounts.length === 0) return null;

  // Convert pattern to regex (escape special chars except *)
  const regexPattern = keyPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexPattern}$`);

  // Find first matching count
  for (const countData of requestCounts) {
    if (regex.test(countData.key)) {
      return countData.count;
    }
  }

  return null;
}

/**
 * Get a numeric attribute value from verified attributes
 * Returns null if attribute doesn't exist, is expired, or value is not numeric
 */
function getNumericAttribute(context: PolicyContext, attributeName: string): number | null {
  const attributes = getVerifiedAttributes(context);
  if (!attributes) return null;

  const now = Math.floor(evaluatedAt(context) / 1000);

  for (const attr of attributes) {
    if (attr.name !== attributeName) continue;
    if (attr.expiresAt && attr.expiresAt <= now) continue;
    if (attr.value === null) return null;

    const num = parseFloat(attr.value);
    return isNaN(num) ? null : num;
  }

  return null;
}

/**
 * Check if an IP address (IPv4 or IPv6) is within a CIDR range
 *
 * @param ip - IP address (e.g., '192.168.1.100' or '2001:db8::1')
 * @param cidr - CIDR range (e.g., '192.168.1.0/24' or '2001:db8::/32')
 * @returns true if IP is within the range
 */
function isIpInCidr(ip: string, cidr: string): boolean {
  // Parse CIDR
  const [range, bitsStr] = cidr.split('/');
  if (!range || !bitsStr) return false;

  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits)) return false;

  // Detect IP version by checking for colons (IPv6) or dots (IPv4)
  const isIpv6Ip = ip.includes(':');
  const isIpv6Range = range.includes(':');

  // Both must be same IP version
  if (isIpv6Ip !== isIpv6Range) return false;

  if (isIpv6Ip) {
    return isIpv6InCidr(ip, range, bits);
  } else {
    return isIpv4InCidr(ip, range, bits);
  }
}

/**
 * Check if IPv4 address is in CIDR range
 */
function isIpv4InCidr(ip: string, range: string, bits: number): boolean {
  if (bits < 0 || bits > 32) return false;

  const ipNum = ipv4ToNumber(ip);
  const rangeNum = ipv4ToNumber(range);

  if (ipNum === null || rangeNum === null) return false;

  // Create mask and compare
  const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

/**
 * Check if IPv6 address is in CIDR range
 */
function isIpv6InCidr(ip: string, range: string, bits: number): boolean {
  if (bits < 0 || bits > 128) return false;

  const ipBigInt = ipv6ToBigInt(ip);
  const rangeBigInt = ipv6ToBigInt(range);

  if (ipBigInt === null || rangeBigInt === null) return false;

  // Create mask: all 1s for the prefix length, rest 0s
  // For 128 bits, we need BigInt operations
  if (bits === 0) {
    // /0 matches everything
    return true;
  }

  // Create mask with `bits` number of leading 1s
  const mask =
    (BigInt(1) << BigInt(128)) - BigInt(1) - ((BigInt(1) << BigInt(128 - bits)) - BigInt(1));
  return (ipBigInt & mask) === (rangeBigInt & mask);
}

/**
 * Convert IPv4 address to 32-bit number
 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) | octet;
  }

  return result >>> 0; // Convert to unsigned 32-bit
}

/**
 * Convert IPv6 address to BigInt (128-bit)
 *
 * Handles:
 * - Full form: 2001:0db8:0000:0000:0000:0000:0000:0001
 * - Compressed form: 2001:db8::1, ::1, ::, fe80::1%eth0
 * - Mixed IPv4/IPv6: ::ffff:192.168.1.1 (IPv4-mapped IPv6)
 */
function ipv6ToBigInt(ip: string): bigint | null {
  // Remove zone ID if present (e.g., %eth0)
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) {
    ip = ip.substring(0, zoneIndex);
  }

  // Handle IPv4-mapped IPv6 (::ffff:192.168.1.1)
  const lastColon = ip.lastIndexOf(':');
  const possibleIpv4 = ip.substring(lastColon + 1);
  if (possibleIpv4.includes('.')) {
    // This is an IPv4-mapped address
    const ipv4Part = ipv4ToNumber(possibleIpv4);
    if (ipv4Part === null) return null;

    // Parse the IPv6 prefix
    const ipv6Prefix = ip.substring(0, lastColon + 1) + '0:0';
    const prefixBigInt = parseIpv6Parts(ipv6Prefix);
    if (prefixBigInt === null) return null;

    return prefixBigInt | BigInt(ipv4Part);
  }

  return parseIpv6Parts(ip);
}

/**
 * Parse IPv6 address parts to BigInt
 */
function parseIpv6Parts(ip: string): bigint | null {
  // Handle :: expansion
  const doubleColonIndex = ip.indexOf('::');
  let parts: string[];

  if (doubleColonIndex !== -1) {
    // Split into left and right parts around ::
    const left = ip.substring(0, doubleColonIndex);
    const right = ip.substring(doubleColonIndex + 2);

    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];

    // Calculate how many zeros to insert
    const zerosNeeded = 8 - leftParts.length - rightParts.length;
    if (zerosNeeded < 0) return null;

    parts = [...leftParts, ...Array(zerosNeeded).fill('0'), ...rightParts];
  } else {
    parts = ip.split(':');
  }

  // Must have exactly 8 parts
  if (parts.length !== 8) return null;

  let result = BigInt(0);
  for (const part of parts) {
    // Handle empty parts (shouldn't happen after :: expansion)
    const hex = part || '0';

    // Validate hex string (0-4 characters)
    if (hex.length > 4) return null;

    const value = parseInt(hex, 16);
    if (isNaN(value) || value < 0 || value > 0xffff) return null;

    result = (result << BigInt(16)) | BigInt(value);
  }

  return result;
}

/**
 * Check if subject has a role with optional scope matching
 */
function hasRole(
  roles: SubjectRole[],
  requiredRole: string,
  scope: string,
  scopeTarget: string | undefined,
  now: number
): boolean {
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
