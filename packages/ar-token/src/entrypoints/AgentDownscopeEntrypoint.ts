import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  AdminAgentAccessRepository,
  AgentBulkRepository,
  agentGrantPinsToolContract,
  agentResourceConstraintsAllow,
  buildAgentToolResourceContext,
  computeAgentBulkChildCapabilityDigest,
  evaluateAgentMcpFeatureFlag,
  hasCompleteAgentConfigurationSnapshot,
  parseAgentAccessTokenClaims,
  type AgentDownscopeExchangeRequest,
  type AgentDownscopeExchangeResult,
  type AgentBulkChildTokenRequest,
  type AgentGrantContract,
} from '@authrim/ar-agent-access/core';
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';
import {
  ADMIN_PERMISSIONS,
  createAccessToken,
  AdminMachineAccessRepository,
  generateSecureRandomString,
  getPublicKeyByKid,
  hasAdminPermission,
  isValidTenantIdentifier,
  parseTokenHeader,
  requireDedicatedAdminDatabaseAdapter,
  verifyToken,
  type Env,
} from '@authrim/ar-lib-core';
import { importPKCS8 } from 'jose';

const DOWNSCOPE_TTL_SECONDS = 60;
const MAX_PERMISSIONS = 64;
const SAFE_PERMISSION = /^[a-z][a-z0-9_:-]{0,199}$/u;
const bulkToolCatalog = createAdminToolCatalog();

interface AgentDownscopeRepository {
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

export interface AgentDownscopeEntrypointDependencies {
  now(): number;
  isFeatureEnabled(env: Env, tenantId: string): Promise<boolean>;
  verifySubjectToken(
    env: Env,
    tenantId: string,
    issuerOrigin: string,
    token: string
  ): Promise<unknown>;
  createRepository(env: Env): AgentDownscopeRepository;
  createBulkRepository?(env: Env): Pick<AgentBulkRepository, 'get' | 'getTenantExecution'>;
  getModeBPermissionLimit(
    env: Env,
    tenantId: string,
    principalId: string,
    credentialId?: string
  ): Promise<string[] | null>;
  signToken(
    env: Env,
    tenantId: string,
    claims: Record<string, unknown>
  ): Promise<AgentDownscopeExchangeResult>;
}

async function defaultModeBPermissionLimit(
  env: Env,
  tenantId: string,
  principalId: string,
  credentialId?: string
): Promise<string[] | null> {
  const repository = new AdminMachineAccessRepository(
    requireDedicatedAdminDatabaseAdapter(env, 'agent-downscope-machine-principal')
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function defaultFeatureEnabled(env: Env, tenantId: string): Promise<boolean> {
  const environmentValue = (env as Env & { ENABLE_AGENT_MCP?: string }).ENABLE_AGENT_MCP;
  const settings = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  if (!settings) {
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      environmentValue,
    }).enabled;
  }
  try {
    const raw = await settings.get(`settings:tenant:${tenantId}:agent-access`);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      tenantValue: isRecord(parsed) ? parsed['agent.mcp.enabled'] : parsed,
      environmentValue,
    }).enabled;
  } catch {
    return false;
  }
}

function parseIssuerOrigin(value: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new Error('agent_downscope_issuer_unavailable');
  }
  const loopback =
    issuer.hostname === 'localhost' ||
    issuer.hostname === '127.0.0.1' ||
    issuer.hostname === '[::1]';
  if (
    issuer.origin !== value ||
    (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && loopback)) ||
    issuer.username ||
    issuer.password
  ) {
    throw new Error('agent_downscope_issuer_unavailable');
  }
  return issuer.origin;
}

async function defaultVerifySubjectToken(
  env: Env,
  tenantId: string,
  issuerOrigin: string,
  token: string
): Promise<unknown> {
  const header = parseTokenHeader(token);
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) {
    throw new Error('invalid_agent_subject_token');
  }
  const key = await getPublicKeyByKid(env, tenantId, header.kid);
  if (!key) throw new Error('agent_subject_verification_key_unavailable');
  const base = parseIssuerOrigin(issuerOrigin);
  return verifyToken(token, key, `${base}/oauth/admin-agent`, {
    audience: `${base}/mcp`,
  });
}

async function defaultSignToken(
  env: Env,
  tenantId: string,
  claims: Record<string, unknown>
): Promise<AgentDownscopeExchangeResult> {
  if (!env.KEY_MANAGER) throw new Error('agent_downscope_signing_key_unavailable');
  const stub = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
  const keyData =
    (await stub.getActiveKeyWithPrivateRpc()) ?? (await stub.rotateKeysWithPrivateRpc());
  const key = await importPKCS8(keyData.privatePEM, 'RS256');
  const issued = await createAccessToken(
    claims as Parameters<typeof createAccessToken>[0],
    key,
    keyData.kid,
    DOWNSCOPE_TTL_SECONDS,
    generateSecureRandomString(96)
  );
  return {
    accessToken: issued.token,
    expiresAt: Date.now() + DOWNSCOPE_TTL_SECONDS * 1000,
  };
}

function validateRequest(input: AgentDownscopeExchangeRequest): void {
  if (
    input.audience !== 'authrim:admin-api' ||
    !isValidTenantIdentifier(input.tenantId) ||
    !input.issuerOrigin ||
    !input.subjectToken ||
    !input.grantId ||
    !input.delegatorId ||
    !input.actorSub ||
    !input.clientId ||
    !input.correlationId ||
    !Number.isSafeInteger(input.grantGeneration) ||
    input.grantGeneration < 1 ||
    !Number.isSafeInteger(input.consentVersion) ||
    input.consentVersion < 1 ||
    input.permissions.length === 0 ||
    input.permissions.length > MAX_PERMISSIONS ||
    new Set(input.permissions).size !== input.permissions.length ||
    input.permissions.some((permission) => !SAFE_PERMISSION.test(permission))
  ) {
    throw new Error('invalid_agent_downscope_request');
  }
}

export async function exchangeAgentAccessToken(
  env: Env,
  input: AgentDownscopeExchangeRequest,
  overrides: Partial<AgentDownscopeEntrypointDependencies> = {}
): Promise<AgentDownscopeExchangeResult> {
  validateRequest(input);
  const dependencies: AgentDownscopeEntrypointDependencies = {
    now: overrides.now ?? (() => Date.now()),
    isFeatureEnabled: overrides.isFeatureEnabled ?? defaultFeatureEnabled,
    verifySubjectToken: overrides.verifySubjectToken ?? defaultVerifySubjectToken,
    createRepository:
      overrides.createRepository ??
      ((runtimeEnv) =>
        new AdminAgentAccessRepository(
          requireDedicatedAdminDatabaseAdapter(runtimeEnv, 'agent-downscope-exchange')
        )),
    getModeBPermissionLimit: overrides.getModeBPermissionLimit ?? defaultModeBPermissionLimit,
    signToken: overrides.signToken ?? defaultSignToken,
  };
  if (!(await dependencies.isFeatureEnabled(env, input.tenantId))) {
    throw new Error('agent_mcp_disabled');
  }
  const source = parseAgentAccessTokenClaims(
    await dependencies.verifySubjectToken(
      env,
      input.tenantId,
      parseIssuerOrigin(input.issuerOrigin),
      input.subjectToken
    )
  );
  if (
    !source ||
    source.tenant_id !== input.tenantId ||
    source.grant_id !== input.grantId ||
    source.grant_generation !== input.grantGeneration ||
    source.consent_version !== input.consentVersion ||
    source.client_id !== input.clientId ||
    source.sub !== `admin_user:${input.delegatorId}` ||
    source.act.sub !== input.actorSub ||
    source.actor_mode !== input.actorMode ||
    source.actor_assurance !== input.actorAssurance ||
    (source.actor_mode === 'mode_b' &&
      (source.act_principal_id !== input.machinePrincipalId ||
        source.act_credential_id !== input.machineCredentialId))
  ) {
    throw new Error('invalid_agent_subject_token_binding');
  }

  const repository = dependencies.createRepository(env);
  const now = dependencies.now();
  const [grant, currentPermissions, currentConsent] = await Promise.all([
    repository.getGrant(input.tenantId, input.grantId),
    repository.getActiveDelegatorPermissions(input.tenantId, input.delegatorId, now),
    repository.hasCurrentConsent(
      input.tenantId,
      input.grantId,
      input.delegatorId,
      input.clientId,
      input.consentVersion
    ),
  ]);
  const principalPermissionLimit = grant?.machinePrincipalId
    ? await dependencies.getModeBPermissionLimit(
        env,
        input.tenantId,
        grant.machinePrincipalId,
        source.actor_mode === 'mode_b' ? source.act_credential_id : undefined
      )
    : undefined;
  if (
    !grant ||
    grant.status !== 'active' ||
    !hasCompleteAgentConfigurationSnapshot(grant) ||
    grant.clientId !== input.clientId ||
    grant.delegatorId !== input.delegatorId ||
    grant.generation !== input.grantGeneration ||
    grant.consentVersion !== input.consentVersion ||
    grant.expiresAt === undefined ||
    grant.expiresAt <= now ||
    !currentPermissions ||
    !currentConsent ||
    (source.actor_mode === 'mode_b' && grant.machinePrincipalId !== source.act_principal_id) ||
    (grant.machinePrincipalId !== undefined && !principalPermissionLimit) ||
    input.permissions.some(
      (permission) =>
        !hasAdminPermission(grant.permissions, permission) ||
        !hasAdminPermission(currentPermissions, permission) ||
        (principalPermissionLimit != null &&
          !hasAdminPermission(principalPermissionLimit, permission))
    )
  ) {
    throw new Error('agent_downscope_authorization_changed');
  }

  const base = parseIssuerOrigin(input.issuerOrigin);
  return dependencies.signToken(env, input.tenantId, {
    iss: `${base}/oauth/admin-agent`,
    sub: source.sub,
    aud: input.audience,
    scope: input.permissions.join(' '),
    permissions: [...input.permissions],
    client_id: input.clientId,
    tenant_id: input.tenantId,
    grant_id: input.grantId,
    grant_generation: input.grantGeneration,
    consent_version: input.consentVersion,
    actor_type: 'agent',
    actor_mode: source.actor_mode,
    actor_assurance: source.actor_assurance,
    act: source.act,
    ...(source.actor_mode === 'mode_b'
      ? {
          act_principal_id: source.act_principal_id,
          act_credential_id: source.act_credential_id,
        }
      : {}),
    source_token_jti: source.jti,
    correlation_id: input.correlationId,
  });
}

function bulkStagePermissions(input: {
  stage: 'validate' | 'apply' | 'verify';
  definition: NonNullable<Awaited<ReturnType<AgentBulkRepository['get']>>>['definition'];
}): string[] {
  if (!input.definition) throw new Error('agent_bulk_definition_unavailable');
  const permissions = new Set<string>([ADMIN_PERMISSIONS.BULK_PLANS_APPLY]);
  for (const step of input.definition.plan.steps) {
    const tool = bulkToolCatalog.list().find((candidate) => candidate.id === step.operation);
    if (!tool || tool.contractVersion !== step.toolContractVersion || tool.riskLevel === 'high') {
      throw new Error('agent_bulk_operation_unavailable');
    }
    if (input.stage === 'apply') {
      tool.requiredPermissions.forEach((permission) => permissions.add(permission));
      continue;
    }
    if (step.operation === 'admin.write.clients.metadata') {
      permissions.add(ADMIN_PERMISSIONS.CLIENTS_READ);
      continue;
    }
    if (step.operation === 'admin.write.login-ui.update') {
      permissions.add(ADMIN_PERMISSIONS.SETTINGS_READ);
      continue;
    }
    if (tool.riskLevel !== 'low') throw new Error('agent_bulk_validation_unavailable');
    tool.requiredPermissions.forEach((permission) => permissions.add(permission));
  }
  return [...permissions].sort();
}

function validateBulkChildRequest(input: AgentBulkChildTokenRequest): void {
  if (
    input.audience !== 'authrim:admin-api' ||
    !isValidTenantIdentifier(input.controlTenantId) ||
    !isValidTenantIdentifier(input.targetTenantId) ||
    !input.issuerOrigin ||
    !input.bulkPlanId ||
    !input.executionId ||
    !input.planDigest ||
    !input.approvalDigest ||
    !input.childCapabilityDigest ||
    !input.correlationId ||
    !Number.isSafeInteger(input.bulkPlanVersion) ||
    input.bulkPlanVersion < 1 ||
    !Number.isSafeInteger(input.executionAttempt) ||
    input.executionAttempt < 1 ||
    !Number.isSafeInteger(input.executionFence) ||
    input.executionFence < 1 ||
    (input.stage !== 'validate' && input.stage !== 'apply' && input.stage !== 'verify')
  ) {
    throw new Error('invalid_agent_bulk_child_request');
  }
}

export async function issueAgentBulkChildToken(
  env: Env,
  input: AgentBulkChildTokenRequest,
  overrides: Partial<AgentDownscopeEntrypointDependencies> = {}
): Promise<AgentDownscopeExchangeResult> {
  validateBulkChildRequest(input);
  const now = overrides.now?.() ?? Date.now();
  const feature = overrides.isFeatureEnabled ?? defaultFeatureEnabled;
  if (!(await feature(env, input.controlTenantId)) || !(await feature(env, input.targetTenantId))) {
    throw new Error('agent_mcp_disabled');
  }
  const database =
    overrides.createBulkRepository && overrides.createRepository
      ? undefined
      : requireDedicatedAdminDatabaseAdapter(env, 'agent-bulk-child-token');
  const bulkRepository =
    overrides.createBulkRepository?.(env) ?? new AgentBulkRepository(database!);
  const accessRepository =
    overrides.createRepository?.(env) ?? new AdminAgentAccessRepository(database!);
  const [plan, execution] = await Promise.all([
    bulkRepository.get(input.controlTenantId, input.bulkPlanId, input.bulkPlanVersion),
    bulkRepository.getTenantExecution(
      input.controlTenantId,
      input.bulkPlanId,
      input.bulkPlanVersion,
      input.executionId
    ),
  ]);
  if (
    !plan ||
    plan.status !== 'running' ||
    plan.cancelledAt !== undefined ||
    plan.definitionDigest !== input.planDigest ||
    plan.approvalDigest !== input.approvalDigest ||
    plan.actorMode !== 'mode_b' ||
    plan.actorAssurance !== 'machine_key' ||
    plan.tokenBinding !== 'dpop' ||
    !plan.delegatorId ||
    !plan.machinePrincipalId ||
    !plan.machineCredentialId ||
    plan.actorSub !== `machine:${plan.machinePrincipalId}` ||
    !execution ||
    execution.targetTenantId !== input.targetTenantId ||
    execution.status !== 'running' ||
    execution.stage !== input.stage ||
    execution.executionAttempt !== input.executionAttempt ||
    execution.executionFence !== input.executionFence ||
    execution.planDigest !== input.planDigest ||
    execution.childCapabilityDigest !== input.childCapabilityDigest ||
    !execution.childCapabilityExpiresAt ||
    execution.childCapabilityExpiresAt <= now
  ) {
    throw new Error('agent_bulk_child_binding_changed');
  }
  const expectedDigest = await computeAgentBulkChildCapabilityDigest({
    purpose: 'authrim-agent-bulk-child-v1',
    controlTenantId: input.controlTenantId,
    targetTenantId: input.targetTenantId,
    bulkPlanId: input.bulkPlanId,
    bulkPlanVersion: input.bulkPlanVersion,
    executionId: input.executionId,
    executionAttempt: input.executionAttempt,
    executionFence: input.executionFence,
    stage: input.stage,
    planDigest: input.planDigest,
    approvalDigest: input.approvalDigest,
    ...(execution.preconditionSnapshotDigest
      ? { preconditionSnapshotDigest: execution.preconditionSnapshotDigest }
      : {}),
    expiresAt: execution.childCapabilityExpiresAt,
  });
  if (expectedDigest !== input.childCapabilityDigest) {
    throw new Error('agent_bulk_child_capability_invalid');
  }
  const permissions = bulkStagePermissions({ stage: input.stage, definition: plan.definition });
  const grant = await accessRepository.getGrant(input.controlTenantId, plan.grantId);
  if (
    !grant ||
    grant.status !== 'active' ||
    !hasCompleteAgentConfigurationSnapshot(grant) ||
    grant.clientId !== plan.clientId ||
    grant.delegatorId !== plan.delegatorId ||
    grant.machinePrincipalId !== plan.machinePrincipalId ||
    grant.generation !== plan.grantGeneration ||
    grant.consentVersion !== plan.consentVersion ||
    !grant.resolvedScopeConstraints.tenantIds.includes(input.targetTenantId) ||
    plan.definition?.plan.steps.some((step) => {
      const currentTool = bulkToolCatalog
        .list()
        .find((candidate) => candidate.id === step.operation);
      return (
        !currentTool ||
        currentTool.riskLevel === 'high' ||
        currentTool.contractVersion !== step.toolContractVersion ||
        !grant.scopes.includes(currentTool.requiredScope) ||
        !agentResourceConstraintsAllow(
          grant.resolvedScopeConstraints,
          buildAgentToolResourceContext({
            base: { tenantId: input.targetTenantId },
            tenantId: input.targetTenantId,
            toolId: currentTool.id,
            arguments: step.input,
          })
        ) ||
        !agentGrantPinsToolContract(grant, currentTool)
      );
    }) ||
    grant.expiresAt === undefined ||
    grant.expiresAt <= now
  ) {
    throw new Error('agent_bulk_child_authorization_changed');
  }
  const [delegatorPermissions, consent, machinePermissions] = await Promise.all([
    accessRepository.getActiveDelegatorPermissions(input.targetTenantId, plan.delegatorId, now),
    accessRepository.hasCurrentConsent(
      input.controlTenantId,
      plan.grantId,
      plan.delegatorId,
      plan.clientId,
      grant.consentVersion
    ),
    (overrides.getModeBPermissionLimit ?? defaultModeBPermissionLimit)(
      env,
      input.targetTenantId,
      plan.machinePrincipalId,
      plan.machineCredentialId
    ),
  ]);
  if (
    !delegatorPermissions ||
    !consent ||
    !machinePermissions ||
    permissions.some(
      (permission) =>
        !hasAdminPermission(grant.permissions, permission) ||
        !hasAdminPermission(delegatorPermissions, permission) ||
        !hasAdminPermission(machinePermissions, permission)
    )
  ) {
    throw new Error('agent_bulk_child_authorization_changed');
  }
  const base = parseIssuerOrigin(input.issuerOrigin);
  const signer = overrides.signToken ?? defaultSignToken;
  return signer(env, input.targetTenantId, {
    iss: `${base}/oauth/admin-agent`,
    sub: `admin_user:${plan.delegatorId}`,
    aud: input.audience,
    scope: permissions.join(' '),
    permissions,
    client_id: plan.clientId,
    tenant_id: input.targetTenantId,
    grant_id: plan.grantId,
    grant_generation: grant.generation,
    consent_version: grant.consentVersion,
    actor_type: 'agent',
    actor_mode: 'mode_b',
    actor_assurance: 'machine_key',
    act: { sub: plan.actorSub },
    act_principal_id: plan.machinePrincipalId,
    act_credential_id: plan.machineCredentialId,
    source_token_jti: `bulk:${input.executionId}:${input.executionAttempt}:${input.executionFence}`,
    correlation_id: input.correlationId,
    bulk: {
      control_tenant_id: input.controlTenantId,
      target_tenant_id: input.targetTenantId,
      plan_id: input.bulkPlanId,
      plan_version: input.bulkPlanVersion,
      execution_id: input.executionId,
      execution_attempt: input.executionAttempt,
      execution_fence: input.executionFence,
      stage: input.stage,
      plan_digest: input.planDigest,
      approval_digest: input.approvalDigest,
      child_capability_digest: input.childCapabilityDigest,
    },
  });
}

/** RPC-only facade; it is not mounted on the public Token Worker HTTP router. */
export class AgentDownscopeEntrypoint extends WorkerEntrypoint<Env> {
  exchangeAgentAccessToken(
    input: AgentDownscopeExchangeRequest
  ): Promise<AgentDownscopeExchangeResult> {
    return exchangeAgentAccessToken(this.env, input);
  }

  issueAgentBulkChildToken(
    input: AgentBulkChildTokenRequest
  ): Promise<AgentDownscopeExchangeResult> {
    return issueAgentBulkChildToken(this.env, input);
  }
}
