/**
 * Token Claim Evaluator Service
 *
 * Evaluates token claim rules against evaluation context to determine
 * custom claims to embed in access/ID tokens.
 *
 * Evaluation order:
 * 1. Filter by tenant_id, token_type, is_active=1
 * 2. Filter by valid_from <= now <= valid_until
 * 3. Sort by priority DESC, created_at ASC
 * 4. Evaluate conditions in order
 * 5. Apply matching rules' actions (Last-Write-Wins for collision)
 * 6. Stop if stop_processing=true rule matches
 *
 * Design Principles:
 * - Token Embedding is Authorization Result Cache, NOT Source of Truth
 * - Determinism: Same context -> Same token (no time-dependent or external I/O)
 * - PII Separation: Only Non-PII data is embedded (roles, permissions, metadata)
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type {
  TokenClaimRule,
  TokenClaimRuleRow,
  TokenClaimCondition,
  TokenClaimCompoundCondition,
  TokenClaimAction,
  TokenClaimEvaluationContext,
  TokenClaimEvaluationResult,
  TokenType,
  RESERVED_CLAIMS,
  PII_CLAIM_PATTERNS,
} from '../types/token-claim-rules';
import type { RuleCondition, CompoundCondition, ConditionOperator } from '../types/policy-rules';
import { normalizeClaimValue, compareNormalized, getNestedValue } from '../utils/claim-normalizer';
import { getEmbeddingLimits } from '../utils/resource-permissions';
import { createLogger } from '../utils/logger';

const log = createLogger().module('TOKEN-CLAIM-EVALUATOR');

// =============================================================================
// Constants
// =============================================================================

/** Default cache TTL for token claim rules (5 minutes) */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/** Cache key prefix for token claim rules */
const TOKEN_CLAIM_RULES_CACHE_PREFIX = 'token_claim_rules_cache:';

/** Reserved claims that cannot be overwritten */
const RESERVED_CLAIM_NAMES = new Set([
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
]);

/** PII patterns for warning (not blocking) */
const PII_PATTERNS = new Set([
  'email',
  'name',
  'phone',
  'address',
  'birthdate',
  'given_name',
  'family_name',
  'picture',
]);

// =============================================================================
// Token Claim Evaluator Class
// =============================================================================

/**
 * Token Claim Evaluator
 *
 * Evaluates token claim rules to determine custom claims to embed in tokens.
 * Supports caching via KV for performance.
 */
export class TokenClaimEvaluator {
  private db: D1Database;
  private cache?: KVNamespace;
  private cacheTtl: number;
  private maxCustomClaims: number;

  constructor(
    db: D1Database,
    cache?: KVNamespace,
    options?: {
      cacheTtlSeconds?: number;
      maxCustomClaims?: number;
    }
  ) {
    this.db = db;
    this.cache = cache;
    this.cacheTtl = options?.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.maxCustomClaims = options?.maxCustomClaims ?? 20;
  }

  /**
   * Evaluate all active rules against the given context
   *
   * @param context - Evaluation context with user/client attributes
   * @param tokenType - Target token type ('access' | 'id')
   * @returns Evaluation result with claims to add
   */
  async evaluate(
    context: TokenClaimEvaluationContext,
    tokenType: 'access' | 'id'
  ): Promise<TokenClaimEvaluationResult> {
    const result: TokenClaimEvaluationResult = {
      matched_rules: [],
      claims_to_add: {},
      claim_overrides: [],
      truncated: false,
    };

    // Load rules (from cache or DB)
    const rules = await this.loadRules(context.tenant_id, tokenType);

    // Current timestamp for validity check
    const now = Math.floor(Date.now() / 1000);

    // Track claim count for bloat protection
    let claimCount = 0;

    // Evaluate rules in priority order (already sorted DESC by priority, ASC by created_at)
    for (const rule of rules) {
      // Check validity period
      if (rule.valid_from && rule.valid_from > now) continue;
      if (rule.valid_until && rule.valid_until < now) continue;

      // Evaluate condition
      const matches = this.evaluateCondition(rule.condition, context);

      if (matches) {
        result.matched_rules.push(rule.id);

        // Apply actions
        const { newClaims, overrides } = this.applyActions(rule, context, result.claims_to_add);

        // Check for bloat protection
        const newClaimKeys = Object.keys(newClaims);
        for (const key of newClaimKeys) {
          if (claimCount >= this.maxCustomClaims) {
            result.truncated = true;
            result.truncation_reason = `Exceeded max_custom_claims limit (${this.maxCustomClaims})`;
            log.warn('Exceeded max_custom_claims limit', {
              tenantId: context.tenant_id,
              subjectId: context.subject_id,
              limit: this.maxCustomClaims,
            });
            break;
          }

          // Only count new claims (not overrides)
          if (!(key in result.claims_to_add)) {
            claimCount++;
          }
          result.claims_to_add[key] = newClaims[key];
        }

        // Record overrides for audit
        result.claim_overrides.push(...overrides);

        // Check for stop_processing
        if (rule.stop_processing) {
          break;
        }

        // Stop if truncated
        if (result.truncated) {
          break;
        }
      }
    }

    return result;
  }

  /**
   * Load rules from cache or database
   */
  private async loadRules(tenantId: string, tokenType: 'access' | 'id'): Promise<TokenClaimRule[]> {
    const cacheKey = `${TOKEN_CLAIM_RULES_CACHE_PREFIX}${tenantId}:${tokenType}`;

    // Try cache first
    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as TokenClaimRule[];
        }
      } catch {
        // Cache miss or error, continue to DB
      }
    }

    // Load from DB
    const rules = await this.loadRulesFromDb(tenantId, tokenType);

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
   * Load rules from D1 database
   */
  private async loadRulesFromDb(
    tenantId: string,
    tokenType: 'access' | 'id'
  ): Promise<TokenClaimRule[]> {
    const query = `
      SELECT
        id, tenant_id, name, description,
        token_type,
        conditions_json, actions_json,
        priority, is_active, stop_processing,
        valid_from, valid_until,
        created_by, created_at, updated_at
      FROM token_claim_rules
      WHERE tenant_id = ?
        AND is_active = 1
        AND (token_type = ? OR token_type = 'both')
      ORDER BY priority DESC, created_at ASC
    `;

    const result = await this.db.prepare(query).bind(tenantId, tokenType).all<TokenClaimRuleRow>();

    return (result.results || []).map(this.rowToRule);
  }

  /**
   * Convert database row to TokenClaimRule
   */
  private rowToRule(row: TokenClaimRuleRow): TokenClaimRule {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      description: row.description ?? undefined,
      token_type: row.token_type as TokenType,
      condition: JSON.parse(row.conditions_json) as
        | TokenClaimCondition
        | TokenClaimCompoundCondition,
      actions: JSON.parse(row.actions_json) as TokenClaimAction[],
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
    condition:
      | TokenClaimCondition
      | TokenClaimCompoundCondition
      | RuleCondition
      | CompoundCondition,
    context: TokenClaimEvaluationContext
  ): boolean {
    // Check if it's a compound condition
    if ('type' in condition && (condition.type === 'and' || condition.type === 'or')) {
      return this.evaluateCompoundCondition(condition as TokenClaimCompoundCondition, context);
    }

    // Single condition
    return this.evaluateSingleCondition(condition as TokenClaimCondition, context);
  }

  /**
   * Evaluate a compound condition (AND/OR)
   */
  private evaluateCompoundCondition(
    condition: TokenClaimCompoundCondition,
    context: TokenClaimEvaluationContext
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
    condition: TokenClaimCondition,
    context: TokenClaimEvaluationContext
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
    context: TokenClaimEvaluationContext
  ): unknown {
    switch (field) {
      case 'has_role':
        // For has_role, return the roles array for contains check
        return context.roles;

      case 'has_permission':
        // For has_permission, return the permissions array for contains check
        return context.permissions;

      case 'org_type':
        return context.org_type;

      case 'org_id':
        return context.org_id;

      case 'user_type':
        return context.user_type;

      case 'scope_contains':
        // For scope_contains, return the scope string for contains check
        return context.scope;

      case 'email_domain_hash':
        return context.email_domain_hash;

      case 'idp_claim':
        if (!claimPath || !context.idp_claims) return undefined;
        return getNestedValue(context.idp_claims, claimPath);

      default:
        return undefined;
    }
  }

  /**
   * Apply rule actions and return new claims and overrides
   */
  private applyActions(
    rule: TokenClaimRule,
    context: TokenClaimEvaluationContext,
    existingClaims: Record<string, unknown>
  ): {
    newClaims: Record<string, unknown>;
    overrides: Array<{
      claim_name: string;
      old_value: unknown;
      new_value: unknown;
      rule_id: string;
    }>;
  } {
    const newClaims: Record<string, unknown> = {};
    const overrides: Array<{
      claim_name: string;
      old_value: unknown;
      new_value: unknown;
      rule_id: string;
    }> = [];

    for (const action of rule.actions) {
      const claimName = action.claim_name;

      // Check reserved claims
      if (RESERVED_CLAIM_NAMES.has(claimName)) {
        log.error('Rejected attempt to override reserved claim', {
          claimName,
          ruleId: rule.id,
          tenantId: context.tenant_id,
        });
        continue;
      }

      // Warn about PII patterns
      if (this.isPiiClaimName(claimName)) {
        log.warn('Token claim rule may embed PII', {
          claimName,
          ruleId: rule.id,
          tenantId: context.tenant_id,
        });
      }

      let claimValue: unknown;

      switch (action.type) {
        case 'add_claim':
          claimValue = action.claim_value;
          break;

        case 'add_claim_template':
          claimValue = this.substituteTemplate(action.template ?? '', context);
          break;

        case 'transform_idp_claim':
          claimValue = this.transformIdpClaim(action, context);
          break;

        case 'copy_from_context':
          claimValue = this.copyFromContext(action.context_field ?? '', context);
          break;

        case 'conditional_value':
          claimValue = this.evaluateConditionalValue(action, context);
          break;

        default:
          continue;
      }

      // Check for override
      if (claimName in existingClaims || claimName in newClaims) {
        const oldValue = newClaims[claimName] ?? existingClaims[claimName];
        overrides.push({
          claim_name: claimName,
          old_value: oldValue,
          new_value: claimValue,
          rule_id: rule.id,
        });
        log.debug('Claim override', {
          claimName,
          oldValue: JSON.stringify(oldValue),
          newValue: JSON.stringify(claimValue),
          ruleId: rule.id,
        });
      }

      newClaims[claimName] = claimValue;
    }

    return { newClaims, overrides };
  }

  /**
   * Check if claim name matches PII patterns
   */
  private isPiiClaimName(name: string): boolean {
    const lowerName = name.toLowerCase();
    for (const pattern of PII_PATTERNS) {
      if (lowerName.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Substitute template variables
   *
   * Available variables: user_type, org_id, org_type, client_id, subject_id
   */
  private substituteTemplate(template: string, context: TokenClaimEvaluationContext): string {
    return template
      .replace(/\{\{user_type\}\}/g, context.user_type ?? '')
      .replace(/\{\{org_id\}\}/g, context.org_id ?? '')
      .replace(/\{\{org_type\}\}/g, context.org_type ?? '')
      .replace(/\{\{client_id\}\}/g, context.client_id)
      .replace(/\{\{subject_id\}\}/g, context.subject_id);
  }

  /**
   * Transform IdP claim value
   */
  private transformIdpClaim(
    action: TokenClaimAction,
    context: TokenClaimEvaluationContext
  ): unknown {
    if (!action.source_path || !context.idp_claims) {
      return undefined;
    }

    let value = getNestedValue(context.idp_claims, action.source_path);

    // Apply transformation if specified
    if (action.transform && typeof value === 'string') {
      switch (action.transform) {
        case 'lowercase':
          value = value.toLowerCase();
          break;
        case 'uppercase':
          value = value.toUpperCase();
          break;
        case 'prefix':
          value = (action.transform_value ?? '') + value;
          break;
        case 'suffix':
          value = value + (action.transform_value ?? '');
          break;
      }
    }

    if (action.transform === 'join' && Array.isArray(value)) {
      value = value.join(action.transform_value ?? ',');
    }

    return value;
  }

  /**
   * Copy value from context
   */
  private copyFromContext(field: string, context: TokenClaimEvaluationContext): unknown {
    switch (field) {
      case 'org_id':
        return context.org_id;
      case 'org_type':
        return context.org_type;
      case 'user_type':
        return context.user_type;
      case 'roles':
        return context.roles;
      case 'permissions':
        return context.permissions;
      default:
        return undefined;
    }
  }

  /**
   * Evaluate conditional value action
   */
  private evaluateConditionalValue(
    action: TokenClaimAction,
    context: TokenClaimEvaluationContext
  ): unknown {
    if (!action.condition) {
      return action.if_true;
    }

    const matches = this.evaluateSingleCondition(action.condition, context);
    return matches ? action.if_true : action.if_false;
  }

  /**
   * Invalidate cache for a tenant
   */
  async invalidateCache(tenantId: string, tokenType?: 'access' | 'id'): Promise<void> {
    if (this.cache) {
      try {
        if (tokenType) {
          const cacheKey = `${TOKEN_CLAIM_RULES_CACHE_PREFIX}${tenantId}:${tokenType}`;
          await this.cache.delete(cacheKey);
        } else {
          // Invalidate both
          await this.cache.delete(`${TOKEN_CLAIM_RULES_CACHE_PREFIX}${tenantId}:access`);
          await this.cache.delete(`${TOKEN_CLAIM_RULES_CACHE_PREFIX}${tenantId}:id`);
        }
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
 * Create a TokenClaimEvaluator instance
 */
export function createTokenClaimEvaluator(
  db: D1Database,
  cache?: KVNamespace,
  options?: {
    cacheTtlSeconds?: number;
    maxCustomClaims?: number;
  }
): TokenClaimEvaluator {
  return new TokenClaimEvaluator(db, cache, options);
}

/**
 * Test a token claim rule against provided context (for Admin API testing)
 *
 * @param rule - Rule to test
 * @param context - Test context
 * @returns Detailed test result
 */
export function testTokenClaimRule(
  rule: TokenClaimRule,
  context: TokenClaimEvaluationContext
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
  would_add_claims: Record<string, unknown>;
} {
  const conditionResults: Array<{
    field: string;
    claim_path?: string;
    operator: ConditionOperator;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }> = [];

  // Create temporary evaluator for testing
  const tempEvaluator = {
    evaluateCondition: function (
      condition: TokenClaimCondition | TokenClaimCompoundCondition,
      ctx: TokenClaimEvaluationContext
    ): boolean {
      if ('type' in condition && (condition.type === 'and' || condition.type === 'or')) {
        const compound = condition as TokenClaimCompoundCondition;
        if (compound.type === 'and') {
          return compound.conditions.every((c) => this.evaluateCondition(c, ctx));
        } else {
          return compound.conditions.some((c) => this.evaluateCondition(c, ctx));
        }
      }

      const single = condition as TokenClaimCondition;
      const actualValue = getFieldValueStandalone(single.field, single.claim_path, ctx);
      const normalized = normalizeClaimValue(actualValue);
      return compareNormalized(normalized, single.operator, single.value);
    },
  };

  // Collect condition results
  collectConditionResults(rule.condition, context, conditionResults);

  // Check overall match
  const matched = tempEvaluator.evaluateCondition(
    rule.condition as TokenClaimCondition | TokenClaimCompoundCondition,
    context
  );

  // Calculate would-be claims
  const wouldAddClaims: Record<string, unknown> = {};
  if (matched) {
    for (const action of rule.actions) {
      const claimName = action.claim_name;
      if (RESERVED_CLAIM_NAMES.has(claimName)) continue;

      let claimValue: unknown;
      switch (action.type) {
        case 'add_claim':
          claimValue = action.claim_value;
          break;
        case 'add_claim_template':
          claimValue = substituteTemplateStandalone(action.template ?? '', context);
          break;
        case 'copy_from_context':
          claimValue = copyFromContextStandalone(action.context_field ?? '', context);
          break;
        default:
          continue;
      }
      wouldAddClaims[claimName] = claimValue;
    }
  }

  return {
    matched,
    condition_results: conditionResults,
    would_add_claims: wouldAddClaims,
  };
}

/**
 * Get field value from context (standalone version)
 */
function getFieldValueStandalone(
  field: string,
  claimPath: string | undefined,
  context: TokenClaimEvaluationContext
): unknown {
  switch (field) {
    case 'has_role':
      return context.roles;
    case 'has_permission':
      return context.permissions;
    case 'org_type':
      return context.org_type;
    case 'org_id':
      return context.org_id;
    case 'user_type':
      return context.user_type;
    case 'scope_contains':
      return context.scope;
    case 'email_domain_hash':
      return context.email_domain_hash;
    case 'idp_claim':
      if (!claimPath || !context.idp_claims) return undefined;
      return getNestedValue(context.idp_claims, claimPath);
    default:
      return undefined;
  }
}

/**
 * Substitute template (standalone version)
 */
function substituteTemplateStandalone(
  template: string,
  context: TokenClaimEvaluationContext
): string {
  return template
    .replace(/\{\{user_type\}\}/g, context.user_type ?? '')
    .replace(/\{\{org_id\}\}/g, context.org_id ?? '')
    .replace(/\{\{org_type\}\}/g, context.org_type ?? '')
    .replace(/\{\{client_id\}\}/g, context.client_id)
    .replace(/\{\{subject_id\}\}/g, context.subject_id);
}

/**
 * Copy from context (standalone version)
 */
function copyFromContextStandalone(field: string, context: TokenClaimEvaluationContext): unknown {
  switch (field) {
    case 'org_id':
      return context.org_id;
    case 'org_type':
      return context.org_type;
    case 'user_type':
      return context.user_type;
    case 'roles':
      return context.roles;
    case 'permissions':
      return context.permissions;
    default:
      return undefined;
  }
}

/**
 * Recursively collect condition evaluation results
 */
function collectConditionResults(
  condition: TokenClaimCondition | TokenClaimCompoundCondition | RuleCondition | CompoundCondition,
  context: TokenClaimEvaluationContext,
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
    const compound = condition as TokenClaimCompoundCondition;
    for (const c of compound.conditions) {
      collectConditionResults(c, context, results);
    }
    return;
  }

  const single = condition as TokenClaimCondition;
  const actualValue = getFieldValueStandalone(single.field, single.claim_path, context);
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

export {
  DEFAULT_CACHE_TTL_SECONDS as TOKEN_CLAIM_DEFAULT_CACHE_TTL,
  TOKEN_CLAIM_RULES_CACHE_PREFIX,
  RESERVED_CLAIM_NAMES,
};
