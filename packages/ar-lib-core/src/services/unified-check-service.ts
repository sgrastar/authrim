/**
 * Unified Check Service
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Provides unified permission checking across:
 * - ID-level permissions (resource:id:action)
 * - Type-level permissions (resource:action)
 * - ReBAC relationship checks
 * - RBAC role-based checks
 *
 * Evaluation Order (first match wins):
 * 1. ID-Level Permission Check (resource_permissions table)
 * 2. Role-Based Permission Check (RBAC)
 * 3. ReBAC Check (relationships via ReBACService)
 * 4. Computed/ABAC (resource_context evaluation)
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type {
  CheckApiRequest,
  CheckApiResponse,
  BatchCheckRequest,
  BatchCheckResponse,
  ParsedPermission,
  PermissionInput,
  ResolvedVia,
  FinalDecision,
  CheckDebugInfo,
  AuditLogConfig,
} from '../types/check-api';
import type { ReBACService, CheckRequest as ReBACCheckRequest } from '../rebac';
import { hasIdLevelPermission, getUserIdLevelPermissions } from '../utils/resource-permissions';
import { createLogger } from '../utils/logger';

const log = createLogger().module('UNIFIED-CHECK-SERVICE');

// =============================================================================
// Constants
// =============================================================================

/**
 * URL-safe pattern for permission string components
 * Allows: a-z, A-Z, 0-9, underscore, hyphen
 */
const URL_SAFE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Default cache TTL in seconds
 */
const DEFAULT_CACHE_TTL = 60;

/**
 * Cache key prefix for check results
 */
const CHECK_CACHE_PREFIX = 'check:result:';

// =============================================================================
// Permission Parser
// =============================================================================

/**
 * Validation result
 */
interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate permission string component (resource, id, or action)
 */
function validateComponent(value: string, componentName: string): ValidationResult {
  if (!value || value.length === 0) {
    return { valid: false, error: `${componentName} cannot be empty` };
  }

  if (!URL_SAFE_PATTERN.test(value)) {
    return {
      valid: false,
      error: `${componentName} must be URL-safe (a-zA-Z0-9_-), got: ${value}`,
    };
  }

  return { valid: true };
}

/**
 * Parse permission input into structured format
 *
 * @param input - Permission string or object
 * @returns Parsed permission with type information
 * @throws Error if permission format is invalid
 */
export function parsePermission(input: PermissionInput): ParsedPermission {
  // Handle structured permission object
  if (typeof input === 'object' && input !== null) {
    const { resource, id, action } = input;

    // Validate resource
    const resourceValidation = validateComponent(resource, 'resource');
    if (!resourceValidation.valid) {
      throw new Error(resourceValidation.error);
    }

    // Validate action
    const actionValidation = validateComponent(action, 'action');
    if (!actionValidation.valid) {
      throw new Error(actionValidation.error);
    }

    // Validate id if provided
    if (id !== undefined && id !== null && id !== '') {
      const idValidation = validateComponent(id, 'id');
      if (!idValidation.valid) {
        throw new Error(idValidation.error);
      }

      return {
        type: 'id_level',
        resource,
        id,
        action,
        original: input,
      };
    }

    return {
      type: 'type_level',
      resource,
      action,
      original: input,
    };
  }

  // Handle permission string
  if (typeof input !== 'string') {
    throw new Error(`Invalid permission input type: ${typeof input}`);
  }

  const parts = input.split(':');

  if (parts.length === 2) {
    // Type-level: resource:action
    const [resource, action] = parts;

    const resourceValidation = validateComponent(resource, 'resource');
    if (!resourceValidation.valid) {
      throw new Error(resourceValidation.error);
    }

    const actionValidation = validateComponent(action, 'action');
    if (!actionValidation.valid) {
      throw new Error(actionValidation.error);
    }

    return {
      type: 'type_level',
      resource,
      action,
      original: input,
    };
  }

  if (parts.length === 3) {
    // ID-level: resource:id:action
    const [resource, id, action] = parts;

    const resourceValidation = validateComponent(resource, 'resource');
    if (!resourceValidation.valid) {
      throw new Error(resourceValidation.error);
    }

    const idValidation = validateComponent(id, 'id');
    if (!idValidation.valid) {
      throw new Error(idValidation.error);
    }

    const actionValidation = validateComponent(action, 'action');
    if (!actionValidation.valid) {
      throw new Error(actionValidation.error);
    }

    return {
      type: 'id_level',
      resource,
      id,
      action,
      original: input,
    };
  }

  throw new Error(
    `Invalid permission format: expected "resource:action" or "resource:id:action", got "${input}"`
  );
}

/**
 * Format parsed permission back to string
 */
export function formatPermission(parsed: ParsedPermission): string {
  if (parsed.type === 'id_level' && parsed.id) {
    return `${parsed.resource}:${parsed.id}:${parsed.action}`;
  }
  return `${parsed.resource}:${parsed.action}`;
}

// =============================================================================
// Unified Check Service
// =============================================================================

/**
 * Configuration for UnifiedCheckService
 */
export interface UnifiedCheckServiceConfig {
  /** D1 database for permission queries */
  db: D1Database;
  /** KV namespace for caching (optional) */
  cache?: KVNamespace;
  /** ReBAC service for relationship checks (optional) */
  rebacService?: ReBACService;
  /** Cache TTL in seconds (default: 60) */
  cacheTTL?: number;
  /** Enable debug mode */
  debugMode?: boolean;
  /** Audit log configuration */
  auditConfig?: AuditLogConfig;
}

/**
 * Internal check context for evaluation
 */
interface CheckContext {
  subjectId: string;
  subjectType: 'user' | 'service';
  tenantId: string;
  parsed: ParsedPermission;
  resourceContext?: CheckApiRequest['resource_context'];
  rebacParams?: CheckApiRequest['rebac'];
  startTime: number;
}

/**
 * Internal check result
 */
interface InternalCheckResult {
  allowed: boolean;
  resolvedVia: ResolvedVia[];
  reason?: string;
  debug?: Partial<CheckDebugInfo>;
}

/**
 * Unified Check Service
 *
 * Provides unified permission checking with multiple resolution strategies.
 */
export class UnifiedCheckService {
  private db: D1Database;
  private cache?: KVNamespace;
  private rebacService?: ReBACService;
  private cacheTTL: number;
  private debugMode: boolean;
  private auditConfig: AuditLogConfig;

  constructor(config: UnifiedCheckServiceConfig) {
    this.db = config.db;
    this.cache = config.cache;
    this.rebacService = config.rebacService;
    this.cacheTTL = config.cacheTTL ?? DEFAULT_CACHE_TTL;
    this.debugMode = config.debugMode ?? false;
    this.auditConfig = config.auditConfig ?? {
      log_deny: 'always',
      log_allow: 'sample',
      allow_sample_rate: 0.01,
    };
  }

  /**
   * Check a single permission
   */
  async check(request: CheckApiRequest): Promise<CheckApiResponse> {
    const startTime = performance.now();

    try {
      // Parse permission
      const parsed = parsePermission(request.permission);

      // Build context
      const context: CheckContext = {
        subjectId: request.subject_id,
        subjectType: request.subject_type ?? 'user',
        tenantId: request.tenant_id ?? 'default',
        parsed,
        resourceContext: request.resource_context,
        rebacParams: request.rebac,
        startTime,
      };

      // Try cache first
      const cacheKey = this.buildCacheKey(context);
      if (this.cache) {
        const cached = await this.getCachedResult(cacheKey);
        if (cached) {
          return cached;
        }
      }

      // Evaluate permission (order matters - first match wins)
      const result = await this.evaluate(context);

      // Build response
      const response = this.buildResponse(result, startTime);

      // Cache result
      if (this.cache) {
        await this.cacheResult(cacheKey, response);
      }

      return response;
    } catch (error) {
      // Handle parsing or evaluation errors
      log.error('Evaluation error', { subjectId: request.subject_id }, error as Error);
      return {
        allowed: false,
        resolved_via: [],
        final_decision: 'deny',
        // SECURITY: Do not expose internal error details in response
        reason: 'evaluation_error: Permission check failed',
        cache_ttl: 0,
      };
    }
  }

  /**
   * Check multiple permissions in batch
   */
  async batchCheck(request: BatchCheckRequest): Promise<BatchCheckResponse> {
    const startTime = performance.now();
    const results: CheckApiResponse[] = [];
    let allowedCount = 0;
    let deniedCount = 0;

    for (const checkRequest of request.checks) {
      const result = await this.check(checkRequest);
      results.push(result);

      if (result.allowed) {
        allowedCount++;
      } else {
        deniedCount++;
        if (request.stop_on_deny) {
          // Fill remaining with skipped results
          for (let i = results.length; i < request.checks.length; i++) {
            results.push({
              allowed: false,
              resolved_via: [],
              final_decision: 'deny',
              reason: 'skipped_due_to_stop_on_deny',
            });
            deniedCount++;
          }
          break;
        }
      }
    }

    const evaluationTime = performance.now() - startTime;

    return {
      results,
      summary: {
        total: request.checks.length,
        allowed: allowedCount,
        denied: deniedCount,
        evaluation_time_ms: Math.round(evaluationTime * 100) / 100,
      },
    };
  }

  /**
   * Evaluate permission through all resolution strategies
   */
  private async evaluate(context: CheckContext): Promise<InternalCheckResult> {
    const matchedRules: string[] = [];

    // 1. ID-Level Permission Check (if ID is present)
    if (context.parsed.type === 'id_level' && context.parsed.id) {
      const idLevelResult = await this.checkIdLevelPermission(context);
      if (idLevelResult.allowed) {
        matchedRules.push(`id_level:${formatPermission(context.parsed)}`);
        return {
          allowed: true,
          resolvedVia: ['id_level'],
          debug: { matched_rules: matchedRules },
        };
      }
    }

    // 2. Role-Based Permission Check (RBAC)
    const rbacResult = await this.checkRoleBasedPermission(context);
    if (rbacResult.allowed) {
      matchedRules.push(`role:${rbacResult.roleName}`);
      return {
        allowed: true,
        resolvedVia: ['role'],
        debug: { matched_rules: matchedRules },
      };
    }

    // 3. ReBAC Check (if rebac params provided and service available)
    if (context.rebacParams && this.rebacService) {
      const rebacResult = await this.checkReBACPermission(context);
      if (rebacResult.allowed) {
        matchedRules.push(`rebac:${context.rebacParams.relation}@${context.rebacParams.object}`);
        return {
          allowed: true,
          resolvedVia: ['rebac'],
          debug: {
            matched_rules: matchedRules,
            path: rebacResult.path,
          },
        };
      }
    }

    // 4. Computed/ABAC (if resource_context provided)
    if (context.resourceContext) {
      const abacResult = await this.checkComputedPermission(context);
      if (abacResult.allowed) {
        matchedRules.push(`computed:${abacResult.ruleName}`);
        return {
          allowed: true,
          resolvedVia: ['computed'],
          debug: { matched_rules: matchedRules },
        };
      }
    }

    // No match - deny
    return {
      allowed: false,
      resolvedVia: [],
      reason: 'no_matching_permission',
      debug: { matched_rules: [] },
    };
  }

  /**
   * Check ID-level permission in resource_permissions table
   */
  private async checkIdLevelPermission(
    context: CheckContext
  ): Promise<{ allowed: boolean; permissionId?: string }> {
    if (!context.parsed.id) {
      return { allowed: false };
    }

    try {
      const hasPermission = await hasIdLevelPermission(
        this.db,
        context.subjectId,
        context.parsed.resource,
        context.parsed.id,
        context.parsed.action,
        context.tenantId
      );

      return { allowed: hasPermission };
    } catch (error) {
      log.error('ID-level check error', { subjectId: context.subjectId }, error as Error);
      return { allowed: false };
    }
  }

  /**
   * Check role-based permission via RBAC
   */
  private async checkRoleBasedPermission(
    context: CheckContext
  ): Promise<{ allowed: boolean; roleName?: string }> {
    try {
      // Query user's roles
      const rolesResult = await this.db
        .prepare(
          `SELECT r.name, r.permissions_json
           FROM roles r
           INNER JOIN role_assignments ra ON r.id = ra.role_id
           WHERE ra.subject_id = ?
             AND ra.tenant_id = ?
             AND r.is_active = 1
             AND (ra.expires_at IS NULL OR ra.expires_at > ?)`
        )
        .bind(context.subjectId, context.tenantId, Math.floor(Date.now() / 1000))
        .all<{ name: string; permissions_json: string }>();

      const permissionToCheck =
        context.parsed.type === 'type_level'
          ? `${context.parsed.resource}:${context.parsed.action}`
          : formatPermission(context.parsed);

      for (const role of rolesResult.results) {
        try {
          const permissions = JSON.parse(role.permissions_json || '[]') as string[];

          // Check for exact match or wildcard
          if (
            permissions.includes(permissionToCheck) ||
            permissions.includes(`${context.parsed.resource}:*`) ||
            permissions.includes('*:*') ||
            permissions.includes('*')
          ) {
            return { allowed: true, roleName: role.name };
          }
        } catch {
          // Skip invalid JSON
        }
      }

      return { allowed: false };
    } catch (error) {
      log.error('RBAC check error', { subjectId: context.subjectId }, error as Error);
      return { allowed: false };
    }
  }

  /**
   * Check ReBAC relationship permission
   */
  private async checkReBACPermission(
    context: CheckContext
  ): Promise<{ allowed: boolean; path?: string[] }> {
    if (!context.rebacParams || !this.rebacService) {
      return { allowed: false };
    }

    try {
      const checkRequest: ReBACCheckRequest = {
        tenant_id: context.tenantId,
        user_id: context.subjectId,
        relation: context.rebacParams.relation,
        object: context.rebacParams.object,
      };

      const result = await this.rebacService.check(checkRequest);

      return {
        allowed: result.allowed,
        path: result.path,
      };
    } catch (error) {
      log.error('ReBAC check error', { subjectId: context.subjectId }, error as Error);
      return { allowed: false };
    }
  }

  /**
   * Check computed/ABAC permission based on resource context
   */
  private async checkComputedPermission(
    context: CheckContext
  ): Promise<{ allowed: boolean; ruleName?: string }> {
    if (!context.resourceContext) {
      return { allowed: false };
    }

    try {
      // Simple ownership check
      if (context.resourceContext.owner_id === context.subjectId) {
        return { allowed: true, ruleName: 'owner_access' };
      }

      // Organization membership check
      if (context.resourceContext.org_id) {
        const orgMemberResult = await this.db
          .prepare(
            `SELECT 1 FROM organization_memberships
             WHERE user_id = ? AND org_id = ? AND is_active = 1`
          )
          .bind(context.subjectId, context.resourceContext.org_id)
          .first();

        if (orgMemberResult) {
          return { allowed: true, ruleName: 'org_member_access' };
        }
      }

      // TODO: Add more ABAC rules based on resource_context.attributes

      return { allowed: false };
    } catch (error) {
      log.error('ABAC check error', { subjectId: context.subjectId }, error as Error);
      return { allowed: false };
    }
  }

  /**
   * Build cache key for check result
   */
  private buildCacheKey(context: CheckContext): string {
    const permStr = formatPermission(context.parsed);
    return `${CHECK_CACHE_PREFIX}${context.tenantId}:${context.subjectId}:${permStr}`;
  }

  /**
   * Get cached result
   */
  private async getCachedResult(key: string): Promise<CheckApiResponse | null> {
    if (!this.cache) return null;

    try {
      const cached = await this.cache.get(key);
      if (cached) {
        return JSON.parse(cached) as CheckApiResponse;
      }
    } catch {
      // Cache read error - continue without cache
    }

    return null;
  }

  /**
   * Cache check result
   */
  private async cacheResult(key: string, response: CheckApiResponse): Promise<void> {
    if (!this.cache) return;

    try {
      await this.cache.put(key, JSON.stringify(response), {
        expirationTtl: this.cacheTTL,
      });
    } catch {
      // Cache write error - ignore
    }
  }

  /**
   * Build final response
   */
  private buildResponse(result: InternalCheckResult, startTime: number): CheckApiResponse {
    const evaluationTime = performance.now() - startTime;

    const response: CheckApiResponse = {
      allowed: result.allowed,
      resolved_via: result.resolvedVia,
      final_decision: result.allowed ? 'allow' : 'deny',
      cache_ttl: this.cacheTTL,
    };

    if (!result.allowed && result.reason) {
      response.reason = result.reason;
    }

    if (this.debugMode && result.debug) {
      response.debug = {
        ...result.debug,
        evaluation_time_ms: Math.round(evaluationTime * 100) / 100,
      };
    }

    return response;
  }

  /**
   * Invalidate cache for a subject
   */
  async invalidateCache(tenantId: string, subjectId: string): Promise<void> {
    if (!this.cache) return;

    // Note: KV doesn't support prefix deletion, so we need to track keys
    // For now, we rely on TTL expiration
    // In production, consider using a secondary index or different cache strategy
    log.debug('Cache invalidation requested', { tenantId, subjectId });
  }
}

/**
 * Create UnifiedCheckService instance
 */
export function createUnifiedCheckService(config: UnifiedCheckServiceConfig): UnifiedCheckService {
  return new UnifiedCheckService(config);
}
