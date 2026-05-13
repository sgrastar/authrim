/**
 * Rule Evaluator Service
 *
 * Evaluates role assignment rules against user context to determine:
 * - Roles to assign
 * - Organizations to join
 * - Attributes to set
 * - Access denial decisions
 *
 * Evaluation order:
 * 1. Filter by tenant_id and is_active=1
 * 2. Filter by valid_from <= now <= valid_until
 * 3. Sort by priority DESC
 * 4. Evaluate conditions in order
 * 5. Apply matching rules' actions
 * 6. Stop if stop_processing=true rule matches
 * 7. Stop immediately if deny action is encountered
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type {
  RoleAssignmentRule,
  RoleAssignmentRuleRow,
  RuleCondition,
  CompoundCondition,
  RuleAction,
  RuleEvaluationContext,
  RuleEvaluationResult,
  ConditionOperator,
  DenyErrorCode,
} from '../types/policy-rules';
import type { DatabaseAdapter, DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import type { ScopeType } from '../types/rbac';
import {
  normalizeClaimValue,
  compareNormalized,
  getNestedValue,
  extractAndNormalizeClaim,
} from '../utils/claim-normalizer';

// =============================================================================
// Constants
// =============================================================================

/** Default cache TTL for rules (5 minutes) */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/** Cache key prefix for rules */
const RULES_CACHE_PREFIX = 'role_assignment_rules_cache:';

// =============================================================================
// Rule Evaluator Class
// =============================================================================

/**
 * Rule Evaluator
 *
 * Evaluates role assignment rules against a given context.
 * Supports caching via KV for performance.
 */
export class RuleEvaluator {
  private db: DatabaseAdapter;
  private cache?: KVNamespace;
  private cacheTtl: number;

  constructor(db: DatabaseSource, cache?: KVNamespace, cacheTtlSeconds?: number) {
    this.db = ensureDatabaseAdapter(db, 'rule-evaluator');
    this.cache = cache;
    this.cacheTtl = cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  }

  /**
   * Evaluate all active rules against the given context
   *
   * @param context - Evaluation context with user attributes
   * @returns Evaluation result with roles, orgs, and deny status
   */
  async evaluate(context: RuleEvaluationContext): Promise<RuleEvaluationResult> {
    const result: RuleEvaluationResult = {
      matched_rules: [],
      roles_to_assign: [],
      orgs_to_join: [],
      attributes_to_set: [],
      denied: false,
    };

    // Load rules (from cache or DB)
    const rules = await this.loadRules(context.tenant_id);

    // Current timestamp for validity check
    const now = Math.floor(Date.now() / 1000);

    // Evaluate rules in priority order (already sorted DESC)
    for (const rule of rules) {
      // Check validity period
      if (rule.valid_from && rule.valid_from > now) continue;
      if (rule.valid_until && rule.valid_until < now) continue;

      // Evaluate condition
      const matches = this.evaluateCondition(rule.condition, context);

      if (matches) {
        result.matched_rules.push(rule.id);

        // Apply actions
        const shouldStop = this.applyActions(rule, context, result);

        // Check for deny
        if (result.denied) {
          return result;
        }

        // Check for stop_processing
        if (shouldStop || rule.stop_processing) {
          break;
        }
      }
    }

    return result;
  }

  /**
   * Load rules from cache or database
   */
  private async loadRules(tenantId: string): Promise<RoleAssignmentRule[]> {
    const cacheKey = `${RULES_CACHE_PREFIX}${tenantId}`;

    // Try cache first
    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as RoleAssignmentRule[];
        }
      } catch {
        // Cache miss or error, continue to DB
      }
    }

    // Load from DB
    const rules = await this.loadRulesFromDb(tenantId);

    // Update cache
    if (this.cache && rules.length > 0) {
      try {
        await this.cache.put(cacheKey, JSON.stringify(rules), {
          expirationTtl: this.cacheTtl,
        });
      } catch {
        // Cache write error, continue without caching
      }
    }

    return rules;
  }

  /**
   * Load rules from the configured database source
   */
  private async loadRulesFromDb(tenantId: string): Promise<RoleAssignmentRule[]> {
    const query = `
      SELECT
        id, tenant_id, name, description,
        role_id, scope_type, scope_target,
        conditions_json, actions_json,
        priority, is_active, stop_processing,
        valid_from, valid_until,
        created_by, created_at, updated_at
      FROM role_assignment_rules
      WHERE tenant_id = ? AND is_active = 1
      ORDER BY priority DESC
    `;

    const rows = await this.db.query<RoleAssignmentRuleRow>(query, [tenantId]);
    return rows.map(this.rowToRule);
  }

  /**
   * Convert database row to RoleAssignmentRule
   */
  private rowToRule(row: RoleAssignmentRuleRow): RoleAssignmentRule {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      description: row.description ?? undefined,
      role_id: row.role_id,
      scope_type: row.scope_type as ScopeType,
      scope_target: row.scope_target,
      condition: JSON.parse(row.conditions_json) as RuleCondition | CompoundCondition,
      actions: JSON.parse(row.actions_json) as RuleAction[],
      priority: row.priority,
      is_active: true,
      stop_processing: row.stop_processing === 1,
      valid_from: row.valid_from ?? undefined,
      valid_until: row.valid_until ?? undefined,
      created_by: row.created_by ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Evaluate a condition (single or compound)
   */
  private evaluateCondition(
    condition: RuleCondition | CompoundCondition,
    context: RuleEvaluationContext
  ): boolean {
    // Check if it's a compound condition
    if ('type' in condition && (condition.type === 'and' || condition.type === 'or')) {
      return this.evaluateCompoundCondition(condition as CompoundCondition, context);
    }

    // Single condition
    return this.evaluateSingleCondition(condition as RuleCondition, context);
  }

  /**
   * Evaluate a compound condition (AND/OR)
   */
  private evaluateCompoundCondition(
    condition: CompoundCondition,
    context: RuleEvaluationContext
  ): boolean {
    if (condition.type === 'and') {
      return condition.conditions.every((c) => this.evaluateCondition(c, context));
    } else {
      return condition.conditions.some((c) => this.evaluateCondition(c, context));
    }
  }

  /**
   * Evaluate a single condition
   */
  private evaluateSingleCondition(
    condition: RuleCondition,
    context: RuleEvaluationContext
  ): boolean {
    const { field, claim_path, operator, value } = condition;

    // Get actual value based on field type
    const actualValue = this.getFieldValue(field, claim_path, context);

    // Normalize and compare
    const normalized = normalizeClaimValue(actualValue);
    return compareNormalized(normalized, operator, value);
  }

  /**
   * Get field value from context
   */
  private getFieldValue(
    field: string,
    claimPath: string | undefined,
    context: RuleEvaluationContext
  ): unknown {
    switch (field) {
      case 'email_domain_hash':
        return context.email_domain_hash;

      case 'email_verified':
        return context.email_verified;

      case 'provider_id':
        return context.provider_id;

      case 'user_type':
        return context.user_type;

      case 'idp_claim':
        if (!claimPath) return undefined;
        return getNestedValue(context.idp_claims, claimPath);

      default:
        return undefined;
    }
  }

  /**
   * Apply rule actions to result
   *
   * @returns true if processing should stop
   */
  private applyActions(
    rule: RoleAssignmentRule,
    context: RuleEvaluationContext,
    result: RuleEvaluationResult
  ): boolean {
    for (const action of rule.actions) {
      switch (action.type) {
        case 'assign_role':
          this.applyAssignRoleAction(rule, action, result);
          break;

        case 'join_org':
          this.applyJoinOrgAction(action, result);
          break;

        case 'set_attribute':
          this.applySetAttributeAction(action, result);
          break;

        case 'deny':
          result.denied = true;
          result.deny_code = action.deny_code ?? 'access_denied';
          result.deny_description = action.deny_description;
          return true; // Stop processing immediately
      }
    }

    return false;
  }

  /**
   * Apply assign_role action
   */
  private applyAssignRoleAction(
    rule: RoleAssignmentRule,
    action: RuleAction,
    result: RuleEvaluationResult
  ): void {
    const roleId = action.role_id ?? rule.role_id;
    const scopeType = action.scope_type ?? rule.scope_type;
    const scopeTarget = action.scope_target ?? rule.scope_target;

    // Check if already added (avoid duplicates)
    const exists = result.roles_to_assign.some(
      (r) => r.role_id === roleId && r.scope_type === scopeType && r.scope_target === scopeTarget
    );

    if (!exists) {
      result.roles_to_assign.push({
        role_id: roleId,
        scope_type: scopeType,
        scope_target: scopeTarget,
      });
    }
  }

  /**
   * Apply join_org action
   */
  private applyJoinOrgAction(action: RuleAction, result: RuleEvaluationResult): void {
    // 'auto' will be resolved by the caller using org_domain_mappings
    const orgId = action.org_id;
    if (orgId && !result.orgs_to_join.includes(orgId)) {
      result.orgs_to_join.push(orgId);
    }
  }

  /**
   * Apply set_attribute action
   */
  private applySetAttributeAction(action: RuleAction, result: RuleEvaluationResult): void {
    if (action.attribute_name && action.attribute_value !== undefined) {
      // Check if already set (later rules win)
      const existingIndex = result.attributes_to_set.findIndex(
        (a) => a.name === action.attribute_name
      );
      if (existingIndex >= 0) {
        result.attributes_to_set[existingIndex].value = action.attribute_value;
      } else {
        result.attributes_to_set.push({
          name: action.attribute_name,
          value: action.attribute_value,
        });
      }
    }
  }

  /**
   * Invalidate cache for a tenant
   */
  async invalidateCache(tenantId: string): Promise<void> {
    if (this.cache) {
      const cacheKey = `${RULES_CACHE_PREFIX}${tenantId}`;
      try {
        await this.cache.delete(cacheKey);
      } catch {
        // Ignore cache errors
      }
    }
  }
}

// =============================================================================
// Standalone Functions
// =============================================================================

/**
 * Create a RuleEvaluator instance
 */
export function createRuleEvaluator(
  db: DatabaseSource,
  cache?: KVNamespace,
  cacheTtlSeconds?: number
): RuleEvaluator {
  return new RuleEvaluator(db, cache, cacheTtlSeconds);
}

/**
 * Evaluate a single rule against a context (for testing)
 *
 * @param rule - Rule to evaluate
 * @param context - Evaluation context
 * @returns Whether the rule matches
 */
export function evaluateRuleCondition(
  rule: RoleAssignmentRule,
  context: RuleEvaluationContext
): boolean {
  const evaluator = {
    evaluateCondition: function (
      condition: RuleCondition | CompoundCondition,
      ctx: RuleEvaluationContext
    ): boolean {
      if ('type' in condition && (condition.type === 'and' || condition.type === 'or')) {
        const compound = condition as CompoundCondition;
        if (compound.type === 'and') {
          return compound.conditions.every((c) => this.evaluateCondition(c, ctx));
        } else {
          return compound.conditions.some((c) => this.evaluateCondition(c, ctx));
        }
      }

      const single = condition as RuleCondition;
      const actualValue = getFieldValue(single.field, single.claim_path, ctx);
      const normalized = normalizeClaimValue(actualValue);
      return compareNormalized(normalized, single.operator, single.value);
    },
  };

  return evaluator.evaluateCondition(rule.condition, context);
}

/**
 * Get field value from context (standalone version)
 */
function getFieldValue(
  field: string,
  claimPath: string | undefined,
  context: RuleEvaluationContext
): unknown {
  switch (field) {
    case 'email_domain_hash':
      return context.email_domain_hash;
    case 'email_verified':
      return context.email_verified;
    case 'provider_id':
      return context.provider_id;
    case 'user_type':
      return context.user_type;
    case 'idp_claim':
      if (!claimPath) return undefined;
      return getNestedValue(context.idp_claims, claimPath);
    default:
      return undefined;
  }
}

/**
 * Test a rule against provided context (for Admin API testing)
 *
 * @param rule - Rule to test
 * @param context - Test context
 * @returns Detailed test result
 */
export function testRuleAgainstContext(
  rule: RoleAssignmentRule,
  context: RuleEvaluationContext
): {
  matched: boolean;
  condition_results: Array<{
    field: string;
    claim_path?: string;
    operator: ConditionOperator;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }>;
  would_apply_actions: RuleAction[];
} {
  const conditionResults: Array<{
    field: string;
    claim_path?: string;
    operator: ConditionOperator;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }> = [];

  // Collect condition results
  collectConditionResults(rule.condition, context, conditionResults);

  // Check overall match
  const matched = evaluateRuleCondition(rule, context);

  return {
    matched,
    condition_results: conditionResults,
    would_apply_actions: matched ? rule.actions : [],
  };
}

/**
 * Recursively collect condition evaluation results
 */
function collectConditionResults(
  condition: RuleCondition | CompoundCondition,
  context: RuleEvaluationContext,
  results: Array<{
    field: string;
    claim_path?: string;
    operator: ConditionOperator;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }>
): void {
  if ('type' in condition && (condition.type === 'and' || condition.type === 'or')) {
    const compound = condition as CompoundCondition;
    for (const c of compound.conditions) {
      collectConditionResults(c, context, results);
    }
    return;
  }

  const single = condition as RuleCondition;
  const actualValue = getFieldValue(single.field, single.claim_path, context);
  const normalized = normalizeClaimValue(actualValue);
  const matched = compareNormalized(normalized, single.operator, single.value);

  results.push({
    field: single.field,
    claim_path: single.claim_path,
    operator: single.operator,
    expected: single.value,
    actual: actualValue,
    matched,
  });
}

// =============================================================================
// Exports
// =============================================================================

export { DEFAULT_CACHE_TTL_SECONDS, RULES_CACHE_PREFIX };
