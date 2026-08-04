import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AdminAgentAccessRepository,
  AgentConfigurationRepository,
  canonicalizeJson,
  resolveAgentGrantExpiration,
  getAgentTaskSetWithBuiltins,
  hasCompleteAgentConfigurationSnapshot,
  normalizeSelfServiceAgentAuthorizationDetails,
  normalizeSelfServiceAgentScopes,
  resolveSelfServiceAgentAccessSnapshot,
  SELF_SERVICE_GRANT_TTL_MS,
  selfServiceRevocationOutboxId,
  sha256Base64Url,
  validateAgentGrantPermissions,
  type AdminAgentGrantRecord,
  type CreateAdminAgentGrantInput,
  type AgentScope,
  type AgentScopeConstraints,
  type AgentResolvedToolContract,
  type JsonObject,
} from '@authrim/ar-agent-access/core';
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';
import {
  ADMIN_PERMISSIONS,
  AdminMachineAccessRepository,
  adminAuthMiddleware,
  ensureDatabaseAdapter,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  resolveTenantDatabaseSourceFromRegistry,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { isAgentMcpEnabled, type AgentManagementEnv } from '../../agent-downscope-auth';

type AgentGrantContext = Context<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const MAX_PURPOSE_LENGTH = 500;
const taskSetCatalog = createAdminToolCatalog();

async function tenantCoreAdapter(c: AgentGrantContext, tenantId: string) {
  const store = await resolveTenantDatabaseSourceFromRegistry(c.env, {
    tenantId,
    role: 'tenant_core',
    dataRole: 'tenant_core/default',
    shardGroup: 'default',
    shardIndex: 0,
  });
  return ensureDatabaseAdapter(store.source, 'agent-grant-client-validation');
}

interface CreateAgentGrantBody {
  client_id?: unknown;
  machine_principal_id?: unknown;
  delegator_id?: unknown;
  authorization_details?: unknown;
  purpose?: unknown;
  expires_at?: unknown;
  delegation_mode?: unknown;
  task_set_id?: unknown;
  task_set_version?: unknown;
  scope_policy_id?: unknown;
  scope_policy_version?: unknown;
}

interface UpdateSelfServiceScopesBody {
  scopes?: unknown;
}

export const agentGrantsRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();

agentGrantsRouter.use('*', adminAuthMiddleware());

function auth(c: AgentGrantContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function tenantId(c: AgentGrantContext): string {
  return auth(c).tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
}

function error(c: AgentGrantContext, status: 400 | 403 | 404 | 409 | 503, code: string) {
  return c.json({ error: code, error_description: code }, status);
}

function stringField(value: unknown, maximum: number = 256): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function positiveVersion(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function authorizationDetails(value: unknown): JsonObject[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) return null;
  if (value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    return null;
  }
  return value as JsonObject[];
}

function registeredScopes(value: unknown): Set<string> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) return null;
    return new Set(parsed as string[]);
  } catch {
    return null;
  }
}

function clientAllowsScopes(value: unknown, requested: readonly AgentScope[]): boolean {
  const allowed = registeredScopes(value);
  return allowed !== null && requested.every((scope) => allowed.has(scope));
}

function responseGrant(grant: AdminAgentGrantRecord) {
  return {
    id: grant.grantId,
    tenant_id: grant.tenantId,
    client_id: grant.clientId,
    machine_principal_id: grant.machinePrincipalId ?? null,
    grantor_id: grant.grantorId,
    delegator_id: grant.delegatorId,
    permissions: grant.permissions,
    scopes: grant.scopes,
    authorization_details: grant.authorizationDetails ?? null,
    resolved_scope_constraints: grant.resolvedScopeConstraints,
    purpose: grant.purpose ?? null,
    management_mode: grant.managementMode,
    consent_version: grant.consentVersion,
    generation: grant.generation,
    status: grant.status,
    delegation_mode: grant.delegationMode,
    task_set_id: grant.taskSetId ?? null,
    task_set_version: grant.taskSetVersion ?? null,
    scope_policy_id: grant.scopePolicyId ?? null,
    scope_policy_version: grant.scopePolicyVersion ?? null,
    resolved_tools: grant.resolvedTools ?? null,
    access_snapshot_hash: grant.accessSnapshotHash ?? null,
    expires_at: grant.expiresAt ?? null,
    last_used_at: grant.lastUsedAt ?? null,
    created_at: grant.createdAt,
    updated_at: grant.updatedAt,
    revoked_at: grant.revokedAt ?? null,
    revoked_by: grant.revokedBy ?? null,
  };
}

agentGrantsRouter.get('/', async (c) => {
  if (!hasAdminPermission(auth(c).permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const status = c.req.query('status');
  if (status && status !== 'active' && status !== 'suspended' && status !== 'revoked') {
    return error(c, 400, 'AGENT_GRANT_INVALID_STATUS');
  }
  const limit = Number(c.req.query('limit') ?? 50);
  const offset = Number(c.req.query('offset') ?? 0);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || limit < 1 || offset < 0) {
    return error(c, 400, 'AGENT_GRANT_INVALID_PAGINATION');
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-management')
  );
  const result = await repository.listGrants({
    tenantId: tenantId(c),
    delegatorId: stringField(c.req.query('delegator_id')) ?? undefined,
    machinePrincipalId: stringField(c.req.query('principal_id')) ?? undefined,
    status: status as 'active' | 'suspended' | 'revoked' | undefined,
    limit,
    offset,
  });
  return c.json({
    grants: result.grants.map(responseGrant),
    pagination: { total: result.total, limit: Math.min(limit, 100), offset },
  });
});

agentGrantsRouter.get('/eligible-permissions', async (c) => {
  const current = auth(c);
  if (!hasAdminPermission(current.permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const tenant = tenantId(c);
  if (!(await isAgentMcpEnabled(c.env, tenant))) return error(c, 404, 'AGENT_MCP_DISABLED');
  const delegatorId = stringField(c.req.query('delegator_id'));
  const principalId = stringField(c.req.query('principal_id')) ?? undefined;
  if (!delegatorId) return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');

  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-eligibility')
  );
  const delegatorPermissions = await repository.getActiveDelegatorPermissions(
    tenant,
    delegatorId,
    Date.now()
  );
  if (
    !delegatorPermissions ||
    !hasAdminPermission(delegatorPermissions, ADMIN_PERMISSIONS.AGENT_USE)
  ) {
    return error(c, 400, 'AGENT_DELEGATOR_NOT_ELIGIBLE');
  }

  let principalPermissions: string[] | undefined;
  let principalTenantScopes:
    | Array<{ scopeMode: 'none' | 'all' | 'allow'; tenantId: string | null }>
    | undefined;
  if (principalId) {
    const machines = new AdminMachineAccessRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-eligibility')
    );
    const principal = await machines.findPrincipalById(principalId);
    if (
      !principal ||
      principal.status !== 'active' ||
      (principal.principalType !== 'ai_agent' && principal.principalType !== 'mcp_server')
    ) {
      return error(c, 400, 'AGENT_PRINCIPAL_INVALID');
    }
    [principalPermissions, principalTenantScopes] = await Promise.all([
      machines.getPrincipalPermissions(principalId),
      machines.getPrincipalTenantScopes(principalId),
    ]);
  }

  const candidates = [
    ...new Set(taskSetCatalog.list().flatMap((tool) => tool.requiredPermissions)),
  ].sort();
  const permissions = candidates.filter(
    (permission) =>
      validateAgentGrantPermissions({
        tenantBoundary: {
          tenantId: tenant,
          clientTenantId: tenant,
          grantorTenantId: tenant,
          delegatorTenantId: tenant,
          principalTenantScopes,
        },
        requestedPermissions: [permission],
        grantorPermissions: current.permissions ?? [],
        delegatorPermissions,
        machinePrincipalId: principalId,
        principalPermissions,
      }).valid
  );
  return c.json({ delegator_id: delegatorId, principal_id: principalId ?? null, permissions });
});

agentGrantsRouter.get('/:id', async (c) => {
  if (!hasAdminPermission(auth(c).permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-management')
  );
  const grant = await repository.getGrantRecord(tenantId(c), c.req.param('id'));
  if (!grant) return error(c, 404, 'AGENT_GRANT_NOT_FOUND');
  const consentCurrent = await repository.hasCurrentConsent(
    grant.tenantId,
    grant.grantId,
    grant.delegatorId,
    grant.clientId,
    grant.consentVersion
  );
  return c.json({ grant: { ...responseGrant(grant), consent_current: consentCurrent } });
});

agentGrantsRouter.get('/:id/audit', async (c) => {
  if (!hasAdminPermission(auth(c).permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_READ)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const limit = Number(c.req.query('limit') ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return error(c, 400, 'AGENT_GRANT_INVALID_PAGINATION');
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-management')
  );
  const id = c.req.param('id');
  const grant = await repository.getGrant(tenantId(c), id);
  if (!grant) return error(c, 404, 'AGENT_GRANT_NOT_FOUND');
  const events = await repository.listGrantAudit(tenantId(c), id, limit);
  return c.json({
    events: events.map((event) => ({
      id: event.id,
      action: event.action,
      result: event.result,
      severity: event.severity,
      actor_type: event.actorType ?? null,
      actor_sub: event.actorSub ?? null,
      metadata: event.metadata,
      created_at: event.createdAt,
    })),
  });
});

agentGrantsRouter.post('/:id/preauthorize', async (c) => {
  const current = auth(c);
  if (
    !hasAdminPermission(current.permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE) ||
    (current.actorType && current.actorType !== 'human')
  ) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const tenant = tenantId(c);
  if (!(await isAgentMcpEnabled(c.env, tenant))) return error(c, 404, 'AGENT_MCP_DISABLED');
  const admin = requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-preauthorization');
  const repository = new AdminAgentAccessRepository(admin);
  const grant = await repository.getGrantRecord(tenant, c.req.param('id'));
  if (
    !grant ||
    grant.status !== 'active' ||
    grant.delegationMode !== 'admin_pre_authorized' ||
    !grant.machinePrincipalId ||
    !hasCompleteAgentConfigurationSnapshot(grant)
  ) {
    return error(c, 409, 'AGENT_GRANT_NOT_PREAUTHORIZABLE');
  }
  const client = await (
    await tenantCoreAdapter(c, tenant)
  ).queryOne<{
    tenant_id: string;
    requestable_scopes: string | null;
  }>(
    'SELECT tenant_id, requestable_scopes FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
    [tenant, grant.clientId]
  );
  if (!client || !clientAllowsScopes(client.requestable_scopes, grant.scopes)) {
    return error(c, 400, 'AGENT_GRANT_CLIENT_SCOPE_NOT_ALLOWED');
  }
  const machines = new AdminMachineAccessRepository(admin);
  const principal = await machines.findPrincipalById(grant.machinePrincipalId);
  const [delegatorPermissions, principalPermissions, principalTenantScopes] = await Promise.all([
    repository.getActiveDelegatorPermissions(tenant, grant.delegatorId, Date.now()),
    machines.getPrincipalPermissions(grant.machinePrincipalId),
    machines.getPrincipalTenantScopes(grant.machinePrincipalId),
  ]);
  if (
    !principal ||
    principal.status !== 'active' ||
    !delegatorPermissions ||
    !hasAdminPermission(delegatorPermissions, ADMIN_PERMISSIONS.AGENT_USE)
  ) {
    return error(c, 400, 'AGENT_GRANT_PREAUTHORIZATION_CONTEXT_INACTIVE');
  }
  const validation = validateAgentGrantPermissions({
    tenantBoundary: {
      tenantId: tenant,
      clientTenantId: client.tenant_id,
      grantorTenantId: tenant,
      delegatorTenantId: tenant,
      principalTenantScopes,
    },
    requestedPermissions: grant.permissions,
    grantorPermissions: current.permissions ?? [],
    delegatorPermissions,
    machinePrincipalId: grant.machinePrincipalId,
    principalPermissions,
  });
  if (!validation.valid) return error(c, 400, validation.code ?? 'AGENT_GRANT_INVALID');
  const now = Date.now();
  const consentBase = {
    tenantId: tenant,
    grantId: grant.grantId,
    userId: grant.delegatorId,
    clientId: grant.clientId,
    consentVersion: grant.consentVersion,
    scopes: grant.scopes,
    grantedAt: now,
  };
  await repository.grantConsentPair({
    delegation: { ...consentBase, id: `acn_${crypto.randomUUID()}`, type: 'delegation' },
    oauthClient: { ...consentBase, id: `acn_${crypto.randomUUID()}`, type: 'oauth_client' },
    audit: {
      id: `audit_${crypto.randomUUID()}`,
      tenantId: tenant,
      adminUserId: current.userId,
      action: 'agent.consent.granted',
      resourceType: 'admin_agent_grant',
      resourceId: grant.grantId,
      severity: 'info',
      result: 'success',
      actorType: 'admin_user',
      actorSub: `admin_user:${current.userId}`,
      grantId: grant.grantId,
      metadata: {
        authorization_basis: 'admin_pre_authorized',
        delegator_id: grant.delegatorId,
        client_id: grant.clientId,
        consent_version: grant.consentVersion,
      },
      createdAt: now,
    },
  });
  return c.json({
    grant_id: grant.grantId,
    consent_version: grant.consentVersion,
    consent_current: true,
  });
});

agentGrantsRouter.put('/:id/self-service-scopes', async (c) => {
  const current = auth(c);
  if (!hasAdminPermission(current.permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  if (current.actorType && current.actorType !== 'human') {
    return error(c, 403, 'AGENT_GRANT_HUMAN_GRANTOR_REQUIRED');
  }
  const tenant = tenantId(c);
  if (!(await isAgentMcpEnabled(c.env, tenant))) return error(c, 404, 'AGENT_MCP_DISABLED');

  let body: UpdateSelfServiceScopesBody;
  try {
    body = await c.req.json<UpdateSelfServiceScopesBody>();
  } catch {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }
  if (Object.keys(body).some((key) => key !== 'scopes') || !Array.isArray(body.scopes)) {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }
  let scopes: AgentScope[];
  try {
    if (body.scopes.some((scope) => typeof scope !== 'string')) {
      return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
    }
    scopes = normalizeSelfServiceAgentScopes(body.scopes as string[]);
  } catch {
    return error(c, 400, 'AGENT_GRANT_SELF_SERVICE_SCOPE_INVALID');
  }

  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-self-service-scopes')
  );
  const grant = await repository.getGrantRecord(tenant, c.req.param('id'));
  if (!grant) return error(c, 404, 'AGENT_GRANT_NOT_FOUND');
  if (grant.status !== 'active') return error(c, 409, 'AGENT_GRANT_NOT_ACTIVE');
  if (
    grant.managementMode !== 'system_managed' ||
    grant.purpose !== 'interactive_self_service' ||
    grant.machinePrincipalId
  ) {
    return error(c, 409, 'AGENT_GRANT_NOT_SELF_SERVICE');
  }
  if (grant.delegatorId !== current.userId || grant.grantorId !== current.userId) {
    return error(c, 403, 'AGENT_GRANT_SELF_SERVICE_OWNER_REQUIRED');
  }
  const client = await (
    await tenantCoreAdapter(c, tenant)
  ).queryOne<{
    tenant_id: string;
    requestable_scopes: string | null;
  }>(
    'SELECT tenant_id, requestable_scopes FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
    [tenant, grant.clientId]
  );
  if (!client) return error(c, 400, 'AGENT_GRANT_CLIENT_NOT_FOUND');
  if (!clientAllowsScopes(client.requestable_scopes, scopes)) {
    return error(c, 400, 'AGENT_GRANT_CLIENT_SCOPE_NOT_ALLOWED');
  }

  const now = Date.now();
  const livePermissions = await repository.getActiveDelegatorPermissions(
    tenant,
    current.userId,
    now
  );
  if (!livePermissions || !hasAdminPermission(livePermissions, ADMIN_PERMISSIONS.AGENT_USE)) {
    return error(c, 400, 'AGENT_DELEGATOR_NOT_ELIGIBLE');
  }
  let resourceConstraintsCurrent = false;
  try {
    resourceConstraintsCurrent =
      normalizeSelfServiceAgentAuthorizationDetails(grant.authorizationDetails)
        .maxSubjectsPerCall === grant.resolvedScopeConstraints.maxPerCall;
  } catch {
    // Continue into snapshot regeneration, which rejects invalid stored RAR fail-closed.
  }
  if (
    scopes.length === grant.scopes.length &&
    scopes.every((scope, index) => scope === grant.scopes[index]) &&
    grant.expiresAt !== undefined &&
    grant.expiresAt > now &&
    resourceConstraintsCurrent
  ) {
    return c.json({ grant: responseGrant(grant), changed: false });
  }

  const nextConsentVersion = grant.consentVersion + 1;
  const expiresAt = now + SELF_SERVICE_GRANT_TTL_MS;
  let snapshot: Awaited<ReturnType<typeof resolveSelfServiceAgentAccessSnapshot>>;
  try {
    snapshot = await resolveSelfServiceAgentAccessSnapshot({
      tenantId: tenant,
      adminUserId: current.userId,
      clientId: grant.clientId,
      grantId: grant.grantId,
      taskSetId: `system_agent_task_set_${grant.grantId}_cv${nextConsentVersion}`,
      taskSetVersion: 1,
      scopePolicyId: `system_agent_scope_policy_${grant.grantId}_cv${nextConsentVersion}`,
      scopePolicyVersion: 1,
      approvedScopes: scopes,
      authorizationDetails: grant.authorizationDetails,
      adminPermissions: livePermissions,
      catalog: taskSetCatalog,
      expiresAt,
    });
  } catch (caught) {
    void caught;
    return error(c, 400, 'AGENT_GRANT_SELF_SERVICE_SCOPE_UNAVAILABLE');
  }
  const nextGrant: CreateAdminAgentGrantInput = {
    grantId: grant.grantId,
    tenantId: tenant,
    clientId: grant.clientId,
    grantorId: current.userId,
    delegatorId: current.userId,
    permissions: snapshot.permissions,
    scopes: snapshot.scopes,
    authorizationDetails: grant.authorizationDetails,
    resolvedScopeConstraints: snapshot.resolvedScopeConstraints,
    consentVersion: nextConsentVersion,
    generation: grant.generation + 1,
    status: 'active',
    delegationMode: 'user_consent',
    taskSetId: snapshot.taskSetId,
    taskSetVersion: snapshot.taskSetVersion,
    scopePolicyId: snapshot.scopePolicyId,
    scopePolicyVersion: snapshot.scopePolicyVersion,
    resolvedTools: snapshot.resolvedTools,
    accessSnapshotHash: snapshot.accessSnapshotHash,
    expiresAt,
    createdAt: now,
    purpose: 'interactive_self_service',
    managementMode: 'system_managed',
  };
  const consentBase = {
    tenantId: tenant,
    grantId: grant.grantId,
    userId: current.userId,
    clientId: grant.clientId,
    consentVersion: nextConsentVersion,
    scopes: snapshot.scopes,
    grantedAt: now,
  };
  const transitionId = `transition_${crypto.randomUUID()}`;
  const auditBase = {
    tenantId: tenant,
    adminUserId: current.userId,
    resourceType: 'admin_agent_grant',
    resourceId: grant.grantId,
    severity: 'info' as const,
    result: 'success' as const,
    requestId: c.req.header('x-request-id'),
    actorType: 'admin_user' as const,
    actorSub: `admin_user:${current.userId}`,
    grantId: grant.grantId,
    createdAt: now,
  };
  try {
    const result = await repository.replaceSelfServiceAuthorization({
      grant: nextGrant,
      expectedGeneration: grant.generation,
      transitionId,
      outboxId: selfServiceRevocationOutboxId(transitionId),
      taskSet: {
        id: snapshot.taskSetId,
        version: snapshot.taskSetVersion,
        digest: snapshot.taskSetDigest,
        resolved: snapshot.taskSetResolved,
      },
      scopePolicy: {
        id: snapshot.scopePolicyId,
        version: snapshot.scopePolicyVersion,
        digest: snapshot.scopePolicyDigest,
        definition: snapshot.scopePolicyDefinition,
        selectorCatalogVersion: 'agent-scope-selectors-v1',
      },
      delegationConsent: {
        ...consentBase,
        id: `agc_${crypto.randomUUID()}`,
        type: 'delegation',
      },
      oauthClientConsent: {
        ...consentBase,
        id: `agc_${crypto.randomUUID()}`,
        type: 'oauth_client',
      },
      grantAudit: {
        ...auditBase,
        id: transitionId,
        action: 'agent.grant.updated',
        metadata: {
          management_mode: 'system_managed',
          source: 'connected_agents_ui',
          previous_scopes: grant.scopes,
          scopes: snapshot.scopes,
          max_subjects_per_call: snapshot.resolvedScopeConstraints.maxPerCall ?? null,
          previous_generation: grant.generation,
        },
      },
      consentAudit: {
        ...auditBase,
        id: `audit_${crypto.randomUUID()}`,
        action: 'agent.consent.granted',
        metadata: {
          source: 'connected_agents_ui',
          consent_version: nextConsentVersion,
          scopes: snapshot.scopes,
          max_subjects_per_call: snapshot.resolvedScopeConstraints.maxPerCall ?? null,
        },
      },
    });
    return c.json({
      grant: responseGrant({
        ...grant,
        ...nextGrant,
        managementMode: 'system_managed',
        updatedAt: now,
      }),
      changed: true,
      token_families_pending_revocation: result.familyCount,
    });
  } catch (caught) {
    if (String(caught).includes('changed before replacement')) {
      return error(c, 409, 'AGENT_GRANT_CONCURRENT_MUTATION');
    }
    throw caught;
  }
});

agentGrantsRouter.patch('/:id', async (c) => {
  const current = auth(c);
  if (!hasAdminPermission(current.permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  if (current.actorType && current.actorType !== 'human') {
    return error(c, 403, 'AGENT_GRANT_HUMAN_GRANTOR_REQUIRED');
  }
  const tenant = tenantId(c);
  if (!(await isAgentMcpEnabled(c.env, tenant))) return error(c, 404, 'AGENT_MCP_DISABLED');
  let body: CreateAgentGrantBody;
  try {
    body = await c.req.json<CreateAgentGrantBody>();
  } catch {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }
  const allowed = new Set(['authorization_details', 'purpose', 'expires_at']);
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-management')
  );
  const grant = await repository.getGrantRecord(tenant, c.req.param('id'));
  if (!grant) return error(c, 404, 'AGENT_GRANT_NOT_FOUND');
  if (grant.status !== 'active') return error(c, 409, 'AGENT_GRANT_NOT_ACTIVE');
  if (!hasCompleteAgentConfigurationSnapshot(grant)) {
    return error(c, 409, 'AGENT_GRANT_CONFIGURATION_SNAPSHOT_INVALID');
  }

  const permissions = grant.permissions;
  const requestedScopes = grant.scopes;
  const details =
    body.authorization_details === undefined
      ? grant.authorizationDetails
      : authorizationDetails(body.authorization_details);
  const purpose =
    body.purpose === undefined
      ? grant.purpose
      : body.purpose === null
        ? undefined
        : (stringField(body.purpose, MAX_PURPOSE_LENGTH) ?? null);
  const now = Date.now();
  const expiresAt =
    body.expires_at === undefined && grant.expiresAt !== undefined
      ? grant.expiresAt
      : resolveAgentGrantExpiration(body.expires_at, now);
  if (
    !permissions ||
    !requestedScopes ||
    details === null ||
    purpose === null ||
    expiresAt === null ||
    resolveAgentGrantExpiration(expiresAt, now) !== expiresAt
  ) {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }
  if (
    permissions.some((permission) => !hasAdminPermission(current.permissions ?? [], permission))
  ) {
    return error(c, 400, 'AGENT_GRANT_PERMISSION_EXCEEDS_UPDATER');
  }
  const client = await (
    await tenantCoreAdapter(c, tenant)
  ).queryOne<{
    tenant_id: string;
    requestable_scopes: string | null;
  }>(
    'SELECT tenant_id, requestable_scopes FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
    [tenant, grant.clientId]
  );
  if (!client) return error(c, 400, 'AGENT_GRANT_CLIENT_NOT_FOUND');
  if (!clientAllowsScopes(client.requestable_scopes, requestedScopes)) {
    return error(c, 400, 'AGENT_GRANT_CLIENT_SCOPE_NOT_ALLOWED');
  }
  const [grantorPermissions, delegatorPermissions] = await Promise.all([
    repository.getActiveDelegatorPermissions(tenant, grant.grantorId, now),
    repository.getActiveDelegatorPermissions(tenant, grant.delegatorId, now),
  ]);
  if (!grantorPermissions) return error(c, 400, 'AGENT_GRANTOR_NOT_ELIGIBLE');
  if (
    !delegatorPermissions ||
    !hasAdminPermission(delegatorPermissions, ADMIN_PERMISSIONS.AGENT_USE)
  ) {
    return error(c, 400, 'AGENT_DELEGATOR_NOT_ELIGIBLE');
  }
  let principalPermissions: string[] | undefined;
  let principalTenantScopes:
    | Array<{ scopeMode: 'none' | 'all' | 'allow'; tenantId: string | null }>
    | undefined;
  if (grant.machinePrincipalId) {
    const machines = new AdminMachineAccessRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-principal-validation')
    );
    const principal = await machines.findPrincipalById(grant.machinePrincipalId);
    if (
      !principal ||
      principal.status !== 'active' ||
      (principal.principalType !== 'ai_agent' && principal.principalType !== 'mcp_server')
    ) {
      return error(c, 400, 'AGENT_PRINCIPAL_INVALID');
    }
    [principalPermissions, principalTenantScopes] = await Promise.all([
      machines.getPrincipalPermissions(grant.machinePrincipalId),
      machines.getPrincipalTenantScopes(grant.machinePrincipalId),
    ]);
  }
  const validation = validateAgentGrantPermissions({
    tenantBoundary: {
      tenantId: tenant,
      clientTenantId: client.tenant_id,
      grantorTenantId: tenant,
      delegatorTenantId: tenant,
      principalTenantScopes,
    },
    requestedPermissions: permissions,
    grantorPermissions,
    delegatorPermissions,
    machinePrincipalId: grant.machinePrincipalId,
    principalPermissions,
  });
  if (!validation.valid) return error(c, 400, validation.code ?? 'AGENT_GRANT_INVALID');

  const outboxId = `agro_${crypto.randomUUID()}`;
  try {
    const result = await repository.updateGrantAndQueueTokenRevocation({
      tenantId: tenant,
      grantId: grant.grantId,
      clientId: grant.clientId,
      expectedGeneration: grant.generation,
      permissions,
      scopes: requestedScopes,
      authorizationDetails: details,
      resolvedScopeConstraints: grant.resolvedScopeConstraints,
      purpose,
      expiresAt,
      outboxId,
      now,
      audit: {
        id: `audit_${crypto.randomUUID()}`,
        tenantId: tenant,
        adminUserId: current.userId,
        action: 'agent.grant.updated',
        resourceType: 'admin_agent_grant',
        resourceId: grant.grantId,
        severity: 'warn',
        result: 'success',
        actorType: 'admin_user',
        actorSub: `admin_user:${current.userId}`,
        grantId: grant.grantId,
        metadata: {
          permissions,
          scopes: requestedScopes,
          authorization_details: details ?? null,
          purpose: purpose ?? null,
          expires_at: expiresAt ?? null,
        },
        createdAt: now,
      },
    });
    return c.json({
      grant_id: grant.grantId,
      status: 'active',
      generation: result.nextGeneration,
      consent_version: result.nextConsentVersion,
      token_families_pending_revocation: result.familyCount,
      revocation_outbox_id: outboxId,
      consent_required: true,
    });
  } catch (caught) {
    if (String(caught).includes('changed before update')) {
      return error(c, 409, 'AGENT_GRANT_CONCURRENT_MUTATION');
    }
    throw caught;
  }
});

agentGrantsRouter.post('/', async (c) => {
  const current = auth(c);
  if (!hasAdminPermission(current.permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  if (current.actorType && current.actorType !== 'human') {
    return error(c, 403, 'AGENT_GRANT_HUMAN_GRANTOR_REQUIRED');
  }

  const tenant = tenantId(c);
  if (!(await isAgentMcpEnabled(c.env, tenant))) {
    return error(c, 404, 'AGENT_MCP_DISABLED');
  }

  let body: CreateAgentGrantBody;
  try {
    body = await c.req.json<CreateAgentGrantBody>();
  } catch {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }
  const allowedCreateFields = new Set([
    'client_id',
    'machine_principal_id',
    'delegator_id',
    'authorization_details',
    'purpose',
    'expires_at',
    'delegation_mode',
    'task_set_id',
    'task_set_version',
    'scope_policy_id',
    'scope_policy_version',
  ]);
  if (Object.keys(body).some((key) => !allowedCreateFields.has(key))) {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }
  const clientId = stringField(body.client_id);
  const delegatorId = stringField(body.delegator_id);
  const machinePrincipalId =
    body.machine_principal_id === undefined || body.machine_principal_id === null
      ? undefined
      : (stringField(body.machine_principal_id) ?? null);
  const delegationMode = body.delegation_mode === undefined ? 'user_consent' : body.delegation_mode;
  let permissions: string[];
  let requestedScopes: AgentScope[];
  const taskSetId =
    body.task_set_id === undefined ? undefined : (stringField(body.task_set_id) ?? null);
  const taskSetVersion = positiveVersion(body.task_set_version);
  const scopePolicyId =
    body.scope_policy_id === undefined ? undefined : (stringField(body.scope_policy_id) ?? null);
  const scopePolicyVersion = positiveVersion(body.scope_policy_version);
  const details = authorizationDetails(body.authorization_details);
  const purpose =
    body.purpose === undefined
      ? undefined
      : (stringField(body.purpose, MAX_PURPOSE_LENGTH) ?? null);
  const now = Date.now();
  const expiresAt = resolveAgentGrantExpiration(body.expires_at, now);
  if (
    !clientId ||
    !delegatorId ||
    machinePrincipalId === null ||
    taskSetId === null ||
    taskSetVersion === null ||
    scopePolicyId === null ||
    scopePolicyVersion === null ||
    !taskSetId ||
    taskSetVersion === undefined ||
    !scopePolicyId ||
    scopePolicyVersion === undefined ||
    (delegationMode !== 'user_consent' && delegationMode !== 'admin_pre_authorized') ||
    (delegationMode === 'admin_pre_authorized' && !machinePrincipalId) ||
    details === null ||
    purpose === null ||
    expiresAt === null
  ) {
    return error(c, 400, 'AGENT_GRANT_INVALID_REQUEST');
  }

  const admin = requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-management');
  let resolvedScopeConstraints: AgentScopeConstraints = { tenantIds: [tenant] };
  let resolvedTools: AgentResolvedToolContract[];
  let accessSnapshotHash: string;
  {
    const configuration = new AgentConfigurationRepository(admin);
    const [taskSet, scopePolicy] = await Promise.all([
      getAgentTaskSetWithBuiltins({
        repository: configuration,
        catalog: taskSetCatalog,
        tenantId: tenant,
        id: taskSetId,
        version: taskSetVersion,
      }),
      configuration.getScopePolicyVersion(tenant, scopePolicyId, scopePolicyVersion),
    ]);
    if (!taskSet || taskSet.status !== 'active') {
      return error(c, 400, 'AGENT_GRANT_TASK_SET_INVALID');
    }
    if (!scopePolicy || scopePolicy.status !== 'active') {
      return error(c, 400, 'AGENT_GRANT_SCOPE_POLICY_INVALID');
    }
    if (scopePolicy.definition.selectors.length > 0) {
      return error(c, 400, 'AGENT_GRANT_SCOPE_SELECTOR_NOT_RUNTIME_SUPPORTED');
    }
    permissions = [...taskSet.version.permissions];
    requestedScopes = [
      ...new Set(taskSet.version.tools.map((tool) => tool.requiredScope)),
    ] as AgentScope[];
    resolvedScopeConstraints = {
      tenantIds: [...scopePolicy.definition.tenantIds],
      ...(scopePolicy.definition.environmentIds.length > 0
        ? { environmentIds: [...scopePolicy.definition.environmentIds] }
        : {}),
      ...(scopePolicy.definition.domains.length > 0
        ? { domains: [...scopePolicy.definition.domains] }
        : {}),
      ...(scopePolicy.definition.resourceIds.length > 0
        ? {
            resourceSelector: {
              kind: 'ids' as const,
              ids: [...scopePolicy.definition.resourceIds],
            },
          }
        : {}),
      ...(scopePolicy.definition.allowedFields.length > 0
        ? { allowedFields: [...scopePolicy.definition.allowedFields] }
        : {}),
      piiMode: scopePolicy.definition.piiMode === 'explicit_unmasked' ? 'unmasked' : 'masked',
      maxPerCall: scopePolicy.definition.maxPerCall,
      maxPerPlan: scopePolicy.definition.maxPlanOperations,
      maxPerBulkPlan: scopePolicy.definition.maxBulkTenants,
    };
    resolvedTools = JSON.parse(
      canonicalizeJson(taskSet.version.tools as never)
    ) as AgentResolvedToolContract[];
    accessSnapshotHash = await sha256Base64Url(
      canonicalizeJson({
        task_set_id: taskSetId,
        task_set_version: taskSetVersion,
        task_set_digest: taskSet.version.digest,
        scope_policy_id: scopePolicyId,
        scope_policy_version: scopePolicyVersion,
        scope_policy_digest: scopePolicy.definitionDigest,
        permissions,
        scopes: requestedScopes,
        constraints: resolvedScopeConstraints,
        tools: resolvedTools,
      } as never)
    );
  }

  const core = await tenantCoreAdapter(c, tenant);
  const client = await core.queryOne<{
    client_id: string;
    tenant_id: string;
    requestable_scopes: string | null;
  }>(
    'SELECT client_id, tenant_id, requestable_scopes FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
    [tenant, clientId]
  );
  if (!client) return error(c, 400, 'AGENT_GRANT_CLIENT_NOT_FOUND');
  if (!clientAllowsScopes(client.requestable_scopes, requestedScopes)) {
    return error(c, 400, 'AGENT_GRANT_CLIENT_SCOPE_NOT_ALLOWED');
  }

  const repository = new AdminAgentAccessRepository(admin);
  const delegatorPermissions = await repository.getActiveDelegatorPermissions(
    tenant,
    delegatorId,
    now
  );
  if (
    !delegatorPermissions ||
    !hasAdminPermission(delegatorPermissions, ADMIN_PERMISSIONS.AGENT_USE)
  ) {
    return error(c, 400, 'AGENT_DELEGATOR_NOT_ELIGIBLE');
  }

  let principalPermissions: string[] | undefined;
  let principalTenantScopes:
    | Array<{ scopeMode: 'none' | 'all' | 'allow'; tenantId: string | null }>
    | undefined;
  if (machinePrincipalId) {
    const machineRepository = new AdminMachineAccessRepository(admin);
    const principal = await machineRepository.findPrincipalById(machinePrincipalId);
    if (
      !principal ||
      principal.status !== 'active' ||
      (principal.principalType !== 'ai_agent' && principal.principalType !== 'mcp_server')
    ) {
      return error(c, 400, 'AGENT_PRINCIPAL_INVALID');
    }
    [principalPermissions, principalTenantScopes] = await Promise.all([
      machineRepository.getPrincipalPermissions(machinePrincipalId),
      machineRepository.getPrincipalTenantScopes(machinePrincipalId),
    ]);
  }

  const validation = validateAgentGrantPermissions({
    tenantBoundary: {
      tenantId: tenant,
      clientTenantId: client.tenant_id,
      grantorTenantId: tenant,
      delegatorTenantId: tenant,
      principalTenantScopes,
    },
    requestedPermissions: permissions,
    grantorPermissions: current.permissions ?? [],
    delegatorPermissions,
    machinePrincipalId,
    principalPermissions,
  });
  if (!validation.valid) return error(c, 400, validation.code ?? 'AGENT_GRANT_INVALID');

  const grantId = `aag_${crypto.randomUUID()}`;
  try {
    const grantInput: CreateAdminAgentGrantInput = {
      grantId,
      tenantId: tenant,
      clientId,
      machinePrincipalId,
      grantorId: current.userId,
      delegatorId,
      permissions,
      scopes: requestedScopes,
      resolvedScopeConstraints,
      taskSetId,
      taskSetVersion,
      scopePolicyId,
      scopePolicyVersion,
      resolvedTools,
      accessSnapshotHash,
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode,
      expiresAt,
      authorizationDetails: details,
      purpose,
      createdAt: now,
    };
    const grantAudit = {
      id: `audit_${crypto.randomUUID()}`,
      tenantId: tenant,
      adminUserId: current.userId,
      action: 'agent.grant.created',
      resourceType: 'admin_agent_grant',
      resourceId: grantId,
      severity: 'info',
      result: 'success',
      actorType: 'admin_user',
      actorSub: `admin_user:${current.userId}`,
      grantId,
      metadata: {
        delegator_id: delegatorId,
        client_id: clientId,
        machine_principal_id: machinePrincipalId ?? null,
        permissions,
        scopes: requestedScopes,
        expires_at: expiresAt ?? null,
        delegation_mode: delegationMode,
        task_set_id: taskSetId ?? null,
        task_set_version: taskSetVersion ?? null,
        scope_policy_id: scopePolicyId ?? null,
        scope_policy_version: scopePolicyVersion ?? null,
        access_snapshot_hash: accessSnapshotHash ?? null,
      },
      createdAt: now,
    } as const;
    if (delegationMode === 'admin_pre_authorized') {
      const consentBase = {
        tenantId: tenant,
        grantId,
        userId: delegatorId,
        clientId,
        consentVersion: 1,
        scopes: requestedScopes,
        grantedAt: now,
      };
      await repository.createGrantWithPreauthorization({
        grant: grantInput,
        delegationConsent: {
          ...consentBase,
          id: `acn_${crypto.randomUUID()}`,
          type: 'delegation',
        },
        oauthClientConsent: {
          ...consentBase,
          id: `acn_${crypto.randomUUID()}`,
          type: 'oauth_client',
        },
        audit: grantAudit,
        consentAudit: {
          id: `audit_${crypto.randomUUID()}`,
          tenantId: tenant,
          adminUserId: current.userId,
          action: 'agent.consent.granted',
          resourceType: 'admin_agent_grant',
          resourceId: grantId,
          severity: 'info',
          result: 'success',
          actorType: 'admin_user',
          actorSub: `admin_user:${current.userId}`,
          grantId,
          metadata: {
            authorization_basis: 'admin_pre_authorized',
            delegator_id: delegatorId,
            client_id: clientId,
            consent_version: 1,
          },
          createdAt: now,
        },
      });
    } else {
      await repository.createGrantWithAudit({ grant: grantInput, audit: grantAudit });
    }
  } catch (caught) {
    if (String(caught).includes('UNIQUE')) return error(c, 409, 'AGENT_GRANT_ALREADY_EXISTS');
    throw caught;
  }

  return c.json(
    {
      grant_id: grantId,
      status: 'active',
      consent_version: 1,
      generation: 1,
      consent_required: delegationMode === 'user_consent',
    },
    201
  );
});

async function invalidateGrant(
  c: AgentGrantContext,
  status: 'suspended' | 'revoked'
): Promise<Response> {
  const required =
    status === 'revoked'
      ? ADMIN_PERMISSIONS.AGENT_GRANTS_REVOKE
      : ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE;
  const current = auth(c);
  if (!hasAdminPermission(current.permissions ?? [], required)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  const tenant = tenantId(c);
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-management')
  );
  const id = stringField(c.req.param('id'));
  if (!id) return error(c, 404, 'AGENT_GRANT_NOT_FOUND');
  const grant = await repository.getGrant(tenant, id);
  if (!grant) return error(c, 404, 'AGENT_GRANT_NOT_FOUND');
  if (grant.status !== 'active') return error(c, 409, 'AGENT_GRANT_NOT_ACTIVE');

  const now = Date.now();
  const outboxId = `agro_${crypto.randomUUID()}`;
  try {
    const result = await repository.invalidateGrantAndQueueTokenRevocation({
      tenantId: tenant,
      grantId: grant.grantId,
      clientId: grant.clientId,
      expectedGeneration: grant.generation,
      status,
      reason: status === 'revoked' ? 'grant_revoked' : 'admin',
      outboxId,
      now,
      audit: {
        id: `audit_${crypto.randomUUID()}`,
        tenantId: tenant,
        adminUserId: current.userId,
        action: status === 'revoked' ? 'agent.grant.revoked' : 'agent.grant.suspended',
        resourceType: 'admin_agent_grant',
        resourceId: grant.grantId,
        severity: status === 'revoked' ? 'critical' : 'warn',
        result: 'success',
        actorType:
          current.actorType === 'agent'
            ? 'agent'
            : current.actorType === undefined || current.actorType === 'human'
              ? 'admin_user'
              : 'system',
        actorSub:
          current.actorType === undefined || current.actorType === 'human'
            ? `admin_user:${current.userId}`
            : (current.actorId ?? current.userId),
        grantId: grant.grantId,
        metadata: { client_id: grant.clientId, previous_generation: grant.generation },
        createdAt: now,
      },
    });
    return c.json({
      grant_id: grant.grantId,
      status,
      generation: result.nextGeneration,
      token_families_pending_revocation: result.familyCount,
      revocation_outbox_id: outboxId,
    });
  } catch (caught) {
    if (String(caught).includes('changed before invalidation')) {
      return error(c, 409, 'AGENT_GRANT_CONCURRENT_MUTATION');
    }
    throw caught;
  }
}

agentGrantsRouter.post('/:id/suspend', (c) => invalidateGrant(c, 'suspended'));
agentGrantsRouter.post('/:id/revoke', (c) => invalidateGrant(c, 'revoked'));

agentGrantsRouter.post('/:id/resume', async (c) => {
  const current = auth(c);
  if (!hasAdminPermission(current.permissions ?? [], ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE)) {
    return error(c, 403, 'ADMIN_INSUFFICIENT_PERMISSIONS');
  }
  if (current.actorType && current.actorType !== 'human') {
    return error(c, 403, 'AGENT_GRANT_HUMAN_GRANTOR_REQUIRED');
  }
  const tenant = tenantId(c);
  if (!(await isAgentMcpEnabled(c.env, tenant))) return error(c, 404, 'AGENT_MCP_DISABLED');
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-management')
  );
  const grant = await repository.getGrant(tenant, c.req.param('id'));
  if (!grant) return error(c, 404, 'AGENT_GRANT_NOT_FOUND');
  if (grant.status !== 'suspended') return error(c, 409, 'AGENT_GRANT_NOT_SUSPENDED');
  if (!hasCompleteAgentConfigurationSnapshot(grant)) {
    return error(c, 409, 'AGENT_GRANT_CONFIGURATION_SNAPSHOT_INVALID');
  }
  const configuration = new AgentConfigurationRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-configuration-validation')
  );
  const [taskSet, scopePolicy] = await Promise.all([
    getAgentTaskSetWithBuiltins({
      repository: configuration,
      catalog: taskSetCatalog,
      tenantId: tenant,
      id: grant.taskSetId,
      version: grant.taskSetVersion,
    }),
    configuration.getScopePolicyVersion(tenant, grant.scopePolicyId, grant.scopePolicyVersion),
  ]);
  if (taskSet?.status !== 'active' || scopePolicy?.status !== 'active') {
    return error(c, 409, 'AGENT_GRANT_CONFIGURATION_SNAPSHOT_INACTIVE');
  }
  if (
    grant.permissions.some(
      (permission) => !hasAdminPermission(current.permissions ?? [], permission)
    )
  ) {
    return error(c, 400, 'AGENT_GRANT_PERMISSION_EXCEEDS_UPDATER');
  }
  const client = await (
    await tenantCoreAdapter(c, tenant)
  ).queryOne<{
    tenant_id: string;
    requestable_scopes: string | null;
  }>(
    'SELECT tenant_id, requestable_scopes FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
    [tenant, grant.clientId]
  );
  if (!client) return error(c, 400, 'AGENT_GRANT_CLIENT_NOT_FOUND');
  if (!clientAllowsScopes(client.requestable_scopes, grant.scopes)) {
    return error(c, 400, 'AGENT_GRANT_CLIENT_SCOPE_NOT_ALLOWED');
  }
  const now = Date.now();
  const expiresAt = resolveAgentGrantExpiration(undefined, now);
  if (expiresAt === null) return error(c, 503, 'AGENT_GRANT_EXPIRY_POLICY_INVALID');
  const [grantorPermissions, delegatorPermissions] = await Promise.all([
    repository.getActiveDelegatorPermissions(tenant, grant.grantorId, now),
    repository.getActiveDelegatorPermissions(tenant, grant.delegatorId, now),
  ]);
  if (
    !grantorPermissions ||
    !delegatorPermissions ||
    !hasAdminPermission(delegatorPermissions, ADMIN_PERMISSIONS.AGENT_USE)
  ) {
    return error(c, 400, 'AGENT_GRANT_PARTICIPANT_NOT_ELIGIBLE');
  }
  const validation = validateAgentGrantPermissions({
    tenantBoundary: {
      tenantId: tenant,
      clientTenantId: tenant,
      grantorTenantId: tenant,
      delegatorTenantId: tenant,
    },
    requestedPermissions: grant.permissions,
    grantorPermissions,
    delegatorPermissions,
  });
  if (!validation.valid) return error(c, 400, validation.code ?? 'AGENT_GRANT_INVALID');
  if (grant.machinePrincipalId) {
    const machines = new AdminMachineAccessRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'agent-grant-principal-validation')
    );
    const principal = await machines.findPrincipalById(grant.machinePrincipalId);
    const [principalPermissions, principalTenantScopes] = await Promise.all([
      machines.getPrincipalPermissions(grant.machinePrincipalId),
      machines.getPrincipalTenantScopes(grant.machinePrincipalId),
    ]);
    if (
      !principal ||
      principal.status !== 'active' ||
      (principal.principalType !== 'ai_agent' && principal.principalType !== 'mcp_server') ||
      !validateAgentGrantPermissions({
        tenantBoundary: {
          tenantId: tenant,
          clientTenantId: tenant,
          grantorTenantId: tenant,
          delegatorTenantId: tenant,
          principalTenantScopes,
        },
        requestedPermissions: grant.permissions,
        grantorPermissions,
        delegatorPermissions,
        machinePrincipalId: grant.machinePrincipalId,
        principalPermissions,
      }).valid
    ) {
      return error(c, 400, 'AGENT_PRINCIPAL_INVALID');
    }
  }
  const transitionId = `audit_${crypto.randomUUID()}`;
  try {
    const resumed = await repository.resumeGrantWithAudit({
      tenantId: tenant,
      grantId: grant.grantId,
      clientId: grant.clientId,
      expectedGeneration: grant.generation,
      transitionId,
      expiresAt,
      now,
      audit: {
        id: transitionId,
        tenantId: tenant,
        adminUserId: current.userId,
        action: 'agent.grant.resumed',
        resourceType: 'admin_agent_grant',
        resourceId: grant.grantId,
        severity: 'warn',
        result: 'success',
        actorType: 'admin_user',
        actorSub: `admin_user:${current.userId}`,
        grantId: grant.grantId,
        metadata: {
          consent_required: true,
          generation: grant.generation,
          expires_at: expiresAt,
          recertified: true,
        },
        createdAt: now,
      },
    });
    if (!resumed) return error(c, 409, 'AGENT_GRANT_CONCURRENT_MUTATION');
    return c.json({
      grant_id: grant.grantId,
      status: 'active',
      generation: grant.generation,
      consent_version: grant.consentVersion,
      consent_required: true,
      expires_at: expiresAt,
    });
  } catch (caught) {
    if (String(caught).includes('UNIQUE')) return error(c, 409, 'AGENT_GRANT_ALREADY_EXISTS');
    throw caught;
  }
});

export type AgentGrantsRouterEnv = Env;
