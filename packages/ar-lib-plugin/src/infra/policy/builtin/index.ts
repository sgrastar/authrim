/**
 * Built-in Policy Infrastructure
 *
 * Implements IPolicyInfra using D1-based ReBAC (Relationship-Based Access Control).
 * This is the default policy engine for Authrim.
 *
 * Features:
 * - Zanzibar-style check API
 * - Recursive relationship traversal via CTE
 * - KV-based caching with configurable TTL
 * - Rule evaluation for JIT provisioning
 */

import type {
  IPolicyInfra,
  IStorageInfra,
  InfraEnv,
  InfraHealthStatus,
  CheckRequest,
  CheckResponse,
  BatchCheckRequest,
  BatchCheckResponse,
  ListObjectsRequest,
  ListObjectsResponse,
  ListUsersRequest,
  ListUsersResponse,
  RuleEvaluationContext,
  RuleEvaluationResult,
  CacheInvalidationRequest,
} from '../../types';

// =============================================================================
// Built-in Policy Infrastructure
// =============================================================================

/**
 * Built-in Policy Infrastructure
 *
 * Implements authorization checks using:
 * - Direct relationship lookup
 * - Recursive CTE for inherited relationships
 * - KV caching for performance
 */
export class BuiltinPolicyInfra implements IPolicyInfra {
  readonly provider = 'builtin' as const;

  private storage: IStorageInfra | null = null;
  private env: InfraEnv | null = null;
  private cache: KVNamespace | null = null;
  private initialized = false;

  // Cache configuration
  private readonly CACHE_TTL_SECONDS = 60;
  private readonly CACHE_PREFIX = 'rebac:';

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(env: InfraEnv, storage: IStorageInfra): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.env = env;
    this.storage = storage;
    this.cache = env.REBAC_CACHE ?? null;
    this.initialized = true;
  }

  async healthCheck(): Promise<InfraHealthStatus> {
    if (!this.initialized) {
      return {
        status: 'unhealthy',
        provider: 'builtin',
        message: 'Policy infrastructure not initialized',
      };
    }

    return {
      status: 'healthy',
      provider: 'builtin',
      message: 'Built-in ReBAC engine ready',
    };
  }

  // ---------------------------------------------------------------------------
  // Check API (Zanzibar-style)
  // ---------------------------------------------------------------------------

  async check(request: CheckRequest): Promise<CheckResponse> {
    this.ensureInitialized();

    const { subject, relation, object, context: _context } = request;

    // Try cache first
    const cacheKey = this.buildCacheKey(subject, relation, object);
    const cached = await this.getFromCache(cacheKey);
    if (cached !== null) {
      return {
        allowed: cached,
        resolution_method: 'direct',
        cached: true,
      };
    }

    // Parse subject and object
    const [subjectType, subjectId] = this.parseReference(subject);
    const [objectType, objectId] = this.parseReference(object);

    // Check direct relationship
    const directMatch = await this.checkDirectRelationship(
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId
    );

    if (directMatch) {
      await this.setCache(cacheKey, true);
      return {
        allowed: true,
        resolution_method: 'direct',
        cached: false,
      };
    }

    // Check inherited relationships via role hierarchy
    const inheritedMatch = await this.checkInheritedRelationship(
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId
    );

    if (inheritedMatch) {
      await this.setCache(cacheKey, true);
      return {
        allowed: true,
        resolution_method: 'inherited',
        cached: false,
      };
    }

    // No match found
    await this.setCache(cacheKey, false);
    return {
      allowed: false,
      cached: false,
    };
  }

  async batchCheck(request: BatchCheckRequest): Promise<BatchCheckResponse> {
    this.ensureInitialized();

    // Process checks in parallel
    const results = await Promise.all(request.checks.map((check) => this.check(check)));

    return { results };
  }

  // ---------------------------------------------------------------------------
  // List API
  // ---------------------------------------------------------------------------

  async listObjects(request: ListObjectsRequest): Promise<ListObjectsResponse> {
    this.ensureInitialized();

    const { subject, relation, objectType, limit = 100, cursor } = request;
    const [subjectTypeRef, subjectId] = this.parseReference(subject);

    // Query relationships where subject has the relation to objects of the given type
    const offset = cursor ? parseInt(cursor, 10) : 0;

    const relationships = await this.storage!.adapter.query<{
      to_type: string;
      to_id: string;
    }>(
      `SELECT DISTINCT to_type, to_id FROM relationships
       WHERE from_type = ? AND from_id = ? AND relationship_type = ? AND to_type = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [subjectTypeRef, subjectId, relation, objectType, limit + 1, offset]
    );

    const hasMore = relationships.length > limit;
    const objects = relationships.slice(0, limit).map((r) => `${r.to_type}:${r.to_id}`);

    return {
      objects,
      cursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  async listUsers(request: ListUsersRequest): Promise<ListUsersResponse> {
    this.ensureInitialized();

    const { object, relation, limit = 100, cursor } = request;
    const [objectType, objectId] = this.parseReference(object);

    const offset = cursor ? parseInt(cursor, 10) : 0;

    const relationships = await this.storage!.adapter.query<{
      from_type: string;
      from_id: string;
    }>(
      `SELECT DISTINCT from_type, from_id FROM relationships
       WHERE to_type = ? AND to_id = ? AND relationship_type = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [objectType, objectId, relation, limit + 1, offset]
    );

    const hasMore = relationships.length > limit;
    const users = relationships.slice(0, limit).map((r) => `${r.from_type}:${r.from_id}`);

    return {
      users,
      cursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Rule Evaluation
  // ---------------------------------------------------------------------------

  async evaluateRules(context: RuleEvaluationContext): Promise<RuleEvaluationResult> {
    this.ensureInitialized();

    const result: RuleEvaluationResult = {
      matched_rules: [],
      roles_to_assign: [],
      orgs_to_join: [],
      attributes_to_set: [],
      denied: false,
    };

    // Load rules from database
    const rules = await this.loadRules(context.tenant_id);

    for (const rule of rules) {
      if (await this.evaluateRuleConditions(rule, context)) {
        result.matched_rules.push(rule.id);

        // Apply rule actions
        if (rule.action === 'deny') {
          result.denied = true;
          result.deny_reason = rule.deny_reason;
          break; // Stop on deny
        }

        if (rule.roles_to_assign) {
          result.roles_to_assign.push(...rule.roles_to_assign);
        }

        if (rule.orgs_to_join) {
          result.orgs_to_join.push(...rule.orgs_to_join);
        }

        if (rule.attributes_to_set) {
          result.attributes_to_set.push(...rule.attributes_to_set);
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Cache Management
  // ---------------------------------------------------------------------------

  async invalidateCache(request: CacheInvalidationRequest): Promise<void> {
    if (!this.cache) return;

    if (request.all) {
      // Note: KV doesn't support bulk delete, so this is a no-op for now
      // In production, you'd use a cache version key pattern
      return;
    }

    if (request.keys) {
      await Promise.all(request.keys.map((key) => this.cache!.delete(this.CACHE_PREFIX + key)));
    }

    // Pattern-based invalidation is not efficiently supported by KV
    // Would need to track keys separately or use a different caching strategy
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized || !this.storage) {
      throw new Error('BuiltinPolicyInfra: Not initialized. Call initialize() first.');
    }
  }

  private parseReference(ref: string): [string, string] {
    const parts = ref.split(':');
    if (parts.length !== 2) {
      throw new Error(`Invalid reference format: ${ref}. Expected 'type:id'`);
    }
    return [parts[0], parts[1]];
  }

  private buildCacheKey(subject: string, relation: string, object: string): string {
    return `${subject}#${relation}@${object}`;
  }

  private async getFromCache(key: string): Promise<boolean | null> {
    if (!this.cache) return null;

    try {
      const value = await this.cache.get(this.CACHE_PREFIX + key);
      if (value === null) return null;
      return value === 'true';
    } catch {
      return null;
    }
  }

  private async setCache(key: string, allowed: boolean): Promise<void> {
    if (!this.cache) return;

    try {
      await this.cache.put(this.CACHE_PREFIX + key, String(allowed), {
        expirationTtl: this.CACHE_TTL_SECONDS,
      });
    } catch {
      // Ignore cache errors
    }
  }

  private async checkDirectRelationship(
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<boolean> {
    const result = await this.storage!.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM relationships
       WHERE from_type = ? AND from_id = ? AND relationship_type = ?
       AND to_type = ? AND to_id = ?
       AND (expires_at IS NULL OR expires_at > ?)`,
      [subjectType, subjectId, relation, objectType, objectId, Date.now()]
    );

    return (result?.count ?? 0) > 0;
  }

  private async checkInheritedRelationship(
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<boolean> {
    // Use recursive CTE to traverse role hierarchy
    const result = await this.storage!.adapter.queryOne<{ found: number }>(
      `
      WITH RECURSIVE role_chain AS (
        -- Base case: direct role assignments
        SELECT ra.role_id, r.parent_role_id, 1 as depth
        FROM role_assignments ra
        JOIN roles r ON ra.role_id = r.id
        WHERE ra.subject_id = ?
        AND (ra.expires_at IS NULL OR ra.expires_at > ?)

        UNION ALL

        -- Recursive case: parent roles
        SELECT r.id, r.parent_role_id, rc.depth + 1
        FROM roles r
        JOIN role_chain rc ON r.id = rc.parent_role_id
        WHERE rc.depth < 10  -- Prevent infinite loops
      )
      SELECT 1 as found FROM role_chain rc
      JOIN relationships rel ON (
        rel.from_type = 'role' AND rel.from_id = rc.role_id
        AND rel.relationship_type = ?
        AND rel.to_type = ? AND rel.to_id = ?
      )
      LIMIT 1
    `,
      [subjectId, Date.now(), relation, objectType, objectId]
    );

    return result !== null;
  }

  private async loadRules(tenantId: string): Promise<Rule[]> {
    // Load from cache first
    if (this.cache) {
      const cached = await this.cache.get(`rules:${tenantId}`);
      if (cached) {
        try {
          return JSON.parse(cached) as Rule[];
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Load from database
    const rules = await this.storage!.adapter.query<RuleRow>(
      `SELECT * FROM role_assignment_rules
       WHERE tenant_id = ? AND is_active = 1
       AND (valid_from IS NULL OR valid_from <= ?)
       AND (valid_until IS NULL OR valid_until > ?)
       ORDER BY priority ASC`,
      [tenantId, Date.now(), Date.now()]
    );

    const parsedRules = rules.map((row) => this.parseRule(row));

    // Cache rules
    if (this.cache) {
      try {
        await this.cache.put(`rules:${tenantId}`, JSON.stringify(parsedRules), {
          expirationTtl: 300, // 5 minutes
        });
      } catch {
        // Ignore cache errors
      }
    }

    return parsedRules;
  }

  private parseRule(row: RuleRow): Rule {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      priority: row.priority,
      conditions: row.conditions ? JSON.parse(row.conditions) : [],
      action: row.action as 'allow' | 'deny',
      roles_to_assign: row.roles_to_assign ? JSON.parse(row.roles_to_assign) : [],
      orgs_to_join: row.orgs_to_join ? JSON.parse(row.orgs_to_join) : [],
      attributes_to_set: row.attributes_to_set ? JSON.parse(row.attributes_to_set) : [],
      deny_reason: row.deny_reason ?? undefined,
    };
  }

  private async evaluateRuleConditions(
    rule: Rule,
    context: RuleEvaluationContext
  ): Promise<boolean> {
    // If no conditions, rule always matches
    if (!rule.conditions || rule.conditions.length === 0) {
      return true;
    }

    // All conditions must match (AND logic)
    for (const condition of rule.conditions) {
      if (!this.evaluateCondition(condition, context)) {
        return false;
      }
    }

    return true;
  }

  private evaluateCondition(condition: RuleCondition, context: RuleEvaluationContext): boolean {
    const { field, operator, value } = condition;

    // Get the actual value from context
    let actualValue: unknown;
    if (field.startsWith('idp_claims.')) {
      const claimPath = field.slice('idp_claims.'.length);
      actualValue = this.getNestedValue(context.idp_claims, claimPath);
    } else {
      actualValue = this.getContextField(context, field);
    }

    // Compare based on operator
    switch (operator) {
      case 'eq':
        return actualValue === value;
      case 'neq':
        return actualValue !== value;
      case 'contains':
        if (typeof actualValue === 'string' && typeof value === 'string') {
          return actualValue.includes(value);
        }
        if (Array.isArray(actualValue)) {
          return actualValue.includes(value);
        }
        return false;
      case 'starts_with':
        if (typeof actualValue === 'string' && typeof value === 'string') {
          return actualValue.startsWith(value);
        }
        return false;
      case 'ends_with':
        if (typeof actualValue === 'string' && typeof value === 'string') {
          return actualValue.endsWith(value);
        }
        return false;
      case 'matches':
        if (typeof actualValue === 'string' && typeof value === 'string') {
          try {
            return new RegExp(value).test(actualValue);
          } catch {
            return false;
          }
        }
        return false;
      case 'in':
        if (Array.isArray(value)) {
          return value.includes(actualValue);
        }
        return false;
      case 'exists':
        return actualValue !== undefined && actualValue !== null;
      default:
        return false;
    }
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Type-safe field accessor for RuleEvaluationContext
   */
  private getContextField(context: RuleEvaluationContext, field: string): unknown {
    switch (field) {
      case 'tenant_id':
        return context.tenant_id;
      case 'email_domain_hash':
        return context.email_domain_hash;
      case 'email_verified':
        return context.email_verified;
      case 'provider_id':
        return context.provider_id;
      case 'user_type':
        return context.user_type;
      case 'idp_claims':
        return context.idp_claims;
      default:
        // For unknown fields, return undefined
        return undefined;
    }
  }
}

// =============================================================================
// Types
// =============================================================================

interface RuleRow {
  id: string;
  tenant_id: string;
  priority: number;
  conditions: string | null;
  action: string;
  roles_to_assign: string | null;
  orgs_to_join: string | null;
  attributes_to_set: string | null;
  deny_reason: string | null;
}

interface Rule {
  id: string;
  tenant_id: string;
  priority: number;
  conditions: RuleCondition[];
  action: 'allow' | 'deny';
  roles_to_assign: string[];
  orgs_to_join: string[];
  attributes_to_set: Array<{ key: string; value: unknown }>;
  deny_reason?: string;
}

interface RuleCondition {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'starts_with' | 'ends_with' | 'matches' | 'in' | 'exists';
  value: unknown;
}

// =============================================================================
// Exports
// =============================================================================

export default BuiltinPolicyInfra;
