import {
  AgentBulkRepository,
  canonicalizeJson,
  computeAgentBulkChildCapabilityDigest,
  decideAgentBulkWave,
  sha256Base64Url,
  type AdminAgentAuditWrite,
  type AgentBulkPlanRecord,
  type AgentBulkTenantExecutionRecord,
  type AgentConfigurationPlanStepDefinition,
  type JsonObject,
  type JsonValue,
} from '../../core';
import type { AgentBulkChildExecutorPort, AgentClockPort, AgentTenantIssuerPort } from '../ports';

const LEASE_MS = 60_000;
const CHILD_CAPABILITY_MS = 60_000;

type BulkRepositoryPort = Pick<
  AgentBulkRepository,
  | 'get'
  | 'listRunning'
  | 'listTenantExecutions'
  | 'listRunnableTenantExecutions'
  | 'getTenantExecution'
  | 'claimTenant'
  | 'advanceTenantStage'
  | 'completeTenant'
  | 'setRunningProgress'
  | 'transition'
>;

export interface AgentBulkCoordinatorResult {
  planId: string;
  version: number;
  outcome: 'advanced' | 'paused' | 'completed' | 'idle' | 'conflict';
  executionId?: string;
  stage?: 'validate' | 'apply' | 'verify';
  reason?: string;
}

interface ValidationCheckpoint extends JsonObject {
  snapshots: Array<JsonObject>;
}

function object(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function audit(
  plan: AgentBulkPlanRecord,
  action: string,
  resourceId: string,
  now: number,
  metadata: JsonObject,
  severity: 'info' | 'warn' = 'info'
): AdminAgentAuditWrite {
  return {
    id: `audit_${crypto.randomUUID()}`,
    tenantId: plan.controlTenantId,
    adminUserId: plan.delegatorId,
    action,
    resourceType: 'agent_bulk_tenant_execution',
    resourceId,
    severity,
    actorType: 'agent',
    actorSub: plan.actorSub,
    actorMode: plan.actorMode,
    actorAssurance: plan.actorAssurance,
    tokenBinding: plan.tokenBinding,
    actClientId: plan.clientId,
    actPrincipalId: plan.machinePrincipalId,
    grantId: plan.grantId,
    metadata,
    createdAt: now,
  };
}

const LOGIN_UI_SETTING_FIELDS = Object.freeze({
  brandName: 'login-ui.brand_name',
  logoUrl: 'login-ui.logo_url',
  supportedLocales: 'login-ui.supported_locales',
} as const);

function expectedSetting(value: JsonValue): JsonValue {
  return Array.isArray(value) ? value.join(',') : value;
}

function readRequest(step: AgentConfigurationPlanStepDefinition): {
  operation: string;
  input: JsonObject;
} {
  if (step.operation === 'admin.write.clients.metadata') {
    const clientId = step.input.client_id;
    if (typeof clientId !== 'string') throw new TypeError('Bulk client_id is missing');
    return { operation: 'admin.read.clients.get', input: { client_id: clientId } };
  }
  if (step.operation === 'admin.write.login-ui.update') {
    return { operation: 'admin.read.login-ui.inspect', input: {} };
  }
  throw new TypeError('Bulk step is not supported by the Cloudflare owner adapter');
}

function readVersion(body: JsonValue, step: AgentConfigurationPlanStepDefinition): string | null {
  const response = object(body);
  if (step.operation === 'admin.write.clients.metadata') {
    const value = response?.resource_version;
    return typeof value === 'string' ? value : null;
  }
  if (step.operation === 'admin.write.login-ui.update') {
    const value = object(response?.snapshot)?.version;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function checkpoint(value: JsonValue | undefined): ValidationCheckpoint | null {
  const record = object(value);
  if (!record || !Array.isArray(record.snapshots)) return null;
  return record as ValidationCheckpoint;
}

function snapshotVersion(value: ValidationCheckpoint, stepId: string): string | null {
  const item = value.snapshots.find((candidate) => object(candidate)?.step_id === stepId);
  const version = object(item)?.resource_version;
  return typeof version === 'string' ? version : null;
}

function expectedFields(step: AgentConfigurationPlanStepDefinition): JsonObject {
  return Object.fromEntries(
    Object.entries(step.input).filter(([key]) => key !== 'client_id' && key !== 'resource_version')
  ) as JsonObject;
}

function matchesExpected(body: JsonValue, step: AgentConfigurationPlanStepDefinition): boolean {
  const response = object(body);
  if (step.operation === 'admin.write.clients.metadata') {
    const client = object(response?.client as JsonValue | undefined);
    return (
      client !== null &&
      Object.entries(expectedFields(step)).every(
        ([key, value]) => canonicalizeJson(client[key] ?? null) === canonicalizeJson(value)
      )
    );
  }
  if (step.operation === 'admin.write.login-ui.update') {
    const values = object(object(response?.snapshot)?.values as JsonValue | undefined);
    return (
      values !== null &&
      Object.entries(expectedFields(step)).every(([key, value]) => {
        const settingKey = LOGIN_UI_SETTING_FIELDS[key as keyof typeof LOGIN_UI_SETTING_FIELDS];
        return (
          settingKey !== undefined &&
          canonicalizeJson(values[settingKey] ?? null) === canonicalizeJson(expectedSetting(value))
        );
      })
    );
  }
  return false;
}

/**
 * Cloudflare scheduling/composition shell for protocol-neutral Bulk Plan records.
 * The coordinator only invokes fixed operation IDs through AgentBulkChildExecutorPort.
 */
export class CloudflareAgentBulkCoordinator {
  constructor(
    private readonly repository: BulkRepositoryPort,
    private readonly executor: AgentBulkChildExecutorPort,
    private readonly clock: AgentClockPort,
    private readonly issuers: AgentTenantIssuerPort,
    private readonly ownerId = 'ar-agent-access-bulk-coordinator'
  ) {}

  async runScheduled(
    limit: number = 25,
    maxAdvancesPerPlan: number = 25
  ): Promise<AgentBulkCoordinatorResult[]> {
    const plans = await this.repository.listRunning(limit);
    const results: AgentBulkCoordinatorResult[] = [];
    for (const plan of plans) {
      let result: AgentBulkCoordinatorResult = {
        planId: plan.id,
        version: plan.version,
        outcome: 'idle',
      };
      for (let advance = 0; advance < maxAdvancesPerPlan; advance += 1) {
        result = await this.runPlan(plan.controlTenantId, plan.id, plan.version);
        if (result.outcome !== 'advanced') break;
      }
      results.push(result);
    }
    return results;
  }

  async runPlan(
    controlTenantId: string,
    planId: string,
    version: number
  ): Promise<AgentBulkCoordinatorResult> {
    const plan = await this.repository.get(controlTenantId, planId, version);
    if (
      !plan ||
      plan.status !== 'running' ||
      plan.cancelledAt !== undefined ||
      !plan.definition ||
      !plan.approvalDigest
    ) {
      return { planId, version, outcome: 'idle' };
    }
    let executions = await this.repository.listTenantExecutions(controlTenantId, planId, version);
    const stale = executions.find(
      (execution) =>
        execution.status === 'running' &&
        execution.executionLeaseExpiresAt !== undefined &&
        execution.executionLeaseExpiresAt <= this.clock.now()
    );
    if (stale) {
      await this.finish(plan, stale, 'indeterminate', 'execution_lease_expired');
      return this.pause(plan, 'indeterminate');
    }

    if (executions.some((execution) => execution.status === 'indeterminate')) {
      return this.pause(plan, 'indeterminate');
    }
    if (
      executions.some(
        (execution) => execution.stage === 'validate' && execution.status === 'failed'
      )
    ) {
      return this.pause(plan, 'validation_failed');
    }

    const validating = executions.some((execution) => execution.stage === 'validate');
    if (!validating) {
      const canaries = executions.filter((execution) => execution.isCanary);
      if (canaries.some((execution) => execution.status === 'failed')) {
        return this.pause(plan, 'canary_failed');
      }
      if (canaries.every((execution) => execution.status === 'succeeded')) {
        const waves = [
          ...new Set(executions.flatMap((execution) => execution.waveNumber ?? [])),
        ].sort((a, b) => a - b);
        for (const wave of waves) {
          const group = executions.filter((execution) => execution.waveNumber === wave);
          const groupSettled = group.every(
            (execution) => execution.status === 'succeeded' || execution.status === 'failed'
          );
          if (groupSettled) {
            const decision = decideAgentBulkWave({
              stage: 'wave',
              succeeded: group.filter((execution) => execution.status === 'succeeded').length,
              failed: group.filter((execution) => execution.status === 'failed').length,
              indeterminate: 0,
              waveFailureThresholdBasisPoints: plan.waveFailureThresholdBasisPoints,
            });
            if (decision.pause) return this.pause(plan, decision.reason!);
          }
        }
      }
    }

    const runnable = await this.repository.listRunnableTenantExecutions({
      controlTenantId,
      bulkPlanId: planId,
      bulkPlanVersion: version,
    });
    const next = runnable[0];
    if (next) return this.runExecution(plan, next);

    executions = await this.repository.listTenantExecutions(controlTenantId, planId, version);
    if (
      executions.length > 0 &&
      executions.every(
        (execution) => execution.status === 'succeeded' || execution.status === 'failed'
      )
    ) {
      const now = this.clock.now();
      const changed = await this.repository.transition({
        controlTenantId,
        id: plan.id,
        version: plan.version,
        from: 'running',
        to: 'completed',
        stage: 'verify',
        now,
        audit: audit(plan, 'agent.bulk_plan.completed', plan.id, now, {
          succeeded: executions.filter((execution) => execution.status === 'succeeded').length,
          failed: executions.filter((execution) => execution.status === 'failed').length,
        }),
      });
      return { planId, version, outcome: changed ? 'completed' : 'conflict' };
    }
    return { planId, version, outcome: 'idle' };
  }

  private async pause(
    plan: AgentBulkPlanRecord,
    reason: string
  ): Promise<AgentBulkCoordinatorResult> {
    const now = this.clock.now();
    const changed = await this.repository.transition({
      controlTenantId: plan.controlTenantId,
      id: plan.id,
      version: plan.version,
      from: 'running',
      to: 'paused',
      stage: plan.stage,
      pauseReason: reason,
      now,
      audit: audit(plan, 'agent.bulk_plan.paused', plan.id, now, { reason }, 'warn'),
    });
    return {
      planId: plan.id,
      version: plan.version,
      outcome: changed ? 'paused' : 'conflict',
      reason,
    };
  }

  private async runExecution(
    plan: AgentBulkPlanRecord,
    execution: AgentBulkTenantExecutionRecord
  ): Promise<AgentBulkCoordinatorResult> {
    const now = this.clock.now();
    const expiresAt = now + CHILD_CAPABILITY_MS;
    const binding = {
      purpose: 'authrim-agent-bulk-child-v1' as const,
      controlTenantId: plan.controlTenantId,
      targetTenantId: execution.targetTenantId,
      bulkPlanId: plan.id,
      bulkPlanVersion: plan.version,
      executionId: execution.id,
      executionAttempt: execution.executionAttempt + 1,
      executionFence: execution.executionFence + 1,
      stage: execution.stage,
      planDigest: plan.definitionDigest,
      approvalDigest: plan.approvalDigest!,
      ...(execution.preconditionSnapshotDigest
        ? { preconditionSnapshotDigest: execution.preconditionSnapshotDigest }
        : {}),
      expiresAt,
    };
    const childCapabilityDigest = await computeAgentBulkChildCapabilityDigest(binding);
    const claimed = await this.repository.claimTenant({
      controlTenantId: plan.controlTenantId,
      bulkPlanId: plan.id,
      bulkPlanVersion: plan.version,
      executionId: execution.id,
      expectedStage: execution.stage,
      ownerId: this.ownerId,
      leaseExpiresAt: now + LEASE_MS,
      childCapabilityDigest,
      childCapabilityExpiresAt: expiresAt,
      now,
    });
    if (!claimed) return { planId: plan.id, version: plan.version, outcome: 'conflict' };
    await this.repository.setRunningProgress({
      controlTenantId: plan.controlTenantId,
      id: plan.id,
      version: plan.version,
      stage: execution.stage,
      currentWave: execution.waveNumber ?? 0,
      now,
    });
    const current = await this.repository.getTenantExecution(
      plan.controlTenantId,
      plan.id,
      plan.version,
      execution.id
    );
    if (!current || !plan.definition) {
      return { planId: plan.id, version: plan.version, outcome: 'conflict' };
    }
    try {
      if (current.stage === 'validate')
        await this.validate(plan, current, binding, childCapabilityDigest);
      else if (current.stage === 'apply')
        await this.apply(plan, current, binding, childCapabilityDigest);
      else await this.verify(plan, current, binding, childCapabilityDigest);
      const after = await this.repository.getTenantExecution(
        plan.controlTenantId,
        plan.id,
        plan.version,
        current.id
      );
      if (after?.status === 'indeterminate') return this.pause(plan, 'indeterminate');
      return {
        planId: plan.id,
        version: plan.version,
        outcome: 'advanced',
        executionId: current.id,
        stage: current.stage,
      };
    } catch {
      const status = current.stage === 'apply' ? 'indeterminate' : 'failed';
      await this.finish(plan, current, status, 'child_execution_error');
      return status === 'indeterminate'
        ? this.pause(plan, 'indeterminate')
        : {
            planId: plan.id,
            version: plan.version,
            outcome: 'advanced',
            executionId: current.id,
            stage: current.stage,
          };
    }
  }

  private request(
    plan: AgentBulkPlanRecord,
    execution: AgentBulkTenantExecutionRecord,
    binding: Parameters<typeof computeAgentBulkChildCapabilityDigest>[0],
    childCapabilityDigest: string,
    operation: string,
    input: JsonObject,
    stepId: string
  ) {
    return this.executor.execute({
      binding,
      childCapabilityDigest,
      issuerOrigin: this.issuers.getIssuerOrigin(execution.targetTenantId),
      correlationId: `bulk:${execution.id}:${execution.executionAttempt}:${execution.stage}`,
      operation,
      input,
      idempotencyKey: `${execution.id}:${execution.executionAttempt}:${execution.stage}:${stepId}`,
    });
  }

  private async validate(
    plan: AgentBulkPlanRecord,
    execution: AgentBulkTenantExecutionRecord,
    binding: Parameters<typeof computeAgentBulkChildCapabilityDigest>[0],
    digest: string
  ): Promise<void> {
    const snapshots: JsonObject[] = [];
    for (const step of plan.definition!.plan.steps) {
      const target = readRequest(step);
      const result = await this.request(
        plan,
        execution,
        binding,
        digest,
        target.operation,
        target.input,
        step.id
      );
      const resourceVersion = result.status === 200 ? readVersion(result.body, step) : null;
      if (!resourceVersion) {
        await this.finish(plan, execution, 'failed', 'validation_failed');
        return;
      }
      snapshots.push({ step_id: step.id, resource_version: resourceVersion });
    }
    const value: ValidationCheckpoint = { snapshots };
    const checkpointDigest = await sha256Base64Url(canonicalizeJson(value));
    await this.advance(plan, execution, 'apply', value, checkpointDigest, 'validated');
  }

  private async apply(
    plan: AgentBulkPlanRecord,
    execution: AgentBulkTenantExecutionRecord,
    binding: Parameters<typeof computeAgentBulkChildCapabilityDigest>[0],
    digest: string
  ): Promise<void> {
    const value = checkpoint(execution.result);
    if (!value) throw new TypeError('Bulk validation checkpoint is unavailable');
    for (const step of plan.definition!.plan.steps) {
      const resourceVersion = snapshotVersion(value, step.id);
      if (!resourceVersion) throw new TypeError('Bulk resource precondition is unavailable');
      const result = await this.request(
        plan,
        execution,
        binding,
        digest,
        step.operation,
        { ...step.input, resource_version: resourceVersion },
        step.id
      );
      if (result.executionStatus === 'indeterminate') {
        await this.finish(plan, execution, 'indeterminate', 'owner_result_indeterminate');
        return;
      }
      if (result.status < 200 || result.status >= 300) {
        await this.finish(
          plan,
          execution,
          'failed',
          result.status === 412 ? 'precondition_failed' : 'owner_rejected'
        );
        return;
      }
    }
    await this.advance(
      plan,
      execution,
      'verify',
      value,
      execution.preconditionSnapshotDigest!,
      'applied'
    );
  }

  private async verify(
    plan: AgentBulkPlanRecord,
    execution: AgentBulkTenantExecutionRecord,
    binding: Parameters<typeof computeAgentBulkChildCapabilityDigest>[0],
    digest: string
  ): Promise<void> {
    for (const step of plan.definition!.plan.steps) {
      const target = readRequest(step);
      const result = await this.request(
        plan,
        execution,
        binding,
        digest,
        target.operation,
        target.input,
        step.id
      );
      if (result.status !== 200 || !matchesExpected(result.body, step)) {
        await this.finish(plan, execution, 'failed', 'verification_failed');
        return;
      }
    }
    await this.finish(plan, execution, 'succeeded');
  }

  private async advance(
    plan: AgentBulkPlanRecord,
    execution: AgentBulkTenantExecutionRecord,
    to: 'apply' | 'verify',
    value: ValidationCheckpoint,
    valueDigest: string,
    action: 'validated' | 'applied'
  ): Promise<void> {
    const now = this.clock.now();
    const changed = await this.repository.advanceTenantStage({
      controlTenantId: plan.controlTenantId,
      bulkPlanId: plan.id,
      bulkPlanVersion: plan.version,
      executionId: execution.id,
      executionAttempt: execution.executionAttempt,
      executionFence: execution.executionFence,
      from: execution.stage,
      to,
      preconditionSnapshotDigest: valueDigest,
      checkpoint: value,
      checkpointDigest: valueDigest,
      now,
      audit: audit(plan, `agent.bulk_tenant.${action}`, execution.id, now, {
        target_tenant_id: execution.targetTenantId,
        stage: execution.stage,
        next_stage: to,
        precondition_snapshot_digest: valueDigest,
      }),
    });
    if (!changed) throw new Error('Bulk child stage transition conflicted');
  }

  private async finish(
    plan: AgentBulkPlanRecord,
    execution: AgentBulkTenantExecutionRecord,
    status: 'succeeded' | 'failed' | 'indeterminate',
    failureKind?: string
  ): Promise<void> {
    const now = this.clock.now();
    const result: JsonObject = {
      target_tenant_id: execution.targetTenantId,
      stage: execution.stage,
      status,
      ...(failureKind ? { failure_kind: failureKind } : {}),
    };
    const resultDigest = await sha256Base64Url(canonicalizeJson(result));
    const changed = await this.repository.completeTenant({
      controlTenantId: plan.controlTenantId,
      bulkPlanId: plan.id,
      bulkPlanVersion: plan.version,
      executionId: execution.id,
      executionAttempt: execution.executionAttempt,
      executionFence: execution.executionFence,
      status,
      result,
      resultDigest,
      failureKind,
      now,
      audit: audit(
        plan,
        `agent.bulk_tenant.${status}`,
        execution.id,
        now,
        {
          target_tenant_id: execution.targetTenantId,
          stage: execution.stage,
          result_digest: resultDigest,
          ...(failureKind ? { failure_kind: failureKind } : {}),
        },
        status === 'succeeded' ? 'info' : 'warn'
      ),
    });
    if (!changed) throw new Error('Bulk child completion conflicted');
  }
}
