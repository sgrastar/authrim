import { ADMIN_PERMISSIONS, hasAdminPermission } from '@authrim/ar-lib-core';
import {
  AgentConfigurationRepository,
  buildAgentToolResourceContext,
  canonicalizeJson,
  createAgentToolCatalog,
  listAgentTaskSetsWithBuiltins,
  resolveAgentConfigurationPlan,
  sha256Base64Url,
  toolSnapshot,
  type AdminAgentAuditWrite,
  type AgentConfigurationPlanRecord,
  type AgentToolCatalog,
  type AgentToolDefinition,
  type JsonObject,
  type JsonValue,
} from '../../core';
import type {
  AgentClockPort,
  AgentAuthorizationPort,
  AgentConfigurationOperationRequest,
  AgentConfigurationOperationResult,
  AgentConfigurationPlanPort,
  AgentJsonSchemaValidatorPort,
  ManagementApiPort,
} from '../ports';

const PLAN_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

function audit(
  request: AgentConfigurationOperationRequest,
  action: string,
  resourceId: string,
  now: number,
  metadata: JsonObject = {}
): AdminAgentAuditWrite {
  return {
    id: `audit_${crypto.randomUUID()}`,
    tenantId: request.grant.tenantId,
    adminUserId: request.grant.delegatorId,
    action,
    resourceType: 'agent_configuration_plan',
    resourceId,
    severity: 'info',
    actorType: 'agent',
    actorSub: request.actor.sub,
    actorMode: request.actor.mode,
    actorAssurance: request.actor.assurance,
    tokenBinding: request.actor.tokenBinding,
    actClientId: request.actor.clientId,
    actPrincipalId: request.actor.machinePrincipalId ?? request.grant.machinePrincipalId,
    grantId: request.grant.grantId,
    mcpTool: request.operation,
    requestId: request.correlationId,
    metadata,
    createdAt: now,
  };
}

function object(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const LOGIN_UI_SETTING_FIELDS = Object.freeze({
  brandName: 'login-ui.brand_name',
  logoUrl: 'login-ui.logo_url',
  supportedLocales: 'login-ui.supported_locales',
} as const);

function expectedLoginUiSetting(value: JsonValue): JsonValue {
  return Array.isArray(value) ? value.join(',') : value;
}

function stepMatchesTarget(operation: string, input: JsonObject, target: JsonObject): boolean {
  if (operation === 'admin.write.clients.metadata') {
    const current = object(target.client);
    return (
      current !== null &&
      Object.entries(input)
        .filter(([key]) => key !== 'client_id' && key !== 'resource_version')
        .every(([key, value]) => canonicalizeJson(current[key] ?? null) === canonicalizeJson(value))
    );
  }
  if (operation === 'admin.write.login-ui.update') {
    const values = object(target.values);
    return (
      values !== null &&
      Object.entries(input)
        .filter(([key]) => key !== 'resource_version')
        .every(([key, value]) => {
          const settingKey = LOGIN_UI_SETTING_FIELDS[key as keyof typeof LOGIN_UI_SETTING_FIELDS];
          return (
            settingKey !== undefined &&
            canonicalizeJson(values[settingKey] ?? null) ===
              canonicalizeJson(expectedLoginUiSetting(value))
          );
        })
    );
  }
  return false;
}

function ref(input: JsonObject): { id: string; version: number } | null {
  const id = input.plan_id;
  const version = input.version;
  return typeof id === 'string' &&
    PLAN_ID.test(id) &&
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version >= 1
    ? { id, version }
    : null;
}

function response(status: number, body: JsonValue): AgentConfigurationOperationResult {
  return { status, body, executionStatus: 'definite' };
}

function publicPlan(plan: AgentConfigurationPlanRecord): JsonObject {
  return {
    id: plan.id,
    version: plan.version,
    digest: plan.definitionDigest,
    status: plan.status,
    stage: plan.stage,
    definition: (plan.definition as unknown as JsonObject | undefined) ?? null,
    snapshot: plan.snapshot ?? null,
    diff: plan.diff ?? null,
    validation: plan.validation ?? null,
    result: plan.result ?? null,
    applied_step_count: plan.appliedStepCount,
    failed_step_id: plan.failedStepId ?? null,
    failure_kind: plan.failureKind ?? null,
    expires_at: plan.expiresAt,
    cancelled_at: plan.cancelledAt ?? null,
    cancelled_by: plan.cancelledBy ?? null,
    cancel_reason: plan.cancelReason ?? null,
    payload_purged_at: plan.payloadPurgedAt ?? null,
  };
}

/**
 * Cloudflare composition for Plan persistence and fixed Management Service Binding calls.
 * The protocol server only sees AgentConfigurationPlanPort and remains platform-neutral.
 */
export class CloudflareAgentConfigurationPlanAdapter implements AgentConfigurationPlanPort {
  private readonly stepCatalog: AgentToolCatalog;

  constructor(
    private readonly repository: AgentConfigurationRepository,
    private readonly catalog: AgentToolCatalog,
    private readonly managementApi: ManagementApiPort,
    private readonly clock: AgentClockPort,
    private readonly authorization: AgentAuthorizationPort,
    private readonly schemaValidator: AgentJsonSchemaValidatorPort,
    private readonly confirmationBasePath = '/admin/agent-access/plans'
  ) {
    this.stepCatalog = createAgentToolCatalog(
      `${catalog.version}-plan-steps`,
      catalog
        .list()
        .filter((tool) => tool.protocolMetadata?.['com.authrim/planStepAllowed'] === true)
    );
  }

  async execute(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    switch (request.operation) {
      case 'admin.read.configuration.capabilities':
        return this.capabilities(request);
      case 'admin.write.configuration.plan.create':
        return this.create(request);
      case 'admin.write.configuration.plan.validate':
        return this.validate(request);
      case 'admin.read.configuration.plan.diff':
        return this.get(request, 'diff');
      case 'admin.write.configuration.plan.apply':
        return this.apply(request);
      case 'admin.write.configuration.plan.cancel':
        return this.cancel(request);
      case 'admin.read.configuration.plan.status':
        return this.get(request, 'status');
      case 'admin.read.configuration.plan.verify':
        return this.verify(request);
      default:
        return response(404, { error: 'AGENT_CONFIGURATION_OPERATION_NOT_FOUND' });
    }
  }

  private async capabilities(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const [taskSets, scopePolicies] = await Promise.all([
      listAgentTaskSetsWithBuiltins({
        repository: this.repository,
        catalog: this.catalog,
        tenantId: request.grant.tenantId,
      }),
      this.repository.listScopePolicies(request.grant.tenantId),
    ]);
    const tools = this.stepCatalog
      .list()
      .filter((tool) =>
        tool.requiredPermissions.every((permission) =>
          hasAdminPermission(request.grant.permissions, permission)
        )
      )
      .map(toolSnapshot);
    return response(200, {
      catalog_version: this.catalog.version,
      tools,
      task_sets: taskSets.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.currentVersion,
        digest: item.version.digest,
      })),
      scope_policies: scopePolicies.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.currentVersion,
        digest: item.definitionDigest,
      })),
    });
  }

  private async create(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const definition = object(request.input.definition);
    if (!definition) return response(400, { error: 'AGENT_PLAN_INVALID_DEFINITION' });
    let resolved;
    try {
      resolved = await resolveAgentConfigurationPlan({
        definition: definition as unknown as Parameters<
          typeof resolveAgentConfigurationPlan
        >[0]['definition'],
        catalog: this.stepCatalog,
        maxOperations: request.grant.resolvedScopeConstraints.maxPerPlan ?? 25,
        schemaValidator: this.schemaValidator,
      });
    } catch {
      return response(400, { error: 'AGENT_PLAN_INVALID_DEFINITION' });
    }
    for (const step of resolved.definition.steps) {
      const tool = this.stepCatalog.list().find((candidate) => candidate.id === step.operation)!;
      if (
        tool.riskLevel === 'high' ||
        tool.requiredPermissions.some(
          (permission) => !hasAdminPermission(request.grant.permissions, permission)
        )
      ) {
        return response(403, { error: 'AGENT_PLAN_STEP_NOT_DELEGATED' });
      }
      if (
        step.operation === 'admin.write.clients.metadata' &&
        !hasAdminPermission(request.grant.permissions, ADMIN_PERMISSIONS.CLIENTS_READ)
      ) {
        return response(403, { error: 'AGENT_PLAN_VALIDATION_READ_NOT_DELEGATED' });
      }
      if (
        step.operation === 'admin.write.login-ui.update' &&
        !hasAdminPermission(request.grant.permissions, ADMIN_PERMISSIONS.SETTINGS_READ)
      ) {
        return response(403, { error: 'AGENT_PLAN_VALIDATION_READ_NOT_DELEGATED' });
      }
      const denied = await this.authorizeStep(request, tool, step.input);
      if (denied) return denied;
    }
    const now = this.clock.now();
    const id = `acp_${crypto.randomUUID()}`;
    const expiresAt = now + 24 * 60 * 60_000;
    await this.repository.createPlan({
      id,
      version: 1,
      tenantId: request.grant.tenantId,
      grantId: request.grant.grantId,
      grantGeneration: request.grant.generation,
      consentVersion: request.grant.consentVersion,
      actorSub: request.actor.sub,
      clientId: request.actor.clientId,
      definition: resolved.definition,
      definitionDigest: resolved.digest,
      risks: resolved.risks,
      expiresAt,
      payloadPurgeAt: expiresAt + 30 * 24 * 60 * 60_000,
      now,
      audit: audit(request, 'agent.configuration.plan.created', id, now, {
        plan_digest: resolved.digest,
        step_count: resolved.definition.steps.length,
      }),
    });
    return response(201, { plan_id: id, version: 1, digest: resolved.digest, status: 'draft' });
  }

  private async ownedPlan(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationPlanRecord | null> {
    const reference = ref(request.input);
    if (!reference) return null;
    const plan = await this.repository.getPlan(
      request.grant.tenantId,
      reference.id,
      reference.version
    );
    return plan &&
      plan.grantId === request.grant.grantId &&
      plan.grantGeneration === request.grant.generation &&
      plan.consentVersion === request.grant.consentVersion &&
      plan.actorSub === request.actor.sub &&
      plan.clientId === request.actor.clientId
      ? plan
      : null;
  }

  private managementRequest(
    request: AgentConfigurationOperationRequest,
    tool: AgentToolDefinition,
    input: JsonObject,
    idempotencyKey?: string
  ) {
    return {
      operation: tool.id,
      tenantId: request.grant.tenantId,
      authorization: {
        actor: request.actor,
        grantId: request.grant.grantId,
        grantGeneration: request.grant.generation,
        delegatorId: request.grant.delegatorId,
        consentVersion: request.grant.consentVersion,
        effectivePermissions: tool.requiredPermissions,
        audience: 'authrim:admin-api' as const,
        issuerOrigin: request.issuerOrigin,
        correlationId: request.correlationId,
      },
      idempotencyKey,
      input,
    };
  }

  private async authorizeStep(
    request: AgentConfigurationOperationRequest,
    tool: AgentToolDefinition,
    input: JsonObject
  ): Promise<AgentConfigurationOperationResult | null> {
    const decision = await this.authorization.authorize({
      actor: request.actor,
      grant: request.grant,
      tool,
      resource: buildAgentToolResourceContext({
        base: { tenantId: request.grant.tenantId },
        toolId: tool.id,
        arguments: input,
      }),
    });
    return decision.allowed
      ? null
      : response(403, {
          error: decision.code ?? 'AGENT_PLAN_STEP_NOT_DELEGATED',
          denied_axis: decision.deniedAxis ?? 'unknown',
        });
  }

  private async readStepTarget(
    request: AgentConfigurationOperationRequest,
    operation: string,
    input: JsonObject
  ): Promise<{ body: JsonObject; resourceVersion: string } | null> {
    if (operation === 'admin.write.login-ui.update') {
      const readTool = this.catalog.get('inspect_login_ui_settings');
      if (!readTool) return null;
      const result = await this.managementApi.execute(
        this.managementRequest(request, readTool, {})
      );
      const body = object(result.body);
      const snapshot = body ? object(body.snapshot) : null;
      return result.status === 200 && snapshot && typeof snapshot.version === 'string'
        ? { body: snapshot, resourceVersion: snapshot.version }
        : null;
    }
    if (operation !== 'admin.write.clients.metadata' || typeof input.client_id !== 'string')
      return null;
    const readTool = this.catalog.get('get_client');
    if (!readTool) return null;
    const result = await this.managementApi.execute(
      this.managementRequest(request, readTool, { client_id: input.client_id })
    );
    const body = object(result.body);
    return result.status === 200 &&
      body &&
      typeof body.resource_version === 'string' &&
      object(body.client)
      ? { body, resourceVersion: body.resource_version }
      : null;
  }

  private async validate(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const plan = await this.ownedPlan(request);
    if (!plan) return response(404, { error: 'AGENT_PLAN_NOT_FOUND' });
    if (plan.status !== 'draft' || plan.cancelledAt !== undefined || !plan.definition) {
      return response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
    }
    const snapshots: JsonValue[] = [];
    const changes: JsonValue[] = [];
    for (const step of plan.definition.steps) {
      const tool = this.stepCatalog.list().find((candidate) => candidate.id === step.operation);
      if (!tool || tool.contractVersion !== step.toolContractVersion) {
        return response(409, { error: 'AGENT_PLAN_CONTRACT_DRIFT' });
      }
      const denied = await this.authorizeStep(request, tool, step.input);
      if (denied) return denied;
      const target = await this.readStepTarget(request, step.operation, step.input);
      if (!target || target.resourceVersion !== step.resourcePrecondition) {
        return response(409, {
          error: 'AGENT_PLAN_PRECONDITION_FAILED',
          step_id: step.id,
          current_resource_version: target?.resourceVersion ?? null,
        });
      }
      snapshots.push({
        step_id: step.id,
        resource_version: target.resourceVersion,
        value: target.body,
      });
      changes.push({
        step_id: step.id,
        operation: step.operation,
        before: target.body,
        after: step.input,
      });
    }
    const now = this.clock.now();
    const validation = { valid: true, validated_at: now, catalog_version: this.catalog.version };
    const marked = await this.repository.markPlanReady({
      tenantId: plan.tenantId,
      id: plan.id,
      version: plan.version,
      definitionDigest: plan.definitionDigest,
      snapshot: { targets: snapshots },
      diff: { changes },
      validation,
      now,
      audit: audit(request, 'agent.configuration.plan.validated', plan.id, now, {
        plan_digest: plan.definitionDigest,
      }),
    });
    return marked
      ? response(200, {
          plan: {
            ...publicPlan(plan),
            status: 'ready',
            stage: 'apply',
            validation,
            diff: { changes },
          },
        })
      : response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
  }

  private async get(
    request: AgentConfigurationOperationRequest,
    kind: 'diff' | 'status'
  ): Promise<AgentConfigurationOperationResult> {
    const plan = await this.ownedPlan(request);
    if (!plan) return response(404, { error: 'AGENT_PLAN_NOT_FOUND' });
    return response(200, {
      plan:
        kind === 'diff'
          ? {
              id: plan.id,
              version: plan.version,
              digest: plan.definitionDigest,
              diff: plan.diff ?? null,
            }
          : publicPlan(plan),
    });
  }

  private async apply(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const plan = await this.ownedPlan(request);
    if (!plan) return response(404, { error: 'AGENT_PLAN_NOT_FOUND' });
    if (plan.cancelledAt !== undefined) {
      return response(409, { error: 'AGENT_PLAN_CANCELLED' });
    }
    if (plan.status !== 'ready' || plan.expiresAt <= this.clock.now() || !plan.definition) {
      return response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
    }
    const now = this.clock.now();
    let confirmationId: string | undefined;
    const machinePreauthorized =
      request.actor.mode === 'mode_b' &&
      request.actor.assurance === 'machine_key' &&
      request.grant.delegationMode === 'admin_pre_authorized';
    if (!machinePreauthorized) {
      const existing = await this.repository.getPlanConfirmation(
        plan.tenantId,
        plan.id,
        plan.version,
        plan.definitionDigest
      );
      const confirmation =
        existing ??
        (await this.repository.ensurePlanConfirmation({
          id: `apc_${crypto.randomUUID()}`,
          tenantId: plan.tenantId,
          planId: plan.id,
          planVersion: plan.version,
          planDigest: plan.definitionDigest,
          grantId: plan.grantId,
          actorSub: plan.actorSub,
          now,
          expiresAt: Math.min(plan.expiresAt, now + 10 * 60_000),
          audit: audit(request, 'agent.configuration.plan.confirmation_requested', plan.id, now, {
            plan_digest: plan.definitionDigest,
          }),
        }));
      if (confirmation.status !== 'confirmed' || confirmation.expiresAt <= now) {
        const path = `${this.confirmationBasePath}/${encodeURIComponent(plan.id)}/${plan.version}/confirm`;
        return {
          status: 403,
          body: { error: 'AGENT_PLAN_CONFIRMATION_REQUIRED' },
          urlElicitation: {
            elicitationId: confirmation.id,
            url: `${request.issuerOrigin}${path}?confirmation_id=${encodeURIComponent(confirmation.id)}`,
            message: 'Review and confirm the immutable configuration Plan before apply.',
          },
        };
      }
      confirmationId = confirmation.id;
    }
    for (const step of plan.definition.steps) {
      const tool = this.stepCatalog.list().find((candidate) => candidate.id === step.operation);
      if (!tool || tool.contractVersion !== step.toolContractVersion) {
        return response(409, { error: 'AGENT_PLAN_CONTRACT_DRIFT' });
      }
      const denied = await this.authorizeStep(request, tool, step.input);
      if (denied) return denied;
      const target = await this.readStepTarget(request, step.operation, step.input);
      if (!target || target.resourceVersion !== step.resourcePrecondition) {
        return response(409, { error: 'AGENT_PLAN_PRECONDITION_FAILED', step_id: step.id });
      }
    }
    const claimed = await this.repository.claimPlanApply({
      tenantId: plan.tenantId,
      id: plan.id,
      version: plan.version,
      definitionDigest: plan.definitionDigest,
      confirmationId,
      now,
      audit: audit(request, 'agent.configuration.plan.started', plan.id, now, {
        plan_digest: plan.definitionDigest,
      }),
    });
    if (!claimed) return response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
    let applied = 0;
    for (const step of plan.definition.steps) {
      const beforeStep = await this.repository.getPlan(plan.tenantId, plan.id, plan.version);
      if (beforeStep?.cancelledAt !== undefined) {
        return this.finishCancelled(request, plan, applied, step.id);
      }
      const tool = this.stepCatalog.list().find((candidate) => candidate.id === step.operation)!;
      const result = await this.managementApi.execute(
        this.managementRequest(
          request,
          tool,
          { ...step.input, resource_version: step.resourcePrecondition! },
          `${plan.id}:${plan.version}:${step.id}:${plan.definitionDigest}`
        )
      );
      if (result.executionStatus === 'indeterminate') {
        const failedAt = this.clock.now();
        await this.repository.writeAudit(
          audit(request, 'agent.configuration.plan.step.indeterminate', plan.id, failedAt, {
            step_id: step.id,
            operation: step.operation,
          })
        );
        const completed = await this.repository.completePlan({
          tenantId: plan.tenantId,
          id: plan.id,
          version: plan.version,
          definitionDigest: plan.definitionDigest,
          status: 'failed',
          result: { error: 'AGENT_PLAN_STEP_INDETERMINATE', step_id: step.id },
          appliedStepCount: applied,
          failedStepId: step.id,
          failureKind: 'indeterminate',
          now: failedAt,
          audit: audit(request, 'agent.configuration.plan.failed', plan.id, failedAt, {
            step_id: step.id,
            failure_kind: 'indeterminate',
          }),
        });
        if (!completed) return this.finishCancelled(request, plan, applied, step.id);
        return {
          status: 503,
          body: { error: 'AGENT_PLAN_STEP_INDETERMINATE' },
          executionStatus: 'indeterminate',
        };
      }
      if (result.status < 200 || result.status >= 300) {
        const failedAt = this.clock.now();
        await this.repository.writeAudit(
          audit(request, 'agent.configuration.plan.step.failed', plan.id, failedAt, {
            step_id: step.id,
            operation: step.operation,
            owner_status: result.status,
          })
        );
        const completed = await this.repository.completePlan({
          tenantId: plan.tenantId,
          id: plan.id,
          version: plan.version,
          definitionDigest: plan.definitionDigest,
          status: 'failed',
          result: { step_id: step.id, owner_status: result.status },
          appliedStepCount: applied,
          failedStepId: step.id,
          failureKind: 'owner_rejected',
          now: failedAt,
          audit: audit(request, 'agent.configuration.plan.failed', plan.id, failedAt, {
            step_id: step.id,
            owner_status: result.status,
          }),
        });
        if (!completed) return this.finishCancelled(request, plan, applied, step.id);
        return response(409, { error: 'AGENT_PLAN_STEP_FAILED', step_id: step.id });
      }
      applied += 1;
      const stepCompletedAt = this.clock.now();
      await this.repository.writeAudit(
        audit(request, 'agent.configuration.plan.step.executed', plan.id, stepCompletedAt, {
          step_id: step.id,
          operation: step.operation,
          owner_status: result.status,
          result_digest: await sha256Base64Url(canonicalizeJson(result.body)),
        })
      );
      const afterStep = await this.repository.getPlan(plan.tenantId, plan.id, plan.version);
      if (afterStep?.cancelledAt !== undefined) {
        return this.finishCancelled(request, plan, applied, step.id);
      }
    }
    const completedAt = this.clock.now();
    const completed = await this.repository.completePlan({
      tenantId: plan.tenantId,
      id: plan.id,
      version: plan.version,
      definitionDigest: plan.definitionDigest,
      status: 'completed',
      result: { applied_steps: applied },
      appliedStepCount: applied,
      now: completedAt,
      audit: audit(request, 'agent.configuration.plan.completed', plan.id, completedAt, {
        applied_steps: applied,
      }),
    });
    if (!completed) return this.finishCancelled(request, plan, applied);
    return response(200, {
      plan: {
        id: plan.id,
        version: plan.version,
        status: 'completed',
        applied_step_count: applied,
      },
    });
  }

  private async finishCancelled(
    request: AgentConfigurationOperationRequest,
    plan: AgentConfigurationPlanRecord,
    appliedStepCount: number,
    failedStepId?: string
  ): Promise<AgentConfigurationOperationResult> {
    const now = this.clock.now();
    const current = await this.repository.getPlan(plan.tenantId, plan.id, plan.version);
    if (current?.cancelledAt === undefined) {
      return response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
    }
    const changed = await this.repository.failCancelledRunningPlan({
      tenantId: plan.tenantId,
      id: plan.id,
      version: plan.version,
      definitionDigest: plan.definitionDigest,
      result: {
        error: 'AGENT_PLAN_CANCELLED',
        applied_step_count: appliedStepCount,
        failed_step_id: failedStepId ?? null,
      },
      appliedStepCount,
      failedStepId,
      now,
      audit: audit(request, 'agent.configuration.plan.failed', plan.id, now, {
        failure_kind: 'plan_cancelled',
        applied_step_count: appliedStepCount,
        failed_step_id: failedStepId ?? null,
      }),
    });
    if (!changed) return response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
    return response(409, {
      error: 'AGENT_PLAN_CANCELLED',
      plan_id: plan.id,
      version: plan.version,
      applied_step_count: appliedStepCount,
    });
  }

  private async cancel(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const plan = await this.ownedPlan(request);
    if (!plan) return response(404, { error: 'AGENT_PLAN_NOT_FOUND' });
    if (plan.cancelledAt !== undefined) {
      return response(200, { plan: publicPlan(plan) });
    }
    if (plan.status === 'completed' || plan.status === 'failed') {
      return response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
    }
    const now = this.clock.now();
    const cancelled = await this.repository.cancelPlan({
      tenantId: plan.tenantId,
      id: plan.id,
      version: plan.version,
      cancelledBy: request.actor.sub,
      reason: 'agent_requested',
      now,
      audit: audit(request, 'agent.configuration.plan.cancelled', plan.id, now, {
        plan_version: plan.version,
        plan_digest: plan.definitionDigest,
        prior_status: plan.status,
      }),
    });
    if (!cancelled) return response(409, { error: 'AGENT_PLAN_STATE_CONFLICT' });
    const current = await this.repository.getPlan(plan.tenantId, plan.id, plan.version);
    return response(200, { plan: current ? publicPlan(current) : publicPlan(plan) });
  }

  private async verify(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    const plan = await this.ownedPlan(request);
    if (!plan) return response(404, { error: 'AGENT_PLAN_NOT_FOUND' });
    if (plan.status !== 'completed' || !plan.definition) {
      return response(409, { error: 'AGENT_PLAN_NOT_COMPLETED' });
    }
    const checks: JsonValue[] = [];
    for (const step of plan.definition.steps) {
      const tool = this.stepCatalog.list().find((candidate) => candidate.id === step.operation);
      if (!tool || tool.contractVersion !== step.toolContractVersion) {
        return response(409, { error: 'AGENT_PLAN_CONTRACT_DRIFT' });
      }
      const denied = await this.authorizeStep(request, tool, step.input);
      if (denied) return denied;
      const target = await this.readStepTarget(request, step.operation, step.input);
      const matches = target !== null && stepMatchesTarget(step.operation, step.input, target.body);
      checks.push({ step_id: step.id, verified: matches });
    }
    const verified = checks.every((check) => object(check)?.verified === true);
    return response(verified ? 200 : 409, {
      plan: { id: plan.id, version: plan.version, verified, checks },
    });
  }
}
