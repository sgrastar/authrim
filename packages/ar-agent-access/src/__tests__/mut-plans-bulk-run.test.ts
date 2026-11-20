import { describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, sha256Base64Url, type AgentBulkPlanRecord } from '../core';
import {
  BULK_NOW,
  bulkExecution,
  bulkHarness,
  expectedBulkAudit,
} from './helpers/mut-plans-bulk-fixtures';

const settled = (id: string, status: 'succeeded' | 'failed', extra = {}) =>
  bulkExecution({ id, stage: 'verify', status, ...extra });

describe('Bulk coordinator: scheduling', () => {
  it('lists running Plans with the default and explicit limits', async () => {
    const test = bulkHarness([]);
    test.repository.listRunning.mockResolvedValue([]);
    await expect(test.coordinator.runScheduled()).resolves.toEqual([]);
    expect(test.repository.listRunning).toHaveBeenCalledWith(25);
    await test.coordinator.runScheduled(3);
    expect(test.repository.listRunning).toHaveBeenLastCalledWith(3);
  });

  it('keeps advancing one Plan until it stops, bounded by the advance budget', async () => {
    const test = bulkHarness([]);
    const runPlan = vi
      .spyOn(test.coordinator, 'runPlan')
      .mockResolvedValue({ planId: 'bulk-1', version: 1, outcome: 'advanced' });
    await expect(test.coordinator.runScheduled(5, 3)).resolves.toEqual([
      { planId: 'bulk-1', version: 1, outcome: 'advanced' },
    ]);
    expect(runPlan).toHaveBeenCalledTimes(3);
    expect(runPlan).toHaveBeenCalledWith('control', 'bulk-1', 1);
    runPlan.mockClear();
    await test.coordinator.runScheduled();
    expect(runPlan).toHaveBeenCalledTimes(25);
  });

  it('stops advancing as soon as a run does not advance', async () => {
    const test = bulkHarness([]);
    const runPlan = vi
      .spyOn(test.coordinator, 'runPlan')
      .mockResolvedValueOnce({ planId: 'bulk-1', version: 1, outcome: 'advanced' })
      .mockResolvedValueOnce({ planId: 'bulk-1', version: 1, outcome: 'paused', reason: 'x' });
    await expect(test.coordinator.runScheduled()).resolves.toEqual([
      { planId: 'bulk-1', version: 1, outcome: 'paused', reason: 'x' },
    ]);
    expect(runPlan).toHaveBeenCalledTimes(2);
  });

  it('reports idle for a Plan given no advance budget', async () => {
    const test = bulkHarness([]);
    const runPlan = vi.spyOn(test.coordinator, 'runPlan');
    await expect(test.coordinator.runScheduled(25, 0)).resolves.toEqual([
      { planId: 'bulk-1', version: 1, outcome: 'idle' },
    ]);
    expect(runPlan).not.toHaveBeenCalled();
  });
});

describe('Bulk coordinator: Plan gating', () => {
  it.each<[label: string, overrides: Partial<AgentBulkPlanRecord> | null]>([
    ['a missing Plan', null],
    ['a paused Plan', { status: 'paused' }],
    ['a cancelled Plan', { cancelledAt: 5 }],
    ['a purged Plan', { definition: undefined }],
    ['an unapproved Plan', { approvalDigest: undefined }],
  ])('leaves %s idle without reading executions', async (_label, overrides) => {
    const test = bulkHarness([bulkExecution()]);
    test.repository.get.mockResolvedValue(
      overrides === null ? null : { ...test.plan, ...overrides }
    );
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'idle',
    });
    expect(test.repository.get).toHaveBeenCalledWith('control', 'bulk-1', 1);
    expect(test.repository.listTenantExecutions).not.toHaveBeenCalled();
  });

  it('recovers a lease that expires exactly now and pauses with a full audit trail', async () => {
    const stale = bulkExecution({
      status: 'running',
      stage: 'apply',
      executionAttempt: 2,
      executionFence: 4,
      executionLeaseExpiresAt: BULK_NOW,
    });
    const test = bulkHarness([stale]);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'paused',
      reason: 'indeterminate',
    });
    const result = {
      target_tenant_id: 'tenant-a',
      stage: 'apply',
      status: 'indeterminate',
      failure_kind: 'execution_lease_expired',
    };
    const resultDigest = await sha256Base64Url(canonicalizeJson(result));
    expect(test.repository.completeTenant).toHaveBeenCalledWith({
      controlTenantId: 'control',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
      executionId: 'execution-1',
      executionAttempt: 2,
      executionFence: 4,
      status: 'indeterminate',
      result,
      resultDigest,
      failureKind: 'execution_lease_expired',
      now: BULK_NOW,
      audit: expectedBulkAudit(
        test.plan,
        'agent.bulk_tenant.indeterminate',
        'execution-1',
        {
          target_tenant_id: 'tenant-a',
          stage: 'apply',
          result_digest: resultDigest,
          failure_kind: 'execution_lease_expired',
        },
        'warn'
      ),
    });
    expect(test.repository.transition).toHaveBeenCalledWith({
      controlTenantId: 'control',
      id: 'bulk-1',
      version: 1,
      from: 'running',
      to: 'paused',
      stage: 'validate',
      pauseReason: 'indeterminate',
      now: BULK_NOW,
      audit: expectedBulkAudit(
        test.plan,
        'agent.bulk_plan.paused',
        'bulk-1',
        { reason: 'indeterminate' },
        'warn'
      ),
    });
    expect(test.executor.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['a live lease', { executionLeaseExpiresAt: BULK_NOW + 1 }],
    ['no lease', {}],
  ])('does not recover a running execution with %s', async (_label, lease) => {
    const test = bulkHarness([bulkExecution({ status: 'running', ...lease })]);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'idle',
    });
    expect(test.repository.completeTenant).not.toHaveBeenCalled();
    expect(test.repository.transition).not.toHaveBeenCalled();
  });

  it('reports a lost pause transition as a conflict that keeps the reason', async () => {
    const test = bulkHarness([bulkExecution({ status: 'indeterminate', stage: 'apply' })]);
    test.repository.transition.mockResolvedValue(false);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'conflict',
      reason: 'indeterminate',
    });
    expect(test.repository.completeTenant).not.toHaveBeenCalled();
  });

  it('pauses on a failed validation but not on a failed later stage', async () => {
    const failedValidation = bulkHarness([
      bulkExecution({ status: 'failed', stage: 'validate', isCanary: false }),
    ]);
    await expect(
      failedValidation.coordinator.runPlan('control', 'bulk-1', 1)
    ).resolves.toMatchObject({ outcome: 'paused', reason: 'validation_failed' });

    const failedVerify = bulkHarness([settled('execution-1', 'failed', { isCanary: false })]);
    await expect(failedVerify.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'completed',
    });
  });

  it('pauses on a failed canary once validation is over', async () => {
    const test = bulkHarness([
      settled('execution-1', 'failed'),
      bulkExecution({ id: 'execution-2', isCanary: false, stage: 'apply' }),
    ]);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'paused',
      reason: 'canary_failed',
    });
    expect(test.repository.claimTenant).not.toHaveBeenCalled();
  });

  it('does not judge canaries while any tenant is still validating', async () => {
    const test = bulkHarness([
      settled('execution-1', 'failed'),
      bulkExecution({ id: 'execution-2', isCanary: false, status: 'running', stage: 'validate' }),
    ]);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'idle',
    });
    expect(test.repository.transition).not.toHaveBeenCalled();
  });

  it('pauses when a settled wave crosses the failure threshold', async () => {
    const test = bulkHarness([
      settled('execution-1', 'succeeded'),
      settled('execution-2', 'failed', { isCanary: false, waveNumber: 2 }),
      settled('execution-3', 'succeeded', { isCanary: false, waveNumber: 2 }),
      bulkExecution({ id: 'execution-4', isCanary: false, stage: 'apply', waveNumber: 3 }),
    ]);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'paused',
      reason: 'wave_failure_threshold',
    });
    expect(test.repository.claimTenant).not.toHaveBeenCalled();
  });

  it('keeps going when a wave is below threshold or not yet settled', async () => {
    const below = bulkHarness(
      [
        settled('execution-1', 'succeeded'),
        settled('execution-2', 'failed', { isCanary: false, waveNumber: 1 }),
        settled('execution-3', 'succeeded', { isCanary: false, waveNumber: 1 }),
        bulkExecution({ id: 'execution-4', isCanary: false, waveNumber: 1, status: 'running' }),
      ],
      { waveFailureThresholdBasisPoints: 5_000 }
    );
    // Wave 1 is unsettled (one running): no wave decision is made.
    await expect(below.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'idle',
    });

    const settledBelow = bulkHarness(
      [
        settled('execution-1', 'succeeded'),
        settled('execution-2', 'failed', { isCanary: false, waveNumber: 1 }),
        settled('execution-3', 'succeeded', { isCanary: false, waveNumber: 1 }),
        settled('execution-4', 'succeeded', { isCanary: false, waveNumber: 1 }),
      ],
      { waveFailureThresholdBasisPoints: 5_000 }
    );
    await expect(settledBelow.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'completed',
    });
  });

  it('skips wave decisions while a canary is still in flight', async () => {
    const test = bulkHarness([
      bulkExecution({ id: 'execution-1', stage: 'apply', status: 'running' }),
      settled('execution-2', 'failed', { isCanary: false, waveNumber: 1 }),
    ]);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'idle',
    });
  });

  it('completes the Plan with settled counts and an audit row', async () => {
    const test = bulkHarness(
      [
        settled('execution-1', 'succeeded'),
        settled('execution-2', 'succeeded', { isCanary: false }),
        settled('execution-3', 'failed', { isCanary: false }),
      ],
      { waveFailureThresholdBasisPoints: 10_000 }
    );
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'completed',
    });
    expect(test.repository.listRunnableTenantExecutions).toHaveBeenCalledWith({
      controlTenantId: 'control',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
    });
    expect(test.repository.transition).toHaveBeenCalledWith({
      controlTenantId: 'control',
      id: 'bulk-1',
      version: 1,
      from: 'running',
      to: 'completed',
      stage: 'verify',
      now: BULK_NOW,
      audit: expectedBulkAudit(test.plan, 'agent.bulk_plan.completed', 'bulk-1', {
        succeeded: 2,
        failed: 1,
      }),
    });
  });

  it('reports a lost completion as a conflict and an empty Plan as idle', async () => {
    const lost = bulkHarness([settled('execution-1', 'succeeded')]);
    lost.repository.transition.mockResolvedValue(false);
    await expect(lost.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'conflict',
    });

    const empty = bulkHarness([]);
    await expect(empty.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'idle',
    });
    expect(empty.repository.transition).not.toHaveBeenCalled();
  });
});
