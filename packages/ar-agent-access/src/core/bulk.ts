import { canonicalizeJson, sha256Base64Url } from './canonical-json';
import type { AgentConfigurationPlanDefinition } from './configuration';
import type { JsonValue } from './types';

const SAFE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const SUPPORTED_BULK_OPERATIONS = new Set([
  'admin.write.clients.metadata',
  'admin.write.login-ui.update',
]);

export type AgentBulkPlanStatus = 'draft' | 'ready' | 'running' | 'paused' | 'completed';
export type AgentBulkPlanStage = 'validate' | 'apply' | 'verify';
export type AgentBulkTenantExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'indeterminate';

export interface AgentBulkRolloutPolicy {
  canarySize: number;
  waveSize: number;
  waveFailureThresholdBasisPoints: number;
}

export interface AgentBulkPlanDefinition {
  schemaVersion: 'authrim-agent-bulk-plan-v1';
  targetTenantIds: readonly string[];
  canaryTenantIds: readonly string[];
  plan: AgentConfigurationPlanDefinition;
  rollout?: Partial<AgentBulkRolloutPolicy>;
}

export interface ResolvedAgentBulkPlan {
  definition: AgentBulkPlanDefinition;
  targetSnapshotDigest: string;
  canaryDigest: string;
  digest: string;
  rollout: AgentBulkRolloutPolicy;
}

export interface AgentBulkWaveOutcome {
  stage: 'canary' | 'wave';
  succeeded: number;
  failed: number;
  indeterminate: number;
  waveFailureThresholdBasisPoints: number;
}

export interface AgentBulkWaveDecision {
  pause: boolean;
  reason?: 'canary_failed' | 'wave_failure_threshold' | 'indeterminate';
}

export interface AgentBulkChildCapabilityBinding {
  purpose: 'authrim-agent-bulk-child-v1';
  controlTenantId: string;
  targetTenantId: string;
  bulkPlanId: string;
  bulkPlanVersion: number;
  executionId: string;
  executionAttempt: number;
  executionFence: number;
  stage: AgentBulkPlanStage;
  planDigest: string;
  approvalDigest: string;
  /** Digest of the tenant-specific validation snapshot used by apply/verify. */
  preconditionSnapshotDigest?: string;
  expiresAt: number;
}

export async function computeAgentBulkChildCapabilityDigest(
  binding: AgentBulkChildCapabilityBinding
): Promise<string> {
  if (
    binding.purpose !== 'authrim-agent-bulk-child-v1' ||
    !SAFE_ID.test(binding.controlTenantId) ||
    !SAFE_ID.test(binding.targetTenantId) ||
    !SAFE_ID.test(binding.bulkPlanId) ||
    !SAFE_ID.test(binding.executionId) ||
    !Number.isSafeInteger(binding.bulkPlanVersion) ||
    binding.bulkPlanVersion < 1 ||
    !Number.isSafeInteger(binding.executionAttempt) ||
    binding.executionAttempt < 1 ||
    !Number.isSafeInteger(binding.executionFence) ||
    binding.executionFence < 1 ||
    !['validate', 'apply', 'verify'].includes(binding.stage) ||
    !binding.planDigest ||
    !binding.approvalDigest ||
    ((binding.stage === 'apply' || binding.stage === 'verify') &&
      !binding.preconditionSnapshotDigest) ||
    !Number.isSafeInteger(binding.expiresAt)
  ) {
    throw new TypeError('Bulk child capability binding is invalid');
  }
  const canonicalBinding: JsonValue = {
    purpose: binding.purpose,
    controlTenantId: binding.controlTenantId,
    targetTenantId: binding.targetTenantId,
    bulkPlanId: binding.bulkPlanId,
    bulkPlanVersion: binding.bulkPlanVersion,
    executionId: binding.executionId,
    executionAttempt: binding.executionAttempt,
    executionFence: binding.executionFence,
    stage: binding.stage,
    planDigest: binding.planDigest,
    approvalDigest: binding.approvalDigest,
    ...(binding.preconditionSnapshotDigest
      ? { preconditionSnapshotDigest: binding.preconditionSnapshotDigest }
      : {}),
    expiresAt: binding.expiresAt,
  };
  return sha256Base64Url(canonicalizeJson(canonicalBinding));
}

export function defaultAgentBulkRollout(targetCount: number): AgentBulkRolloutPolicy {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
    throw new TypeError('Bulk target count must be positive');
  }
  return {
    canarySize: Math.min(5, Math.max(1, Math.ceil(targetCount * 0.05))),
    waveSize: Math.min(25, Math.max(1, Math.ceil(targetCount * 0.2))),
    waveFailureThresholdBasisPoints: 500,
  };
}

function uniqueTenantIds(values: readonly string[], field: string): string[] {
  if (values.length === 0 || values.length > 1000 || values.some((value) => !SAFE_ID.test(value))) {
    throw new TypeError(`${field} is invalid`);
  }
  const result = [...new Set(values)].sort();
  if (result.length !== values.length) throw new TypeError(`${field} contains duplicates`);
  return result;
}

/** Resolves selectors before approval. No `all` or future-tenant selector survives this boundary. */
export async function resolveAgentBulkPlan(
  value: AgentBulkPlanDefinition
): Promise<ResolvedAgentBulkPlan> {
  if (value.schemaVersion !== 'authrim-agent-bulk-plan-v1') {
    throw new TypeError('Bulk Plan schema version is invalid');
  }
  const targetTenantIds = uniqueTenantIds(value.targetTenantIds, 'targetTenantIds');
  const defaults = defaultAgentBulkRollout(targetTenantIds.length);
  const requested = value.rollout ?? {};
  const rollout: AgentBulkRolloutPolicy = {
    canarySize: requested.canarySize ?? defaults.canarySize,
    waveSize: requested.waveSize ?? defaults.waveSize,
    waveFailureThresholdBasisPoints:
      requested.waveFailureThresholdBasisPoints ?? defaults.waveFailureThresholdBasisPoints,
  };
  if (
    !Number.isSafeInteger(rollout.canarySize) ||
    rollout.canarySize < 1 ||
    rollout.canarySize > defaults.canarySize ||
    !Number.isSafeInteger(rollout.waveSize) ||
    rollout.waveSize < 1 ||
    rollout.waveSize > defaults.waveSize ||
    !Number.isSafeInteger(rollout.waveFailureThresholdBasisPoints) ||
    rollout.waveFailureThresholdBasisPoints < 0 ||
    rollout.waveFailureThresholdBasisPoints > defaults.waveFailureThresholdBasisPoints
  ) {
    throw new TypeError('Bulk rollout may only be stricter than safe defaults');
  }
  const canaryTenantIds = uniqueTenantIds(value.canaryTenantIds, 'canaryTenantIds');
  if (
    canaryTenantIds.length !== rollout.canarySize ||
    canaryTenantIds.some((tenantId) => !targetTenantIds.includes(tenantId))
  ) {
    throw new TypeError('Explicit canary tenants must be the required target subset');
  }
  const definition: AgentBulkPlanDefinition = {
    schemaVersion: 'authrim-agent-bulk-plan-v1',
    targetTenantIds,
    canaryTenantIds,
    plan: JSON.parse(
      canonicalizeJson(value.plan as unknown as JsonValue)
    ) as AgentConfigurationPlanDefinition,
    rollout,
  };
  if (
    definition.plan.steps.some(
      (step) =>
        !SUPPORTED_BULK_OPERATIONS.has(step.operation) ||
        step.resourcePrecondition !== 'per-tenant-validation' ||
        Object.hasOwn(step.input, 'resource_version')
    )
  ) {
    throw new TypeError(
      'Bulk writes must be supported declarative operations with separate per-tenant validation'
    );
  }
  const resourceKeys = definition.plan.steps.map(
    (step) =>
      `${step.operation}:${typeof step.input.client_id === 'string' ? step.input.client_id : ''}`
  );
  if (new Set(resourceKeys).size !== resourceKeys.length) {
    throw new TypeError('Bulk Plan contains multiple writes to the same resource');
  }
  const targetSnapshotDigest = await sha256Base64Url(canonicalizeJson(targetTenantIds));
  const canaryDigest = await sha256Base64Url(canonicalizeJson(canaryTenantIds));
  return {
    definition,
    targetSnapshotDigest,
    canaryDigest,
    digest: await sha256Base64Url(canonicalizeJson(definition as unknown as JsonValue)),
    rollout,
  };
}

export function decideAgentBulkWave(outcome: AgentBulkWaveOutcome): AgentBulkWaveDecision {
  if (outcome.indeterminate > 0) return { pause: true, reason: 'indeterminate' };
  if (outcome.stage === 'canary' && outcome.failed > 0) {
    return { pause: true, reason: 'canary_failed' };
  }
  const total = outcome.succeeded + outcome.failed;
  if (
    outcome.stage === 'wave' &&
    outcome.failed > 0 &&
    total > 0 &&
    outcome.failed * 10_000 >= total * outcome.waveFailureThresholdBasisPoints
  ) {
    return { pause: true, reason: 'wave_failure_threshold' };
  }
  return { pause: false };
}

export interface AgentBaselinePolicy {
  mode: 'one_time' | 'managed';
  enforcement: 'report_only' | 'standard_auto_remediation';
}

export function validateAgentBaselinePolicy(value: AgentBaselinePolicy): AgentBaselinePolicy {
  if (value.mode === 'one_time' && value.enforcement !== 'report_only') {
    throw new TypeError('One-time baseline does not auto-remediate');
  }
  return { ...value };
}
