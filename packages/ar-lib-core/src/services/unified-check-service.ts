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

import type { KVNamespace } from '@cloudflare/workers-types';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../db';
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
  VerifiedAttributeForCheck,
  AttributeRepository,
  PolicyEvaluator,
  PolicyEvaluationContext,
} from '../types/check-api';
import type { CheckAuditService, PermissionCheckAuditEntry } from './check-audit-service';
import { generateAuditId } from './check-audit-service';
import type { ReBACService, CheckRequest as ReBACCheckRequest } from '../rebac';
import { hasIdLevelPermission, getUserIdLevelPermissions } from '../utils/resource-permissions';
import { createLogger } from '../utils/logger';
import { DEFAULT_TENANT_ID } from '../utils/tenant-context';

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
  /** Database source for permission queries */
  db: DatabaseSource;
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
  /** Attribute repository for ABAC evaluation (optional) */
  attributeRepository?: AttributeRepository;
  /** Enable ABAC evaluation (default: false) */
  enableAbac?: boolean;
  /** Policy evaluator for ABAC rules (optional) */
  policyEvaluator?: PolicyEvaluator;
  /** Audit service for permission check logging (optional) */
  auditService?: CheckAuditService;
  /** Defensive fallback when caller omitted tenant_id */
  defaultTenantId?: string;
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
  /** Verified attributes for ABAC evaluation (loaded from DB) */
  verifiedAttributes?: VerifiedAttributeForCheck[];
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
  private db: DatabaseAdapter;
  private cache?: KVNamespace;
  private rebacService?: ReBACService;
  private cacheTTL: number;
  private debugMode: boolean;
  private auditConfig: AuditLogConfig;
  private attributeRepository?: AttributeRepository;
  private enableAbac: boolean;
  private policyEvaluator?: PolicyEvaluator;
  private auditService?: CheckAuditService;
  private defaultTenantId: string;

  constructor(config: UnifiedCheckServiceConfig) {
    this.db = ensureDatabaseAdapter(config.db, 'policy-check');
    this.cache = config.cache;
    this.rebacService = config.rebacService;
    this.cacheTTL = config.cacheTTL ?? DEFAULT_CACHE_TTL;
    this.debugMode = config.debugMode ?? false;
    this.auditConfig = config.auditConfig ?? {
      log_deny: 'always',
      log_allow: 'sample',
      allow_sample_rate: 0.01,
    };
    this.attributeRepository = config.attributeRepository;
    this.enableAbac = config.enableAbac ?? false;
    this.policyEvaluator = config.policyEvaluator;
    this.auditService = config.auditService;
    this.defaultTenantId = config.defaultTenantId ?? DEFAULT_TENANT_ID;
  }

  /**
   * Check a single permission
   *
   * @param request - Check request
   * @param options - Optional parameters for audit logging
   * @param options.ctx - ExecutionContext for non-blocking audit logging (waitUntil mode)
   * @param options.apiKeyId - API key ID for audit logging
   * @param options.clientId - Client ID for audit logging
   * @param options.requestId - Request ID for correlation
   */
  async check(
    request: CheckApiRequest,
    options?: {
      ctx?: ExecutionContext;
      apiKeyId?: string;
      clientId?: string;
      requestId?: string;
    }
  ): Promise<CheckApiResponse> {
    const startTime = performance.now();
    let parsed: ParsedPermission | undefined;
    let tenantId = request.tenant_id ?? this.defaultTenantId;

    try {
      // Parse permission
      parsed = parsePermission(request.permission);

      // Build context
      const context: CheckContext = {
        subjectId: request.subject_id,
        subjectType: request.subject_type ?? 'user',
        tenantId,
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
          // Log audit for cached result too
          await this.logAudit(request, cached, parsed, tenantId, options);
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

      // Log audit entry
      await this.logAudit(request, response, parsed, tenantId, options);

      return response;
    } catch (error) {
      // Handle parsing or evaluation errors
      log.error('Evaluation error', { subjectId: request.subject_id }, error as Error);
      const errorResponse: CheckApiResponse = {
        allowed: false,
        resolved_via: [],
        final_decision: 'deny',
        // SECURITY: Do not expose internal error details in response
        reason: 'evaluation_error: Permission check failed',
        cache_ttl: 0,
      };

      // Log audit for error case too
      await this.logAudit(request, errorResponse, parsed, tenantId, options);

      return errorResponse;
    }
  }

  /**
   * Log audit entry for permission check
   */
  private async logAudit(
    request: CheckApiRequest,
    response: CheckApiResponse,
    parsed: ParsedPermission | undefined,
    tenantId: string,
    options?: {
      ctx?: ExecutionContext;
      apiKeyId?: string;
      clientId?: string;
      requestId?: string;
    }
  ): Promise<void> {
    if (!this.auditService) return;

    try {
      const entry: PermissionCheckAuditEntry = {
        id: generateAuditId(),
        tenantId,
        subjectId: request.subject_id,
        permission:
          typeof request.permission === 'string'
            ? request.permission
            : `${request.permission.resource}:${request.permission.id ?? ''}:${request.permission.action}`,
        permissionParsed: parsed,
        allowed: response.allowed,
        resolvedVia: response.resolved_via,
        finalDecision: response.final_decision,
        reason: response.reason,
        apiKeyId: options?.apiKeyId,
        clientId: options?.clientId,
        requestId: options?.requestId,
      };

      await this.auditService.log(entry, options?.ctx);
    } catch (error) {
      // Audit logging should not fail the request
      log.error('Failed to log audit entry', { subjectId: request.subject_id }, error as Error);
    }
  }

  /**
   * Check multiple permissions in batch
   *
   * @param request - Batch check request
   * @param options - Optional parameters for audit logging
   */
  async batchCheck(
    request: BatchCheckRequest,
    options?: {
      ctx?: ExecutionContext;
      apiKeyId?: string;
      clientId?: string;
      requestId?: string;
    }
  ): Promise<BatchCheckResponse> {
    const startTime = performance.now();
    const results: CheckApiResponse[] = [];
    let allowedCount = 0;
    let deniedCount = 0;

    for (const checkRequest of request.checks) {
      const result = await this.check(checkRequest, options);
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

    // Pre-load user verified attributes for ABAC evaluation
    if (this.enableAbac && this.attributeRepository && !context.verifiedAttributes) {
      try {
        const attrs = await this.attributeRepository.getValidAttributesForUser(
          context.tenantId,
          context.subjectId
        );
        context.verifiedAttributes = Object.entries(attrs).map(([name, value]) => ({
          name,
          value,
          source: 'db' as const,
        }));
      } catch (error) {
        log.error(
          'Failed to load user attributes',
          { subjectId: context.subjectId },
          error as Error
        );
        // Continue without attributes - don't fail the check
      }
    }

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
        .query<{ name: string; permissions_json: string }>(
          `SELECT r.name, r.permissions_json
           FROM roles r
           INNER JOIN role_assignments ra ON r.id = ra.role_id
           WHERE ra.subject_id = ?
             AND ra.tenant_id = ?
             AND r.is_active = 1
             AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
          [context.subjectId, context.tenantId, Math.floor(Date.now() / 1000)]
        );

      const permissionToCheck =
        context.parsed.type === 'type_level'
          ? `${context.parsed.resource}:${context.parsed.action}`
          : formatPermission(context.parsed);

      for (const role of rolesResult) {
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

      // Pass contextual tuples if provided
      if (context.rebacParams.contextual_tuples?.length) {
        checkRequest.context = {
          contextual_tuples: context.rebacParams.contextual_tuples.map((t) => ({
            user_id: t.user_id,
            relation: t.relation,
            object: t.object,
          })),
        };
      }

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
          .queryOne(
            `SELECT 1 FROM organization_memberships
             WHERE user_id = ? AND org_id = ? AND is_active = 1`,
            [context.subjectId, context.resourceContext.org_id]
          );

        if (orgMemberResult) {
          return { allowed: true, ruleName: 'org_member_access' };
        }
      }

      // ABAC evaluation via PolicyEvaluator (if enabled and configured)
      if (this.enableAbac && this.policyEvaluator && context.verifiedAttributes?.length) {
        const policyContext: PolicyEvaluationContext = {
          subjectId: context.subjectId,
          verifiedAttributes: context.verifiedAttributes,
          resourceType: context.parsed.resource,
          resourceId: context.parsed.id,
          resourceOwnerId: context.resourceContext.owner_id,
          resourceOrgId: context.resourceContext.org_id,
          resourceAttributes: context.resourceContext.attributes,
          action: context.parsed.action,
          timestamp: Date.now(),
        };

        const decision = this.policyEvaluator.evaluate(policyContext);
        if (decision.allowed) {
          return { allowed: true, ruleName: decision.decidedBy ?? 'abac_policy' };
        }
      }

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
