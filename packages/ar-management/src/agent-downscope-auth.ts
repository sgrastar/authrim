import type { Context } from 'hono';
import {
  AdminAgentAccessRepository,
  AgentBulkRepository,
  computeAgentBulkChildCapabilityDigest,
  evaluateAgentMcpFeatureFlag,
  hasCompleteAgentConfigurationSnapshot,
  parseAgentAdminApiDownscopeTokenClaims,
  type AgentGrantContract,
} from '@authrim/ar-agent-access/core';
import {
  buildRequestIssuerUrl,
  AdminMachineAccessRepository,
  getPublicKeyByKid,
  hasAdminPermission,
  parseTokenHeader,
  requireDedicatedAdminDatabaseAdapter,
  verifyToken,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

export type AgentManagementEnv = Env & { ENABLE_AGENT_MCP?: string };

interface AgentDownscopeAuthRepository {
  getGrant(tenantId: string, grantId: string): Promise<AgentGrantContract | null>;
  getActiveDelegatorPermissions(
    tenantId: string,
    delegatorId: string,
    now: number
  ): Promise<string[] | null>;
  hasCurrentConsent(
    tenantId: string,
    grantId: string,
    delegatorId: string,
    clientId: string,
    consentVersion: number
  ): Promise<boolean>;
}

export interface AgentDownscopeAuthDependencies {
  now(): number;
  isFeatureEnabled(env: AgentManagementEnv, tenantId: string): Promise<boolean>;
  verifyJwt(
    env: AgentManagementEnv,
    request: Request,
    tenantId: string,
    token: string
  ): Promise<unknown>;
  createRepository(env: AgentManagementEnv): AgentDownscopeAuthRepository;
  getModeBPermissionLimit(
    env: AgentManagementEnv,
    tenantId: string,
    principalId: string,
    credentialId?: string
  ): Promise<string[] | null>;
  validateBulkChild(
    env: AgentManagementEnv,
    claims: NonNullable<ReturnType<typeof parseAgentAdminApiDownscopeTokenClaims>>,
    now: number
  ): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function isAgentMcpEnabled(
  env: AgentManagementEnv,
  tenantId: string
): Promise<boolean> {
  const settings = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  if (!settings) {
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      environmentValue: env.ENABLE_AGENT_MCP,
    }).enabled;
  }
  try {
    const raw = await settings.get(`settings:tenant:${tenantId}:agent-access`);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      tenantValue: isRecord(parsed) ? parsed['agent.mcp.enabled'] : parsed,
      environmentValue: env.ENABLE_AGENT_MCP,
    }).enabled;
  } catch {
    return false;
  }
}

async function defaultVerifyJwt(
  env: AgentManagementEnv,
  request: Request,
  tenantId: string,
  token: string
): Promise<unknown> {
  const header = parseTokenHeader(token);
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) {
    throw new Error('invalid_agent_admin_api_token_header');
  }
  const publicKey = await getPublicKeyByKid(env, tenantId, header.kid);
  if (!publicKey) throw new Error('agent_admin_api_verification_key_unavailable');
  const issuer = `${buildRequestIssuerUrl(request, env, tenantId).replace(/\/$/u, '')}/oauth/admin-agent`;
  return verifyToken(token, publicKey, issuer, { audience: 'authrim:admin-api' });
}

async function defaultModeBPermissionLimit(
  env: AgentManagementEnv,
  tenantId: string,
  principalId: string,
  credentialId?: string
): Promise<string[] | null> {
  const repository = new AdminMachineAccessRepository(
    requireDedicatedAdminDatabaseAdapter(env, 'agent-admin-api-machine-principal')
  );
  const principal = await repository.findPrincipalById(principalId);
  if (!principal || principal.status !== 'active') return null;
  const [principalScopes, principalPermissions] = await Promise.all([
    repository.getPrincipalTenantScopes(principalId),
    repository.getPrincipalPermissions(principalId),
  ]);
  if (
    principalScopes.length === 0 ||
    principalScopes.some((scope) => scope.scopeMode !== 'allow') ||
    !principalScopes.some((scope) => scope.tenantId === tenantId)
  ) {
    return null;
  }
  if (!credentialId) return principalPermissions;
  const credential = await repository.findCredentialById(credentialId);
  if (
    !credential ||
    credential.principalId !== principalId ||
    (credential.status !== 'active' && credential.status !== 'rotating')
  ) {
    return null;
  }
  const [credentialScopes, credentialPermissions] = await Promise.all([
    repository.getCredentialTenantScopes(credentialId),
    repository.getCredentialPermissions(credentialId),
  ]);
  if (
    credentialScopes.length > 0 &&
    (credentialScopes.some((scope) => scope.scopeMode !== 'allow') ||
      !credentialScopes.some((scope) => scope.tenantId === tenantId))
  ) {
    return null;
  }
  return credentialPermissions.length === 0
    ? principalPermissions
    : principalPermissions.filter((permission) =>
        credentialPermissions.some((candidate) => hasAdminPermission([candidate], permission))
      );
}

async function defaultValidateBulkChild(
  env: AgentManagementEnv,
  claims: NonNullable<ReturnType<typeof parseAgentAdminApiDownscopeTokenClaims>>,
  now: number
): Promise<boolean> {
  if (!claims.bulk) return true;
  const repository = new AgentBulkRepository(
    requireDedicatedAdminDatabaseAdapter(env, 'agent-admin-api-bulk-child')
  );
  const [plan, execution] = await Promise.all([
    repository.get(claims.bulk.control_tenant_id, claims.bulk.plan_id, claims.bulk.plan_version),
    repository.getTenantExecution(
      claims.bulk.control_tenant_id,
      claims.bulk.plan_id,
      claims.bulk.plan_version,
      claims.bulk.execution_id
    ),
  ]);
  if (
    !plan ||
    plan.status !== 'running' ||
    plan.cancelledAt !== undefined ||
    plan.definitionDigest !== claims.bulk.plan_digest ||
    plan.approvalDigest !== claims.bulk.approval_digest ||
    plan.grantId !== claims.grant_id ||
    plan.actorSub !== claims.act.sub ||
    plan.clientId !== claims.client_id ||
    plan.actorMode !== 'mode_b' ||
    !execution ||
    execution.targetTenantId !== claims.tenant_id ||
    execution.status !== 'running' ||
    execution.stage !== claims.bulk.stage ||
    execution.executionAttempt !== claims.bulk.execution_attempt ||
    execution.executionFence !== claims.bulk.execution_fence ||
    execution.planDigest !== claims.bulk.plan_digest ||
    execution.childCapabilityDigest !== claims.bulk.child_capability_digest ||
    !execution.childCapabilityExpiresAt ||
    execution.childCapabilityExpiresAt <= now
  ) {
    return false;
  }
  return (
    (await computeAgentBulkChildCapabilityDigest({
      purpose: 'authrim-agent-bulk-child-v1',
      controlTenantId: claims.bulk.control_tenant_id,
      targetTenantId: claims.bulk.target_tenant_id,
      bulkPlanId: claims.bulk.plan_id,
      bulkPlanVersion: claims.bulk.plan_version,
      executionId: claims.bulk.execution_id,
      executionAttempt: claims.bulk.execution_attempt,
      executionFence: claims.bulk.execution_fence,
      stage: claims.bulk.stage,
      planDigest: claims.bulk.plan_digest,
      approvalDigest: claims.bulk.approval_digest,
      ...(execution.preconditionSnapshotDigest
        ? { preconditionSnapshotDigest: execution.preconditionSnapshotDigest }
        : {}),
      expiresAt: execution.childCapabilityExpiresAt,
    })) === claims.bulk.child_capability_digest
  );
}

/** Owner-package verifier used by ar-lib-core's extensible Admin bearer boundary. */
export async function authenticateAgentDownscopeBearer(
  c: Context<{ Bindings: AgentManagementEnv }>,
  token: string,
  tenantId: string,
  overrides: Partial<AgentDownscopeAuthDependencies> = {}
): Promise<AdminAuthContext | null> {
  const dependencies: AgentDownscopeAuthDependencies = {
    now: overrides.now ?? (() => Date.now()),
    isFeatureEnabled: overrides.isFeatureEnabled ?? isAgentMcpEnabled,
    verifyJwt: overrides.verifyJwt ?? defaultVerifyJwt,
    createRepository:
      overrides.createRepository ??
      ((env) =>
        new AdminAgentAccessRepository(
          requireDedicatedAdminDatabaseAdapter(env, 'agent-admin-api-authentication')
        )),
    getModeBPermissionLimit: overrides.getModeBPermissionLimit ?? defaultModeBPermissionLimit,
    validateBulkChild: overrides.validateBulkChild ?? defaultValidateBulkChild,
  };

  try {
    if (!(await dependencies.isFeatureEnabled(c.env, tenantId))) return null;
    const claims = parseAgentAdminApiDownscopeTokenClaims(
      await dependencies.verifyJwt(c.env, c.req.raw, tenantId, token)
    );
    if (!claims || claims.tenant_id !== tenantId) return null;
    const grantTenantId = claims.bulk?.control_tenant_id ?? tenantId;
    if (
      claims.bulk &&
      (!(await dependencies.isFeatureEnabled(c.env, grantTenantId)) ||
        !(await dependencies.validateBulkChild(c.env, claims, dependencies.now())))
    ) {
      return null;
    }
    if (
      (claims.actor_mode === 'mode_a' && claims.act.sub !== `client:${claims.client_id}`) ||
      (claims.actor_mode === 'mode_b' &&
        (!claims.act_principal_id ||
          !claims.act_credential_id ||
          claims.act.sub !== `machine:${claims.act_principal_id}`))
    ) {
      return null;
    }

    const delegatorId = claims.sub.slice('admin_user:'.length);
    const repository = dependencies.createRepository(c.env);
    const now = dependencies.now();
    const [grant, currentPermissions, currentConsent] = await Promise.all([
      repository.getGrant(grantTenantId, claims.grant_id),
      repository.getActiveDelegatorPermissions(tenantId, delegatorId, now),
      repository.hasCurrentConsent(
        grantTenantId,
        claims.grant_id,
        delegatorId,
        claims.client_id,
        claims.consent_version
      ),
    ]);
    const principalPermissionLimit = grant?.machinePrincipalId
      ? await dependencies.getModeBPermissionLimit(
          c.env,
          tenantId,
          grant.machinePrincipalId,
          claims.actor_mode === 'mode_b' ? claims.act_credential_id! : undefined
        )
      : undefined;
    if (
      !grant ||
      grant.status !== 'active' ||
      !hasCompleteAgentConfigurationSnapshot(grant) ||
      grant.clientId !== claims.client_id ||
      grant.delegatorId !== delegatorId ||
      grant.generation !== claims.grant_generation ||
      grant.consentVersion !== claims.consent_version ||
      !grant.resolvedScopeConstraints.tenantIds.includes(tenantId) ||
      (grant.expiresAt !== undefined && grant.expiresAt <= now) ||
      !currentPermissions ||
      !currentConsent ||
      (claims.actor_mode === 'mode_b' && grant.machinePrincipalId !== claims.act_principal_id) ||
      (grant.machinePrincipalId !== undefined && !principalPermissionLimit) ||
      claims.permissions.some(
        (permission) =>
          !hasAdminPermission(grant.permissions, permission) ||
          !hasAdminPermission(currentPermissions, permission) ||
          (principalPermissionLimit != null &&
            !hasAdminPermission(principalPermissionLimit, permission))
      )
    ) {
      return null;
    }

    return {
      userId: delegatorId,
      authMethod: 'bearer',
      actorType: 'agent',
      actorId: claims.act.sub,
      clientId: claims.client_id,
      roles: [],
      tenantId,
      tenantScope: [tenantId],
      permissions: claims.permissions,
      hierarchyLevel: 0,
      mfaVerified: false,
      clientAuthMethod: 'service_binding',
      credentialStrength: 'service_binding',
      senderConstrained: false,
      agentMode: claims.actor_mode,
      agentAssurance: claims.actor_assurance,
      agentGrantId: claims.grant_id,
      agentGrantGeneration: claims.grant_generation,
      agentConsentVersion: claims.consent_version,
      sourceTokenJti: claims.source_token_jti,
      correlationId: claims.correlation_id,
    };
  } catch {
    return null;
  }
}
