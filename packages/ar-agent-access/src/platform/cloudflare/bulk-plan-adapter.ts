import {
  ADMIN_PERMISSIONS,
  AdminMachineAccessRepository,
  hasAdminPermission,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  AdminAgentAccessRepository,
  AgentBulkRepository,
  agentGrantPinsToolContract,
  agentResourceConstraintsAllow,
  buildAgentToolResourceContext,
  resolveAgentBulkPlan,
  resolveAgentConfigurationPlan,
  hasCompleteAgentConfigurationSnapshot,
  type AdminAgentAuditWrite,
  type AgentBulkPlanDefinition,
  type AgentGrantContract,
  type AgentToolCatalog,
  type JsonObject,
} from '../../core';
import type {
  AgentBulkPlanPort,
  AgentConfigurationOperationRequest,
  AgentConfigurationOperationResult,
  AgentJsonSchemaValidatorPort,
  AgentSettingsPort,
} from '../ports';

const REQUIRED_BULK_PERMISSIONS = [
  ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
  ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
  ADMIN_PERMISSIONS.CLIENTS_READ,
] as const;

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

function audit(
  request: AgentConfigurationOperationRequest,
  action: string,
  resourceId: string,
  now: number,
  metadata: JsonObject
): AdminAgentAuditWrite {
  return {
    id: `audit_${crypto.randomUUID()}`,
    tenantId: request.grant.tenantId,
    adminUserId: request.grant.delegatorId,
    action,
    resourceType: 'agent_bulk_plan',
    resourceId,
    severity: 'info',
    actorType: 'agent',
    actorSub: request.actor.sub,
    actorMode: request.actor.mode,
    actorAssurance: request.actor.assurance,
    tokenBinding: request.actor.tokenBinding,
    actClientId: request.actor.clientId,
    actPrincipalId: request.actor.machinePrincipalId,
    grantId: request.grant.grantId,
    requestId: request.correlationId,
    metadata,
    createdAt: now,
  };
}

function result(status: number, body: JsonObject): AgentConfigurationOperationResult {
  return { status, body, executionStatus: 'definite' };
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

/** Cloudflare control-plane adapter for draft/status/validation Bulk MCP tools. */
export class CloudflareAgentBulkPlanAdapter implements AgentBulkPlanPort {
  private readonly bulk: AgentBulkRepository;
  private readonly grants: AdminAgentAccessRepository;
  private readonly machines: AdminMachineAccessRepository;

  constructor(
    private readonly database: DatabaseAdapter,
    private readonly catalog: AgentToolCatalog,
    private readonly settings: AgentSettingsPort,
    private readonly schemaValidator: AgentJsonSchemaValidatorPort,
    private readonly now: () => number = () => Date.now(),
    private readonly tenantDirectoryDatabase: DatabaseAdapter = database
  ) {
    this.bulk = new AgentBulkRepository(database);
    this.grants = new AdminAgentAccessRepository(database);
    this.machines = new AdminMachineAccessRepository(database);
  }

  async execute(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    switch (request.operation) {
      case 'admin.write.bulk.plan.create':
        return this.create(request);
      case 'admin.read.bulk.plan.get':
        return this.get(request);
      case 'admin.write.bulk.plan.validate':
        return this.validate(request);
      default:
        return result(400, { error: 'AGENT_BULK_OPERATION_UNSUPPORTED' });
    }
  }

  private async create(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const definition = request.input.definition as unknown as AgentBulkPlanDefinition | undefined;
    if (!definition) return result(400, { error: 'AGENT_BULK_PLAN_INVALID' });
    let resolved;
    try {
      resolved = await resolveAgentBulkPlan(definition);
      await resolveAgentConfigurationPlan({
        definition: resolved.definition.plan,
        catalog: this.catalog,
        maxOperations: request.grant.resolvedScopeConstraints.maxPerPlan ?? 100,
        schemaValidator: this.schemaValidator,
      });
    } catch {
      return result(400, { error: 'AGENT_BULK_PLAN_INVALID' });
    }
    const denied = await this.validateAuthority(request, request.grant, resolved.definition);
    if (denied) return denied;
    const id = `abp_${crypto.randomUUID()}`;
    const now = this.now();
    const expiresAt = now + 24 * 60 * 60_000;
    await this.bulk.create({
      id,
      version: 1,
      controlTenantId: request.grant.tenantId,
      grantId: request.grant.grantId,
      actorSub: request.actor.sub,
      clientId: request.actor.clientId,
      delegatorId: request.grant.delegatorId,
      actorMode: request.actor.mode,
      actorAssurance: request.actor.assurance,
      tokenBinding: request.actor.tokenBinding,
      machinePrincipalId: request.actor.machinePrincipalId,
      machineCredentialId: request.actor.machineCredentialId,
      grantGeneration: request.grant.generation,
      consentVersion: request.grant.consentVersion,
      resolved,
      expiresAt,
      payloadPurgeAt: expiresAt + 30 * 24 * 60 * 60_000,
      now,
      audit: audit(request, 'agent.bulk_plan.created', id, now, {
        version: 1,
        plan_digest: resolved.digest,
        target_snapshot_digest: resolved.targetSnapshotDigest,
        canary_digest: resolved.canaryDigest,
      }),
    });
    return result(201, { bulk_plan_id: id, version: 1, digest: resolved.digest, status: 'draft' });
  }

  private async get(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const id = request.input.bulk_plan_id;
    const version = integer(request.input.version);
    if (typeof id !== 'string' || !version) {
      return result(400, { error: 'AGENT_BULK_PLAN_INVALID' });
    }
    const plan = await this.bulk.get(request.grant.tenantId, id, version);
    if (
      !plan ||
      plan.grantId !== request.grant.grantId ||
      plan.actorSub !== request.actor.sub ||
      plan.clientId !== request.actor.clientId
    ) {
      return result(404, { error: 'AGENT_BULK_PLAN_NOT_FOUND' });
    }
    const executions = await this.bulk.listTenantExecutions(request.grant.tenantId, id, version);
    return result(200, {
      bulk_plan: plan as unknown as JsonObject,
      tenant_executions: executions as unknown as JsonObject['tenant_executions'],
    });
  }

  private async validate(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const id = request.input.bulk_plan_id;
    const version = integer(request.input.version);
    if (typeof id !== 'string' || !version) {
      return result(400, { error: 'AGENT_BULK_PLAN_INVALID' });
    }
    const plan = await this.bulk.get(request.grant.tenantId, id, version);
    if (
      !plan?.definition ||
      plan.status !== 'draft' ||
      plan.grantId !== request.grant.grantId ||
      plan.actorSub !== request.actor.sub ||
      plan.clientId !== request.actor.clientId
    ) {
      return result(404, { error: 'AGENT_BULK_PLAN_NOT_FOUND' });
    }
    const denied = await this.validateAuthority(request, request.grant, plan.definition);
    if (denied) return denied;
    const now = this.now();
    const changed = await this.bulk.transition({
      controlTenantId: request.grant.tenantId,
      id,
      version,
      from: 'draft',
      to: 'ready',
      stage: 'validate',
      now,
      audit: audit(request, 'agent.bulk_plan.validated', id, now, {
        version,
        plan_digest: plan.definitionDigest,
        target_snapshot_digest: plan.targetSnapshotDigest,
      }),
    });
    return changed
      ? result(200, { bulk_plan_id: id, version, status: 'ready' })
      : result(409, { error: 'AGENT_BULK_PLAN_STATE_CONFLICT' });
  }

  private async validateAuthority(
    request: AgentConfigurationOperationRequest,
    tokenGrant: AgentGrantContract,
    definition: AgentBulkPlanDefinition
  ): Promise<AgentConfigurationOperationResult | null> {
    if (
      request.actor.mode !== 'mode_b' ||
      request.actor.assurance !== 'machine_key' ||
      request.actor.tokenBinding !== 'dpop' ||
      !request.actor.machinePrincipalId ||
      !request.actor.machineCredentialId ||
      request.actor.machinePrincipalId !== tokenGrant.machinePrincipalId
    ) {
      return result(403, { error: 'AGENT_BULK_PLAN_MODE_B_REQUIRED' });
    }
    const grant = await this.grants.getGrant(tokenGrant.tenantId, tokenGrant.grantId);
    if (
      !grant ||
      grant.status !== 'active' ||
      !hasCompleteAgentConfigurationSnapshot(grant) ||
      grant.generation !== tokenGrant.generation ||
      grant.consentVersion !== tokenGrant.consentVersion ||
      grant.delegatorId !== tokenGrant.delegatorId ||
      grant.clientId !== request.actor.clientId
    ) {
      return result(403, { error: 'AGENT_BULK_PLAN_GRANT_INVALID' });
    }
    const targets = definition.targetTenantIds;
    if (
      targets.some((tenantId) => !grant.resolvedScopeConstraints.tenantIds.includes(tenantId)) ||
      (grant.resolvedScopeConstraints.maxPerBulkPlan !== undefined &&
        targets.length > grant.resolvedScopeConstraints.maxPerBulkPlan)
    ) {
      return result(403, { error: 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED' });
    }
    const rows = await this.tenantDirectoryDatabase.query<{ id: string; lifecycle_state: string }>(
      `SELECT id, lifecycle_state FROM tenants WHERE id IN (${targets.map(() => '?').join(', ')})`,
      [...targets]
    );
    const active = new Set(
      rows.filter((row) => row.lifecycle_state === 'active').map((row) => row.id)
    );
    if (targets.some((tenantId) => !active.has(tenantId))) {
      return result(409, { error: 'AGENT_BULK_PLAN_TARGET_INVALID' });
    }
    let targetSettings;
    try {
      targetSettings = await Promise.all(targets.map((tenantId) => this.settings.get(tenantId)));
    } catch {
      return result(503, { error: 'AGENT_BULK_PLAN_TARGET_POLICY_UNAVAILABLE' });
    }
    if (targetSettings.some((setting) => !setting.enabled)) {
      return result(409, { error: 'AGENT_BULK_PLAN_TARGET_AGENT_ACCESS_DISABLED' });
    }
    if (
      definition.canaryTenantIds.some(
        (tenantId) => targetSettings[targets.indexOf(tenantId)]?.bulkCanaryProtected === true
      )
    ) {
      return result(409, { error: 'AGENT_BULK_PLAN_CANARY_PROTECTED' });
    }

    const [
      principal,
      credential,
      principalScopes,
      credentialScopes,
      principalPermissions,
      credentialPermissions,
    ] = await Promise.all([
      this.machines.findPrincipalById(request.actor.machinePrincipalId),
      this.machines.findCredentialById(request.actor.machineCredentialId),
      this.machines.getPrincipalTenantScopes(request.actor.machinePrincipalId),
      this.machines.getCredentialTenantScopes(request.actor.machineCredentialId),
      this.machines.getPrincipalPermissions(request.actor.machinePrincipalId),
      this.machines.getCredentialPermissions(request.actor.machineCredentialId),
    ]);
    if (
      !principal ||
      principal.status !== 'active' ||
      !credential ||
      credential.principalId !== principal.id ||
      (credential.status !== 'active' && credential.status !== 'rotating') ||
      principalScopes.length === 0 ||
      principalScopes.some((scope) => scope.scopeMode !== 'allow') ||
      targets.some((tenantId) => !principalScopes.some((scope) => scope.tenantId === tenantId)) ||
      credentialScopes.some((scope) => scope.scopeMode !== 'allow') ||
      (credentialScopes.length > 0 &&
        targets.some((tenantId) => !credentialScopes.some((scope) => scope.tenantId === tenantId)))
    ) {
      return result(403, { error: 'AGENT_BULK_PLAN_MACHINE_SCOPE_REQUIRED' });
    }
    const machinePermissions =
      credentialPermissions.length === 0
        ? principalPermissions
        : principalPermissions.filter((permission) =>
            hasAdminPermission(credentialPermissions, permission)
          );
    const delegatorPermissions = await Promise.all(
      targets.map((tenantId) =>
        this.grants.getActiveDelegatorPermissions(tenantId, grant.delegatorId, this.now())
      )
    );
    const tools = definition.plan.steps.map((step) =>
      this.catalog.list().find((candidate) => candidate.id === step.operation)
    );
    const requiredPermissions = [
      ...REQUIRED_BULK_PERMISSIONS,
      ...validationReadPermissions(definition),
      ...tools.flatMap((tool) => tool?.requiredPermissions ?? []),
    ];
    if (
      tools.some(
        (tool, index) =>
          !tool ||
          tool.contractVersion !== definition.plan.steps[index]!.toolContractVersion ||
          !agentGrantPinsToolContract(grant, tool)
      ) ||
      requiredPermissions.some(
        (permission) =>
          !hasAdminPermission(grant.permissions, permission) ||
          !hasAdminPermission(machinePermissions, permission) ||
          delegatorPermissions.some(
            (permissions) => !permissions || !hasAdminPermission(permissions, permission)
          )
      )
    ) {
      return result(403, { error: 'AGENT_BULK_PLAN_BASE_PERMISSION_REQUIRED' });
    }
    for (const [index, step] of definition.plan.steps.entries()) {
      const tool = tools[index]!;
      if (
        tool.riskLevel === 'high' ||
        !grant.scopes.includes(tool.requiredScope) ||
        targets.some(
          (tenantId) =>
            !agentResourceConstraintsAllow(
              grant.resolvedScopeConstraints,
              buildAgentToolResourceContext({
                base: { tenantId },
                tenantId,
                toolId: tool.id,
                arguments: step.input,
              })
            )
        )
      ) {
        return result(403, { error: 'AGENT_BULK_PLAN_RESOURCE_SCOPE_REQUIRED' });
      }
    }
    return null;
  }
}
