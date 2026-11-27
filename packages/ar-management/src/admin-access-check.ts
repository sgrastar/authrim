/**
 * Admin access check: POST /api/admin/access-check
 *
 * "May this user do this?" asked by an administrator (the console's access check, checking as
 * someone else, and the `debug` explanation). The administrator's permission is checked by the
 * declared route access rules (`admin:roles:read` or `admin:groups:read`); the question is then
 * evaluated in-process by the same unified check the policy service runs for `/api/check`
 * (ar-lib-core's UnifiedCheckService), under the server contract and with debug details:
 *
 * - any subject of the administrator's tenant, with the request's `resource_context` and `rebac`;
 * - the tenant's ABAC rules and ReBAC as its feature flags enable them (`feature.enable_abac`,
 *   `feature.enable_custom_rules`, `feature.enable_rebac`);
 * - independent of `feature.enable_check_api` (that switch is for the public Check API).
 *
 * Nothing is written and no permission-check audit row is recorded.
 */

import type { Context } from 'hono';
import {
  AR_ERROR_CODES,
  createAuthContextFromHono,
  createErrorResponse,
  createLogger,
  createReBACService,
  createUnifiedCheckService,
  getTenantIdFromContext,
  parsePermission,
  readPolicyFlags,
  resolveAccountCoreDataContext,
  UserVerifiedAttributeRepository,
  type AdminAuthContext,
  type CheckApiRequest,
  type DatabaseAdapter,
  type Env,
  type IStorageAdapter,
  type PolicyEvaluationContext,
  type TenantPolicySettings,
} from '@authrim/ar-lib-core';
import {
  evaluateTenantRules,
  tenantRulesUnusableReason,
  toTenantPolicyRule,
  type PolicyContext,
  type TenantPolicyRule,
  type TenantPolicyRuleRow,
} from '@authrim/ar-lib-policy';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const log = createLogger().module('ADMIN-ACCESS-CHECK');

const MAX_CONTEXTUAL_TUPLES = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageAdapterOf(adapter: DatabaseAdapter): IStorageAdapter {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    query: <T = unknown>(sql: string, params?: unknown[]) => adapter.query<T>(sql, params),
    execute: async (sql: string, params?: unknown[]) => {
      const result = await adapter.execute(sql, params);
      return {
        success: result.success,
        meta: { changes: result.rowsAffected, last_row_id: Number(result.lastInsertRowid ?? 0) },
      };
    },
  };
}

/**
 * The tenant's policy settings for the check, as the policy service resolves them
 * (ar-policy/src/tenant-policy.ts): everything off when they cannot be read, no grants from the
 * rules when one of them cannot be evaluated.
 */
async function tenantPolicyOf(
  env: Env,
  db: DatabaseAdapter,
  tenantId: string
): Promise<TenantPolicySettings> {
  const flags = await readPolicyFlags(env, tenantId);
  if (!flags) {
    return { abac: false, verifiedAttributes: false, rebac: false, logDecisions: false };
  }
  const settings: TenantPolicySettings = {
    abac: flags.abac,
    verifiedAttributes: flags.abac && flags.verifiedAttributes,
    rebac: flags.rebac,
    logDecisions: false,
  };
  if (!flags.abac || !flags.customRules) return settings;
  try {
    const rows = await db.query<TenantPolicyRuleRow>(
      `SELECT id, name, description, priority, effect, resource_types, actions, conditions
         FROM policy_rules
        WHERE tenant_id = ? AND enabled = 1
        ORDER BY priority DESC`,
      [tenantId]
    );
    const rules: TenantPolicyRule[] = [];
    for (const row of rows) {
      const rule = toTenantPolicyRule(row);
      if (!rule) throw new Error(`Policy rule ${row.id} cannot be evaluated as stored`);
      rules.push(rule);
    }
    const unusable = tenantRulesUnusableReason(rules, settings);
    if (unusable) throw new Error(unusable);
    settings.evaluator = {
      evaluate(context: PolicyEvaluationContext) {
        const policyContext: PolicyContext = {
          subject: {
            id: context.subjectId,
            roles: (context.subjectRoles ?? []).map((role) => ({
              name: role.name,
              scope: role.scope,
              scopeTarget: role.scopeTarget,
              expiresAt: role.expiresAt,
            })),
            verifiedAttributes: context.verifiedAttributes.map((attribute) => ({
              name: attribute.name,
              value: attribute.value,
              source: attribute.source,
            })),
          } as PolicyContext['subject'],
          resource: {
            type: context.resourceType,
            id: context.resourceId ?? '',
            ownerId: context.resourceOwnerId,
            orgId: context.resourceOrgId,
            attributes: context.resourceAttributes,
          },
          action: { name: context.action },
          timestamp: context.timestamp,
          environment: context.environment,
        };
        const decision = evaluateTenantRules(rules, policyContext);
        return {
          allowed: decision.allowed,
          reason: decision.reason,
          decidedBy: decision.decidedBy,
        };
      },
    };
  } catch (error) {
    log.warn('Tenant policy rules could not be used; no grants from them', {
      tenantId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { ...settings, abac: false, verifiedAttributes: false, unavailable: true };
  }
  return settings;
}

/** The request's `rebac`, when well formed (undefined when absent; null when malformed). */
function rebacOf(value: unknown): CheckApiRequest['rebac'] | null | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return null;
  if (typeof value.relation !== 'string' || !value.relation) return null;
  if (typeof value.object !== 'string' || !value.object) return null;
  const tuples = value.contextual_tuples;
  if (tuples !== undefined) {
    if (!Array.isArray(tuples) || tuples.length > MAX_CONTEXTUAL_TUPLES) return null;
    for (const tuple of tuples) {
      if (
        !isPlainObject(tuple) ||
        typeof tuple.user_id !== 'string' ||
        !tuple.user_id ||
        typeof tuple.relation !== 'string' ||
        !tuple.relation ||
        typeof tuple.object !== 'string' ||
        !tuple.object
      ) {
        return null;
      }
    }
  }
  return value as unknown as CheckApiRequest['rebac'];
}

/**
 * POST /api/admin/access-check
 *
 * Body: `{ subject_id, permission, resource_context?, rebac? }` (the server contract of
 * `/api/check`, in the administrator's tenant). Answer: the unified check's response with
 * `debug` (matched rules, ReBAC path, evaluation time), plus `tenant_id` and `subject_id`.
 */
export async function adminAccessCheckHandler(c: AdminContext) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  if (!isPlainObject(body)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  if (typeof body.subject_id !== 'string' || !body.subject_id.trim()) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'subject_id' },
    });
  }
  if (body.permission === undefined || body.permission === null || body.permission === '') {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'permission' },
    });
  }
  const permission = body.permission as CheckApiRequest['permission'];
  try {
    parsePermission(permission);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  if (body.resource_context !== undefined && !isPlainObject(body.resource_context)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  const rebac = rebacOf(body.rebac);
  if (rebac === null) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  const tenantId = getTenantIdFromContext(c);
  const subjectId = body.subject_id.trim();
  try {
    const coreAdapter = createAuthContextFromHono(
      c as unknown as Context<{ Bindings: Env }>,
      tenantId
    ).coreAdapter;
    const service = createUnifiedCheckService({
      db: coreAdapter,
      subjectAccountDb: async (tenant, subject) =>
        (await resolveAccountCoreDataContext(c.env, { tenantId: tenant, accountId: subject }))
          .coreDb,
      rebacService: createReBACService(storageAdapterOf(coreAdapter), { max_depth: 5 }),
      debugMode: true,
      attributeRepository: new UserVerifiedAttributeRepository(coreAdapter),
      tenantPolicy: (tenant) => tenantPolicyOf(c.env, coreAdapter, tenant),
    });
    const result = await service.check(
      {
        subject_id: subjectId,
        subject_type: 'user',
        permission,
        tenant_id: tenantId,
        ...(isPlainObject(body.resource_context) && { resource_context: body.resource_context }),
        ...(rebac !== undefined && { rebac }),
      },
      { contract: 'server' }
    );
    return c.json({ tenant_id: tenantId, subject_id: subjectId, ...result });
  } catch (error) {
    log.error('Admin access check failed', { tenantId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
