import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  resolveAgentBulkPlan,
  type AgentBulkPlanDefinition,
  type AgentBulkRepository,
} from '../core';
import { createAdminToolCatalog } from '../protocol/mcp';
import {
  BULK_CLIENT_WRITE_STEP,
  agentSettings,
  bulkAdapterRequest,
  bulkPlanDefinition,
  machineSnapshot,
} from './helpers/mut-plans-bulk-adapter-fixtures';

const mocks = vi.hoisted(() => ({
  create: vi.fn<AgentBulkRepository['create']>(),
  get: vi.fn(),
  listTenantExecutions: vi.fn(),
  transition: vi.fn(),
  getGrant: vi.fn(),
  getActiveDelegatorPermissions: vi.fn(),
  loadMachineGrantSnapshot: vi.fn(),
}));

vi.mock('../core/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/repositories')>();
  return {
    ...actual,
    AgentBulkRepository: class {
      create = mocks.create;
      get = mocks.get;
      listTenantExecutions = mocks.listTenantExecutions;
      transition = mocks.transition;
    },
    AdminAgentAccessRepository: class {
      getGrant = mocks.getGrant;
      getActiveDelegatorPermissions = mocks.getActiveDelegatorPermissions;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    AdminMachineAccessRepository: class {
      loadMachineGrantSnapshot = mocks.loadMachineGrantSnapshot;
    },
  };
});

import { CloudflareAgentBulkPlanAdapter } from '../platform/cloudflare/bulk-plan-adapter';

const NOW = 1_000;
const database = {} as DatabaseAdapter;
const settings = { get: vi.fn() };
const resolveActiveTenantIds = vi.fn();

function adapter(validate = () => ({ valid: true }), withClock = true) {
  return new CloudflareAgentBulkPlanAdapter(
    database,
    createAdminToolCatalog(),
    settings,
    { validate },
    resolveActiveTenantIds,
    withClock ? () => NOW : undefined
  );
}

function storedPlan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abp-1',
    version: 3,
    grantId: 'grant-1',
    actorSub: 'machine:principal-1',
    clientId: 'client-agent',
    status: 'draft',
    definition: bulkPlanDefinition(),
    definitionDigest: 'plan-digest',
    targetSnapshotDigest: 'target-digest',
    ...overrides,
  };
}

const expectedAudit = (
  action: string,
  resourceId: string,
  createdAt: number,
  metadata: object
) => ({
  id: expect.stringMatching(/^audit_[0-9a-f-]{36}$/u) as string,
  tenantId: 'platform',
  adminUserId: 'admin-1',
  action,
  resourceType: 'agent_bulk_plan',
  resourceId,
  severity: 'info',
  actorType: 'agent',
  actorSub: 'machine:principal-1',
  actorMode: 'mode_b',
  actorAssurance: 'machine_key',
  tokenBinding: 'dpop',
  actClientId: 'client-agent',
  actPrincipalId: 'principal-1',
  grantId: 'grant-1',
  requestId: 'correlation-1',
  metadata,
  createdAt,
});

describe('Bulk Plan adapter lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveTenantIds.mockResolvedValue(new Set(['platform', 'tenant-1']));
    settings.get.mockResolvedValue(agentSettings());
    mocks.getGrant.mockResolvedValue(bulkAdapterRequest().grant);
    mocks.getActiveDelegatorPermissions.mockResolvedValue(bulkAdapterRequest().grant.permissions);
    mocks.loadMachineGrantSnapshot.mockResolvedValue(machineSnapshot());
    mocks.get.mockResolvedValue(storedPlan());
    mocks.listTenantExecutions.mockResolvedValue([{ id: 'execution-1' }]);
    mocks.transition.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an unsupported Bulk operation', async () => {
    await expect(
      adapter().execute(bulkAdapterRequest('admin.write.bulk.plan.apply'))
    ).resolves.toEqual({
      status: 400,
      body: { error: 'AGENT_BULK_OPERATION_UNSUPPORTED' },
      executionStatus: 'definite',
    });
  });

  it('persists the resolved Bulk Plan with its digests and audit', async () => {
    const result = await adapter().execute(bulkAdapterRequest());
    const resolved = await resolveAgentBulkPlan(
      bulkPlanDefinition() as unknown as AgentBulkPlanDefinition
    );
    const id = mocks.create.mock.calls[0][0].id;
    expect(id).toMatch(/^abp_[0-9a-f-]{36}$/u);
    expect(mocks.create).toHaveBeenCalledWith({
      id,
      version: 1,
      controlTenantId: 'platform',
      grantId: 'grant-1',
      actorSub: 'machine:principal-1',
      clientId: 'client-agent',
      delegatorId: 'admin-1',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      machinePrincipalId: 'principal-1',
      machineCredentialId: 'credential-1',
      grantGeneration: 2,
      consentVersion: 1,
      resolved,
      expiresAt: NOW + 86_400_000,
      payloadPurgeAt: NOW + 86_400_000 + 2_592_000_000,
      now: NOW,
      audit: expectedAudit('agent.bulk_plan.created', id, NOW, {
        version: 1,
        plan_digest: resolved.digest,
        target_snapshot_digest: resolved.targetSnapshotDigest,
        canary_digest: resolved.canaryDigest,
      }),
    });
    expect(result).toEqual({
      status: 201,
      body: { bulk_plan_id: id, version: 1, digest: resolved.digest, status: 'draft' },
      executionStatus: 'definite',
    });
    expect(mocks.getActiveDelegatorPermissions).toHaveBeenCalledWith('platform', 'admin-1', NOW);
    expect(mocks.getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', NOW);
    expect(mocks.getGrant).toHaveBeenCalledWith('platform', 'grant-1');
    expect(mocks.loadMachineGrantSnapshot).toHaveBeenCalledWith('principal-1', 'credential-1');
    expect(settings.get).toHaveBeenCalledWith('platform');
    expect(settings.get).toHaveBeenCalledWith('tenant-1');
  });

  it('defaults the clock to Date.now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_000);
    await adapter(undefined, false).execute(bulkAdapterRequest());
    expect(mocks.create.mock.calls[0][0].expiresAt).toBe(7_000 + 86_400_000);
  });

  it.each([
    ['a missing definition', {}],
    [
      'a malformed Bulk definition',
      { definition: { ...bulkPlanDefinition(), schemaVersion: 'v0' } },
    ],
  ])('rejects %s', async (_label, input) => {
    await expect(
      adapter().execute(bulkAdapterRequest('admin.write.bulk.plan.create', input as never))
    ).resolves.toEqual({
      status: 400,
      body: { error: 'AGENT_BULK_PLAN_INVALID' },
      executionStatus: 'definite',
    });
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it('rejects a step whose input fails the tool schema', async () => {
    await expect(
      adapter(() => ({ valid: false, errorMessage: 'bad' })).execute(bulkAdapterRequest())
    ).resolves.toMatchObject({ status: 400, body: { error: 'AGENT_BULK_PLAN_INVALID' } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('honours the Grant per-Plan operation limit', async () => {
    const incoming = bulkAdapterRequest('admin.write.bulk.plan.create', {
      definition: bulkPlanDefinition([
        BULK_CLIENT_WRITE_STEP,
        {
          ...BULK_CLIENT_WRITE_STEP,
          id: 'step-2',
          input: { client_id: 'client-2', client_name: 'x' },
        },
      ]),
    });
    incoming.grant.resolvedScopeConstraints.maxPerPlan = 1;
    await expect(adapter().execute(incoming)).resolves.toMatchObject({ status: 400 });
    incoming.grant.resolvedScopeConstraints.maxPerPlan = undefined;
    await expect(adapter().execute(incoming)).resolves.toMatchObject({ status: 201 });
  });

  it.each([
    ['a missing id', { version: 1 }],
    ['a numeric id', { bulk_plan_id: 3, version: 1 }],
    ['a zero version', { bulk_plan_id: 'abp-1', version: 0 }],
    ['a fractional version', { bulk_plan_id: 'abp-1', version: 1.5 }],
    ['a string version', { bulk_plan_id: 'abp-1', version: '1' }],
  ])('rejects %s on get and validate', async (_label, input) => {
    for (const operation of ['admin.read.bulk.plan.get', 'admin.write.bulk.plan.validate']) {
      await expect(
        adapter().execute(bulkAdapterRequest(operation, input as never))
      ).resolves.toEqual({
        status: 400,
        body: { error: 'AGENT_BULK_PLAN_INVALID' },
        executionStatus: 'definite',
      });
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('returns an owned Bulk Plan with its tenant executions', async () => {
    const input = { bulk_plan_id: 'abp-1', version: 3 };
    await expect(
      adapter().execute(bulkAdapterRequest('admin.read.bulk.plan.get', input))
    ).resolves.toEqual({
      status: 200,
      body: { bulk_plan: storedPlan(), tenant_executions: [{ id: 'execution-1' }] },
      executionStatus: 'definite',
    });
    expect(mocks.get).toHaveBeenCalledWith('platform', 'abp-1', 3);
    expect(mocks.listTenantExecutions).toHaveBeenCalledWith('platform', 'abp-1', 3);
  });

  it.each([
    ['a missing Plan', null],
    ['another Grant', storedPlan({ grantId: 'grant-2' })],
    ['another actor', storedPlan({ actorSub: 'machine:other' })],
    ['another client', storedPlan({ clientId: 'client-other' })],
  ])('hides %s on get', async (_label, plan) => {
    mocks.get.mockResolvedValue(plan);
    await expect(
      adapter().execute(
        bulkAdapterRequest('admin.read.bulk.plan.get', { bulk_plan_id: 'abp-1', version: 3 })
      )
    ).resolves.toEqual({
      status: 404,
      body: { error: 'AGENT_BULK_PLAN_NOT_FOUND' },
      executionStatus: 'definite',
    });
    expect(mocks.listTenantExecutions).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing Plan', null],
    ['a purged Plan', storedPlan({ definition: undefined })],
    ['a ready Plan', storedPlan({ status: 'ready' })],
    ['another Grant', storedPlan({ grantId: 'grant-2' })],
    ['another actor', storedPlan({ actorSub: 'machine:other' })],
    ['another client', storedPlan({ clientId: 'client-other' })],
  ])('does not validate %s', async (_label, plan) => {
    mocks.get.mockResolvedValue(plan);
    await expect(
      adapter().execute(
        bulkAdapterRequest('admin.write.bulk.plan.validate', { bulk_plan_id: 'abp-1', version: 3 })
      )
    ).resolves.toEqual({
      status: 404,
      body: { error: 'AGENT_BULK_PLAN_NOT_FOUND' },
      executionStatus: 'definite',
    });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('re-checks authority and marks the draft ready with an audit row', async () => {
    const incoming = bulkAdapterRequest('admin.write.bulk.plan.validate', {
      bulk_plan_id: 'abp-1',
      version: 3,
    });
    await expect(adapter().execute(incoming)).resolves.toEqual({
      status: 200,
      body: { bulk_plan_id: 'abp-1', version: 3, status: 'ready' },
      executionStatus: 'definite',
    });
    expect(mocks.getGrant).toHaveBeenCalledWith('platform', 'grant-1');
    expect(mocks.transition).toHaveBeenCalledWith({
      controlTenantId: 'platform',
      id: 'abp-1',
      version: 3,
      from: 'draft',
      to: 'ready',
      stage: 'validate',
      now: NOW,
      audit: expectedAudit('agent.bulk_plan.validated', 'abp-1', NOW, {
        version: 3,
        plan_digest: 'plan-digest',
        target_snapshot_digest: 'target-digest',
      }),
    });
  });

  it('returns the authority denial and skips the transition on validate', async () => {
    mocks.getGrant.mockResolvedValue(null);
    await expect(
      adapter().execute(
        bulkAdapterRequest('admin.write.bulk.plan.validate', { bulk_plan_id: 'abp-1', version: 3 })
      )
    ).resolves.toMatchObject({ status: 403, body: { error: 'AGENT_BULK_PLAN_GRANT_INVALID' } });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('reports a lost ready transition as a state conflict', async () => {
    mocks.transition.mockResolvedValue(false);
    await expect(
      adapter().execute(
        bulkAdapterRequest('admin.write.bulk.plan.validate', { bulk_plan_id: 'abp-1', version: 3 })
      )
    ).resolves.toEqual({
      status: 409,
      body: { error: 'AGENT_BULK_PLAN_STATE_CONFLICT' },
      executionStatus: 'definite',
    });
  });
});
