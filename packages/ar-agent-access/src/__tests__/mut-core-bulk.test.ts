import { describe, expect, it } from 'vitest';
import {
  computeAgentBulkChildCapabilityDigest,
  decideAgentBulkWave,
  defaultAgentBulkRollout,
  resolveAgentBulkPlan,
  validateAgentBaselinePolicy,
  type AgentBulkChildCapabilityBinding,
  type AgentBulkPlanDefinition,
} from '../core/bulk';
import { canonicalizeJson, sha256Base64Url } from '../core/canonical-json';
import type { JsonValue } from '../core/types';

const binding: AgentBulkChildCapabilityBinding = {
  purpose: 'authrim-agent-bulk-child-v1',
  controlTenantId: 'control',
  targetTenantId: 'tenant-1',
  bulkPlanId: 'plan-1',
  bulkPlanVersion: 1,
  executionId: 'exec-1',
  executionAttempt: 1,
  executionFence: 1,
  stage: 'apply',
  planDigest: 'pd',
  approvalDigest: 'ad',
  preconditionSnapshotDigest: 'psd',
  expiresAt: 1000,
};

describe('computeAgentBulkChildCapabilityDigest', () => {
  it('hashes the canonical binding including the precondition digest', async () => {
    const expected = await sha256Base64Url(canonicalizeJson(binding as unknown as JsonValue));
    await expect(computeAgentBulkChildCapabilityDigest(binding)).resolves.toBe(expected);
  });

  it('omits an absent precondition digest for validate bindings', async () => {
    const validate = {
      ...binding,
      stage: 'validate' as const,
      preconditionSnapshotDigest: undefined,
    };
    const { preconditionSnapshotDigest: _omit, ...rest } = validate;
    const expected = await sha256Base64Url(canonicalizeJson(rest));
    await expect(computeAgentBulkChildCapabilityDigest(validate)).resolves.toBe(expected);
    const withDigest = await computeAgentBulkChildCapabilityDigest({
      ...validate,
      preconditionSnapshotDigest: 'psd',
    });
    expect(withDigest).not.toBe(expected);
  });

  it('accepts the verify stage and larger counters', async () => {
    await expect(
      computeAgentBulkChildCapabilityDigest({
        ...binding,
        stage: 'verify',
        bulkPlanVersion: 2,
        executionAttempt: 3,
        executionFence: 4,
      })
    ).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it.each([
    ['purpose', { purpose: 'other' }],
    ['controlTenantId', { controlTenantId: 'bad id' }],
    ['controlTenantId junk prefix', { controlTenantId: '!control' }],
    ['controlTenantId junk suffix', { controlTenantId: 'control!' }],
    ['targetTenantId', { targetTenantId: '' }],
    ['bulkPlanId', { bulkPlanId: 'x'.repeat(129) }],
    ['executionId', { executionId: 'a/b' }],
    ['bulkPlanVersion fraction', { bulkPlanVersion: 1.5 }],
    ['bulkPlanVersion zero', { bulkPlanVersion: 0 }],
    ['executionAttempt fraction', { executionAttempt: 1.5 }],
    ['executionAttempt zero', { executionAttempt: 0 }],
    ['executionFence fraction', { executionFence: 2.5 }],
    ['executionFence zero', { executionFence: 0 }],
    ['stage', { stage: 'rollback' }],
    ['planDigest', { planDigest: '' }],
    ['approvalDigest', { approvalDigest: '' }],
    ['apply without precondition', { preconditionSnapshotDigest: undefined }],
    ['verify without precondition', { stage: 'verify', preconditionSnapshotDigest: '' }],
    ['expiresAt', { expiresAt: 1.5 }],
  ])('rejects an invalid %s', async (_label, override) => {
    await expect(
      computeAgentBulkChildCapabilityDigest({
        ...binding,
        ...override,
      } as AgentBulkChildCapabilityBinding)
    ).rejects.toThrow('Bulk child capability binding is invalid');
  });
});

describe('defaultAgentBulkRollout', () => {
  it.each([
    [1, { canarySize: 1, waveSize: 1 }],
    [21, { canarySize: 2, waveSize: 5 }],
    [100, { canarySize: 5, waveSize: 20 }],
    [1000, { canarySize: 5, waveSize: 25 }],
  ])('derives defaults for %i targets', (count, sizes) => {
    expect(defaultAgentBulkRollout(count)).toEqual({
      ...sizes,
      waveFailureThresholdBasisPoints: 500,
    });
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])('rejects target count %s', (count) => {
    expect(() => defaultAgentBulkRollout(count)).toThrow('Bulk target count must be positive');
  });
});

const step = {
  id: 'step-1',
  operation: 'admin.write.clients.metadata',
  toolContractVersion: '1',
  input: { client_id: 'c1', client_name: 'x' },
  resourcePrecondition: 'per-tenant-validation',
};
const targets = Array.from({ length: 21 }, (_, i) => `t-${String(i).padStart(2, '0')}`);
const plan: AgentBulkPlanDefinition = {
  schemaVersion: 'authrim-agent-bulk-plan-v1',
  targetTenantIds: [...targets].reverse(),
  canaryTenantIds: ['t-05', 't-01'],
  plan: { schemaVersion: 'authrim-agent-plan-v1', goal: 'Rename', steps: [step] },
};

describe('resolveAgentBulkPlan', () => {
  it('returns the sorted definition, default rollout and digests', async () => {
    const result = await resolveAgentBulkPlan(plan);
    const rollout = { canarySize: 2, waveSize: 5, waveFailureThresholdBasisPoints: 500 };
    expect(result.definition).toEqual({
      ...plan,
      targetTenantIds: targets,
      canaryTenantIds: ['t-01', 't-05'],
      rollout,
    });
    expect(result.rollout).toEqual(rollout);
    expect(result.targetSnapshotDigest).toBe(await sha256Base64Url(canonicalizeJson(targets)));
    expect(result.canaryDigest).toBe(await sha256Base64Url(canonicalizeJson(['t-01', 't-05'])));
    expect(result.digest).toBe(
      await sha256Base64Url(canonicalizeJson(result.definition as unknown as JsonValue))
    );
  });

  it('accepts stricter rollout values', async () => {
    const rollout = { canarySize: 1, waveSize: 1, waveFailureThresholdBasisPoints: 0 };
    const result = await resolveAgentBulkPlan({ ...plan, canaryTenantIds: ['t-03'], rollout });
    expect(result.rollout).toEqual(rollout);
  });

  it('rejects an unknown schema version', async () => {
    await expect(
      resolveAgentBulkPlan({ ...plan, schemaVersion: 'v2' } as unknown as AgentBulkPlanDefinition)
    ).rejects.toThrow('Bulk Plan schema version is invalid');
  });

  it.each([
    ['empty', []],
    ['over 1000', Array.from({ length: 1001 }, (_, i) => `t${i}`)],
    ['malformed', ['t-01', 't-05', 'bad id']],
  ])('rejects %s target lists', async (_label, targetTenantIds) => {
    await expect(resolveAgentBulkPlan({ ...plan, targetTenantIds })).rejects.toThrow(
      'targetTenantIds is invalid'
    );
  });

  it('accepts exactly 1000 targets', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `t-${String(i).padStart(4, '0')}`);
    await expect(
      resolveAgentBulkPlan({ ...plan, targetTenantIds: many, canaryTenantIds: many.slice(0, 5) })
    ).resolves.toMatchObject({ rollout: { canarySize: 5, waveSize: 25 } });
  });

  it('rejects duplicate targets and canaries', async () => {
    await expect(
      resolveAgentBulkPlan({ ...plan, targetTenantIds: [...targets, 't-01'] })
    ).rejects.toThrow('targetTenantIds contains duplicates');
    await expect(
      resolveAgentBulkPlan({ ...plan, canaryTenantIds: ['t-01', 't-01'] })
    ).rejects.toThrow('canaryTenantIds contains duplicates');
    await expect(resolveAgentBulkPlan({ ...plan, canaryTenantIds: [] })).rejects.toThrow(
      'canaryTenantIds is invalid'
    );
  });

  it.each([
    ['fractional canary', { canarySize: 1.5 }],
    ['zero canary', { canarySize: 0 }],
    ['larger canary', { canarySize: 3 }],
    ['fractional wave', { waveSize: 1.5 }],
    ['zero wave', { waveSize: 0 }],
    ['larger wave', { waveSize: 6 }],
    ['fractional threshold', { waveFailureThresholdBasisPoints: 1.5 }],
    ['negative threshold', { waveFailureThresholdBasisPoints: -1 }],
    ['looser threshold', { waveFailureThresholdBasisPoints: 501 }],
  ])('rejects a %s rollout', async (_label, rollout) => {
    await expect(resolveAgentBulkPlan({ ...plan, rollout })).rejects.toThrow(
      'Bulk rollout may only be stricter than safe defaults'
    );
  });

  it('requires canaries to be exactly the rollout-sized target subset', async () => {
    for (const canaryTenantIds of [['t-01'], ['t-01', 't-02', 't-03'], ['t-01', 'outsider']]) {
      await expect(resolveAgentBulkPlan({ ...plan, canaryTenantIds })).rejects.toThrow(
        'Explicit canary tenants must be the required target subset'
      );
    }
  });

  it.each([
    ['unsupported operation', { operation: 'admin.write.users.delete' }],
    ['shared precondition', { resourcePrecondition: 'etag:v1' }],
    ['embedded resource_version', { input: { client_id: 'c1', resource_version: 'v1' } }],
  ])('rejects a step with %s', async (_label, override) => {
    await expect(
      resolveAgentBulkPlan({ ...plan, plan: { ...plan.plan, steps: [{ ...step, ...override }] } })
    ).rejects.toThrow(
      'Bulk writes must be supported declarative operations with separate per-tenant validation'
    );
  });

  it('allows distinct resources and rejects repeated writes to one resource', async () => {
    const steps = (...inputs: Record<string, JsonValue>[]) =>
      inputs.map((input, i) => ({ ...step, id: `s${i}`, input }));
    const withSteps = (s: ReturnType<typeof steps>) => ({
      ...plan,
      plan: { ...plan.plan, steps: s },
    });
    await expect(
      resolveAgentBulkPlan(withSteps(steps({ client_id: 'a' }, { client_id: 'b' })))
    ).resolves.toBeDefined();
    await expect(
      resolveAgentBulkPlan(withSteps(steps({ client_id: 'placeholder' }, {})))
    ).resolves.toBeDefined();
    await expect(
      resolveAgentBulkPlan({
        ...plan,
        plan: {
          ...plan.plan,
          steps: [
            { ...step, id: 's1', input: {} },
            { ...step, id: 's2', operation: 'admin.write.login-ui.update', input: {} },
          ],
        },
      })
    ).resolves.toBeDefined();
    for (const pair of [
      steps({ client_id: 'a' }, { client_id: 'a' }),
      steps({ client_id: 1 }, { client_id: 2 }),
      steps({ client_id: '' }, {}),
    ]) {
      await expect(resolveAgentBulkPlan(withSteps(pair))).rejects.toThrow(
        'Bulk Plan contains multiple writes to the same resource'
      );
    }
  });
});

describe('decideAgentBulkWave', () => {
  const wave = {
    stage: 'wave' as const,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    waveFailureThresholdBasisPoints: 500,
  };

  it('pauses on any indeterminate result first', () => {
    expect(decideAgentBulkWave({ ...wave, stage: 'canary', failed: 1, indeterminate: 1 })).toEqual({
      pause: true,
      reason: 'indeterminate',
    });
  });

  it('pauses on any canary failure and continues on a clean canary', () => {
    expect(decideAgentBulkWave({ ...wave, stage: 'canary', succeeded: 99, failed: 1 })).toEqual({
      pause: true,
      reason: 'canary_failed',
    });
    expect(decideAgentBulkWave({ ...wave, stage: 'canary', succeeded: 3 })).toEqual({
      pause: false,
    });
  });

  it('applies the inclusive wave failure threshold', () => {
    expect(decideAgentBulkWave({ ...wave, succeeded: 95, failed: 5 })).toEqual({
      pause: true,
      reason: 'wave_failure_threshold',
    });
    expect(decideAgentBulkWave({ ...wave, succeeded: 100, failed: 5 })).toEqual({ pause: false });
    expect(decideAgentBulkWave({ ...wave, succeeded: 999, failed: 1 })).toEqual({ pause: false });
    expect(decideAgentBulkWave({ ...wave, succeeded: 10 })).toEqual({ pause: false });
    expect(decideAgentBulkWave({ ...wave, failed: 1, waveFailureThresholdBasisPoints: 0 })).toEqual(
      {
        pause: true,
        reason: 'wave_failure_threshold',
      }
    );
  });
});

describe('validateAgentBaselinePolicy', () => {
  it('returns a copy of valid policies', () => {
    for (const value of [
      { mode: 'one_time' as const, enforcement: 'report_only' as const },
      { mode: 'managed' as const, enforcement: 'standard_auto_remediation' as const },
      { mode: 'managed' as const, enforcement: 'report_only' as const },
    ]) {
      const result = validateAgentBaselinePolicy(value);
      expect(result).toEqual(value);
      expect(result).not.toBe(value);
    }
  });

  it('forbids one-time auto-remediation', () => {
    expect(() =>
      validateAgentBaselinePolicy({ mode: 'one_time', enforcement: 'standard_auto_remediation' })
    ).toThrow('One-time baseline does not auto-remediate');
  });
});
