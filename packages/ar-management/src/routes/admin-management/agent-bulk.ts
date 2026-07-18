import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AdminAgentAccessRepository,
  AgentBulkRepository,
  agentGrantPinsToolContract,
  agentResourceConstraintsAllow,
  buildAgentToolResourceContext,
  canonicalizeJson,
  hasCompleteAgentConfigurationSnapshot,
  resolveAgentBulkPlan,
  resolveAgentConfigurationPlan,
  sha256Base64Url,
  type AdminAgentAuditWrite,
  type AgentBulkPlanDefinition,
  type JsonObject,
} from '@authrim/ar-agent-access/core';
import {
  createAdminToolCatalog,
  McpSdkJsonSchemaValidator,
} from '@authrim/ar-agent-access/protocol/mcp';
import { CloudflareAgentSettingsProvider } from '@authrim/ar-agent-access/platform/cloudflare/tenant-settings';
import {
  ADMIN_PERMISSIONS,
  AdminMachineAccessRepository,
  adminAuthMiddleware,
  ensureDatabaseAdapter,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import type { AgentManagementEnv } from '../../agent-downscope-auth';
import { isFreshAdminHuman } from '../../agent-fresh-auth';

type BulkContext = Context<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const catalog = createAdminToolCatalog();
const schemaValidator = new McpSdkJsonSchemaValidator();
const SAFE = /^[A-Za-z0-9._~-]{1,128}$/u;

function validationReadPermissions(definition: AgentBulkPlanDefinition): string[] {
  return [
    ...new Set(
      definition.plan.steps.map((step) =>
        step.operation === 'admin.write.login-ui.update'
          ? ADMIN_PERMISSIONS.SETTINGS_READ
          : ADMIN_PERMISSIONS.CLIENTS_READ
      )
    ),
  ];
}

export const agentBulkPlansRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();

agentBulkPlansRouter.use('*', adminAuthMiddleware());

function current(c: BulkContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function controlTenant(c: BulkContext): string {
  return current(c).tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
}

function human(c: BulkContext): boolean {
  const auth = current(c);
  return (
    (!auth.actorType || auth.actorType === 'human') &&
    auth.authMethod === 'session' &&
    typeof auth.userId === 'string'
  );
}

function tenantScoped(c: BulkContext, tenantIds: readonly string[]): boolean {
  const scope = current(c).tenantScope ?? [];
  return scope.includes('*') || tenantIds.every((tenantId) => scope.includes(tenantId));
}

function permitted(c: BulkContext, permission: string): boolean {
  return hasAdminPermission(current(c).permissions ?? [], permission);
}

function error(c: BulkContext, status: 400 | 403 | 404 | 409 | 503, code: string) {
  return c.json({ error: code, error_description: code }, status);
}

function repository(c: BulkContext): AgentBulkRepository {
  return new AgentBulkRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-bulk-plan-management')
  );
}

function audit(
  c: BulkContext,
  id: string,
  action: string,
  resourceId: string,
  metadata: JsonObject
): AdminAgentAuditWrite {
  const auth = current(c);
  return {
    id,
    tenantId: controlTenant(c),
    adminUserId: auth.userId,
    action,
    resourceType: 'agent_bulk_plan',
    resourceId,
    severity: action.endsWith('.paused') || action.endsWith('.cancelled') ? 'warn' : 'info',
    actorType: 'admin_user',
    actorSub: `admin_user:${auth.userId}`,
    requestId: c.req.header('x-request-id'),
    metadata,
    createdAt: Date.now(),
  };
}

async function jsonBody(c: BulkContext): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function version(c: BulkContext): number | null {
  const value = Number(c.req.param('version'));
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

async function activeTargetTenants(c: BulkContext, tenantIds: readonly string[]): Promise<boolean> {
  const adapter = ensureDatabaseAdapter(c.env.DB, 'agent-bulk-target-validation');
  const placeholders = tenantIds.map(() => '?').join(', ');
  const rows = await adapter.query<{ id: string; lifecycle_state: string }>(
    `SELECT id, lifecycle_state FROM tenants WHERE id IN (${placeholders})`,
    [...tenantIds]
  );
  const active = new Set(
    rows.filter((row) => row.lifecycle_state === 'active').map((row) => row.id)
  );
  return tenantIds.every((tenantId) => active.has(tenantId));
}

async function targetPolicyError(
  c: BulkContext,
  targetTenantIds: readonly string[],
  canaryTenantIds: readonly string[]
): Promise<string | null> {
  try {
    const provider = new CloudflareAgentSettingsProvider(c.env);
    const settings = await Promise.all(
      targetTenantIds.map((targetTenantId) => provider.get(targetTenantId))
    );
    if (settings.some((value) => !value.enabled)) {
      return 'AGENT_BULK_PLAN_TARGET_AGENT_ACCESS_DISABLED';
    }
    if (
      canaryTenantIds.some(
        (tenantId) => settings[targetTenantIds.indexOf(tenantId)]?.bulkCanaryProtected === true
      )
    ) {
      return 'AGENT_BULK_PLAN_CANARY_PROTECTED';
    }
    return null;
  } catch {
    return 'AGENT_BULK_PLAN_TARGET_POLICY_UNAVAILABLE';
  }
}

agentBulkPlansRouter.get('/', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const items = await repository(c).list(controlTenant(c));
  return c.json({
    bulk_plans: items.filter(
      (item) => item.targetTenantIds && tenantScoped(c, item.targetTenantIds)
    ),
  });
});

agentBulkPlansRouter.get('/:id/:version', async (c) => {
  if (!permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = version(c);
  if (!itemVersion) return error(c, 400, 'AGENT_BULK_PLAN_INVALID_VERSION');
  const item = await repository(c).get(controlTenant(c), c.req.param('id') ?? '', itemVersion);
  if (!item) return error(c, 404, 'AGENT_BULK_PLAN_NOT_FOUND');
  if (!item.targetTenantIds || !tenantScoped(c, item.targetTenantIds)) {
    return error(c, 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
  }
  const executions = await repository(c).listTenantExecutions(
    controlTenant(c),
    item.id,
    item.version
  );
  return c.json({ bulk_plan: item, tenant_executions: executions });
});

agentBulkPlansRouter.post('/', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_CREATE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const body = await jsonBody(c);
  const grantId = body?.grant_id;
  const credentialId = body?.machine_credential_id;
  const definition = body?.definition as AgentBulkPlanDefinition | undefined;
  if (
    !body ||
    typeof grantId !== 'string' ||
    !SAFE.test(grantId) ||
    typeof credentialId !== 'string' ||
    !SAFE.test(credentialId) ||
    !definition
  ) {
    return error(c, 400, 'AGENT_BULK_PLAN_INVALID');
  }
  let resolved;
  try {
    resolved = await resolveAgentBulkPlan(definition);
    await resolveAgentConfigurationPlan({
      definition: resolved.definition.plan,
      catalog,
      maxOperations: 100,
      schemaValidator,
    });
  } catch {
    return error(c, 400, 'AGENT_BULK_PLAN_INVALID');
  }
  if (!(await activeTargetTenants(c, resolved.definition.targetTenantIds))) {
    return error(c, 400, 'AGENT_BULK_PLAN_TARGET_INVALID');
  }
  const policyError = await targetPolicyError(
    c,
    resolved.definition.targetTenantIds,
    resolved.definition.canaryTenantIds
  );
  if (policyError) {
    return error(
      c,
      policyError === 'AGENT_BULK_PLAN_TARGET_POLICY_UNAVAILABLE' ? 503 : 409,
      policyError
    );
  }
  if (!tenantScoped(c, resolved.definition.targetTenantIds)) {
    return error(c, 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
  }
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'agent-bulk-grant-validation');
  const grants = new AdminAgentAccessRepository(database);
  const grant = await grants.getGrant(controlTenant(c), grantId);
  if (
    !grant ||
    grant.status !== 'active' ||
    !hasCompleteAgentConfigurationSnapshot(grant) ||
    !grant.machinePrincipalId ||
    !hasAdminPermission(grant.permissions, ADMIN_PERMISSIONS.BULK_PLANS_CREATE) ||
    !hasAdminPermission(grant.permissions, ADMIN_PERMISSIONS.BULK_PLANS_APPLY) ||
    !hasAdminPermission(grant.permissions, ADMIN_PERMISSIONS.CLIENTS_READ) ||
    resolved.definition.targetTenantIds.some(
      (targetTenantId) => !grant.resolvedScopeConstraints.tenantIds.includes(targetTenantId)
    ) ||
    (grant.resolvedScopeConstraints.maxPerBulkPlan !== undefined &&
      resolved.definition.targetTenantIds.length > grant.resolvedScopeConstraints.maxPerBulkPlan)
  ) {
    return error(c, 403, 'AGENT_BULK_PLAN_GRANT_INVALID');
  }
  const machines = new AdminMachineAccessRepository(database);
  const [
    principal,
    credential,
    principalScopes,
    credentialScopes,
    principalPermissions,
    credentialPermissions,
  ] = await Promise.all([
    machines.findPrincipalById(grant.machinePrincipalId),
    machines.findCredentialById(credentialId),
    machines.getPrincipalTenantScopes(grant.machinePrincipalId),
    machines.getCredentialTenantScopes(credentialId),
    machines.getPrincipalPermissions(grant.machinePrincipalId),
    machines.getCredentialPermissions(credentialId),
  ]);
  const targetTenants = resolved.definition.targetTenantIds;
  if (
    !principal ||
    principal.status !== 'active' ||
    !credential ||
    credential.principalId !== grant.machinePrincipalId ||
    (credential.status !== 'active' && credential.status !== 'rotating') ||
    principalScopes.length === 0 ||
    principalScopes.some((scope) => scope.scopeMode !== 'allow') ||
    targetTenants.some(
      (tenantId) => !principalScopes.some((scope) => scope.tenantId === tenantId)
    ) ||
    credentialScopes.some((scope) => scope.scopeMode !== 'allow') ||
    (credentialScopes.length > 0 &&
      targetTenants.some(
        (tenantId) => !credentialScopes.some((scope) => scope.tenantId === tenantId)
      ))
  ) {
    return error(c, 403, 'AGENT_BULK_PLAN_MACHINE_SCOPE_REQUIRED');
  }
  const machinePermissions =
    credentialPermissions.length === 0
      ? principalPermissions
      : principalPermissions.filter((permission) =>
          hasAdminPermission(credentialPermissions, permission)
        );
  const requiredBulkPermissions = [
    ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
    ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
    ADMIN_PERMISSIONS.CLIENTS_READ,
    ...validationReadPermissions(resolved.definition),
  ];
  if (
    requiredBulkPermissions.some(
      (permission) =>
        !hasAdminPermission(grant.permissions, permission) ||
        !hasAdminPermission(machinePermissions, permission)
    )
  ) {
    return error(c, 403, 'AGENT_BULK_PLAN_BASE_PERMISSION_REQUIRED');
  }
  const targetDelegatorPermissions = await Promise.all(
    targetTenants.map((targetTenantId) =>
      grants.getActiveDelegatorPermissions(targetTenantId, grant.delegatorId, Date.now())
    )
  );
  if (
    targetDelegatorPermissions.some(
      (permissions) =>
        !permissions ||
        requiredBulkPermissions.some((permission) => !hasAdminPermission(permissions, permission))
    )
  ) {
    return error(c, 403, 'AGENT_BULK_PLAN_DELEGATOR_PERMISSION_REQUIRED');
  }
  for (const step of resolved.definition.plan.steps) {
    const tool = catalog.list().find((candidate) => candidate.id === step.operation);
    if (
      !tool ||
      tool.riskLevel === 'high' ||
      tool.contractVersion !== step.toolContractVersion ||
      !grant.scopes.includes(tool.requiredScope) ||
      !agentGrantPinsToolContract(grant, tool) ||
      targetTenants.some(
        (targetTenantId) =>
          !agentResourceConstraintsAllow(
            grant.resolvedScopeConstraints,
            buildAgentToolResourceContext({
              base: { tenantId: targetTenantId },
              tenantId: targetTenantId,
              toolId: tool.id,
              arguments: step.input,
            })
          )
      ) ||
      tool.requiredPermissions.some(
        (permission) =>
          !hasAdminPermission(current(c).permissions ?? [], permission) ||
          !hasAdminPermission(grant.permissions, permission) ||
          !hasAdminPermission(machinePermissions, permission) ||
          targetDelegatorPermissions.some(
            (permissions) => !permissions || !hasAdminPermission(permissions, permission)
          )
      )
    ) {
      return error(c, 403, 'AGENT_BULK_PLAN_BASE_PERMISSION_REQUIRED');
    }
  }
  const id = `abp_${crypto.randomUUID()}`;
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60_000;
  const transitionId = `audit_${crypto.randomUUID()}`;
  await repository(c).create({
    id,
    version: 1,
    controlTenantId: controlTenant(c),
    grantId,
    actorSub: `machine:${grant.machinePrincipalId}`,
    clientId: grant.clientId,
    delegatorId: grant.delegatorId,
    actorMode: 'mode_b',
    actorAssurance: 'machine_key',
    tokenBinding: 'dpop',
    machinePrincipalId: grant.machinePrincipalId,
    machineCredentialId: credentialId,
    grantGeneration: grant.generation,
    consentVersion: grant.consentVersion,
    resolved,
    expiresAt,
    payloadPurgeAt: expiresAt + 30 * 24 * 60 * 60_000,
    now,
    audit: audit(c, transitionId, 'agent.bulk_plan.created', id, {
      version: 1,
      plan_digest: resolved.digest,
      target_snapshot_digest: resolved.targetSnapshotDigest,
      canary_digest: resolved.canaryDigest,
    }),
  });
  return c.json({ id, version: 1, digest: resolved.digest, status: 'draft' }, 201);
});

agentBulkPlansRouter.post('/:id/:version/validate', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_CREATE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = version(c);
  if (!itemVersion) return error(c, 400, 'AGENT_BULK_PLAN_INVALID_VERSION');
  const item = await repository(c).get(controlTenant(c), c.req.param('id') ?? '', itemVersion);
  if (!item?.targetTenantIds || !(await activeTargetTenants(c, item.targetTenantIds))) {
    return error(c, 409, 'AGENT_BULK_PLAN_TARGET_INVALID');
  }
  if (!tenantScoped(c, item.targetTenantIds)) {
    return error(c, 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
  }
  const policyError = await targetPolicyError(c, item.targetTenantIds, item.canaryTenantIds ?? []);
  if (policyError) {
    return error(
      c,
      policyError === 'AGENT_BULK_PLAN_TARGET_POLICY_UNAVAILABLE' ? 503 : 409,
      policyError
    );
  }
  const transitionId = `audit_${crypto.randomUUID()}`;
  const changed = await repository(c).transition({
    controlTenantId: controlTenant(c),
    id: item.id,
    version: item.version,
    from: 'draft',
    to: 'ready',
    stage: 'validate',
    now: Date.now(),
    audit: audit(c, transitionId, 'agent.bulk_plan.validated', item.id, {
      version: item.version,
      plan_digest: item.definitionDigest,
      target_snapshot_digest: item.targetSnapshotDigest,
    }),
  });
  return changed
    ? c.json({ id: item.id, version: item.version, status: 'ready' })
    : error(c, 409, 'AGENT_BULK_PLAN_STATE_CONFLICT');
});

agentBulkPlansRouter.post('/:id/:version/start', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_APPLY)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const body = await jsonBody(c);
  const itemVersion = version(c);
  const digest = body?.plan_digest;
  if (!itemVersion || typeof digest !== 'string' || !isFreshAdminHuman(current(c), Date.now())) {
    return error(c, 403, 'AGENT_BULK_PLAN_FRESH_CONFIRMATION_REQUIRED');
  }
  const item = await repository(c).get(controlTenant(c), c.req.param('id') ?? '', itemVersion);
  if (!item || item.definitionDigest !== digest || !item.targetTenantIds) {
    return error(c, 409, 'AGENT_BULK_PLAN_DIGEST_MISMATCH');
  }
  if (!tenantScoped(c, item.targetTenantIds)) {
    return error(c, 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
  }
  if (!(await activeTargetTenants(c, item.targetTenantIds))) {
    return error(c, 409, 'AGENT_BULK_PLAN_TARGET_CHANGED');
  }
  const policyError = await targetPolicyError(c, item.targetTenantIds, item.canaryTenantIds ?? []);
  if (policyError) {
    return error(
      c,
      policyError === 'AGENT_BULK_PLAN_TARGET_POLICY_UNAVAILABLE' ? 503 : 409,
      policyError
    );
  }
  const approvalDigest = await sha256Base64Url(
    canonicalizeJson({
      purpose: 'authrim-agent-bulk-approval-v1',
      bulk_plan_id: item.id,
      bulk_plan_version: item.version,
      plan_digest: item.definitionDigest,
      target_snapshot_digest: item.targetSnapshotDigest,
      canary_digest: item.canaryDigest,
    })
  );
  const transitionId = `audit_${crypto.randomUUID()}`;
  const changed = await repository(c).startApproved({
    controlTenantId: controlTenant(c),
    id: item.id,
    version: item.version,
    definitionDigest: item.definitionDigest,
    targetSnapshotDigest: item.targetSnapshotDigest,
    canaryDigest: item.canaryDigest,
    approvedBy: current(c).userId!,
    approvalDigest,
    now: Date.now(),
    audit: audit(c, transitionId, 'agent.bulk_plan.started', item.id, {
      version: item.version,
      plan_digest: item.definitionDigest,
      target_snapshot_digest: item.targetSnapshotDigest,
      canary_digest: item.canaryDigest,
      approval_digest: approvalDigest,
    }),
  });
  return changed
    ? c.json({ id: item.id, version: item.version, status: 'running' })
    : error(c, 409, 'AGENT_BULK_PLAN_STATE_CONFLICT');
});

async function pauseOrResume(c: BulkContext, operation: 'pause' | 'resume'): Promise<Response> {
  const required =
    operation === 'pause'
      ? ADMIN_PERMISSIONS.BULK_PLANS_PAUSE
      : ADMIN_PERMISSIONS.BULK_PLANS_RESUME;
  if (!human(c) || !permitted(c, required)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = version(c);
  if (!itemVersion) return error(c, 400, 'AGENT_BULK_PLAN_INVALID_VERSION');
  const item = await repository(c).get(controlTenant(c), c.req.param('id') ?? '', itemVersion);
  if (!item) return error(c, 404, 'AGENT_BULK_PLAN_NOT_FOUND');
  if (!item.targetTenantIds || !tenantScoped(c, item.targetTenantIds)) {
    return error(c, 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
  }
  const transitionId = `audit_${crypto.randomUUID()}`;
  const reason = operation === 'pause' ? 'operator_requested' : undefined;
  const changed = await repository(c).transition({
    controlTenantId: controlTenant(c),
    id: item.id,
    version: item.version,
    from: operation === 'pause' ? 'running' : 'paused',
    to: operation === 'pause' ? 'paused' : 'running',
    stage: item.stage,
    pauseReason: reason,
    now: Date.now(),
    audit: audit(c, transitionId, `agent.bulk_plan.${operation}d`, item.id, {
      version: item.version,
      reason: reason ?? 'operator_resumed',
    }),
  });
  return changed
    ? c.json({
        id: item.id,
        version: item.version,
        status: operation === 'pause' ? 'paused' : 'running',
      })
    : error(c, 409, 'AGENT_BULK_PLAN_STATE_CONFLICT');
}

agentBulkPlansRouter.post('/:id/:version/pause', (c) => pauseOrResume(c, 'pause'));
agentBulkPlansRouter.post('/:id/:version/resume', (c) => pauseOrResume(c, 'resume'));

agentBulkPlansRouter.post('/:id/:version/cancel', async (c) => {
  if (!human(c) || !permitted(c, ADMIN_PERMISSIONS.BULK_PLANS_APPLY)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const itemVersion = version(c);
  if (!itemVersion) return error(c, 400, 'AGENT_BULK_PLAN_INVALID_VERSION');
  const item = await repository(c).get(controlTenant(c), c.req.param('id') ?? '', itemVersion);
  if (!item) return error(c, 404, 'AGENT_BULK_PLAN_NOT_FOUND');
  if (!item.targetTenantIds || !tenantScoped(c, item.targetTenantIds)) {
    return error(c, 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
  }
  const value = await jsonBody(c);
  const reason =
    typeof value?.reason === 'string' && value.reason.trim().length > 0
      ? value.reason.trim()
      : 'operator_requested';
  if (reason.length > 500) return error(c, 400, 'AGENT_BULK_PLAN_CANCEL_INVALID');
  const transitionId = `audit_${crypto.randomUUID()}`;
  const changed = await repository(c).cancel({
    controlTenantId: controlTenant(c),
    id: item.id,
    version: item.version,
    cancelledBy: current(c).userId!,
    reason,
    now: Date.now(),
    audit: audit(c, transitionId, 'agent.bulk_plan.cancelled', item.id, {
      version: item.version,
      reason,
      completed_children: item.succeededCount + item.failedCount + item.indeterminateCount,
    }),
  });
  return changed
    ? c.json({ id: item.id, version: item.version, cancelled: true })
    : error(c, 409, 'AGENT_BULK_PLAN_STATE_CONFLICT');
});

export type AgentBulkManagementEnv = Env;
