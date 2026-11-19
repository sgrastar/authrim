import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  computeAgentBulkChildCapabilityDigest,
  sha256Base64Url,
  type JsonValue,
} from '../core';
import type { ManagementOperationResult } from '../platform/ports';
import {
  BULK_CLIENT_STEP,
  BULK_LOGIN_STEP,
  BULK_NOW,
  bulkDefinition,
  bulkExecution,
  bulkHarness,
  expectedBulkAudit,
} from './helpers/mut-plans-bulk-fixtures';

const ok = (body: JsonValue): ManagementOperationResult => ({
  status: 200,
  body,
  executionStatus: 'definite',
});
const checkpoint = { snapshots: [{ step_id: 'step-1', resource_version: 'rv-1' }] };
const applying = (extra = {}) =>
  bulkExecution({
    stage: 'apply',
    executionAttempt: 1,
    executionFence: 1,
    preconditionSnapshotDigest: 'snapshot-digest',
    result: checkpoint,
    waveNumber: 2,
    ...extra,
  });

describe('Bulk coordinator: child claim and capability binding', () => {
  it('claims with a digest over the exact child binding and records progress', async () => {
    const test = bulkHarness([applying()], {}, 'custom-owner');
    test.executor.execute.mockResolvedValue(ok({}));
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'advanced',
      executionId: 'execution-1',
      stage: 'apply',
    });
    const binding = {
      purpose: 'authrim-agent-bulk-child-v1' as const,
      controlTenantId: 'control',
      targetTenantId: 'tenant-a',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
      executionId: 'execution-1',
      executionAttempt: 2,
      executionFence: 2,
      stage: 'apply' as const,
      planDigest: 'plan-digest',
      approvalDigest: 'approval-digest',
      preconditionSnapshotDigest: 'snapshot-digest',
      expiresAt: BULK_NOW + 60_000,
    };
    const digest = await computeAgentBulkChildCapabilityDigest(binding);
    expect(test.repository.claimTenant).toHaveBeenCalledWith({
      controlTenantId: 'control',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
      executionId: 'execution-1',
      expectedStage: 'apply',
      ownerId: 'custom-owner',
      leaseExpiresAt: BULK_NOW + 60_000,
      childCapabilityDigest: digest,
      childCapabilityExpiresAt: BULK_NOW + 60_000,
      now: BULK_NOW,
    });
    expect(test.repository.setRunningProgress).toHaveBeenCalledWith({
      controlTenantId: 'control',
      id: 'bulk-1',
      version: 1,
      stage: 'apply',
      currentWave: 2,
      now: BULK_NOW,
    });
    expect(test.executor.execute).toHaveBeenCalledWith({
      binding,
      childCapabilityDigest: digest,
      issuerOrigin: 'https://tenant-a.auth.example',
      correlationId: 'bulk:execution-1:2:apply',
      operation: 'admin.write.clients.metadata',
      input: { client_id: 'client-1', client_name: 'Updated', resource_version: 'rv-1' },
      idempotencyKey: 'execution-1:2:apply:step-1',
    });
  });

  it('uses the default owner, wave zero and no snapshot digest for a first validation', async () => {
    const test = bulkHarness([bulkExecution()]);
    test.executor.execute.mockResolvedValue(ok({ resource_version: 'rv-1' }));
    await test.coordinator.runPlan('control', 'bulk-1', 1);
    const claim = test.repository.claimTenant.mock.calls[0][0];
    expect(claim.ownerId).toBe('ar-agent-access-bulk-coordinator');
    expect(test.repository.setRunningProgress.mock.calls[0][0].currentWave).toBe(0);
    const { binding } = test.executor.execute.mock.calls[0][0];
    expect(binding).not.toHaveProperty('preconditionSnapshotDigest');
    expect(claim.childCapabilityDigest).toBe(await computeAgentBulkChildCapabilityDigest(binding));
  });

  it('stops on a lost claim without running the child', async () => {
    const test = bulkHarness([bulkExecution()]);
    test.repository.claimTenant.mockResolvedValue(false);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'conflict',
    });
    expect(test.repository.setRunningProgress).not.toHaveBeenCalled();
    expect(test.executor.execute).not.toHaveBeenCalled();
  });

  it('stops when the claimed execution can no longer be read', async () => {
    const test = bulkHarness([bulkExecution()]);
    test.repository.getTenantExecution.mockResolvedValue(null);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'conflict',
    });
    expect(test.executor.execute).not.toHaveBeenCalled();
  });
});

describe('Bulk coordinator: validate stage', () => {
  it('checkpoints every step version and advances to apply with a digest', async () => {
    const test = bulkHarness([bulkExecution()], {
      definition: bulkDefinition(BULK_CLIENT_STEP, BULK_LOGIN_STEP),
    });
    test.executor.execute
      .mockResolvedValueOnce(ok({ resource_version: 'rv-1' }))
      .mockResolvedValueOnce(ok({ snapshot: { version: 'settings-1' } }));
    await test.coordinator.runPlan('control', 'bulk-1', 1);
    expect(test.executor.execute.mock.calls.map(([call]) => [call.operation, call.input])).toEqual([
      ['admin.read.clients.get', { client_id: 'client-1' }],
      ['admin.read.login-ui.inspect', {}],
    ]);
    const value = {
      snapshots: [
        { step_id: 'step-1', resource_version: 'rv-1' },
        { step_id: 'step-brand', resource_version: 'settings-1' },
      ],
    };
    const digest = await sha256Base64Url(canonicalizeJson(value));
    expect(test.repository.advanceTenantStage).toHaveBeenCalledWith({
      controlTenantId: 'control',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
      executionId: 'execution-1',
      executionAttempt: 1,
      executionFence: 1,
      from: 'validate',
      to: 'apply',
      preconditionSnapshotDigest: digest,
      checkpoint: value,
      checkpointDigest: digest,
      now: BULK_NOW,
      audit: expectedBulkAudit(test.plan, 'agent.bulk_tenant.validated', 'execution-1', {
        target_tenant_id: 'tenant-a',
        stage: 'validate',
        next_stage: 'apply',
        precondition_snapshot_digest: digest,
      }),
    });
  });

  it.each([
    ['a non-200 read', { status: 404, body: { resource_version: 'rv-1' } }, BULK_CLIENT_STEP],
    ['a non-string client version', ok({ resource_version: 3 }), BULK_CLIENT_STEP],
    ['a non-object body', ok(['rv-1']), BULK_CLIENT_STEP],
    ['a missing Login UI version', ok({ snapshot: {} }), BULK_LOGIN_STEP],
  ])('fails validation on %s', async (_label, read, step) => {
    const test = bulkHarness([bulkExecution()], { definition: bulkDefinition(step) });
    test.executor.execute.mockResolvedValue(read);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'advanced',
      stage: 'validate',
    });
    expect(test.execution()).toMatchObject({
      status: 'failed',
      result: {
        target_tenant_id: 'tenant-a',
        stage: 'validate',
        status: 'failed',
        failure_kind: 'validation_failed',
      },
    });
    expect(test.repository.advanceTenantStage).not.toHaveBeenCalled();
  });

  it.each([
    ['an unsupported operation', { ...BULK_CLIENT_STEP, operation: 'admin.write.users.suspend' }],
    ['a missing client id', { ...BULK_CLIENT_STEP, input: { client_name: 'x' } }],
  ])('fails the child on %s without calling the owner', async (_label, step) => {
    const test = bulkHarness([bulkExecution()], { definition: bulkDefinition(step) });
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'advanced',
      executionId: 'execution-1',
      stage: 'validate',
    });
    expect(test.executor.execute).not.toHaveBeenCalled();
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failureKind: 'child_execution_error' })
    );
    expect(test.repository.transition).not.toHaveBeenCalled();
  });

  it('fails the child when the stage advance conflicts', async () => {
    const test = bulkHarness([bulkExecution()]);
    test.executor.execute.mockResolvedValue(ok({ resource_version: 'rv-1' }));
    test.repository.advanceTenantStage.mockResolvedValue(false);
    await test.coordinator.runPlan('control', 'bulk-1', 1);
    expect(test.execution()).toMatchObject({
      status: 'failed',
      result: { failure_kind: 'child_execution_error' },
    });
  });
});

describe('Bulk coordinator: apply stage', () => {
  it.each([
    ['a missing checkpoint', { result: undefined }],
    ['a checkpoint without snapshots', { result: { snapshots: 'x' } }],
    [
      'a checkpoint without this step',
      { result: { snapshots: [{ step_id: 'other', resource_version: 'rv' }] } },
    ],
    [
      'a non-string snapshot version',
      { result: { snapshots: [{ step_id: 'step-1', resource_version: 1 }] } },
    ],
  ])('treats %s as indeterminate and pauses the Plan', async (_label, extra) => {
    const test = bulkHarness([applying(extra)]);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toEqual({
      planId: 'bulk-1',
      version: 1,
      outcome: 'paused',
      reason: 'indeterminate',
    });
    expect(test.executor.execute).not.toHaveBeenCalled();
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'indeterminate', failureKind: 'child_execution_error' })
    );
  });

  it.each([
    [412, 'precondition_failed'],
    [409, 'owner_rejected'],
    [199, 'owner_rejected'],
    [300, 'owner_rejected'],
  ])('fails the child on owner status %i as %s', async (status, kind) => {
    const test = bulkHarness([applying()]);
    test.executor.execute.mockResolvedValue({ status, body: {}, executionStatus: 'definite' });
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'advanced',
      stage: 'apply',
    });
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failureKind: kind })
    );
    expect(test.repository.advanceTenantStage).not.toHaveBeenCalled();
  });

  it('advances an applied child to verify with the validated snapshot digest', async () => {
    const test = bulkHarness([applying()]);
    test.executor.execute.mockResolvedValue({ status: 299, body: {}, executionStatus: 'definite' });
    await test.coordinator.runPlan('control', 'bulk-1', 1);
    expect(test.repository.advanceTenantStage).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAttempt: 2,
        executionFence: 2,
        from: 'apply',
        to: 'verify',
        preconditionSnapshotDigest: 'snapshot-digest',
        checkpoint,
        checkpointDigest: 'snapshot-digest',
        audit: expectedBulkAudit(test.plan, 'agent.bulk_tenant.applied', 'execution-1', {
          target_tenant_id: 'tenant-a',
          stage: 'apply',
          next_stage: 'verify',
          precondition_snapshot_digest: 'snapshot-digest',
        }),
      })
    );
  });
});

describe('Bulk coordinator: verify stage', () => {
  const verifying = () =>
    bulkExecution({
      stage: 'verify',
      preconditionSnapshotDigest: 'snapshot-digest',
      result: checkpoint,
    });

  it('records success with an info-level audit and no failure kind', async () => {
    const test = bulkHarness([verifying()]);
    test.executor.execute.mockResolvedValue(
      ok({ client: { client_id: 'other-id', client_name: 'Updated' } })
    );
    await test.coordinator.runPlan('control', 'bulk-1', 1);
    const result = { target_tenant_id: 'tenant-a', stage: 'verify', status: 'succeeded' };
    const resultDigest = await sha256Base64Url(canonicalizeJson(result));
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        result,
        resultDigest,
        failureKind: undefined,
        audit: expectedBulkAudit(test.plan, 'agent.bulk_tenant.succeeded', 'execution-1', {
          target_tenant_id: 'tenant-a',
          stage: 'verify',
          result_digest: resultDigest,
        }),
      })
    );
  });

  it.each([
    [
      'a non-200 read',
      { status: 500, body: { client: { client_name: 'Updated' } } },
      BULK_CLIENT_STEP,
    ],
    ['a mismatched field', ok({ client: { client_name: 'Old' } }), BULK_CLIENT_STEP],
    ['a missing client', ok({}), BULK_CLIENT_STEP],
    [
      'a locale mismatch',
      ok({
        snapshot: {
          values: { 'login-ui.brand_name': 'Example', 'login-ui.supported_locales': 'en,ja' },
        },
      }),
      BULK_LOGIN_STEP,
    ],
    [
      'an unmapped field',
      ok({ snapshot: { values: { 'login-ui.brand_name': 'Example' } } }),
      { ...BULK_LOGIN_STEP, input: { brandName: 'Example', other: 'x' } },
    ],
    ['missing values', ok({ snapshot: {} }), BULK_LOGIN_STEP],
  ])('fails verification on %s', async (_label, read, step) => {
    const test = bulkHarness([verifying()], { definition: bulkDefinition(step) });
    test.executor.execute.mockResolvedValue(read);
    await test.coordinator.runPlan('control', 'bulk-1', 1);
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failureKind: 'verification_failed' })
    );
  });

  it('fails verification for a step the owner adapter cannot read', async () => {
    const test = bulkHarness([verifying()], {
      definition: bulkDefinition({ ...BULK_CLIENT_STEP, operation: 'admin.write.other' }),
    });
    await test.coordinator.runPlan('control', 'bulk-1', 1);
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failureKind: 'child_execution_error' })
    );
  });

  it('propagates a completion conflict that cannot be recorded', async () => {
    const test = bulkHarness([verifying()]);
    test.executor.execute.mockResolvedValue(ok({ client: { client_name: 'Updated' } }));
    test.repository.completeTenant.mockResolvedValue(false);
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).rejects.toThrow(
      'Bulk child completion conflicted'
    );
  });
});
