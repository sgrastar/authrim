import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeJson,
  resolveAgentBulkPlan,
  sha256Base64Url,
  type AgentBulkPlanRecord,
} from '../core';
import {
  BASELINE_NOW,
  baselineContext,
  baselineHarness,
  expectedBaselineAudit,
  profile,
  sourcePlan,
} from './helpers/mut-plans-baseline-fixtures';

const remediation = (overrides: Partial<AgentBulkPlanRecord> = {}) =>
  sourcePlan({
    id: 'bulk-remediation',
    version: 1,
    status: 'ready',
    definitionDigest: 'remediation-digest',
    targetSnapshotDigest: 'r-target',
    canaryDigest: 'r-canary',
    ...overrides,
  });

/** bulk.get resolver: the source Plan, then a sequence of remediation reads. */
function arrangeBulk(
  test: ReturnType<typeof baselineHarness>,
  source: AgentBulkPlanRecord | null,
  remediations: Array<AgentBulkPlanRecord | null>
) {
  const queue = [...remediations];
  test.bulk.get.mockImplementation(async (_tenant: string, id: string) =>
    id === 'bulk-source' ? source : ((queue.length > 1 ? queue.shift() : queue[0]) ?? null)
  );
}

describe('Baseline remediation scheduler', () => {
  it('runs each pending remediation and isolates a failing one', async () => {
    const test = baselineHarness();
    test.baselines.listPendingAutoRemediations.mockResolvedValue([
      { controlTenantId: 'control', assignmentId: 'assignment-1' },
      { controlTenantId: 'control', assignmentId: 'assignment-2' },
    ]);
    test.baselines.getAssignmentContext
      .mockRejectedValueOnce(new Error('d1 down'))
      .mockResolvedValueOnce(null);
    await expect(test.coordinator.runScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'blocked', reason: 'coordinator_unavailable' },
      { assignmentId: 'assignment-2', outcome: 'conflict' },
    ]);
    expect(test.baselines.listPendingAutoRemediations).toHaveBeenCalledWith(25);
    await test.coordinator.runScheduled(3);
    expect(test.baselines.listPendingAutoRemediations).toHaveBeenLastCalledWith(3);
  });
});

describe('Baseline remediation run', () => {
  it.each([
    ['a retired baseline', {}, { status: 'retired' as never }],
    ['a one-time baseline', {}, { mode: 'one_time' as const }],
    ['report-only enforcement', {}, { enforcement: 'report_only' as const }],
    ['no reserved drift digest', { remediationDriftDigest: undefined }, {}],
    ['no reserved Plan id', { remediationBulkPlanId: undefined }, {}],
    ['a non-initial reserved version', { remediationBulkPlanVersion: 2 }, {}],
  ])('refuses %s as a conflict', async (_label, assignment, baseline) => {
    const test = baselineHarness();
    test.baselines.getAssignmentContext.mockResolvedValue(baselineContext(assignment, baseline));
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      outcome: 'conflict',
    });
    expect(test.settings.get).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing source', null],
    ['a running source', sourcePlan({ status: 'running' })],
    ['a purged source', sourcePlan({ definition: undefined })],
    [
      'a source with another profile',
      sourcePlan({
        definition: { ...sourcePlan().definition!, plan: { ...profile, goal: 'Other goal' } },
      }),
    ],
    ['a Mode A source', sourcePlan({ actorMode: 'mode_a' })],
    ['a non machine-key source', sourcePlan({ actorAssurance: 'public_client_transaction' })],
    ['a bearer source', sourcePlan({ tokenBinding: 'bearer' })],
    ['a source without delegator', sourcePlan({ delegatorId: undefined })],
    ['a source without machine principal', sourcePlan({ machinePrincipalId: undefined })],
    ['a source without machine credential', sourcePlan({ machineCredentialId: undefined })],
  ])('blocks on %s', async (_label, source) => {
    const test = baselineHarness();
    arrangeBulk(test, source, [null]);
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      outcome: 'blocked',
      reason: 'source_binding_unavailable',
    });
    expect(test.bulk.get).toHaveBeenCalledWith('control', 'bulk-source', 4);
    expect(test.bulk.create).not.toHaveBeenCalled();
  });

  it('materializes the single-tenant remediation from the source delegation', async () => {
    const test = baselineHarness();
    arrangeBulk(test, sourcePlan(), [null, remediation({ status: 'running' })]);
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      bulkPlanId: 'bulk-remediation',
      outcome: 'advanced',
    });
    const resolved = await resolveAgentBulkPlan({
      schemaVersion: 'authrim-agent-bulk-plan-v1',
      targetTenantIds: ['tenant-1'],
      canaryTenantIds: ['tenant-1'],
      plan: profile,
      rollout: { canarySize: 1, waveSize: 1, waveFailureThresholdBasisPoints: 0 },
    });
    expect(test.bulk.create).toHaveBeenCalledWith({
      id: 'bulk-remediation',
      version: 1,
      controlTenantId: 'control',
      grantId: 'grant-1',
      actorSub: 'machine:principal-1',
      clientId: 'client-1',
      delegatorId: 'admin-1',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      machinePrincipalId: 'principal-1',
      machineCredentialId: 'credential-1',
      grantGeneration: 5,
      consentVersion: 6,
      resolved,
      expiresAt: BASELINE_NOW + 86_400_000,
      payloadPurgeAt: BASELINE_NOW + 86_400_000 + 2_592_000_000,
      now: BASELINE_NOW,
      audit: expectedBaselineAudit(
        'agent.baseline.remediation_plan_created',
        'agent_bulk_plan',
        'bulk-remediation',
        {
          assignment_id: 'assignment-1',
          baseline_id: 'baseline-1',
          baseline_version: 2,
          drift_digest: 'drift-1',
          plan_digest: resolved.digest,
        }
      ),
    });
    expect(test.bulk.transition).not.toHaveBeenCalled();
    expect(test.bulk.startApproved).not.toHaveBeenCalled();
  });

  it('recovers when a concurrent run already created the remediation Plan', async () => {
    const test = baselineHarness();
    test.bulk.create.mockRejectedValue(new Error('UNIQUE constraint'));
    arrangeBulk(test, sourcePlan(), [null, remediation({ status: 'paused' })]);
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      bulkPlanId: 'bulk-remediation',
      outcome: 'advanced',
    });
  });

  it.each([
    ['a failed create with no Plan', true],
    ['a create whose Plan is not readable', false],
  ])('reports %s as a conflict', async (_label, createFails) => {
    const test = baselineHarness();
    if (createFails) test.bulk.create.mockRejectedValue(new Error('write failed'));
    arrangeBulk(test, sourcePlan(), [null]);
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      bulkPlanId: 'bulk-remediation',
      outcome: 'conflict',
    });
    expect(test.bulk.startApproved).not.toHaveBeenCalled();
  });

  it('validates a draft remediation Plan and then starts it with an approval digest', async () => {
    const test = baselineHarness();
    arrangeBulk(test, sourcePlan(), [remediation({ status: 'draft' }), remediation()]);
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      bulkPlanId: 'bulk-remediation',
      outcome: 'started',
    });
    expect(test.bulk.create).not.toHaveBeenCalled();
    expect(test.bulk.transition).toHaveBeenCalledWith({
      controlTenantId: 'control',
      id: 'bulk-remediation',
      version: 1,
      from: 'draft',
      to: 'ready',
      stage: 'validate',
      now: BASELINE_NOW,
      audit: expectedBaselineAudit(
        'agent.baseline.remediation_plan_validated',
        'agent_bulk_plan',
        'bulk-remediation',
        { assignment_id: 'assignment-1', drift_digest: 'drift-1' }
      ),
    });
    const approvalDigest = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-baseline-remediation-approval-v1',
        assignment_id: 'assignment-1',
        baseline_id: 'baseline-1',
        baseline_version: 2,
        baseline_digest: 'baseline-digest',
        drift_digest: 'drift-1',
        bulk_plan_id: 'bulk-remediation',
        bulk_plan_version: 1,
        plan_digest: 'remediation-digest',
        target_snapshot_digest: 'r-target',
        canary_digest: 'r-canary',
      })
    );
    expect(test.bulk.startApproved).toHaveBeenCalledWith({
      controlTenantId: 'control',
      id: 'bulk-remediation',
      version: 1,
      definitionDigest: 'remediation-digest',
      targetSnapshotDigest: 'r-target',
      canaryDigest: 'r-canary',
      approvedBy: 'admin-creator',
      approvalDigest,
      now: BASELINE_NOW,
      audit: expectedBaselineAudit(
        'agent.baseline.remediation_started',
        'agent_bulk_plan',
        'bulk-remediation',
        { assignment_id: 'assignment-1', drift_digest: 'drift-1', approval_digest: approvalDigest }
      ),
    });
  });

  it('reports a lost draft-to-ready transition as a conflict', async () => {
    const test = baselineHarness();
    test.bulk.transition.mockResolvedValue(false);
    arrangeBulk(test, sourcePlan(), [remediation({ status: 'draft' })]);
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      bulkPlanId: 'bulk-remediation',
      outcome: 'conflict',
    });
    expect(test.bulk.startApproved).not.toHaveBeenCalled();
  });

  it('reports a lost start as a conflict', async () => {
    const test = baselineHarness();
    test.bulk.startApproved.mockResolvedValue(false);
    arrangeBulk(test, sourcePlan(), [remediation()]);
    await expect(test.coordinator.run('control', 'assignment-1')).resolves.toEqual({
      assignmentId: 'assignment-1',
      bulkPlanId: 'bulk-remediation',
      outcome: 'conflict',
    });
    expect(test.bulk.transition).not.toHaveBeenCalled();
  });

  it('reads the remediation Plan by its reserved id at version 1', async () => {
    const test = baselineHarness();
    arrangeBulk(test, sourcePlan(), [remediation()]);
    await test.coordinator.run('control', 'assignment-1');
    expect(test.bulk.get).toHaveBeenCalledWith('control', 'bulk-remediation', 1);
    expect(vi.mocked(test.settings.get)).toHaveBeenCalledWith('tenant-1');
  });
});
