import { describe, expect, it } from 'vitest';
import {
  computeAgentBulkChildCapabilityDigest,
  decideAgentBulkWave,
  defaultAgentBulkRollout,
  resolveAgentBulkPlan,
  validateAgentBaselinePolicy,
} from '../bulk';
import { resolveAgentConfigurationPlan } from '../configuration';
import { createAgentToolCatalog } from '../tool-catalog';

const catalog = createAgentToolCatalog('test', [
  {
    id: 'admin.write.clients.metadata',
    name: 'update_client_metadata',
    title: 'Update client metadata',
    description: 'Test contract',
    contractVersion: '1',
    requiredPermissions: ['admin:clients:write'],
    requiredScope: 'agent:write',
    riskLevel: 'standard',
    schemaDigest: 'sha256:test',
    inputSchema: { type: 'object' },
  },
]);

const plan = {
  schemaVersion: 'authrim-agent-plan-v1' as const,
  steps: [
    {
      id: 'step-1',
      operation: 'admin.write.clients.metadata',
      toolContractVersion: '1',
      input: { client_id: 'client-1', client_name: 'Updated' },
      resourcePrecondition: 'per-tenant-validation',
    },
  ],
};

describe('Agent Bulk child capability', () => {
  it('omits an explicitly undefined validation snapshot from the canonical digest', async () => {
    const binding = {
      purpose: 'authrim-agent-bulk-child-v1' as const,
      controlTenantId: 'tenant-control',
      targetTenantId: 'tenant-target',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
      executionId: 'execution-1',
      executionAttempt: 1,
      executionFence: 1,
      stage: 'validate' as const,
      planDigest: 'plan-digest',
      approvalDigest: 'approval-digest',
      expiresAt: 1_800_000_000_000,
    };

    await expect(
      computeAgentBulkChildCapabilityDigest({
        ...binding,
        preconditionSnapshotDigest: undefined,
      })
    ).resolves.toBe(await computeAgentBulkChildCapabilityDigest(binding));
  });
});

describe('Agent Bulk Plan policy', () => {
  it('uses bounded canary and wave defaults', () => {
    expect(defaultAgentBulkRollout(100)).toEqual({
      canarySize: 5,
      waveSize: 20,
      waveFailureThresholdBasisPoints: 500,
    });
    expect(defaultAgentBulkRollout(1000)).toMatchObject({ canarySize: 5, waveSize: 25 });
  });

  it('pins explicit targets and canaries and only permits stricter rollout settings', async () => {
    const resolved = await resolveAgentBulkPlan({
      schemaVersion: 'authrim-agent-bulk-plan-v1',
      targetTenantIds: ['tenant-2', 'tenant-1'],
      canaryTenantIds: ['tenant-1'],
      plan,
      rollout: { waveSize: 1, waveFailureThresholdBasisPoints: 100 },
    });
    expect(resolved).toMatchObject({
      definition: { targetTenantIds: ['tenant-1', 'tenant-2'], canaryTenantIds: ['tenant-1'] },
      rollout: { canarySize: 1, waveSize: 1, waveFailureThresholdBasisPoints: 100 },
    });
    await expect(
      resolveAgentConfigurationPlan({
        definition: resolved.definition.plan,
        catalog,
        maxOperations: 100,
        schemaValidator: { validate: () => ({ valid: true }) },
      })
    ).resolves.toMatchObject({ definition: plan });
    await expect(
      resolveAgentBulkPlan({
        schemaVersion: 'authrim-agent-bulk-plan-v1',
        targetTenantIds: ['tenant-1', 'tenant-2'],
        canaryTenantIds: ['tenant-1'],
        plan,
        rollout: { waveSize: 2 },
      })
    ).rejects.toThrow('stricter');
  });

  it('accepts only declarative operations implemented by the Bulk coordinator', async () => {
    await expect(
      resolveAgentBulkPlan({
        schemaVersion: 'authrim-agent-bulk-plan-v1',
        targetTenantIds: ['tenant-1'],
        canaryTenantIds: ['tenant-1'],
        plan: {
          schemaVersion: 'authrim-agent-plan-v1',
          steps: [
            {
              id: 'step-brand',
              operation: 'admin.write.login-ui.update',
              toolContractVersion: '1',
              input: { brandName: 'Example' },
              resourcePrecondition: 'per-tenant-validation',
            },
          ],
        },
      })
    ).resolves.toMatchObject({ definition: { plan: { steps: [{ id: 'step-brand' }] } } });

    await expect(
      resolveAgentBulkPlan({
        schemaVersion: 'authrim-agent-bulk-plan-v1',
        targetTenantIds: ['tenant-1'],
        canaryTenantIds: ['tenant-1'],
        plan: {
          schemaVersion: 'authrim-agent-plan-v1',
          steps: [
            {
              id: 'step-session',
              operation: 'admin.write.session.update',
              toolContractVersion: '1',
              input: { defaultTtl: 3600 },
              resourcePrecondition: 'per-tenant-validation',
            },
          ],
        },
      })
    ).rejects.toThrow('supported declarative operations');

    await expect(
      resolveAgentBulkPlan({
        schemaVersion: 'authrim-agent-bulk-plan-v1',
        targetTenantIds: ['tenant-1'],
        canaryTenantIds: ['tenant-1'],
        plan: {
          schemaVersion: 'authrim-agent-plan-v1',
          steps: [
            {
              id: 'step-client',
              operation: 'admin.write.clients.metadata',
              toolContractVersion: '1',
              input: {
                client_id: 'client-1',
                client_name: 'Updated',
                resource_version: 'caller-supplied',
              },
              resourcePrecondition: 'per-tenant-validation',
            },
          ],
        },
      })
    ).rejects.toThrow('separate per-tenant validation');
  });

  it('pauses on one canary failure, five-percent wave failures, or any indeterminate result', () => {
    expect(
      decideAgentBulkWave({
        stage: 'canary',
        succeeded: 4,
        failed: 1,
        indeterminate: 0,
        waveFailureThresholdBasisPoints: 500,
      })
    ).toMatchObject({ pause: true, reason: 'canary_failed' });
    expect(
      decideAgentBulkWave({
        stage: 'wave',
        succeeded: 19,
        failed: 1,
        indeterminate: 0,
        waveFailureThresholdBasisPoints: 500,
      })
    ).toMatchObject({ pause: true, reason: 'wave_failure_threshold' });
    expect(
      decideAgentBulkWave({
        stage: 'wave',
        succeeded: 100,
        failed: 0,
        indeterminate: 1,
        waveFailureThresholdBasisPoints: 500,
      })
    ).toMatchObject({ pause: true, reason: 'indeterminate' });
  });

  it('treats a zero-basis-point threshold as pause-on-any-failure, not pause-on-success', () => {
    expect(
      decideAgentBulkWave({
        stage: 'wave',
        succeeded: 20,
        failed: 0,
        indeterminate: 0,
        waveFailureThresholdBasisPoints: 0,
      })
    ).toEqual({ pause: false });
    expect(
      decideAgentBulkWave({
        stage: 'wave',
        succeeded: 19,
        failed: 1,
        indeterminate: 0,
        waveFailureThresholdBasisPoints: 0,
      })
    ).toEqual({ pause: true, reason: 'wave_failure_threshold' });
  });

  it('keeps one-time baselines report-only', () => {
    expect(() =>
      validateAgentBaselinePolicy({ mode: 'one_time', enforcement: 'standard_auto_remediation' })
    ).toThrow('does not auto-remediate');
  });
});
