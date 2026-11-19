import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_STEP,
  NOW,
  clientReadBody,
  confirmation,
  definitionOf,
  expectedPlanAudit,
  planHarness,
  planRecord,
  planRequest,
} from './helpers/mut-plans-config-fixtures';

const APPLY = 'admin.write.configuration.plan.apply';

describe('configuration Plan adapter: apply preconditions', () => {
  let h: ReturnType<typeof planHarness>;
  beforeEach(() => {
    h = planHarness();
  });

  it('refuses a cancelled Plan even while it is still ready', async () => {
    h.repository.getPlan.mockResolvedValue(planRecord({ cancelledAt: NOW - 1 }));
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_CANCELLED' },
      executionStatus: 'definite',
    });
    expect(h.repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it.each([
    ['a draft Plan', { status: 'draft' as const }],
    ['a Plan expiring exactly now', { expiresAt: NOW }],
    ['an expired Plan', { expiresAt: NOW - 1 }],
    ['a purged Plan', { definition: undefined }],
  ])('refuses %s as a state conflict', async (_label, overrides) => {
    h.repository.getPlan.mockResolvedValue(planRecord(overrides));
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
    expect(h.authorization.authorize).not.toHaveBeenCalled();
    expect(h.repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it('applies a Plan that expires one millisecond after now', async () => {
    h.repository.getPlan.mockResolvedValue(planRecord({ expiresAt: NOW + 1 }));
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toMatchObject({
      status: 200,
    });
  });

  it.each([
    ['a non-plan-step tool', { ...CLIENT_STEP, operation: 'admin.write.users.suspend' }],
    ['a drifted contract version', { ...CLIENT_STEP, toolContractVersion: '9' }],
  ])('reports contract drift for %s before claiming', async (_label, step) => {
    h.repository.getPlan.mockResolvedValue(planRecord({ definition: definitionOf(step) }));
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_CONTRACT_DRIFT' },
      executionStatus: 'definite',
    });
    expect(h.repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it('returns a denial from live re-authorization before reading the target', async () => {
    h.authorization.authorize.mockResolvedValue({ allowed: false, requiresElevation: false });
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toEqual({
      status: 403,
      body: { error: 'AGENT_PLAN_STEP_NOT_DELEGATED', denied_axis: 'unknown' },
      executionStatus: 'definite',
    });
    expect(h.managementApi.execute).not.toHaveBeenCalled();
  });

  it('reports only the failing step on a changed precondition', async () => {
    h.managementApi.execute.mockResolvedValue(clientReadBody('resource-v2'));
    await expect(h.build().execute(planRequest('mode_b', APPLY))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_PRECONDITION_FAILED', step_id: 'step-1' },
      executionStatus: 'definite',
    });
  });

  it('claims apply with the digest and full audit, then stops when the claim is lost', async () => {
    h.repository.claimPlanApply.mockResolvedValue(false);
    const incoming = planRequest('mode_b', APPLY);
    await expect(h.build().execute(incoming)).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
    expect(h.repository.claimPlanApply).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      id: 'acp-1',
      version: 1,
      definitionDigest: 'plan-digest',
      confirmationId: undefined,
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.started', 'acp-1', NOW, {
        plan_digest: 'plan-digest',
      }),
    });
    // Only the precondition read ran; no owner write was attempted.
    expect(h.managementApi.execute).toHaveBeenCalledTimes(1);
  });
});

describe('configuration Plan adapter: apply confirmation', () => {
  let h: ReturnType<typeof planHarness>;
  beforeEach(() => {
    h = planHarness();
  });

  it.each([
    [
      'a Mode B actor without machine-key assurance',
      { assurance: 'public_client_transaction' },
      {},
    ],
    ['a Mode B actor under user consent', {}, { delegationMode: 'user_consent' }],
    ['a Mode A actor under admin pre-authorization', { mode: 'mode_a' }, {}],
  ])('requires a human confirmation for %s', async (_label, actorPatch, grantPatch) => {
    const incoming = planRequest('mode_b', APPLY);
    Object.assign(incoming.actor, actorPatch);
    Object.assign(incoming.grant, grantPatch);
    if ('mode' in actorPatch) incoming.grant.delegationMode = 'admin_pre_authorized';
    await expect(h.build().execute(incoming)).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_PLAN_CONFIRMATION_REQUIRED' },
    });
    expect(h.repository.getPlanConfirmation).toHaveBeenCalledWith(
      'tenant-1',
      'acp-1',
      1,
      'plan-digest'
    );
    expect(h.repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it('skips confirmation entirely for a pre-authorized machine-key Mode B actor', async () => {
    await h.build().execute(planRequest('mode_b', APPLY));
    expect(h.repository.getPlanConfirmation).not.toHaveBeenCalled();
    expect(h.repository.ensurePlanConfirmation).not.toHaveBeenCalled();
  });

  it('creates a digest-bound confirmation capped at the Plan expiry', async () => {
    h.repository.getPlan.mockResolvedValue(planRecord({ actorSub: 'client:client-1' }));
    const incoming = planRequest('mode_a', APPLY);
    const result = await h.build().execute(incoming);
    expect(h.repository.ensurePlanConfirmation).toHaveBeenCalledWith({
      id: expect.stringMatching(/^apc_[0-9a-f-]{36}$/u) as string,
      tenantId: 'tenant-1',
      planId: 'acp-1',
      planVersion: 1,
      planDigest: 'plan-digest',
      grantId: 'grant-1',
      actorSub: 'client:client-1',
      now: NOW,
      expiresAt: NOW + 60_000,
      audit: expectedPlanAudit(
        incoming,
        'agent.configuration.plan.confirmation_requested',
        'acp-1',
        NOW,
        { plan_digest: 'plan-digest' }
      ),
    });
    expect(result).toEqual({
      status: 403,
      body: { error: 'AGENT_PLAN_CONFIRMATION_REQUIRED' },
      urlElicitation: {
        elicitationId: 'apc-1',
        url: 'https://tenant.example/admin/agent-access/plans/acp-1/1/confirm?confirmation_id=apc-1',
        message: 'Review and confirm the immutable configuration Plan before apply.',
      },
    });
  });

  it('caps a confirmation at ten minutes for a long-lived Plan', async () => {
    h.repository.getPlan.mockResolvedValue(
      planRecord({ actorSub: 'client:client-1', expiresAt: NOW + 3_600_000 })
    );
    await h.build().execute(planRequest('mode_a', APPLY));
    expect(h.repository.ensurePlanConfirmation.mock.calls[0][0].expiresAt).toBe(NOW + 600_000);
  });

  it('builds the confirmation URL under a custom base path with encoded ids', async () => {
    h.repository.getPlan.mockResolvedValue(
      planRecord({ actorSub: 'client:client-1', id: 'acp~1', version: 3 })
    );
    h.repository.getPlanConfirmation.mockResolvedValue(
      confirmation({ id: 'apc 1/2', planId: 'acp~1', planVersion: 3 })
    );
    const result = await h
      .build({ confirmationBasePath: '/custom/confirm-base' })
      .execute(planRequest('mode_a', APPLY, { plan_id: 'acp~1', version: 3 }));
    expect(result.urlElicitation).toEqual({
      elicitationId: 'apc 1/2',
      url: 'https://tenant.example/custom/confirm-base/acp~1/3/confirm?confirmation_id=apc%201%2F2',
      message: 'Review and confirm the immutable configuration Plan before apply.',
    });
    expect(h.repository.ensurePlanConfirmation).not.toHaveBeenCalled();
  });

  it('treats a confirmation expiring exactly now as unconfirmed', async () => {
    h.repository.getPlan.mockResolvedValue(planRecord({ actorSub: 'client:client-1' }));
    h.repository.getPlanConfirmation.mockResolvedValue(
      confirmation({ id: 'apc-old', status: 'confirmed', expiresAt: NOW })
    );
    await expect(h.build().execute(planRequest('mode_a', APPLY))).resolves.toMatchObject({
      status: 403,
      urlElicitation: { elicitationId: 'apc-old' },
    });
    expect(h.repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it('binds a live human confirmation into the apply claim', async () => {
    h.repository.getPlan.mockResolvedValue(planRecord({ actorSub: 'client:client-1' }));
    h.repository.getPlanConfirmation.mockResolvedValue(
      confirmation({ id: 'apc-live', status: 'confirmed', expiresAt: NOW + 1 })
    );
    await expect(h.build().execute(planRequest('mode_a', APPLY))).resolves.toMatchObject({
      status: 200,
      body: { plan: { status: 'completed' } },
    });
    expect(h.repository.ensurePlanConfirmation).not.toHaveBeenCalled();
    expect(h.repository.claimPlanApply).toHaveBeenCalledWith(
      expect.objectContaining({ confirmationId: 'apc-live' })
    );
  });
});
