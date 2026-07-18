import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AgentConfigurationRepository,
  AdminAgentAccessRepository,
  getAgentTaskSetWithBuiltins,
  isPublicClientStandardOptInEligibleTool,
  listAgentTaskSetsWithBuiltins,
  normalizeAgentScopePolicy,
  resolveAgentTaskSetVersion,
  toolSnapshot,
  type AdminAgentAuditWrite,
  type AgentScopePolicyDefinition,
  type JsonObject,
} from '@authrim/ar-agent-access/core';
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { isAgentMcpEnabled, type AgentManagementEnv } from '../../agent-downscope-auth';

type AgentConfigurationContext = Context<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const NAME = /^[\p{L}\p{N} ._~-]{1,120}$/u;
const SAFE = /^[A-Za-z0-9._~-]{1,128}$/u;
const PROVIDER_KEY = /^[A-Za-z0-9][A-Za-z0-9._/:~-]{0,255}$/u;
const catalog = createAdminToolCatalog();

export const agentTaskSetsRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();
export const agentScopePoliciesRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();
export const agentConfigurationPlansRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();
export const agentSecretRefsRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();

for (const router of [
  agentTaskSetsRouter,
  agentScopePoliciesRouter,
  agentConfigurationPlansRouter,
  agentSecretRefsRouter,
]) {
  router.use('*', adminAuthMiddleware());
}

function auth(c: AgentConfigurationContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function tenant(c: AgentConfigurationContext): string {
  return auth(c).tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
}

function repository(c: AgentConfigurationContext): AgentConfigurationRepository {
  return new AgentConfigurationRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-configuration-management')
  );
}

function error(c: AgentConfigurationContext, status: 400 | 403 | 404 | 409 | 503, code: string) {
  return c.json({ error: code, error_description: code }, status);
}

function permitted(c: AgentConfigurationContext, permission: string): boolean {
  return hasAdminPermission(auth(c).permissions ?? [], permission);
}

function human(c: AgentConfigurationContext): boolean {
  const current = auth(c);
  return (
    (!current.actorType || current.actorType === 'human') &&
    current.authMethod === 'session' &&
    typeof current.userId === 'string'
  );
}

async function body(c: AgentConfigurationContext): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function name(value: unknown): string | null {
  return typeof value === 'string' && NAME.test(value.trim()) ? value.trim() : null;
}

function description(value: unknown): string | undefined | null {
  return value === undefined
    ? undefined
    : typeof value === 'string' && value.length <= 1000
      ? value
      : null;
}

function version(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function audit(
  c: AgentConfigurationContext,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: JsonObject,
  id: string = `audit_${crypto.randomUUID()}`
): AdminAgentAuditWrite {
  const current = auth(c);
  return {
    id,
    tenantId: tenant(c),
    adminUserId: current.userId,
    action,
    resourceType,
    resourceId,
    severity: 'info',
    actorType: 'admin_user',
    actorSub: `admin_user:${current.userId}`,
    requestId: c.req.header('x-request-id'),
    metadata,
    createdAt: Date.now(),
  };
}

function taskSetResponse(item: Awaited<ReturnType<AgentConfigurationRepository['getTaskSet']>>) {
  return item
    ? {
        id: item.id,
        name: item.name,
        description: item.description ?? null,
        kind: item.kind,
        status: item.status,
        current_version: item.currentVersion,
        catalog_version: item.version.catalogVersion,
        digest: item.version.digest,
        tools: item.version.tools,
        permissions: item.version.permissions,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      }
    : null;
}

agentTaskSetsRouter.get('/', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_TASK_SETS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const items = await listAgentTaskSetsWithBuiltins({
    repository: repository(c),
    catalog,
    tenantId: tenant(c),
  });
  return c.json({ task_sets: items.map((item) => taskSetResponse(item)) });
});

agentTaskSetsRouter.get('/catalog', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_TASK_SETS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const tools = catalog
    .list()
    .filter((tool) =>
      tool.requiredPermissions.every((permission) =>
        hasAdminPermission(auth(c).permissions ?? [], permission)
      )
    )
    .map((tool) => ({
      ...toolSnapshot(tool),
      public_client_standard_opt_in_eligible: isPublicClientStandardOptInEligibleTool(tool),
    }));
  return c.json({ catalog_version: catalog.version, tools });
});

agentTaskSetsRouter.get('/:id', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_TASK_SETS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const item = await getAgentTaskSetWithBuiltins({
    repository: repository(c),
    catalog,
    tenantId: tenant(c),
    id: c.req.param('id'),
  });
  return item
    ? c.json({ task_set: taskSetResponse(item) })
    : error(c, 404, 'AGENT_TASK_SET_NOT_FOUND');
});

agentTaskSetsRouter.post('/', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  if (!(await isAgentMcpEnabled(c.env, tenant(c)))) return error(c, 404, 'AGENT_MCP_DISABLED');
  const value = await body(c);
  const itemName = name(value?.name);
  const itemDescription = description(value?.description);
  const toolIds = value?.tool_ids;
  if (
    !value ||
    !itemName ||
    itemDescription === null ||
    !Array.isArray(toolIds) ||
    toolIds.length === 0 ||
    toolIds.length > 256 ||
    toolIds.some((id) => typeof id !== 'string')
  ) {
    return error(c, 400, 'AGENT_TASK_SET_INVALID');
  }
  let resolved;
  try {
    resolved = await resolveAgentTaskSetVersion({
      toolIds: toolIds as string[],
      catalog,
      creatorPermissions: auth(c).permissions ?? [],
    });
  } catch {
    return error(c, 400, 'AGENT_TASK_SET_INVALID_TOOL');
  }
  const id = `ats_${crypto.randomUUID()}`;
  const now = Date.now();
  await repository(c).createTaskSet({
    id,
    tenantId: tenant(c),
    name: itemName,
    description: itemDescription,
    kind: 'custom',
    resolved,
    createdBy: auth(c).userId,
    now,
    audit: audit(c, 'agent.task_set.created', 'agent_task_set', id, {
      version: 1,
      definition_digest: resolved.digest,
      tool_count: resolved.tools.length,
    }),
  });
  return c.json({ id, version: 1, digest: resolved.digest }, 201);
});

agentTaskSetsRouter.post('/:id/versions', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const expectedVersion = version(value?.expected_version);
  const toolIds = value?.tool_ids;
  if (
    !value ||
    !expectedVersion ||
    !Array.isArray(toolIds) ||
    toolIds.length === 0 ||
    toolIds.some((id) => typeof id !== 'string')
  ) {
    return error(c, 400, 'AGENT_TASK_SET_INVALID');
  }
  let resolved;
  try {
    resolved = await resolveAgentTaskSetVersion({
      toolIds: toolIds as string[],
      catalog,
      creatorPermissions: auth(c).permissions ?? [],
    });
  } catch {
    return error(c, 400, 'AGENT_TASK_SET_INVALID_TOOL');
  }
  const id = c.req.param('id');
  const updated = await repository(c).createTaskSetVersion({
    tenantId: tenant(c),
    id,
    expectedVersion,
    resolved,
    createdBy: auth(c).userId,
    now: Date.now(),
    audit: audit(c, 'agent.task_set.version_created', 'agent_task_set', id, {
      from_version: expectedVersion,
      to_version: expectedVersion + 1,
      definition_digest: resolved.digest,
    }),
  });
  return updated
    ? c.json({ id, version: expectedVersion + 1, digest: resolved.digest })
    : error(c, 409, 'AGENT_TASK_SET_VERSION_CONFLICT');
});

agentTaskSetsRouter.post('/:id/versions/:version/suspend', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = Number(c.req.param('version'));
  if (!Number.isSafeInteger(itemVersion) || itemVersion < 1) {
    return error(c, 400, 'AGENT_TASK_SET_VERSION_INVALID');
  }
  const id = c.req.param('id');
  const transitionId = `audit_${crypto.randomUUID()}`;
  const suspended = await repository(c).suspendTaskSetVersion({
    tenantId: tenant(c),
    id,
    version: itemVersion,
    audit: audit(
      c,
      'agent.task_set.version_suspended',
      'agent_task_set',
      id,
      {
        version: itemVersion,
        reason: 'security_response',
        transition_id: transitionId,
      },
      transitionId
    ),
  });
  return suspended
    ? c.json({ id, version: itemVersion, status: 'suspended' })
    : error(c, 409, 'AGENT_TASK_SET_VERSION_NOT_ACTIVE');
});

function scopeResponse(item: Awaited<ReturnType<AgentConfigurationRepository['getScopePolicy']>>) {
  return item
    ? {
        id: item.id,
        name: item.name,
        description: item.description ?? null,
        kind: item.kind,
        status: item.status,
        current_version: item.currentVersion,
        digest: item.definitionDigest,
        selector_catalog_version: item.selectorCatalogVersion,
        definition: item.definition,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      }
    : null;
}

agentScopePoliciesRouter.get('/', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const items = await repository(c).listScopePolicies(tenant(c));
  return c.json({ scope_policies: items.map((item) => scopeResponse(item)) });
});

agentScopePoliciesRouter.get('/:id', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const item = await repository(c).getScopePolicy(tenant(c), c.req.param('id'));
  return item
    ? c.json({ scope_policy: scopeResponse(item) })
    : error(c, 404, 'AGENT_SCOPE_POLICY_NOT_FOUND');
});

async function normalizedScope(
  c: AgentConfigurationContext,
  value: unknown
): Promise<Awaited<ReturnType<typeof normalizeAgentScopePolicy>> | null> {
  try {
    const normalized = await normalizeAgentScopePolicy(
      value as AgentScopePolicyDefinition,
      tenant(c)
    );
    const targets = normalized.definition.tenantIds;
    const tenantScope = auth(c).tenantScope ?? [];
    if (
      targets.length > 1 &&
      (!permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_CREATE) ||
        (!tenantScope.includes('*') &&
          targets.some((targetTenantId) => !tenantScope.includes(targetTenantId))))
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

agentScopePoliciesRouter.post('/', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const itemName = name(value?.name);
  const itemDescription = description(value?.description);
  const normalized = await normalizedScope(c, value?.definition);
  if (!value || !itemName || itemDescription === null || !normalized) {
    return error(c, 400, 'AGENT_SCOPE_POLICY_INVALID');
  }
  const id = `asp_${crypto.randomUUID()}`;
  const now = Date.now();
  await repository(c).createScopePolicy({
    id,
    tenantId: tenant(c),
    name: itemName,
    description: itemDescription,
    kind: 'custom',
    definition: normalized.definition,
    definitionDigest: normalized.digest,
    selectorCatalogVersion: 'agent-selector-catalog-v1',
    createdBy: auth(c).userId,
    now,
    audit: audit(c, 'agent.scope_policy.created', 'agent_scope_policy', id, {
      version: 1,
      definition_digest: normalized.digest,
    }),
  });
  return c.json({ id, version: 1, digest: normalized.digest }, 201);
});

agentScopePoliciesRouter.post('/:id/versions', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const expectedVersion = version(value?.expected_version);
  const normalized = await normalizedScope(c, value?.definition);
  if (!value || !expectedVersion || !normalized) {
    return error(c, 400, 'AGENT_SCOPE_POLICY_INVALID');
  }
  const id = c.req.param('id');
  const updated = await repository(c).createScopePolicyVersion({
    tenantId: tenant(c),
    id,
    expectedVersion,
    definition: normalized.definition,
    definitionDigest: normalized.digest,
    selectorCatalogVersion: 'agent-selector-catalog-v1',
    createdBy: auth(c).userId,
    now: Date.now(),
    audit: audit(c, 'agent.scope_policy.version_created', 'agent_scope_policy', id, {
      from_version: expectedVersion,
      to_version: expectedVersion + 1,
      definition_digest: normalized.digest,
    }),
  });
  return updated
    ? c.json({ id, version: expectedVersion + 1, digest: normalized.digest })
    : error(c, 409, 'AGENT_SCOPE_POLICY_VERSION_CONFLICT');
});

agentScopePoliciesRouter.post('/:id/versions/:version/suspend', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = Number(c.req.param('version'));
  if (!Number.isSafeInteger(itemVersion) || itemVersion < 1) {
    return error(c, 400, 'AGENT_SCOPE_POLICY_VERSION_INVALID');
  }
  const id = c.req.param('id');
  const transitionId = `audit_${crypto.randomUUID()}`;
  const suspended = await repository(c).suspendScopePolicyVersion({
    tenantId: tenant(c),
    id,
    version: itemVersion,
    audit: audit(
      c,
      'agent.scope_policy.version_suspended',
      'agent_scope_policy',
      id,
      {
        version: itemVersion,
        reason: 'security_response',
        transition_id: transitionId,
      },
      transitionId
    ),
  });
  return suspended
    ? c.json({ id, version: itemVersion, status: 'suspended' })
    : error(c, 409, 'AGENT_SCOPE_POLICY_VERSION_NOT_ACTIVE');
});

agentConfigurationPlansRouter.get('/', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const plans = await repository(c).listPlans(tenant(c));
  return c.json({
    plans: plans.map((plan) => ({
      id: plan.id,
      version: plan.version,
      digest: plan.definitionDigest,
      status: plan.status,
      stage: plan.stage,
      grant_id: plan.grantId,
      actor_sub: plan.actorSub,
      applied_step_count: plan.appliedStepCount,
      expires_at: plan.expiresAt,
      cancelled_at: plan.cancelledAt ?? null,
      cancelled_by: plan.cancelledBy ?? null,
      cancel_reason: plan.cancelReason ?? null,
      payload_purged: plan.definition === undefined,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt,
    })),
  });
});

agentConfigurationPlansRouter.get('/:id/:version', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const planVersion = Number(c.req.param('version'));
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) {
    return error(c, 400, 'AGENT_PLAN_INVALID_VERSION');
  }
  const plan = await repository(c).getPlan(tenant(c), c.req.param('id'), planVersion);
  return plan ? c.json({ plan }) : error(c, 404, 'AGENT_PLAN_NOT_FOUND');
});

agentConfigurationPlansRouter.post('/:id/:version/confirm', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_APPLY)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const confirmationId = value?.confirmation_id;
  const planDigest = value?.plan_digest;
  const planVersion = Number(c.req.param('version'));
  if (
    !value ||
    typeof confirmationId !== 'string' ||
    !SAFE.test(confirmationId) ||
    typeof planDigest !== 'string' ||
    !Number.isSafeInteger(planVersion) ||
    planVersion < 1
  ) {
    return error(c, 400, 'AGENT_PLAN_CONFIRMATION_INVALID');
  }
  const planRepository = repository(c);
  const plan = await planRepository.getPlan(tenant(c), c.req.param('id'), planVersion);
  if (!plan || plan.status !== 'ready' || plan.definitionDigest !== planDigest) {
    return error(c, 404, 'AGENT_PLAN_NOT_FOUND');
  }
  const grants = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-plan-confirmation')
  );
  const grant = await grants.getGrant(tenant(c), plan.grantId);
  if (!grant || grant.delegatorId !== auth(c).userId || grant.status !== 'active') {
    return error(c, 403, 'AGENT_PLAN_CONFIRMATION_SUBJECT_MISMATCH');
  }
  const confirmed = await planRepository.confirmPlan({
    tenantId: tenant(c),
    confirmationId,
    confirmedBy: auth(c).userId,
    planId: plan.id,
    planVersion: plan.version,
    planDigest: plan.definitionDigest,
    now: Date.now(),
    audit: audit(c, 'agent.configuration.plan.confirmed', 'agent_configuration_plan', plan.id, {
      plan_version: plan.version,
      plan_digest: plan.definitionDigest,
      confirmation_id: confirmationId,
    }),
  });
  return confirmed
    ? c.json({ plan_id: plan.id, version: plan.version, status: 'confirmed' })
    : error(c, 409, 'AGENT_PLAN_CONFIRMATION_CONFLICT');
});

agentConfigurationPlansRouter.post('/:id/:version/cancel', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const planVersion = Number(c.req.param('version'));
  const value = await body(c);
  const reason = value?.reason;
  if (
    !Number.isSafeInteger(planVersion) ||
    planVersion < 1 ||
    (reason !== undefined &&
      (typeof reason !== 'string' || reason.length < 1 || reason.length > 500))
  ) {
    return error(c, 400, 'AGENT_PLAN_CANCEL_INVALID');
  }
  const planRepository = repository(c);
  const existing = await planRepository.getPlan(tenant(c), c.req.param('id'), planVersion);
  if (!existing) return error(c, 404, 'AGENT_PLAN_NOT_FOUND');
  if (existing.cancelledAt !== undefined) {
    return c.json({
      plan_id: existing.id,
      version: existing.version,
      status: existing.status,
      cancelled_at: existing.cancelledAt,
    });
  }
  if (existing.status === 'completed' || existing.status === 'failed') {
    return error(c, 409, 'AGENT_PLAN_STATE_CONFLICT');
  }
  const now = Date.now();
  const cancelled = await planRepository.cancelPlan({
    tenantId: tenant(c),
    id: existing.id,
    version: existing.version,
    cancelledBy: auth(c).userId!,
    reason: (reason as string | undefined) ?? 'operator_requested',
    now,
    audit: audit(c, 'agent.configuration.plan.cancelled', 'agent_configuration_plan', existing.id, {
      plan_version: existing.version,
      plan_digest: existing.definitionDigest,
      prior_status: existing.status,
      reason: (reason as string | undefined) ?? 'operator_requested',
    }),
  });
  return cancelled
    ? c.json({
        plan_id: existing.id,
        version: existing.version,
        status: existing.status,
        cancelled_at: now,
      })
    : error(c, 409, 'AGENT_PLAN_STATE_CONFLICT');
});

agentSecretRefsRouter.get('/', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  return c.json({ secret_refs: await repository(c).listSecretRefs(tenant(c), Date.now()) });
});

agentSecretRefsRouter.post('/', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const value = await body(c);
  const resourceType = value?.resource_type;
  const resourceId = value?.resource_id;
  const purpose = value?.purpose;
  const providerKey = value?.provider_key;
  const expiresAt = value?.expires_at;
  const tenantId = tenant(c);
  const now = Date.now();
  if (
    !value ||
    typeof resourceType !== 'string' ||
    !SAFE.test(resourceType) ||
    (resourceId !== undefined && (typeof resourceId !== 'string' || !SAFE.test(resourceId))) ||
    typeof purpose !== 'string' ||
    !NAME.test(purpose) ||
    typeof providerKey !== 'string' ||
    !PROVIDER_KEY.test(providerKey) ||
    !providerKey.startsWith(`tenant:${tenantId}:agent:`) ||
    (expiresAt !== undefined &&
      (typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now ||
        expiresAt > now + 31_536_000_000))
  ) {
    return error(c, 400, 'AGENT_SECRET_REF_INVALID');
  }
  let providerAvailable = false;
  try {
    const keyManager = c.env.KEY_MANAGER.get(c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
    const enrolled = await keyManager.getOrCreateSecretRpc(providerKey);
    providerAvailable =
      typeof enrolled?.active?.value === 'string' && enrolled.active.value.length > 0;
  } catch {
    providerAvailable = false;
  }
  if (!providerAvailable) {
    return error(c, 503, 'AGENT_SECRET_PROVIDER_UNAVAILABLE');
  }
  const id = `asr_${crypto.randomUUID().replaceAll('-', '')}`;
  await repository(c).createSecretRef({
    id,
    tenantId,
    resourceType,
    resourceId: resourceId as string | undefined,
    purpose,
    providerKey,
    createdBy: auth(c).userId,
    now,
    expiresAt: expiresAt as number | undefined,
    audit: audit(c, 'agent.secret_ref.enrolled', 'agent_secret_ref', id, {
      resource_type: resourceType,
      resource_id: (resourceId as string | undefined) ?? null,
      purpose,
    }),
  });
  return c.json({ id, status: 'active' }, 201);
});

agentSecretRefsRouter.post('/:id/revoke', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const id = c.req.param('id');
  if (!/^asr_[A-Za-z0-9_-]{16,120}$/u.test(id)) {
    return error(c, 400, 'AGENT_SECRET_REF_INVALID');
  }
  const revoked = await repository(c).revokeSecretRef({
    tenantId: tenant(c),
    id,
    revokedBy: auth(c).userId,
    now: Date.now(),
    audit: audit(c, 'agent.secret_ref.revoked', 'agent_secret_ref', id, {}),
  });
  return revoked ? c.json({ id, status: 'revoked' }) : error(c, 409, 'AGENT_SECRET_REF_NOT_ACTIVE');
});

export type AgentConfigurationManagementEnv = Env;
