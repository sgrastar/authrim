import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeJson, sha256Base64Url } from '../core';
import {
  CLIENT_STEP,
  NOW,
  clientReadBody,
  definitionOf,
  expectedManagementCall,
  expectedPlanAudit,
  planHarness,
  planRecord,
  planRequest,
} from './helpers/mut-plans-config-fixtures';
import type { ManagementOperationResult } from '../platform/ports';

const APPLY = 'admin.write.configuration.plan.apply';
const STEP_2 = {
  ...CLIENT_STEP,
  id: 'step-2',
  input: { client_id: 'client-target', description: 'd' },
};
const twoSteps = planRecord({ definition: definitionOf(CLIENT_STEP, STEP_2) });
const cancelled = planRecord({ cancelledAt: NOW });

describe('configuration Plan adapter: apply execution', () => {
  let h: ReturnType<typeof planHarness>;
  let writes: ManagementOperationResult[];
  beforeEach(() => {
    h = planHarness();
    writes = [];
    h.repository.getPlan.mockResolvedValue(twoSteps);
    h.managementApi.execute.mockImplementation(async (incoming) =>
      incoming.operation === 'admin.read.clients.get'
        ? clientReadBody()
        : (writes.shift() ?? { status: 200, body: { client: { client_id: 'client-target' } } })
    );
  });

  it('executes every step with its bound precondition and idempotency key, in order', async () => {
    const incoming = planRequest('mode_b', APPLY);
    const result = await h.build().execute(incoming);
    expect(result).toEqual({
      status: 200,
      body: { plan: { id: 'acp-1', version: 1, status: 'completed', applied_step_count: 2 } },
      executionStatus: 'definite',
    });
    const calls = h.managementApi.execute.mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.operation)).toEqual([
      'admin.read.clients.get',
      'admin.read.clients.get',
      'admin.write.clients.metadata',
      'admin.write.clients.metadata',
    ]);
    expect(calls[2]).toEqual(
      expectedManagementCall(
        incoming,
        'admin.write.clients.metadata',
        ['admin:clients:write'],
        { ...CLIENT_STEP.input, resource_version: 'resource-v1' },
        'acp-1:1:step-1:plan-digest'
      )
    );
    expect(calls[3].idempotencyKey).toBe('acp-1:1:step-2:plan-digest');
    expect(calls[3].input).toEqual({ ...STEP_2.input, resource_version: 'resource-v1' });

    const resultDigest = await sha256Base64Url(
      canonicalizeJson({ client: { client_id: 'client-target' } })
    );
    expect(h.repository.writeAudit).toHaveBeenNthCalledWith(
      1,
      expectedPlanAudit(incoming, 'agent.configuration.plan.step.executed', 'acp-1', NOW, {
        step_id: 'step-1',
        operation: 'admin.write.clients.metadata',
        owner_status: 200,
        result_digest: resultDigest,
      })
    );
    expect(h.repository.completePlan).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      id: 'acp-1',
      version: 1,
      definitionDigest: 'plan-digest',
      status: 'completed',
      result: { applied_steps: 2 },
      appliedStepCount: 2,
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.completed', 'acp-1', NOW, {
        applied_steps: 2,
      }),
    });
    // Ownership read plus a cancellation check before and after each step.
    expect(h.repository.getPlan).toHaveBeenCalledTimes(5);
    expect(h.repository.getPlan).toHaveBeenLastCalledWith('tenant-1', 'acp-1', 1);
  });

  it('records an indeterminate owner result as a failed Plan and stops', async () => {
    writes.push({ status: 502, body: {}, executionStatus: 'indeterminate' });
    const incoming = planRequest('mode_b', APPLY);
    await expect(h.build().execute(incoming)).resolves.toEqual({
      status: 503,
      body: { error: 'AGENT_PLAN_STEP_INDETERMINATE' },
      executionStatus: 'indeterminate',
    });
    expect(h.repository.writeAudit).toHaveBeenCalledTimes(1);
    expect(h.repository.writeAudit).toHaveBeenCalledWith(
      expectedPlanAudit(incoming, 'agent.configuration.plan.step.indeterminate', 'acp-1', NOW, {
        step_id: 'step-1',
        operation: 'admin.write.clients.metadata',
      })
    );
    expect(h.repository.completePlan).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      id: 'acp-1',
      version: 1,
      definitionDigest: 'plan-digest',
      status: 'failed',
      result: { error: 'AGENT_PLAN_STEP_INDETERMINATE', step_id: 'step-1' },
      appliedStepCount: 0,
      failedStepId: 'step-1',
      failureKind: 'indeterminate',
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.failed', 'acp-1', NOW, {
        step_id: 'step-1',
        failure_kind: 'indeterminate',
      }),
    });
    expect(h.managementApi.execute).toHaveBeenCalledTimes(3);
  });

  it('records an owner rejection of the second step with one applied step', async () => {
    writes.push({ status: 200, body: {} }, { status: 422, body: { error: 'bad' } });
    const incoming = planRequest('mode_b', APPLY);
    await expect(h.build().execute(incoming)).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STEP_FAILED', step_id: 'step-2' },
      executionStatus: 'definite',
    });
    expect(h.repository.writeAudit).toHaveBeenLastCalledWith(
      expectedPlanAudit(incoming, 'agent.configuration.plan.step.failed', 'acp-1', NOW, {
        step_id: 'step-2',
        operation: 'admin.write.clients.metadata',
        owner_status: 422,
      })
    );
    expect(h.repository.completePlan).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      id: 'acp-1',
      version: 1,
      definitionDigest: 'plan-digest',
      status: 'failed',
      result: { step_id: 'step-2', owner_status: 422 },
      appliedStepCount: 1,
      failedStepId: 'step-2',
      failureKind: 'owner_rejected',
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.failed', 'acp-1', NOW, {
        step_id: 'step-2',
        owner_status: 422,
      }),
    });
  });

  it.each([199, 300, 404])('treats owner status %i as a rejection', async (status) => {
    writes.push({ status, body: {} });
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toMatchObject({
      status: 409,
      body: { error: 'AGENT_PLAN_STEP_FAILED', step_id: 'step-1' },
    });
  });

  it.each([201, 299])('treats owner status %i as success', async (status) => {
    writes.push({ status, body: {} }, { status, body: {} });
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toMatchObject({
      status: 200,
      body: { plan: { applied_step_count: 2 } },
    });
  });

  it('finishes as cancelled when cancellation lands before the first step', async () => {
    h.repository.getPlan
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelled);
    const incoming = planRequest('mode_b', APPLY);
    await expect(h.build().execute(incoming)).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_CANCELLED', plan_id: 'acp-1', version: 1, applied_step_count: 0 },
      executionStatus: 'definite',
    });
    expect(h.repository.failCancelledRunningPlan).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      id: 'acp-1',
      version: 1,
      definitionDigest: 'plan-digest',
      result: { error: 'AGENT_PLAN_CANCELLED', applied_step_count: 0, failed_step_id: 'step-1' },
      appliedStepCount: 0,
      failedStepId: 'step-1',
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.failed', 'acp-1', NOW, {
        failure_kind: 'plan_cancelled',
        applied_step_count: 0,
        failed_step_id: 'step-1',
      }),
    });
    expect(
      h.managementApi.execute.mock.calls.filter(([call]) =>
        call.operation.startsWith('admin.write')
      )
    ).toHaveLength(0);
  });

  it('finishes as cancelled after the step during which cancellation landed', async () => {
    h.repository.getPlan
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelled);
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toMatchObject({
      status: 409,
      body: { error: 'AGENT_PLAN_CANCELLED', applied_step_count: 1 },
    });
    expect(h.repository.failCancelledRunningPlan).toHaveBeenCalledWith(
      expect.objectContaining({ appliedStepCount: 1, failedStepId: 'step-1' })
    );
    expect(h.repository.completePlan).not.toHaveBeenCalled();
  });

  it('finishes as cancelled without a failed step when completion lost to a cancel', async () => {
    h.repository.completePlan.mockResolvedValue(false);
    h.repository.getPlan
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(cancelled);
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toMatchObject({
      status: 409,
      body: { error: 'AGENT_PLAN_CANCELLED', applied_step_count: 2 },
    });
    const call = h.repository.failCancelledRunningPlan.mock.calls[0][0];
    expect(call.failedStepId).toBeUndefined();
    expect(call.result).toEqual({
      error: 'AGENT_PLAN_CANCELLED',
      applied_step_count: 2,
      failed_step_id: null,
    });
    expect(call.audit.metadata.failed_step_id).toBeNull();
  });

  it.each<[label: string, write: ManagementOperationResult]>([
    ['indeterminate', { status: 502, body: {}, executionStatus: 'indeterminate' }],
    ['rejected', { status: 400, body: {} }],
  ])('reconciles a lost %s failure record with a concurrent cancel', async (_label, write) => {
    writes.push(write);
    h.repository.completePlan.mockResolvedValue(false);
    h.repository.getPlan
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(cancelled);
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toMatchObject({
      status: 409,
      body: { error: 'AGENT_PLAN_CANCELLED', applied_step_count: 0 },
    });
    expect(h.repository.failCancelledRunningPlan).toHaveBeenCalledWith(
      expect.objectContaining({ appliedStepCount: 0, failedStepId: 'step-1' })
    );
  });

  it('reports a conflict when the cancelled-failure transition is lost', async () => {
    h.repository.failCancelledRunningPlan.mockResolvedValue(false);
    h.repository.getPlan
      .mockResolvedValueOnce(twoSteps)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelled);
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
  });
});
