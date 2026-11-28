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
 * 3. ReBAC Check (relationships via ReBACService), only when the tenant enables ReBAC
 *    (`feature.enable_rebac`) and the request carries `rebac`
 * 4. Computed/ABAC (resource_context evaluation)
 *
 * Contracts (see CheckContract): a `server` check takes `resource_context` and `rebac` from the
 * request. A `self` check (an end-user access token) never does: its resource context comes from
 * the configured ResourceContextResolver (none by default), and it has no relationship check.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../db';
import type {
  CheckApiRequest,
  CheckApiResponse,
  CheckContract,
  ResourceContextResolver,
  BatchCheckRequest,
  BatchCheckResponse,
  ParsedPermission,
  PermissionInput,
  ResolvedVia,
  CheckDebugInfo,
  AuditLogConfig,
  VerifiedAttributeForCheck,
  AttributeRepository,
  PolicyEvaluator,
  TenantPolicySettings,
  PolicyEvaluationContext,
  PolicySubjectRole,
} from '../types/check-api';
import type { CheckAuditService, PermissionCheckAuditEntry } from './check-audit-service';
import { generateAuditId } from './check-audit-service';
import type { ReBACService, SubjectGroupsResolver } from '../rebac';
import { parseObjectString } from '../rebac/relation-parser';
import { externalSubjectId } from '../rebac/rebac-service';
import { hasIdLevelPermission } from '../utils/resource-permissions';
import {
  grantedPermissionCovers,
  isValidPermissionId,
  isValidPermissionName,
  parseConcretePermission,
  type ConcretePermission,
} from '../utils/permission-grammar';
import { NO_RESOURCE_CONTEXT_RESOLVER } from './resource-context-resolver';
import { createLogger } from '../utils/logger';
import {
  resolveSubjectRolesAndGroups,
  roleAssignmentHolds,
  rolePermissions,
  type RoleAssignmentTarget,
  type TenantRBACDatabases,
} from './tenant-rbac';

const log = createLogger().module('UNIFIED-CHECK-SERVICE');

// =============================================================================
// Permission Parser
// =============================================================================

/**
 * Parse a checked permission (string or object) into structured format: one concrete action, in
 * the grammar of utils/permission-grammar.ts (`resource:action` or `resource:<id>:action`;
 * resource and action `[a-z][a-z0-9_]*`, id without whitespace or `:`). The wildcard forms a
 * role may hold (`resource:*`, `*:*`, `*`) are not a check.
 *
 * @param input - Permission string or object
 * @returns Parsed permission with type information
 * @throws Error if permission format is invalid
 */
export function parsePermission(input: PermissionInput): ParsedPermission {
  // Handle structured permission object
  if (typeof input === 'object' && input !== null) {
    const { resource, id, action } = input;
    if (!isValidPermissionName(resource)) {
      throw new Error(`resource must match [a-z][a-z0-9_]*, got: ${String(resource)}`);
    }
    if (!isValidPermissionName(action)) {
      throw new Error(`action must match [a-z][a-z0-9_]*, got: ${String(action)}`);
    }
    // An id that is present must be one: `""` or `null` is invalid, not "no id".
    if (id !== undefined) {
      if (!isValidPermissionId(id)) {
        throw new Error(
          `id must be non-empty without whitespace, control characters or ':', got: ${String(id)}`
        );
      }
      return { type: 'id_level', resource, id, action, original: input };
    }
    return { type: 'type_level', resource, action, original: input };
  }

  // Handle permission string
  if (typeof input !== 'string') {
    throw new Error(`Invalid permission input type: ${typeof input}`);
  }

  const parsed = parseConcretePermission(input);
  if (!parsed) {
    throw new Error(
      `Invalid permission format: expected "resource:action" or "resource:id:action", got "${input}"`
    );
  }
  return parsed.kind === 'id_level'
    ? {
        type: 'id_level',
        resource: parsed.resource,
        id: parsed.id,
        action: parsed.action,
        original: input,
      }
    : { type: 'type_level', resource: parsed.resource, action: parsed.action, original: input };
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
  /** Database source for permission queries: the tenant metadata database */
  db: DatabaseSource;
  /**
   * The database of a subject's account, where its role assignments and group memberships
   * are (see services/tenant-rbac.ts). It throws when the subject has no account. Without it, the
   * subject's assignments are read from `db` (a single-database deployment).
   */
  subjectAccountDb?: (tenantId: string, subjectId: string) => Promise<DatabaseSource>;
  /**
   * The subject's account database and the id its rows are stored under (the account router's
   * canonical id: a request may name the account in another form, such as with `account:` or
   * surrounding spaces). Takes precedence over `subjectAccountDb`. It throws when the subject has
   * no account.
   */
  subjectAccount?: (
    tenantId: string,
    subjectId: string
  ) => Promise<{ db: DatabaseSource; subjectId: string }>;
  /** @deprecated Shared decisions are evaluated against the current database. */
  cache?: KVNamespace;
  /** ReBAC service for relationship checks (optional) */
  rebacService?: ReBACService;
  /** @deprecated Check responses always return cache_ttl=0. */
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
  /**
   * Evaluate a request's `rebac` (default: false), when `tenantPolicy` is not given. With
   * `tenantPolicy`, its `rebac` (the tenant's `feature.enable_rebac`) decides.
   */
  enableRebac?: boolean;
  /**
   * The attribute-based policy settings of a tenant (optional). When given, it decides per check
   * (by the check's tenant) instead of `enableAbac` / `policyEvaluator`. It must not throw: it
   * returns everything off when the tenant's settings cannot be read.
   */
  tenantPolicy?: (tenantId: string) => Promise<TenantPolicySettings>;
  /**
   * Resolves the resource context of self-contract checks (default: resolves nothing, so a self
   * check has no resource context). Server-contract checks never use it.
   */
  resourceContextResolver?: ResourceContextResolver;
}

/** Options of a check beyond its request. */
export interface CheckOptions {
  ctx?: ExecutionContext;
  apiKeyId?: string;
  clientId?: string;
  requestId?: string;
  /**
   * The contract the request came in under (default `server`). A `self` request must not carry
   * `resource_context` or `rebac` (it is refused with `contract_violation`); its resource context
   * is resolved server-side.
   */
  contract?: CheckContract;
}

/**
 * Internal check context for evaluation
 */
interface CheckContext {
  /** The contract of the request (see CheckContract) */
  contract: CheckContract;
  /**
   * The subject: the account router's canonical id once the evaluation resolved it (every lookup
   * and comparison of the check uses it), the request's id until then or when it does not resolve.
   */
  subjectId: string;
  /** The subject as the request named it (the key the account is resolved by). */
  requestSubjectId: string;
  subjectType: 'user' | 'service';
  tenantId: string;
  parsed: ParsedPermission;
  resourceContext?: CheckApiRequest['resource_context'];
  rebacParams?: CheckApiRequest['rebac'];
  /** Self contract: the relationship the resolver says would grant the permission */
  selfRelation?: { relation: string; object_type: string; object_id: string };
  startTime: number;
  /** Verified attributes for ABAC evaluation (loaded from DB) */
  verifiedAttributes?: VerifiedAttributeForCheck[];
  /** The tenant's attribute-based policy settings for this check */
  policy: TenantPolicySettings;
  /** The subject's active role assignments with their scope (from the role check; unset when
   * they could not be read) */
  subjectRoles?: PolicySubjectRole[];
  /** The subject's effective group ids (read with its roles; unset when they could not be read) */
  subjectGroupIds?: string[];
  /** Groups whose membership is not known (see resolveSubjectGroups) */
  subjectUnknownGroupIds?: string[];
  /** The verified attributes were wanted but could not be read */
  attributesUnavailable?: boolean;
  /**
   * A self-contract check whose resource could not be resolved (the resolver failed): the
   * tenant's rules grant nothing, as a deny on resource material could not apply.
   */
  resourceUnavailable?: boolean;
  /** The relationship check was left undecided by a group membership (`unknown_membership`) */
  rebacUndecided?: boolean;
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

/** The target of a check, as role assignments are matched against it. */
function checkTarget(context: CheckContext): RoleAssignmentTarget {
  return {
    tenantId: context.tenantId,
    groupIds: context.resourceContext?.group_id ? [context.resourceContext.group_id] : [],
    resourceType: context.parsed.resource,
    resourceId: context.parsed.id,
  };
}

/**
 * Unified Check Service
 *
 * Provides unified permission checking with multiple resolution strategies.
 */
export class UnifiedCheckService {
  private db: DatabaseAdapter;
  private subjectAccount?: (
    tenantId: string,
    subjectId: string
  ) => Promise<{ db: DatabaseSource; subjectId: string }>;
  /** Subject accounts resolved during this service's lifetime (one request). */
  private subjectAccounts = new Map<string, Promise<{ db: DatabaseSource; subjectId: string }>>();
  private rebacService?: ReBACService;
  private debugMode: boolean;
  private auditConfig: AuditLogConfig;
  private attributeRepository?: AttributeRepository;
  private enableAbac: boolean;
  private enableRebac: boolean;
  private resourceContextResolver: ResourceContextResolver;
  private policyEvaluator?: PolicyEvaluator;
  private auditService?: CheckAuditService;
  private tenantPolicy?: (tenantId: string) => Promise<TenantPolicySettings>;
  /** Tenant policy settings resolved during this service's lifetime (one request). */
  private tenantPolicies = new Map<string, Promise<TenantPolicySettings>>();

  constructor(config: UnifiedCheckServiceConfig) {
    this.db = ensureDatabaseAdapter(config.db, 'policy-check');
    const accountDb = config.subjectAccountDb;
    this.subjectAccount =
      config.subjectAccount ??
      (accountDb
        ? async (tenantId, subjectId) => ({ db: await accountDb(tenantId, subjectId), subjectId })
        : undefined);
    this.rebacService = config.rebacService;
    this.debugMode = config.debugMode ?? false;
    this.auditConfig = config.auditConfig ?? {
      log_deny: 'always',
      log_allow: 'sample',
      allow_sample_rate: 0.01,
    };
    this.attributeRepository = config.attributeRepository;
    this.enableAbac = config.enableAbac ?? false;
    this.enableRebac = config.enableRebac ?? false;
    this.resourceContextResolver = config.resourceContextResolver ?? NO_RESOURCE_CONTEXT_RESOLVER;
    this.policyEvaluator = config.policyEvaluator;
    this.auditService = config.auditService;
    this.tenantPolicy = config.tenantPolicy;
  }

  /** The attribute-based policy settings for a tenant (once per tenant for this service). */
  private policyFor(tenantId: string): Promise<TenantPolicySettings> {
    if (!this.tenantPolicy) {
      return Promise.resolve({
        abac: this.enableAbac,
        verifiedAttributes: this.enableAbac,
        rebac: this.enableRebac,
        logDecisions: false,
        evaluator: this.policyEvaluator,
      });
    }
    let policy = this.tenantPolicies.get(tenantId);
    if (!policy) {
      policy = this.tenantPolicy(tenantId).catch(() => ({
        abac: false,
        verifiedAttributes: false,
        rebac: false,
        logDecisions: false,
        unavailable: true,
      }));
      this.tenantPolicies.set(tenantId, policy);
    }
    return policy;
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
   * @param options.contract - The contract of the request (default `server`)
   */
  async check(request: CheckApiRequest, options?: CheckOptions): Promise<CheckApiResponse> {
    const startTime = performance.now();
    let parsed: ParsedPermission | undefined;
    const tenantId = request.tenant_id?.trim();
    if (!tenantId) {
      throw new Error('UnifiedCheckService requires tenant_id');
    }

    try {
      // Parse permission
      parsed = parsePermission(request.permission);

      const contract = options?.contract ?? 'server';
      if (
        contract === 'self' &&
        (request.resource_context !== undefined || request.rebac !== undefined)
      ) {
        // The route refuses these with 400; never evaluate them if one gets here.
        const refused: CheckApiResponse = {
          allowed: false,
          resolved_via: [],
          final_decision: 'deny',
          reason: 'contract_violation',
          cache_ttl: 0,
        };
        await this.logAudit(request, refused, parsed, tenantId, options);
        return refused;
      }

      // Build context
      const resolved =
        contract === 'self'
          ? await this.resolveSelfResourceContext(tenantId, request.subject_id, parsed, options)
          : undefined;
      const context: CheckContext = {
        contract,
        subjectId: request.subject_id,
        requestSubjectId: request.subject_id,
        subjectType: request.subject_type ?? 'user',
        tenantId,
        parsed,
        resourceContext: contract === 'self' ? resolved?.context : request.resource_context,
        rebacParams: contract === 'self' ? undefined : request.rebac,
        selfRelation: resolved?.relation,
        ...(resolved?.unavailable && { resourceUnavailable: true }),
        startTime,
        policy: await this.policyFor(tenantId),
      };

      // Evaluate permission (order matters - first match wins)
      const result = await this.evaluate(context);

      // Build response
      const response = this.buildResponse(result, startTime);

      this.logDecision(context, request, response);

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
   * The resource context of a self-contract check, from the resolver: none when it knows nothing
   * about the resource or fails (no allow may come from material that could not be resolved).
   */
  private async resolveSelfResourceContext(
    tenantId: string,
    subjectId: string,
    parsed: ParsedPermission,
    options?: CheckOptions
  ): Promise<
    | {
        context?: CheckApiRequest['resource_context'];
        relation?: { relation: string; object_type: string; object_id: string };
        /** The resolver failed: the tenant's rules then grant nothing. */
        unavailable?: boolean;
      }
    | undefined
  > {
    try {
      const resolved = await this.resourceContextResolver.resolve({
        tenantId,
        resourceType: parsed.resource,
        resourceId: parsed.id,
        action: parsed.action,
        subjectId,
        clientId: options?.clientId,
      });
      if (!resolved) return undefined;
      const context: NonNullable<CheckApiRequest['resource_context']> = {};
      if (typeof resolved.owner_id === 'string' && resolved.owner_id) {
        context.owner_id = resolved.owner_id;
      }
      if (typeof resolved.group_id === 'string' && resolved.group_id) {
        context.group_id = resolved.group_id;
      }
      if (resolved.attributes && typeof resolved.attributes === 'object') {
        context.attributes = resolved.attributes;
      }
      const rebac = resolved.rebac;
      const relation =
        rebac &&
        typeof rebac.relation === 'string' &&
        rebac.relation &&
        typeof rebac.object_type === 'string' &&
        rebac.object_type &&
        typeof rebac.object_id === 'string' &&
        rebac.object_id
          ? {
              relation: rebac.relation,
              object_type: rebac.object_type,
              object_id: rebac.object_id,
            }
          : undefined;
      return {
        context: Object.keys(context).length > 0 ? context : undefined,
        relation,
      };
    } catch (error) {
      // Fail closed: without the resource, a tenant rule that denies on its owner, group or
      // attributes would not match and a later rule could grant, so the rules grant nothing.
      log.warn('Resource context resolver failed; checking without a resource context', {
        tenantId,
        resourceType: parsed.resource,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { unavailable: true };
    }
  }

  /** Log a decision, for a tenant that enables it (`feature.enable_policy_logging`). */
  private logDecision(
    context: CheckContext,
    request: CheckApiRequest,
    response: CheckApiResponse
  ): void {
    if (!context.policy.logDecisions) return;
    log.info('Permission check decision', {
      tenantId: context.tenantId,
      subjectId: context.subjectId,
      permission: formatPermission(context.parsed),
      allowed: response.allowed,
      resolvedVia: response.resolved_via,
      decidedBy: response.debug?.matched_rules?.[0],
      reason: response.reason,
      hasResourceContext: request.resource_context !== undefined,
    });
  }

  /**
   * Log audit entry for permission check
   */
  private async logAudit(
    request: CheckApiRequest,
    response: CheckApiResponse,
    parsed: ParsedPermission | undefined,
    tenantId: string,
    options?: CheckOptions
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
    options?: CheckOptions
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

    // The subject under the account router's canonical id, for every lookup and comparison
    // below (attributes, roles, memberships, relationships, the resource owner). One that does not
    // resolve is denied here: no stage may evaluate the request's raw id (a contextual tuple or a
    // resource owner naming it would otherwise grant).
    if (this.subjectAccount) {
      try {
        context.subjectId = (await this.subjectRBACDatabases(context)).subjectId;
      } catch {
        return {
          allowed: false,
          resolvedVia: [],
          reason: 'no_matching_permission',
          debug: { matched_rules: [] },
        };
      }
    }

    // Pre-load user verified attributes for ABAC evaluation
    if (
      context.policy.abac &&
      context.policy.verifiedAttributes &&
      this.attributeRepository &&
      !context.verifiedAttributes
    ) {
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
        // Continue without attributes - don't fail the check; the tenant's rules are not
        // evaluated then (a rule denying on an attribute must not be skipped).
        context.attributesUnavailable = true;
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
      matchedRules.push(
        rbacResult.viaGroup
          ? `group_role:${rbacResult.roleName}@${rbacResult.viaGroup}`
          : `role:${rbacResult.roleName}`
      );
      return {
        allowed: true,
        resolvedVia: [rbacResult.viaGroup ? 'group_role' : 'role'],
        debug: { matched_rules: matchedRules },
      };
    }

    // 3a. Self contract: the relationship check of the bound subject, for the relation and object
    // the resolver named (only when the tenant enables ReBAC): direct tuples, group usersets,
    // relation definitions and exclusion apply as on the server contract
    if (
      context.contract === 'self' &&
      context.selfRelation &&
      this.rebacService &&
      context.policy.rebac === true
    ) {
      const selfResult = await this.checkSelfRelation(context, context.selfRelation);
      if (selfResult.allowed) {
        const { relation, object_type, object_id } = context.selfRelation;
        matchedRules.push(`rebac:${relation}@${object_type}:${object_id}`);
        return {
          allowed: true,
          resolvedVia: ['rebac'],
          debug: { matched_rules: matchedRules },
        };
      }
    }

    // 3. ReBAC Check (if rebac params provided, service available, and the tenant enables ReBAC)
    if (context.rebacParams && this.rebacService && context.policy.rebac === true) {
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

    // 4. Computed/ABAC (ownership and membership with resource_context; the tenant's rules when
    // attribute-based policy is on)
    if (context.resourceContext || (context.policy.abac && context.policy.evaluator)) {
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

    // No match - deny (a relationship a group membership left undecided says so)
    return {
      allowed: false,
      resolvedVia: [],
      reason: context.rebacUndecided ? 'unknown_membership' : 'no_matching_permission',
      debug: { matched_rules: [] },
    };
  }

  /**
   * The tenant metadata database, the subject's account database, and the id the subject's rows
   * are stored under there (the account router's canonical id).
   */
  private async subjectRBACDatabases(
    context: CheckContext
  ): Promise<{ dbs: TenantRBACDatabases; subjectId: string }> {
    const resolve = this.subjectAccount;
    if (!resolve) {
      return { dbs: { metadata: this.db, account: this.db }, subjectId: context.subjectId };
    }
    const key = `${context.tenantId}\u0000${context.requestSubjectId}`;
    let account = this.subjectAccounts.get(key);
    if (!account) {
      account = resolve(context.tenantId, context.requestSubjectId);
      this.subjectAccounts.set(key, account);
    }
    const resolved = await account;
    return { dbs: { metadata: this.db, account: resolved.db }, subjectId: resolved.subjectId };
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
      const { dbs, subjectId } = await this.subjectRBACDatabases(context);
      const hasPermission = await hasIdLevelPermission(
        dbs,
        subjectId,
        context.parsed.resource,
        context.parsed.id,
        context.parsed.action,
        context.tenantId,
        checkTarget(context)
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
  ): Promise<{ allowed: boolean; roleName?: string; viaGroup?: string }> {
    try {
      // Query user's roles (and the effective groups they were read through, for group
      // conditions of the tenant's rules)
      const { dbs, subjectId } = await this.subjectRBACDatabases(context);
      const { roles, effectiveGroupIds, unknownGroupIds, rolesComplete } =
        await resolveSubjectRolesAndGroups(dbs, context.tenantId, subjectId);
      context.subjectGroupIds = effectiveGroupIds;
      context.subjectUnknownGroupIds = unknownGroupIds;
      const rolesResult = roles.map(({ role, assignment }) => ({
        name: role.name,
        permissions: rolePermissions(role),
        scope_type: assignment.scope_type,
        scope_target: assignment.scope_target,
        expires_at: assignment.expires_at,
        viaGroup: assignment.via.kind === 'group' ? assignment.via.groupId : undefined,
      }));

      // Role assignments for attribute-based rules with role conditions, with their scope: an
      // assignment limited to one group or resource must not match a rule for another.
      // One with a scope the rules cannot express is left out (it only grants less).
      // A tenant-scoped assignment in its own tenant (as invitations once wrote) is tenant-wide, as a
      // global one.
      const known = rolesResult.flatMap((role): PolicySubjectRole[] => {
        const assigned = role.scope_type ?? 'global';
        const ownTenant =
          assigned === 'tenant' && (!role.scope_target || role.scope_target === context.tenantId);
        const scope = ownTenant ? 'global' : assigned;
        if (scope !== 'global' && scope !== 'group' && scope !== 'resource') return [];
        return [
          {
            name: role.name,
            scope,
            scopeTarget: scope === 'global' ? undefined : role.scope_target || undefined,
            expiresAt: role.expires_at ? role.expires_at * 1000 : undefined,
          },
        ];
      });
      // A group with a role grant whose membership is unknown: the roles through it are unknown
      // too, so the rules (which may deny on a role the subject lacks) see the roles as unread.
      // The known ones below still grant.
      context.subjectRoles = rolesComplete ? known : undefined;

      const permissionToCheck: ConcretePermission =
        context.parsed.type === 'id_level' && context.parsed.id
          ? {
              kind: 'id_level',
              resource: context.parsed.resource,
              id: context.parsed.id,
              action: context.parsed.action,
            }
          : {
              kind: 'type_level',
              resource: context.parsed.resource,
              action: context.parsed.action,
            };

      // A direct assignment that grants is reported before one through a group.
      let groupMatch: { roleName: string; viaGroup: string } | undefined;
      for (const role of rolesResult) {
        // A role grants only where it is assigned (see roleAssignmentHolds).
        if (
          !roleAssignmentHolds(
            { scope: role.scope_type, scopeTarget: role.scope_target },
            checkTarget(context)
          )
        ) {
          continue;
        }
        const permissions = role.permissions;

        // The same string, `resource:*`, `*:*` or `*` (grantedPermissionCovers)
        if (
          permissions.some((permission) => grantedPermissionCovers(permission, permissionToCheck))
        ) {
          if (!role.viaGroup) return { allowed: true, roleName: role.name };
          groupMatch ??= { roleName: role.name, viaGroup: role.viaGroup };
        }
      }

      return groupMatch ? { allowed: true, ...groupMatch } : { allowed: false };
    } catch (error) {
      log.error('RBAC check error', { subjectId: context.subjectId }, error as Error);
      return { allowed: false };
    }
  }

  /**
   * The subject's groups as the role check read them, for group usersets: when they could not be
   * read, it throws (a userset on the path is then undecided and grants nothing).
   */
  private subjectGroupsOf(context: CheckContext): SubjectGroupsResolver {
    return async () => {
      if (!context.subjectGroupIds) throw new Error('subject_groups_unread');
      return {
        effectiveGroupIds: context.subjectGroupIds,
        unknownGroupIds: context.subjectUnknownGroupIds ?? [],
      };
    };
  }

  /**
   * The self contract's relationship check: ReBACService.checkResolved for the bound subject (its
   * resolved id, taken verbatim) and the relation and object the resolver named. Errors grant
   * nothing.
   */
  private async checkSelfRelation(
    context: CheckContext,
    target: { relation: string; object_type: string; object_id: string }
  ): Promise<{ allowed: boolean }> {
    if (!this.rebacService) return { allowed: false };
    try {
      const result = await this.rebacService.checkResolved(
        {
          tenantId: context.tenantId,
          subjectId: context.subjectId,
          relation: target.relation,
          objectType: target.object_type,
          objectId: target.object_id,
        },
        { subjectGroups: this.subjectGroupsOf(context) }
      );
      if (result.resolved_via === 'unknown_membership') context.rebacUndecided = true;
      return { allowed: result.allowed };
    } catch (error) {
      log.error('Self-contract relationship check error', {}, error as Error);
      return { allowed: false };
    }
  }

  /**
   * Check ReBAC relationship permission (server contract): the subject is the check's resolved
   * subject (verbatim); the request's object and contextual tuples are typed strings.
   */
  private async checkReBACPermission(
    context: CheckContext
  ): Promise<{ allowed: boolean; path?: string[] }> {
    if (!context.rebacParams || !this.rebacService) {
      return { allowed: false };
    }

    try {
      const object = parseObjectString(context.rebacParams.object);
      // A contextual tuple is the subject's when its subject, read as the API boundary reads one
      // (a single leading `user:` taken away), is the resolved stored id: never both a stored id
      // and `user:` + it.
      const contextualTuples = context.rebacParams.contextual_tuples?.length
        ? context.rebacParams.contextual_tuples
            .filter((tuple) => externalSubjectId(tuple.user_id) === context.subjectId)
            .map((tuple) => {
              const target = parseObjectString(tuple.object);
              return { relation: tuple.relation, objectType: target.type, objectId: target.id };
            })
        : undefined;

      const result = await this.rebacService.checkResolved(
        {
          tenantId: context.tenantId,
          subjectId: context.subjectId,
          relation: context.rebacParams.relation,
          objectType: object.type,
          objectId: object.id,
          ...(contextualTuples && { contextualTuples }),
        },
        { subjectGroups: this.subjectGroupsOf(context) }
      );
      if (result.resolved_via === 'unknown_membership') context.rebacUndecided = true;

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
    try {
      // Simple ownership check: server contract only. A self-contract check's owner (from the
      // resolver) is material for the tenant's rules below, which decide per action.
      if (
        context.contract === 'server' &&
        context.resourceContext &&
        context.resourceContext.owner_id === context.subjectId
      ) {
        return { allowed: true, ruleName: 'owner_access' };
      }

      // Membership of the resource's group alone grants nothing: what a member may do is decided
      // by their roles (scoped to the group) and the tenant's rules below.

      // ABAC evaluation: the tenant's rules (when its settings turn attribute-based policy on)
      const evaluator = context.policy.abac ? context.policy.evaluator : undefined;
      // Rules see roles and attributes: without them, a rule that denies on one of them would not
      // match and a later rule could grant. No grant from the rules then.
      // Likewise the subject's groups, when the rules read them (unknown is not "no groups").
      if (
        evaluator &&
        (context.subjectRoles === undefined ||
          context.attributesUnavailable ||
          context.resourceUnavailable ||
          (evaluator.usesSubjectGroups === true && context.subjectGroupIds === undefined))
      ) {
        log.warn('Tenant rules not evaluated: roles, groups or attributes could not be read', {
          subjectId: context.subjectId,
        });
      } else if (evaluator) {
        const policyContext: PolicyEvaluationContext = {
          subjectId: context.subjectId,
          subjectRoles: context.subjectRoles,
          subjectGroupIds: context.subjectGroupIds,
          subjectUnknownGroupIds: context.subjectUnknownGroupIds,
          verifiedAttributes: context.verifiedAttributes ?? [],
          resourceType: context.parsed.resource,
          resourceId: context.parsed.id,
          resourceOwnerId: context.resourceContext?.owner_id,
          resourceGroupIds: context.resourceContext?.group_id
            ? [context.resourceContext.group_id]
            : undefined,
          resourceAttributes: context.resourceContext?.attributes,
          action: context.parsed.action,
          timestamp: Date.now(),
        };

        const decision = evaluator.evaluate(policyContext);
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
   * Build final response
   */
  private buildResponse(result: InternalCheckResult, startTime: number): CheckApiResponse {
    const evaluationTime = performance.now() - startTime;

    const response: CheckApiResponse = {
      allowed: result.allowed,
      resolved_via: result.resolvedVia,
      final_decision: result.allowed ? 'allow' : 'deny',
      cache_ttl: 0,
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
}

/**
 * Create UnifiedCheckService instance
 */
export function createUnifiedCheckService(config: UnifiedCheckServiceConfig): UnifiedCheckService {
  return new UnifiedCheckService(config);
}
