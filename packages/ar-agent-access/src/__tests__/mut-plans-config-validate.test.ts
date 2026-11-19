import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_STEP,
  LOGIN_STEP,
  NOW,
  clientReadBody,
  customCatalog,
  definitionOf,
  expectedManagementCall,
  expectedPlanAudit,
  loginReadBody,
  planHarness,
  planRecord,
  planRequest,
} from './helpers/mut-plans-config-fixtures';

const VALIDATE = 'admin.write.configuration.plan.validate';
const draft = (overrides = {}) =>
  planRecord({ status: 'draft', stage: 'validate', diff: undefined, ...overrides });

describe('configuration Plan adapter: Plan reference and ownership', () => {
  let h: ReturnType<typeof planHarness>;
  beforeEach(() => {
    h = planHarness();
  });

  it.each([
    ['an embedded space', { plan_id: 'x y', version: 1 }],
    ['an over-long id', { plan_id: 'a'.repeat(129), version: 1 }],
    ['an empty id', { plan_id: '', version: 1 }],
    ['a numeric id', { plan_id: 5, version: 1 }],
    ['a string version', { plan_id: 'acp-1', version: '1' }],
    ['a fractional version', { plan_id: 'acp-1', version: 1.5 }],
    ['version zero', { plan_id: 'acp-1', version: 0 }],
    ['an unsafe version', { plan_id: 'acp-1', version: Number.MAX_SAFE_INTEGER + 1 }],
  ])('treats %s as an unknown Plan without reading storage', async (_label, input) => {
    await expect(
      h.build().execute(planRequest('mode_b', 'admin.read.configuration.plan.status', input))
    ).resolves.toEqual({
      status: 404,
      body: { error: 'AGENT_PLAN_NOT_FOUND' },
      executionStatus: 'definite',
    });
    expect(h.repository.getPlan).not.toHaveBeenCalled();
  });

  it('accepts the longest allowed id and reads it by tenant, id and version', async () => {
    const id = `A-z.0_~${'b'.repeat(121)}`;
    h.repository.getPlan.mockResolvedValue(planRecord({ id }));
    await expect(
      h
        .build()
        .execute(
          planRequest('mode_b', 'admin.read.configuration.plan.status', { plan_id: id, version: 7 })
        )
    ).resolves.toMatchObject({ status: 200 });
    expect(h.repository.getPlan).toHaveBeenCalledWith('tenant-1', id, 7);
  });

  it.each([
    ['Grant', { grantId: 'grant-other' }],
    ['Grant generation', { grantGeneration: 2 }],
    ['consent version', { consentVersion: 2 }],
    ['actor', { actorSub: 'machine:other' }],
    ['client', { clientId: 'client-other' }],
  ])('hides a Plan bound to another %s', async (_label, overrides) => {
    h.repository.getPlan.mockResolvedValue(planRecord(overrides));
    await expect(
      h.build().execute(planRequest('mode_b', 'admin.read.configuration.plan.status'))
    ).resolves.toMatchObject({ status: 404, body: { error: 'AGENT_PLAN_NOT_FOUND' } });
  });

  it('returns 404 when storage has no such Plan', async () => {
    h.repository.getPlan.mockResolvedValue(null);
    await expect(
      h.build().execute(planRequest('mode_b', 'admin.read.configuration.plan.diff'))
    ).resolves.toMatchObject({ status: 404, body: { error: 'AGENT_PLAN_NOT_FOUND' } });
  });

  it('returns only the digest-bound diff for a diff read', async () => {
    h.repository.getPlan.mockResolvedValue(planRecord({ diff: { changes: [{ a: 1 }] } }));
    await expect(
      h.build().execute(planRequest('mode_b', 'admin.read.configuration.plan.diff'))
    ).resolves.toEqual({
      status: 200,
      body: {
        plan: { id: 'acp-1', version: 1, digest: 'plan-digest', diff: { changes: [{ a: 1 }] } },
      },
      executionStatus: 'definite',
    });
    h.repository.getPlan.mockResolvedValue(planRecord({ diff: undefined }));
    const result = await h
      .build()
      .execute(planRequest('mode_b', 'admin.read.configuration.plan.diff'));
    expect(result.body).toEqual({
      plan: { id: 'acp-1', version: 1, digest: 'plan-digest', diff: null },
    });
  });

  it('returns the public status projection with explicit nulls for unset fields', async () => {
    h.repository.getPlan.mockResolvedValue(
      planRecord({ definition: undefined, diff: undefined, payloadPurgedAt: undefined })
    );
    const result = await h
      .build()
      .execute(planRequest('mode_b', 'admin.read.configuration.plan.status'));
    expect(result.body).toEqual({
      plan: {
        id: 'acp-1',
        version: 1,
        digest: 'plan-digest',
        status: 'ready',
        stage: 'apply',
        definition: null,
        snapshot: null,
        diff: null,
        validation: null,
        result: null,
        applied_step_count: 0,
        failed_step_id: null,
        failure_kind: null,
        expires_at: NOW + 60_000,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        payload_purged_at: null,
      },
    });
  });

  it('returns every populated status field as stored', async () => {
    const full = planRecord({
      status: 'failed',
      stage: 'verify',
      snapshot: { targets: [] },
      diff: { changes: [] },
      validation: { valid: true },
      result: { step_id: 'step-1' },
      appliedStepCount: 2,
      failedStepId: 'step-1',
      failureKind: 'owner_rejected',
      cancelledAt: NOW - 1,
      cancelledBy: 'admin-1',
      cancelReason: 'agent_requested',
      payloadPurgedAt: NOW - 2,
    });
    h.repository.getPlan.mockResolvedValue(full);
    const result = await h
      .build()
      .execute(planRequest('mode_b', 'admin.read.configuration.plan.status'));
    expect(result.body).toEqual({
      plan: {
        id: 'acp-1',
        version: 1,
        digest: 'plan-digest',
        status: 'failed',
        stage: 'verify',
        definition: full.definition,
        snapshot: { targets: [] },
        diff: { changes: [] },
        validation: { valid: true },
        result: { step_id: 'step-1' },
        applied_step_count: 2,
        failed_step_id: 'step-1',
        failure_kind: 'owner_rejected',
        expires_at: NOW + 60_000,
        cancelled_at: NOW - 1,
        cancelled_by: 'admin-1',
        cancel_reason: 'agent_requested',
        payload_purged_at: NOW - 2,
      },
    });
  });
});

describe('configuration Plan adapter: validate', () => {
  let h: ReturnType<typeof planHarness>;
  beforeEach(() => {
    h = planHarness();
    h.repository.getPlan.mockResolvedValue(draft());
  });

  it.each([
    ['a ready Plan', { status: 'ready' as const }],
    ['a cancelled draft', { cancelledAt: NOW - 1 }],
    ['a purged draft', { definition: undefined }],
  ])('refuses to validate %s', async (_label, overrides) => {
    h.repository.getPlan.mockResolvedValue(draft(overrides));
    await expect(h.build().execute(planRequest('mode_b', VALIDATE))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
    expect(h.managementApi.execute).not.toHaveBeenCalled();
    expect(h.repository.markPlanReady).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-plan-step tool', { ...CLIENT_STEP, operation: 'admin.write.users.suspend' }],
    ['a drifted contract version', { ...CLIENT_STEP, toolContractVersion: '2' }],
  ])('reports contract drift for %s', async (_label, step) => {
    h.repository.getPlan.mockResolvedValue(draft({ definition: definitionOf(step) }));
    await expect(h.build().execute(planRequest('mode_b', VALIDATE))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_CONTRACT_DRIFT' },
      executionStatus: 'definite',
    });
    expect(h.authorization.authorize).not.toHaveBeenCalled();
  });

  it('returns the live authorization denial before reading the target', async () => {
    h.authorization.authorize.mockResolvedValue({
      allowed: false,
      requiresElevation: false,
      code: 'AGENT_GRANT_REVOKED',
      deniedAxis: 'grant',
    });
    await expect(h.build().execute(planRequest('mode_b', VALIDATE))).resolves.toEqual({
      status: 403,
      body: { error: 'AGENT_GRANT_REVOKED', denied_axis: 'grant' },
      executionStatus: 'definite',
    });
    expect(h.managementApi.execute).not.toHaveBeenCalled();
  });

  it('reads the client target through the fixed read tool envelope', async () => {
    const incoming = planRequest('mode_b', VALIDATE);
    await h.build().execute(incoming);
    expect(h.managementApi.execute).toHaveBeenCalledTimes(1);
    expect(h.managementApi.execute).toHaveBeenCalledWith(
      expectedManagementCall(incoming, 'admin.read.clients.get', ['admin:clients:read'], {
        client_id: 'client-target',
      })
    );
  });

  it.each([
    ['a non-200 read', { status: 404, body: { error: 'not_found' } }, null],
    ['a missing resource version', { status: 200, body: { client: {} } }, null],
    ['a missing client', { status: 200, body: { resource_version: 'resource-v1' } }, null],
    ['a non-object body', { status: 200, body: 'resource-v1' }, null],
    ['a changed resource', clientReadBody('resource-v2'), 'resource-v2'],
  ])('fails the precondition on %s', async (_label, read, current) => {
    h.managementApi.execute.mockResolvedValue(read);
    await expect(h.build().execute(planRequest('mode_b', VALIDATE))).resolves.toEqual({
      status: 409,
      body: {
        error: 'AGENT_PLAN_PRECONDITION_FAILED',
        step_id: 'step-1',
        current_resource_version: current,
      },
      executionStatus: 'definite',
    });
    expect(h.repository.markPlanReady).not.toHaveBeenCalled();
  });

  it('does not read a client step whose persisted client_id is not a string', async () => {
    h.repository.getPlan.mockResolvedValue(
      draft({ definition: definitionOf({ ...CLIENT_STEP, input: { client_id: 7 } }) })
    );
    await expect(h.build().execute(planRequest('mode_b', VALIDATE))).resolves.toMatchObject({
      status: 409,
      body: { error: 'AGENT_PLAN_PRECONDITION_FAILED', current_resource_version: null },
    });
    expect(h.managementApi.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['get_client', CLIENT_STEP],
    ['inspect_login_ui_settings', LOGIN_STEP],
  ])('fails closed when the catalog lacks the %s read tool', async (name, step) => {
    const catalog = customCatalog((tools) => tools.filter((tool) => tool.name !== name));
    h.repository.getPlan.mockResolvedValue(draft({ definition: definitionOf(step) }));
    await expect(
      h.build({ catalog }).execute(planRequest('mode_b', VALIDATE))
    ).resolves.toMatchObject({
      status: 409,
      body: { error: 'AGENT_PLAN_PRECONDITION_FAILED', current_resource_version: null },
    });
    expect(h.managementApi.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-200 read', { status: 503, body: { snapshot: { version: 'settings-v1' } } }],
    ['a missing snapshot', { status: 200, body: { version: 'settings-v1' } }],
    ['a non-string version', { status: 200, body: { snapshot: { version: 1 } } }],
  ])('fails a Login UI precondition on %s', async (_label, read) => {
    h.repository.getPlan.mockResolvedValue(draft({ definition: definitionOf(LOGIN_STEP) }));
    h.managementApi.execute.mockResolvedValue(read);
    await expect(h.build().execute(planRequest('mode_b', VALIDATE))).resolves.toMatchObject({
      status: 409,
      body: {
        error: 'AGENT_PLAN_PRECONDITION_FAILED',
        step_id: 'step-brand',
        current_resource_version: null,
      },
    });
  });

  it('marks a multi-step Plan ready with ordered snapshots, diff and audit', async () => {
    h.repository.getPlan.mockResolvedValue(
      draft({ definition: definitionOf(CLIENT_STEP, LOGIN_STEP) })
    );
    h.managementApi.execute.mockImplementation(async (incoming: { operation: string }) =>
      incoming.operation === 'admin.read.clients.get'
        ? clientReadBody()
        : loginReadBody('settings-v1', { 'login-ui.brand_name': 'Old' })
    );
    const incoming = planRequest('mode_b', VALIDATE);
    incoming.grant.permissions.push('admin:settings:read', 'admin:settings:login_ui:update');
    const result = await h.build().execute(incoming);

    expect(h.managementApi.execute).toHaveBeenNthCalledWith(
      2,
      expectedManagementCall(incoming, 'admin.read.login-ui.inspect', ['admin:settings:read'], {})
    );
    const clientBody = clientReadBody().body;
    const loginBody = { version: 'settings-v1', values: { 'login-ui.brand_name': 'Old' } };
    const changes = [
      {
        step_id: 'step-1',
        operation: CLIENT_STEP.operation,
        before: clientBody,
        after: CLIENT_STEP.input,
      },
      {
        step_id: 'step-brand',
        operation: LOGIN_STEP.operation,
        before: loginBody,
        after: LOGIN_STEP.input,
      },
    ];
    const validation = { valid: true, validated_at: NOW, catalog_version: 'admin-agent-access-v9' };
    expect(h.repository.markPlanReady).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      id: 'acp-1',
      version: 1,
      definitionDigest: 'plan-digest',
      snapshot: {
        targets: [
          { step_id: 'step-1', resource_version: 'resource-v1', value: clientBody },
          { step_id: 'step-brand', resource_version: 'settings-v1', value: loginBody },
        ],
      },
      diff: { changes },
      validation,
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.validated', 'acp-1', NOW, {
        plan_digest: 'plan-digest',
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      plan: {
        id: 'acp-1',
        version: 1,
        digest: 'plan-digest',
        status: 'ready',
        stage: 'apply',
        validation,
        diff: { changes },
        applied_step_count: 0,
        cancelled_at: null,
      },
    });
  });

  it('reports a lost ready transition as a state conflict', async () => {
    h.repository.markPlanReady.mockResolvedValue(false);
    await expect(h.build().execute(planRequest('mode_b', VALIDATE))).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
  });
});
