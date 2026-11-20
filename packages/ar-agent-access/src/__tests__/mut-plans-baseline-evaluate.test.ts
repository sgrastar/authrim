import { describe, expect, it } from 'vitest';
import { evaluateAgentBaselineConfiguration } from '../core';
import {
  BASELINE_NOW,
  baselineContext,
  baselineHarness,
  expectedBaselineAudit,
  profile,
} from './helpers/mut-plans-baseline-fixtures';

const candidate = { controlTenantId: 'control', assignmentId: 'assignment-1', lastEvaluatedAt: 42 };

async function evaluation(current: Record<string, unknown> | null, exceptionFields: string[] = []) {
  return evaluateAgentBaselineConfiguration({
    definition: baselineContext().baseline.definition,
    current: [
      {
        stepId: 'client-metadata',
        operation: 'admin.write.clients.metadata',
        current: current as never,
      },
    ],
    exceptionFields,
  });
}

describe('Baseline drift evaluation scheduler', () => {
  it('does nothing without a configuration state reader', async () => {
    const test = baselineHarness({ stateReader: false });
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([]);
    expect(test.baselines.listManagedEvaluationCandidates).not.toHaveBeenCalled();
  });

  it('selects candidates with the fixed fifteen-minute interval and a limit', async () => {
    const test = baselineHarness();
    await test.coordinator.evaluateScheduled();
    expect(test.baselines.listManagedEvaluationCandidates).toHaveBeenCalledWith({
      now: BASELINE_NOW,
      minimumIntervalMs: 900_000,
      limit: 25,
    });
    await test.coordinator.evaluateScheduled(4);
    expect(test.baselines.listManagedEvaluationCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 4 })
    );
  });

  it.each([
    ['a vanished assignment', null],
    ['a retired baseline', baselineContext({}, { status: 'retired' as never })],
    ['a one-time baseline', baselineContext({}, { mode: 'one_time' })],
  ])('leaves %s unchanged', async (_label, context) => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    test.baselines.getAssignmentContext.mockResolvedValue(context);
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'unchanged' },
    ]);
    expect(test.baselines.getAssignmentContext).toHaveBeenCalledWith('control', 'assignment-1');
    expect(test.stateReader.readCurrent).not.toHaveBeenCalled();
    expect(test.baselines.evaluateManagedAssignment).not.toHaveBeenCalled();
  });

  it('stores the evaluation with an optimistic timestamp and a full audit row', async () => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    test.baselines.listExceptions.mockResolvedValue([{ fields: ['other.field'] }]);
    await test.coordinator.evaluateScheduled();
    expect(test.stateReader.readCurrent).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      step: profile.steps[0],
    });
    expect(test.baselines.listExceptions).toHaveBeenCalledWith(
      'control',
      'assignment-1',
      BASELINE_NOW
    );
    const expected = await evaluation({ client_name: 'Changed' });
    expect(test.baselines.evaluateManagedAssignment).toHaveBeenCalledWith({
      controlTenantId: 'control',
      assignmentId: 'assignment-1',
      expectedLastEvaluatedAt: 42,
      status: 'drifted',
      currentDigest: expected.currentDigest,
      evaluatedAt: BASELINE_NOW,
      audit: expectedBaselineAudit(
        'agent.baseline.drift_evaluated',
        'agent_baseline_assignment',
        'assignment-1',
        {
          current_digest: expected.currentDigest,
          drift_status: 'drifted',
          drift_fields: ['client-metadata.client_name'],
          excepted_fields: [],
          evaluation_source: 'scheduler',
        }
      ),
    });
  });

  it('honours an active exception for the drifted field', async () => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    test.baselines.listExceptions.mockResolvedValue([{ fields: ['client-metadata.client_name'] }]);
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'evaluated', driftStatus: 'in_sync' },
    ]);
    expect(test.baselines.evaluateManagedAssignment.mock.calls[0][0].audit.metadata).toMatchObject({
      drift_fields: [],
      excepted_fields: ['client-metadata.client_name'],
    });
    expect(test.baselines.reserveAutoRemediation).not.toHaveBeenCalled();
  });

  it('reports a lost evaluation write as unchanged', async () => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    test.baselines.evaluateManagedAssignment.mockResolvedValue(false);
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'unchanged' },
    ]);
    expect(test.settings.get).not.toHaveBeenCalled();
  });

  it('only reports drift for a report-only baseline', async () => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    test.baselines.getAssignmentContext.mockResolvedValue(
      baselineContext({}, { enforcement: 'report_only' })
    );
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'evaluated', driftStatus: 'drifted' },
    ]);
    expect(test.settings.get).not.toHaveBeenCalled();
    expect(test.baselines.reserveAutoRemediation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Agent access is disabled',
      { enabled: false, bulkCanaryProtected: false },
      'agent_access_disabled',
    ],
    ['the tenant is protected', { enabled: true, bulkCanaryProtected: true }, 'protected_tenant'],
    [
      'disabled and protected',
      { enabled: false, bulkCanaryProtected: true },
      'agent_access_disabled',
    ],
  ])('blocks remediation when %s', async (_label, targetSettings, reason) => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    test.settings.get.mockResolvedValue(targetSettings);
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'blocked', driftStatus: 'drifted', reason },
    ]);
    expect(test.settings.get).toHaveBeenCalledWith('tenant-1');
    expect(test.baselines.reserveAutoRemediation).not.toHaveBeenCalled();
  });

  it('reserves one remediation Plan bound to the drift digest', async () => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'queued', driftStatus: 'drifted' },
    ]);
    const { currentDigest } = await evaluation({ client_name: 'Changed' });
    const reserved = test.baselines.reserveAutoRemediation.mock.calls[0][0];
    expect(reserved.bulkPlanId).toMatch(/^abp_baseline_[0-9a-f-]{36}$/u);
    expect(reserved).toEqual({
      controlTenantId: 'control',
      assignmentId: 'assignment-1',
      driftDigest: currentDigest,
      bulkPlanId: reserved.bulkPlanId,
      bulkPlanVersion: 1,
      requestedAt: BASELINE_NOW,
      audit: expectedBaselineAudit(
        'agent.baseline.remediation_requested',
        'agent_baseline_assignment',
        'assignment-1',
        {
          baseline_id: 'baseline-1',
          baseline_version: 2,
          tenant_id: 'tenant-1',
          drift_digest: currentDigest,
          bulk_plan_id: reserved.bulkPlanId,
          request_source: 'scheduler',
        }
      ),
    });
  });

  it('reports a lost reservation as unchanged', async () => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([candidate]);
    test.baselines.reserveAutoRemediation.mockResolvedValue(false);
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'unchanged', driftStatus: 'drifted' },
    ]);
  });

  it('blocks one failing candidate and continues with the next', async () => {
    const test = baselineHarness();
    test.baselines.listManagedEvaluationCandidates.mockResolvedValue([
      candidate,
      { ...candidate, assignmentId: 'assignment-2' },
    ]);
    test.stateReader.readCurrent
      .mockRejectedValueOnce(new Error('owner unavailable'))
      .mockResolvedValueOnce({ client_name: 'Expected' });
    await expect(test.coordinator.evaluateScheduled()).resolves.toEqual([
      { assignmentId: 'assignment-1', outcome: 'blocked', reason: 'evaluation_unavailable' },
      { assignmentId: 'assignment-2', outcome: 'evaluated', driftStatus: 'in_sync' },
    ]);
  });
});
