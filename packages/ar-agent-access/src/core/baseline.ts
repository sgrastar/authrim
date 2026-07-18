import { canonicalizeJson, sha256Base64Url } from './canonical-json';
import { assertNoRawSecrets } from './configuration';
import type { AgentConfigurationPlanDefinition } from './configuration';
import type { JsonObject, JsonValue } from './types';

const SAFE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export type AgentConfigurationTemplateType = 'task_set' | 'scope_policy';
export type AgentBaselineMode = 'one_time' | 'managed';
export type AgentBaselineEnforcement = 'report_only' | 'standard_auto_remediation';
export type AgentBaselineDriftStatus = 'in_sync' | 'drifted' | 'unknown';

export interface AgentBaselineDefinition {
  schemaVersion: 'authrim-agent-baseline-v1';
  taskSet?: { id: string; version: number; digest: string };
  scopePolicy?: { id: string; version: number; digest: string };
  configurationProfile: AgentConfigurationPlanDefinition;
}

export interface ResolvedAgentBaselineDefinition {
  definition: AgentBaselineDefinition;
  digest: string;
}

export interface AgentBaselineCurrentStepState {
  stepId: string;
  operation: string;
  current: JsonObject | null;
}

export interface AgentBaselineEvaluation {
  status: AgentBaselineDriftStatus;
  currentDigest: string;
  driftFields: string[];
  exceptedFields: string[];
}

function reference(
  value: AgentBaselineDefinition['taskSet'] | AgentBaselineDefinition['scopePolicy'],
  field: string
): void {
  if (
    value &&
    (!SAFE_ID.test(value.id) ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1 ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(value.digest))
  ) {
    throw new TypeError(`${field} reference is invalid`);
  }
}

export async function resolveAgentBaselineDefinition(input: {
  definition: AgentBaselineDefinition;
  mode: AgentBaselineMode;
  enforcement: AgentBaselineEnforcement;
}): Promise<ResolvedAgentBaselineDefinition> {
  if (
    input.definition.schemaVersion !== 'authrim-agent-baseline-v1' ||
    (input.mode !== 'one_time' && input.mode !== 'managed') ||
    (input.enforcement !== 'report_only' && input.enforcement !== 'standard_auto_remediation') ||
    (input.mode === 'one_time' && input.enforcement !== 'report_only') ||
    (!input.definition.taskSet && !input.definition.scopePolicy) ||
    input.definition.configurationProfile?.schemaVersion !== 'authrim-agent-plan-v1' ||
    !Array.isArray(input.definition.configurationProfile.steps) ||
    input.definition.configurationProfile.steps.length === 0
  ) {
    throw new TypeError('Baseline definition or policy is invalid');
  }
  reference(input.definition.taskSet, 'Task Set');
  reference(input.definition.scopePolicy, 'Scope Policy');
  if (
    input.definition.configurationProfile.steps.some(
      (step) =>
        step.operation !== 'admin.write.clients.metadata' ||
        step.resourcePrecondition !== 'per-tenant-validation' ||
        Object.hasOwn(step.input, 'resource_version') ||
        !Object.keys(step.input).some(
          (field) => field !== 'client_id' && field !== 'resource_version'
        )
    )
  ) {
    throw new TypeError('Baseline contains an unsupported or non-declarative operation');
  }
  assertNoRawSecrets(input.definition.configurationProfile as unknown as JsonValue);
  const definition = JSON.parse(
    canonicalizeJson(input.definition as unknown as JsonValue)
  ) as AgentBaselineDefinition;
  return {
    definition,
    digest: await sha256Base64Url(canonicalizeJson(definition as unknown as JsonValue)),
  };
}

/** Compares trusted platform reads with the immutable declarative Baseline profile. */
export async function evaluateAgentBaselineConfiguration(input: {
  definition: AgentBaselineDefinition;
  current: readonly AgentBaselineCurrentStepState[];
  exceptionFields?: readonly string[];
}): Promise<AgentBaselineEvaluation> {
  const currentByStep = new Map(input.current.map((item) => [item.stepId, item]));
  const exceptions = new Set(input.exceptionFields ?? []);
  const driftFields: string[] = [];
  const exceptedFields: string[] = [];
  const stateSteps: JsonObject[] = [];

  for (const step of input.definition.configurationProfile.steps) {
    const snapshot = currentByStep.get(step.id);
    if (snapshot && snapshot.operation !== step.operation) {
      throw new TypeError('Baseline current-state operation does not match the Plan');
    }
    const expected = Object.fromEntries(
      Object.entries(step.input).filter(
        ([field]) => field !== 'client_id' && field !== 'resource_version'
      )
    ) as JsonObject;
    const current: JsonObject = snapshot?.current ?? {};
    const fields = Object.keys(expected).sort();
    if (!snapshot || snapshot.current === null) fields.push('$resource');
    for (const field of [...new Set(fields)]) {
      const path = `${step.id}.${field}`;
      const matches =
        field !== '$resource' &&
        canonicalizeJson(current[field] ?? null) === canonicalizeJson(expected[field] ?? null);
      if (matches) continue;
      if (exceptions.has(path)) exceptedFields.push(path);
      else driftFields.push(path);
    }
    stateSteps.push({
      step_id: step.id,
      operation: step.operation,
      resource_id: step.input.client_id ?? null,
      exists: snapshot?.current !== null && snapshot !== undefined,
      values: current,
    });
  }

  const currentDigest = await sha256Base64Url(
    canonicalizeJson({
      schema_version: 'authrim-agent-baseline-state-v1',
      steps: stateSteps,
    })
  );
  return {
    status: driftFields.length === 0 ? 'in_sync' : 'drifted',
    currentDigest,
    driftFields: driftFields.sort(),
    exceptedFields: exceptedFields.sort(),
  };
}

export function validateAgentBaselineException(input: {
  fields: readonly string[];
  reason: string;
  expiresAt: number;
  now: number;
}): { fields: string[]; reason: string; expiresAt: number } {
  const fields = [...new Set(input.fields)].sort();
  if (
    fields.length === 0 ||
    fields.length > 100 ||
    fields.some((field) => !/^[A-Za-z0-9_.~-]{1,200}$/u.test(field)) ||
    input.reason.trim().length < 3 ||
    input.reason.length > 1000 ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.now ||
    input.expiresAt > input.now + 365 * 24 * 60 * 60_000
  ) {
    throw new TypeError('Baseline exception is invalid');
  }
  return { fields, reason: input.reason.trim(), expiresAt: input.expiresAt };
}
