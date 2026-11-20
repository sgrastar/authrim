import { beforeEach, describe, expect, it } from 'vitest';
import { buildAgentToolResourceContext, toolSnapshot } from '../core';
import { createAdminToolCatalog } from '../protocol/mcp';
import {
  CLIENT_STEP,
  LOGIN_STEP,
  NOW,
  customCatalog,
  definitionOf,
  expectedPlanAudit,
  planHarness,
  planRequest,
  resealTool,
} from './helpers/mut-plans-config-fixtures';

const catalog = createAdminToolCatalog();
const clientTool = catalog.list().find((tool) => tool.id === 'admin.write.clients.metadata')!;
const loginTool = catalog.list().find((tool) => tool.id === 'admin.write.login-ui.update')!;

function createRequest(steps: object[] = [CLIENT_STEP], mode: 'mode_a' | 'mode_b' = 'mode_b') {
  return planRequest(mode, 'admin.write.configuration.plan.create', {
    definition: definitionOf(...steps) as never,
  });
}

describe('configuration Plan adapter: routing and capabilities', () => {
  let h: ReturnType<typeof planHarness>;
  beforeEach(() => {
    h = planHarness();
  });

  it('rejects an operation outside the fixed Plan surface', async () => {
    await expect(
      h.build().execute(planRequest('mode_b', 'admin.write.configuration.plan.delete'))
    ).resolves.toEqual({
      status: 404,
      body: { error: 'AGENT_CONFIGURATION_OPERATION_NOT_FOUND' },
      executionStatus: 'definite',
    });
  });

  it('lists only delegated plan-step tools plus task sets and scope policies', async () => {
    h.repository.listTaskSets.mockResolvedValue([
      {
        id: 'ats-custom',
        tenantId: 'tenant-1',
        name: 'Custom',
        description: 'Custom task set',
        kind: 'custom',
        managementMode: 'managed',
        currentVersion: 3,
        status: 'active',
        version: {
          catalogVersion: catalog.version,
          tools: [],
          permissions: ['admin:clients:update'],
          digest: 'task-digest',
        },
        createdAt: NOW - 20,
        updatedAt: NOW - 10,
      },
    ]);
    h.repository.listScopePolicies.mockResolvedValue([
      {
        id: 'asp-1',
        tenantId: 'tenant-1',
        name: 'Policy',
        description: 'Tenant policy',
        kind: 'custom',
        managementMode: 'managed',
        currentVersion: 2,
        definition: {
          tenantIds: ['tenant-1'],
          environmentIds: [],
          domains: [],
          resourceIds: [],
          selectors: [],
          allowedFields: [],
          piiMode: 'masked',
          maxPerCall: 10,
          maxPlanOperations: 10,
          maxBulkTenants: 1,
        },
        definitionDigest: 'policy-digest',
        selectorCatalogVersion: 'selectors-1',
        status: 'active',
        createdAt: NOW - 20,
        updatedAt: NOW - 10,
      },
    ]);
    const result = await h
      .build()
      .execute(planRequest('mode_b', 'admin.read.configuration.capabilities', {}));
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.catalog_version).toBe(catalog.version);
    // Only the plan-step tools whose permissions are all delegated; read tools are excluded.
    expect(body.tools).toEqual([toolSnapshot(clientTool)]);
    expect(h.repository.listTaskSets).toHaveBeenCalledWith('tenant-1');
    expect(h.repository.listScopePolicies).toHaveBeenCalledWith('tenant-1');
    const taskSets = body.task_sets as Array<Record<string, unknown>>;
    expect(taskSets.at(-1)).toEqual({
      id: 'ats-custom',
      name: 'Custom',
      version: 3,
      digest: 'task-digest',
    });
    for (const item of taskSets) {
      expect(Object.keys(item).sort()).toEqual(['digest', 'id', 'name', 'version']);
    }
    expect(body.scope_policies).toEqual([
      { id: 'asp-1', name: 'Policy', version: 2, digest: 'policy-digest' },
    ]);
  });

  it('adds the Login UI step tool once its permission is delegated', async () => {
    const incoming = planRequest('mode_b', 'admin.read.configuration.capabilities', {});
    incoming.grant.permissions.push('admin:settings:login_ui:update');
    const result = await h.build().execute(incoming);
    expect((result.body as Record<string, unknown>).tools).toEqual([
      toolSnapshot(clientTool),
      toolSnapshot(loginTool),
    ]);
  });
});

describe('configuration Plan adapter: create', () => {
  let h: ReturnType<typeof planHarness>;
  beforeEach(() => {
    h = planHarness();
  });

  it.each([
    ['missing', undefined],
    ['array', []],
    ['string', 'plan'],
    ['null', null],
  ])('rejects a %s definition before resolution', async (_label, value) => {
    const incoming = planRequest('mode_b', 'admin.write.configuration.plan.create', {
      definition: value as never,
    });
    await expect(h.build().execute(incoming)).resolves.toEqual({
      status: 400,
      body: { error: 'AGENT_PLAN_INVALID_DEFINITION' },
      executionStatus: 'definite',
    });
    expect(h.authorization.authorize).not.toHaveBeenCalled();
    expect(h.repository.createPlan).not.toHaveBeenCalled();
  });

  it('persists the normalized, digest-bound Plan with its full audit row', async () => {
    const incoming = createRequest();
    const result = await h.build().execute(incoming);
    expect(result.status).toBe(201);
    expect(h.repository.createPlan).toHaveBeenCalledTimes(1);
    const persisted = h.repository.createPlan.mock.calls[0][0];
    const digest = persisted.definitionDigest;
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(persisted).toEqual({
      id: expect.stringMatching(/^acp_[0-9a-f-]{36}$/u) as string,
      version: 1,
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 1,
      consentVersion: 1,
      actorSub: 'machine:amp-1',
      clientId: 'client-1',
      definition: definitionOf(CLIENT_STEP),
      definitionDigest: digest,
      risks: ['standard'],
      expiresAt: NOW + 86_400_000,
      payloadPurgeAt: NOW + 86_400_000 + 2_592_000_000,
      now: NOW,
      audit: expectedPlanAudit(incoming, 'agent.configuration.plan.created', persisted.id, NOW, {
        plan_digest: digest,
        step_count: 1,
      }),
    });
    expect(result).toEqual({
      status: 201,
      body: { plan_id: persisted.id, version: 1, digest, status: 'draft' },
      executionStatus: 'definite',
    });
  });

  it('records the acting machine principal ahead of the Grant principal in audit', async () => {
    const incoming = createRequest();
    incoming.actor.machinePrincipalId = 'amp-actor';
    incoming.grant.machinePrincipalId = 'amp-grant';
    await h.build().execute(incoming);
    expect(h.repository.createPlan.mock.calls[0][0].audit.actPrincipalId).toBe('amp-actor');
  });

  it('falls back to the Grant machine principal when the actor carries none', async () => {
    const incoming = createRequest([CLIENT_STEP], 'mode_a');
    incoming.grant.machinePrincipalId = 'amp-grant';
    await h.build().execute(incoming);
    expect(h.repository.createPlan.mock.calls[0][0].audit.actPrincipalId).toBe('amp-grant');
  });

  it('authorizes each step against its concrete resource context', async () => {
    const incoming = createRequest();
    await h.build().execute(incoming);
    expect(h.authorization.authorize).toHaveBeenCalledWith({
      actor: incoming.actor,
      grant: incoming.grant,
      tool: expect.objectContaining({ id: 'admin.write.clients.metadata' }) as unknown,
      resource: buildAgentToolResourceContext({
        base: { tenantId: 'tenant-1' },
        toolId: 'admin.write.clients.metadata',
        arguments: CLIENT_STEP.input,
      }),
    });
  });

  it('enforces the Grant per-Plan operation limit', async () => {
    const incoming = createRequest([CLIENT_STEP, { ...CLIENT_STEP, id: 'step-2' }]);
    incoming.grant.resolvedScopeConstraints.maxPerPlan = 1;
    await expect(h.build().execute(incoming)).resolves.toMatchObject({
      status: 400,
      body: { error: 'AGENT_PLAN_INVALID_DEFINITION' },
    });
    expect(h.repository.createPlan).not.toHaveBeenCalled();
  });

  it('defaults the per-Plan operation limit to 25 when the Grant has none', async () => {
    const steps = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...CLIENT_STEP, id: `step-${index}` }));
    const over = createRequest(steps(26));
    over.grant.resolvedScopeConstraints = { tenantIds: ['tenant-1'] };
    await expect(h.build().execute(over)).resolves.toMatchObject({ status: 400 });
    const atLimit = createRequest(steps(25));
    atLimit.grant.resolvedScopeConstraints = { tenantIds: ['tenant-1'] };
    await expect(h.build().execute(atLimit)).resolves.toMatchObject({ status: 201 });
    expect(h.repository.createPlan.mock.calls[0][0].audit.metadata.step_count).toBe(25);
  });

  it('rejects a high-risk plan-step tool even when its permission is delegated', async () => {
    const highRisk = customCatalog((tools) =>
      tools.map((tool) =>
        tool.id === 'admin.write.clients.protocol-security'
          ? resealTool(tool, { protocolMetadata: { 'com.authrim/planStepAllowed': true } })
          : tool
      )
    );
    const incoming = createRequest([
      {
        id: 'step-1',
        operation: 'admin.write.clients.protocol-security',
        toolContractVersion: '1',
        input: { client_id: 'client-target', require_pkce: true },
        resourcePrecondition: 'resource-v1',
      },
    ]);
    incoming.grant.permissions.push('admin:clients:update');
    await expect(h.build({ catalog: highRisk }).execute(incoming)).resolves.toEqual({
      status: 403,
      body: { error: 'AGENT_PLAN_STEP_NOT_DELEGATED' },
      executionStatus: 'definite',
    });
    expect(h.authorization.authorize).not.toHaveBeenCalled();
    expect(h.repository.createPlan).not.toHaveBeenCalled();
  });

  it('rejects a step whose write permission is not delegated', async () => {
    const incoming = createRequest();
    incoming.grant.permissions = incoming.grant.permissions.filter(
      (permission) => permission !== 'admin:clients:write'
    );
    await expect(h.build().execute(incoming)).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_PLAN_STEP_NOT_DELEGATED' },
    });
    expect(h.repository.createPlan).not.toHaveBeenCalled();
  });

  it('requires the client read permission used to validate a client metadata step', async () => {
    const incoming = createRequest();
    incoming.grant.permissions = incoming.grant.permissions.filter(
      (permission) => permission !== 'admin:clients:read'
    );
    await expect(h.build().execute(incoming)).resolves.toEqual({
      status: 403,
      body: { error: 'AGENT_PLAN_VALIDATION_READ_NOT_DELEGATED' },
      executionStatus: 'definite',
    });
    expect(h.authorization.authorize).not.toHaveBeenCalled();
  });

  it('requires the settings read permission for a Login UI step only', async () => {
    const incoming = createRequest([LOGIN_STEP]);
    incoming.grant.permissions.push('admin:settings:login_ui:update');
    await expect(h.build().execute(incoming)).resolves.toEqual({
      status: 403,
      body: { error: 'AGENT_PLAN_VALIDATION_READ_NOT_DELEGATED' },
      executionStatus: 'definite',
    });

    // Settings read is enough for a Login UI step; client read is not consulted.
    incoming.grant.permissions = [
      'admin:settings:read',
      'admin:settings:login_ui:update',
      'admin:auth_config_plans:create',
    ];
    await expect(h.build().execute(incoming)).resolves.toMatchObject({ status: 201 });
    expect(h.repository.createPlan.mock.calls[0][0].definition.steps).toEqual([LOGIN_STEP]);
  });

  it('returns the authorization denial with a default code and axis', async () => {
    h.authorization.authorize.mockResolvedValue({ allowed: false, requiresElevation: false });
    await expect(h.build().execute(createRequest())).resolves.toEqual({
      status: 403,
      body: { error: 'AGENT_PLAN_STEP_NOT_DELEGATED', denied_axis: 'unknown' },
      executionStatus: 'definite',
    });
    expect(h.repository.createPlan).not.toHaveBeenCalled();
  });

  it('stops at the first denied step of a multi-step Plan', async () => {
    h.authorization.authorize
      .mockResolvedValueOnce({ allowed: true, requiresElevation: false })
      .mockResolvedValueOnce({
        allowed: false,
        requiresElevation: false,
        code: 'AGENT_FIELD_CONSTRAINT',
        deniedAxis: 'scope',
      });
    const incoming = createRequest([CLIENT_STEP, { ...CLIENT_STEP, id: 'step-2' }]);
    await expect(h.build().execute(incoming)).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_FIELD_CONSTRAINT', denied_axis: 'scope' },
    });
    expect(h.authorization.authorize).toHaveBeenCalledTimes(2);
    expect(h.repository.createPlan).not.toHaveBeenCalled();
  });
});
