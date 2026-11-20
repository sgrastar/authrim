import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_STEP,
  LOGIN_STEP,
  NOW,
  clientReadBody,
  definitionOf,
  expectedPlanAudit,
  loginReadBody,
  planHarness,
  planRecord,
  planRequest,
} from './helpers/mut-plans-config-fixtures';

const CANCEL = 'admin.write.configuration.plan.cancel';
const VERIFY = 'admin.read.configuration.plan.verify';

describe('configuration Plan adapter: cancel', () => {
  let h: ReturnType<typeof planHarness>;
  beforeEach(() => {
    h = planHarness();
  });

  it('returns an already cancelled Plan unchanged without cancelling again', async () => {
    h.repository.getPlan.mockResolvedValue(
      planRecord({ status: 'completed', cancelledAt: NOW - 1, cancelledBy: 'x', cancelReason: 'r' })
    );
    const result = await h.build().execute(planRequest('mode_b', CANCEL));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      plan: { status: 'completed', cancelled_at: NOW - 1, cancelled_by: 'x', cancel_reason: 'r' },
    });
    expect(h.repository.cancelPlan).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'] as const)('refuses to cancel a %s Plan', async (status) => {
    h.repository.getPlan.mockResolvedValue(planRecord({ status }));
    await expect(h.build().execute(planRequest('mode_b', CANCEL))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
    expect(h.repository.cancelPlan).not.toHaveBeenCalled();
  });

  it('cancels a running Plan with the actor, reason and prior status audited', async () => {
    h.repository.getPlan
      .mockResolvedValueOnce(planRecord({ status: 'running' }))
      .mockResolvedValueOnce(
        planRecord({ status: 'running', cancelledAt: NOW, cancelledBy: 'machine:amp-1' })
      );
    const incoming = planRequest('mode_b', CANCEL);
    const result = await h.build().execute(incoming);
    expect(h.repository.cancelPlan).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      id: 'acp-1',
      version: 1,
      cancelledBy: 'machine:amp-1',
      reason: 'agent_requested',
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.cancelled', 'acp-1', NOW, {
        plan_version: 1,
        plan_digest: 'plan-digest',
        prior_status: 'running',
      }),
    });
    expect(result.body).toMatchObject({
      plan: { status: 'running', cancelled_at: NOW, cancelled_by: 'machine:amp-1' },
    });
  });

  it('falls back to the pre-cancel projection when the re-read returns nothing', async () => {
    h.repository.getPlan
      .mockResolvedValueOnce(planRecord({ status: 'draft' }))
      .mockResolvedValueOnce(null);
    const result = await h.build().execute(planRequest('mode_b', CANCEL));
    expect(result).toMatchObject({
      status: 200,
      body: { plan: { status: 'draft', cancelled_at: null } },
    });
  });

  it('reports a lost cancel transition as a conflict', async () => {
    h.repository.cancelPlan.mockResolvedValue(false);
    await expect(h.build().execute(planRequest('mode_b', CANCEL))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
  });
});

describe('configuration Plan adapter: verify', () => {
  let h: ReturnType<typeof planHarness>;
  const completed = (...steps: object[]) =>
    planRecord({ status: 'completed', stage: 'verify', definition: definitionOf(...steps) });
  const loginRequest = () => {
    const incoming = planRequest('mode_b', VERIFY);
    incoming.grant.permissions.push('admin:settings:read', 'admin:settings:login_ui:update');
    return incoming;
  };
  beforeEach(() => {
    h = planHarness();
  });

  it.each([
    ['a ready Plan', planRecord()],
    ['a purged completed Plan', planRecord({ status: 'completed', definition: undefined })],
  ])('refuses to verify %s', async (_label, record) => {
    h.repository.getPlan.mockResolvedValue(record);
    await expect(h.build().execute(planRequest('mode_b', VERIFY))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_NOT_COMPLETED' },
      executionStatus: 'definite',
    });
    expect(h.managementApi.execute).not.toHaveBeenCalled();
  });

  it('reports contract drift and re-authorization denials', async () => {
    h.repository.getPlan.mockResolvedValue(completed({ ...CLIENT_STEP, toolContractVersion: '0' }));
    await expect(h.build().execute(planRequest('mode_b', VERIFY))).resolves.toMatchObject({
      status: 409,
      body: { error: 'AGENT_PLAN_CONTRACT_DRIFT' },
    });
    h.repository.getPlan.mockResolvedValue(completed(CLIENT_STEP));
    h.authorization.authorize.mockResolvedValue({
      allowed: false,
      requiresElevation: false,
      code: 'AGENT_GRANT_EXPIRED',
      deniedAxis: 'grant',
    });
    await expect(h.build().execute(planRequest('mode_b', VERIFY))).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_GRANT_EXPIRED', denied_axis: 'grant' },
    });
    expect(h.managementApi.execute).not.toHaveBeenCalled();
  });

  it('verifies client fields while ignoring the binding keys', async () => {
    h.repository.getPlan.mockResolvedValue(
      completed({
        ...CLIENT_STEP,
        input: { ...CLIENT_STEP.input, resource_version: 'stale', description: null },
      })
    );
    h.managementApi.execute.mockResolvedValue(
      clientReadBody('resource-v9', { client_id: 'client-target', client_name: 'Updated name' })
    );
    await expect(h.build().execute(planRequest('mode_b', VERIFY))).resolves.toEqual({
      status: 200,
      body: {
        plan: {
          id: 'acp-1',
          version: 1,
          verified: true,
          checks: [{ step_id: 'step-1', verified: true }],
        },
      },
      executionStatus: 'definite',
    });
  });

  it('fails verification of a single drifted field while reporting each step', async () => {
    h.repository.getPlan.mockResolvedValue(
      completed(CLIENT_STEP, {
        ...CLIENT_STEP,
        id: 'step-2',
        input: { client_id: 'client-target', description: 'x' },
      })
    );
    h.managementApi.execute.mockResolvedValue(
      clientReadBody('resource-v9', { client_name: 'Updated name', description: 'y' })
    );
    await expect(h.build().execute(planRequest('mode_b', VERIFY))).resolves.toEqual({
      status: 409,
      body: {
        plan: {
          id: 'acp-1',
          version: 1,
          verified: false,
          checks: [
            { step_id: 'step-1', verified: true },
            { step_id: 'step-2', verified: false },
          ],
        },
      },
      executionStatus: 'definite',
    });
  });

  it('fails verification when the client cannot be read', async () => {
    h.repository.getPlan.mockResolvedValue(completed(CLIENT_STEP));
    h.managementApi.execute.mockResolvedValue({ status: 404, body: {} });
    await expect(h.build().execute(planRequest('mode_b', VERIFY))).resolves.toMatchObject({
      status: 409,
      body: { plan: { verified: false, checks: [{ step_id: 'step-1', verified: false }] } },
    });
  });

  it('maps Login UI fields, joining locale lists', async () => {
    h.repository.getPlan.mockResolvedValue(
      completed({
        ...LOGIN_STEP,
        input: { logoUrl: 'https://cdn.example/logo.png', supportedLocales: ['ja', 'en'] },
      })
    );
    h.managementApi.execute.mockResolvedValue(
      loginReadBody('settings-v2', {
        'login-ui.logo_url': 'https://cdn.example/logo.png',
        'login-ui.supported_locales': 'ja,en',
      })
    );
    await expect(h.build().execute(loginRequest())).resolves.toMatchObject({
      status: 200,
      body: { plan: { verified: true } },
    });
  });

  it.each([
    [
      'a mismatched locale order',
      { supportedLocales: ['en', 'ja'] },
      { 'login-ui.supported_locales': 'ja,en' },
    ],
    [
      'an unmapped input key',
      { brandName: 'Example', footer: 'x' },
      { 'login-ui.brand_name': 'Example' },
    ],
    ['a missing value', { brandName: 'Example' }, {}],
  ])('fails Login UI verification on %s', async (_label, input, values) => {
    h.repository.getPlan.mockResolvedValue(completed({ ...LOGIN_STEP, input }));
    h.managementApi.execute.mockResolvedValue(loginReadBody('settings-v2', values));
    await expect(h.build().execute(loginRequest())).resolves.toMatchObject({
      status: 409,
      body: { plan: { verified: false } },
    });
  });

  it('fails Login UI verification when the snapshot carries no values object', async () => {
    h.repository.getPlan.mockResolvedValue(completed(LOGIN_STEP));
    h.managementApi.execute.mockResolvedValue({
      status: 200,
      body: { snapshot: { version: 'settings-v2', values: ['Example'] } },
    });
    await expect(h.build().execute(loginRequest())).resolves.toMatchObject({
      status: 409,
      body: { plan: { verified: false } },
    });
  });

  it('ignores the resource_version binding key in a Login UI step', async () => {
    h.repository.getPlan.mockResolvedValue(
      completed({ ...LOGIN_STEP, input: { brandName: 'Example', resource_version: 'settings-v1' } })
    );
    h.managementApi.execute.mockResolvedValue(
      loginReadBody('settings-v2', { 'login-ui.brand_name': 'Example' })
    );
    await expect(h.build().execute(loginRequest())).resolves.toMatchObject({
      status: 200,
      body: { plan: { verified: true } },
    });
  });
});
