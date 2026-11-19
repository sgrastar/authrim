import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { AgentConfigurationOperationRequest } from '../platform/ports';
import { createAdminToolCatalog } from '../protocol/mcp';
import {
  BULK_CLIENT_WRITE_STEP,
  BULK_PERMISSIONS,
  agentSettings,
  bulkAdapterRequest,
  bulkPlanDefinition,
  machineSnapshot,
  pinned,
  toolById,
} from './helpers/mut-plans-bulk-adapter-fixtures';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
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

const settings = { get: vi.fn() };
const resolveActiveTenantIds = vi.fn();
const adapter = () =>
  new CloudflareAgentBulkPlanAdapter(
    {} as DatabaseAdapter,
    createAdminToolCatalog(),
    settings,
    { validate: () => ({ valid: true }) },
    resolveActiveTenantIds,
    () => 1_000
  );

type Request = AgentConfigurationOperationRequest;
async function expectCreate(incoming: Request, status: number, error?: string) {
  const result = await adapter().execute(incoming);
  if (error) {
    expect(result).toEqual({ status, body: { error }, executionStatus: 'definite' });
    expect(mocks.create).not.toHaveBeenCalled();
  } else {
    expect(result.status).toBe(status);
  }
}
function validateStored(definition: object) {
  mocks.get.mockResolvedValue({
    id: 'abp-1',
    version: 1,
    grantId: 'grant-1',
    actorSub: 'machine:principal-1',
    clientId: 'client-agent',
    status: 'draft',
    definition,
    definitionDigest: 'd',
    targetSnapshotDigest: 't',
  });
  return bulkAdapterRequest('admin.write.bulk.plan.validate', {
    bulk_plan_id: 'abp-1',
    version: 1,
  });
}

describe('Bulk Plan adapter authority checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveTenantIds.mockResolvedValue(new Set(['platform', 'tenant-1']));
    settings.get.mockResolvedValue(agentSettings());
    mocks.getGrant.mockResolvedValue(bulkAdapterRequest().grant);
    mocks.getActiveDelegatorPermissions.mockResolvedValue([...BULK_PERMISSIONS]);
    mocks.loadMachineGrantSnapshot.mockResolvedValue(machineSnapshot());
    mocks.transition.mockResolvedValue(true);
  });

  it('accepts the baseline request', async () => {
    await expectCreate(bulkAdapterRequest(), 201);
  });

  it.each([
    ['Mode A', (r: Request) => void (r.actor.mode = 'mode_a')],
    [
      'non machine-key assurance',
      (r: Request) => void (r.actor.assurance = 'public_client_transaction'),
    ],
    ['a bearer token', (r: Request) => void (r.actor.tokenBinding = 'bearer')],
    ['no machine principal', (r: Request) => void (r.actor.machinePrincipalId = undefined)],
    ['no machine credential', (r: Request) => void (r.actor.machineCredentialId = undefined)],
    [
      'a principal not bound to the Grant',
      (r: Request) => void (r.grant.machinePrincipalId = 'principal-2'),
    ],
  ])('requires Mode B machine context: %s', async (_label, mutate) => {
    const incoming = bulkAdapterRequest();
    mutate(incoming);
    await expectCreate(incoming, 403, 'AGENT_BULK_PLAN_MODE_B_REQUIRED');
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing Grant', () => null],
    ['a suspended Grant', (g: Request['grant']) => ({ ...g, status: 'suspended' })],
    [
      'an incomplete configuration snapshot',
      (g: Request['grant']) => ({ ...g, taskSetId: undefined }),
    ],
    ['a new generation', (g: Request['grant']) => ({ ...g, generation: 3 })],
    ['a new consent version', (g: Request['grant']) => ({ ...g, consentVersion: 2 })],
    ['another delegator', (g: Request['grant']) => ({ ...g, delegatorId: 'admin-9' })],
    ['another client', (g: Request['grant']) => ({ ...g, clientId: 'client-9' })],
  ])('rejects the stored Grant: %s', async (_label, stored) => {
    mocks.getGrant.mockResolvedValue(stored(bulkAdapterRequest().grant));
    await expectCreate(bulkAdapterRequest(), 403, 'AGENT_BULK_PLAN_GRANT_INVALID');
    expect(resolveActiveTenantIds).not.toHaveBeenCalled();
  });

  it('enforces the stored Grant tenant scope and per-Bulk-Plan limit', async () => {
    const grant = bulkAdapterRequest().grant;
    mocks.getGrant.mockResolvedValue({
      ...grant,
      resolvedScopeConstraints: { tenantIds: ['platform'], maxPerBulkPlan: 2 },
    });
    await expectCreate(bulkAdapterRequest(), 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
    mocks.getGrant.mockResolvedValue({
      ...grant,
      resolvedScopeConstraints: { tenantIds: ['platform', 'tenant-1'], maxPerBulkPlan: 1 },
    });
    await expectCreate(bulkAdapterRequest(), 403, 'AGENT_BULK_PLAN_TENANT_SCOPE_REQUIRED');
    mocks.getGrant.mockResolvedValue({
      ...grant,
      resolvedScopeConstraints: { tenantIds: ['platform', 'tenant-1'] },
    });
    await expectCreate(bulkAdapterRequest(), 201);
    expect(resolveActiveTenantIds).toHaveBeenCalledWith(['platform', 'tenant-1']);
  });

  it('fails closed when a target policy cannot be read', async () => {
    settings.get.mockRejectedValueOnce(new Error('kv down'));
    await expectCreate(bulkAdapterRequest(), 503, 'AGENT_BULK_PLAN_TARGET_POLICY_UNAVAILABLE');
  });

  it('rejects a target with Agent access disabled', async () => {
    settings.get.mockImplementation(async (tenantId: string) =>
      agentSettings({ enabled: tenantId !== 'platform' })
    );
    await expectCreate(bulkAdapterRequest(), 409, 'AGENT_BULK_PLAN_TARGET_AGENT_ACCESS_DISABLED');
  });

  it('allows a protected tenant that is a target but not a canary', async () => {
    settings.get.mockImplementation(async (tenantId: string) =>
      agentSettings({ bulkCanaryProtected: tenantId === 'platform' })
    );
    await expectCreate(bulkAdapterRequest(), 201);
  });

  it.each([
    ['a missing machine snapshot', null],
    [
      'a disabled principal',
      machineSnapshot({ principal: { id: 'principal-1', status: 'disabled' } }),
    ],
    ['a missing credential', machineSnapshot({ credential: undefined })],
    [
      'a credential of another principal',
      machineSnapshot({ credential: { id: 'credential-1', principalId: 'p-2', status: 'active' } }),
    ],
    [
      'a revoked credential',
      machineSnapshot({
        credential: { id: 'credential-1', principalId: 'principal-1', status: 'revoked' },
      }),
    ],
    ['no principal tenant scopes', machineSnapshot({ principalTenantScopes: [] })],
    [
      'a deny principal scope',
      machineSnapshot({
        principalTenantScopes: [
          { tenantId: 'platform', scopeMode: 'allow' },
          { tenantId: 'tenant-1', scopeMode: 'deny' },
        ],
      }),
    ],
    [
      'a target outside principal scopes',
      machineSnapshot({ principalTenantScopes: [{ tenantId: 'platform', scopeMode: 'allow' }] }),
    ],
    [
      'a deny credential scope',
      machineSnapshot({ credentialTenantScopes: [{ tenantId: 'other', scopeMode: 'deny' }] }),
    ],
    [
      'a target outside credential scopes',
      machineSnapshot({ credentialTenantScopes: [{ tenantId: 'platform', scopeMode: 'allow' }] }),
    ],
  ])('requires machine scope: %s', async (_label, snapshot) => {
    mocks.loadMachineGrantSnapshot.mockResolvedValue(snapshot);
    await expectCreate(bulkAdapterRequest(), 403, 'AGENT_BULK_PLAN_MACHINE_SCOPE_REQUIRED');
    expect(mocks.getActiveDelegatorPermissions).not.toHaveBeenCalled();
  });

  it('accepts a rotating credential narrowed to exactly the targets', async () => {
    mocks.loadMachineGrantSnapshot.mockResolvedValue(
      machineSnapshot({
        credential: { id: 'credential-1', principalId: 'principal-1', status: 'rotating' },
        credentialTenantScopes: [
          { tenantId: 'platform', scopeMode: 'allow' },
          { tenantId: 'tenant-1', scopeMode: 'allow' },
        ],
      })
    );
    await expectCreate(bulkAdapterRequest(), 201);
  });

  it('intersects principal permissions with credential permissions', async () => {
    mocks.loadMachineGrantSnapshot.mockResolvedValue(
      machineSnapshot({ credentialPermissions: ['admin:bulk_plans:create'] })
    );
    await expectCreate(bulkAdapterRequest(), 403, 'AGENT_BULK_PLAN_BASE_PERMISSION_REQUIRED');
    vi.clearAllMocks();
    mocks.loadMachineGrantSnapshot.mockResolvedValue(
      machineSnapshot({ credentialPermissions: [...BULK_PERMISSIONS] })
    );
    await expectCreate(bulkAdapterRequest(), 201);
  });

  it.each([
    [
      'the Grant',
      () => {
        mocks.getGrant.mockResolvedValue({
          ...bulkAdapterRequest().grant,
          permissions: BULK_PERMISSIONS.filter((p) => p !== 'admin:bulk_plans:apply'),
        });
      },
    ],
    [
      'the machine principal',
      () => {
        mocks.loadMachineGrantSnapshot.mockResolvedValue(
          machineSnapshot({
            principalPermissions: BULK_PERMISSIONS.filter((p) => p !== 'admin:clients:read'),
          })
        );
      },
    ],
    [
      'one target delegator',
      () => {
        mocks.getActiveDelegatorPermissions.mockImplementation(async (tenantId: string) =>
          tenantId === 'tenant-1'
            ? BULK_PERMISSIONS.filter((p) => p !== 'admin:clients:write')
            : [...BULK_PERMISSIONS]
        );
      },
    ],
    [
      'an inactive delegator',
      () => {
        mocks.getActiveDelegatorPermissions.mockImplementation(async (tenantId: string) =>
          tenantId === 'platform' ? null : [...BULK_PERMISSIONS]
        );
      },
    ],
    [
      'an unpinned tool contract',
      () => {
        mocks.getGrant.mockResolvedValue({
          ...bulkAdapterRequest().grant,
          resolvedTools: [
            { ...pinned(toolById('admin.write.clients.metadata')), schemaDigest: 'sha256:x' },
          ],
        });
      },
    ],
  ])('requires every base permission from %s', async (_label, arrange) => {
    arrange();
    await expectCreate(bulkAdapterRequest(), 403, 'AGENT_BULK_PLAN_BASE_PERMISSION_REQUIRED');
  });

  it('requires settings read and the Login UI write for a Login UI step', async () => {
    const login = toolById('admin.write.login-ui.update');
    const definition = bulkPlanDefinition([
      {
        id: 'step-brand',
        operation: login.id,
        toolContractVersion: '1',
        input: { brandName: 'Example' },
        resourcePrecondition: 'per-tenant-validation',
      },
    ]);
    const all = [...BULK_PERMISSIONS, 'admin:settings:login_ui:update'];
    const grant = {
      ...bulkAdapterRequest().grant,
      permissions: all,
      resolvedTools: [pinned(login)],
    };
    mocks.getGrant.mockResolvedValue(grant);
    mocks.getActiveDelegatorPermissions.mockResolvedValue(all);
    mocks.loadMachineGrantSnapshot.mockResolvedValue(
      machineSnapshot({ principalPermissions: all })
    );
    const incoming = bulkAdapterRequest('admin.write.bulk.plan.create', { definition });
    incoming.grant = { ...grant };
    await expectCreate(incoming, 403, 'AGENT_BULK_PLAN_BASE_PERMISSION_REQUIRED');

    const withRead = [...all, 'admin:settings:read'];
    mocks.getGrant.mockResolvedValue({ ...grant, permissions: withRead });
    mocks.getActiveDelegatorPermissions.mockResolvedValue(withRead);
    mocks.loadMachineGrantSnapshot.mockResolvedValue(
      machineSnapshot({ principalPermissions: withRead })
    );
    await expectCreate(incoming, 201);
  });

  it.each([
    [
      'an uncatalogued stored operation',
      { ...BULK_CLIENT_WRITE_STEP, operation: 'admin.write.unknown' },
    ],
    ['a drifted stored contract', { ...BULK_CLIENT_WRITE_STEP, toolContractVersion: '7' }],
  ])('rejects %s on validate', async (_label, step) => {
    const incoming = validateStored(bulkPlanDefinition([step]));
    await expect(adapter().execute(incoming)).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_BULK_PLAN_BASE_PERMISSION_REQUIRED' },
    });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('rejects a high-risk stored step even when fully delegated', async () => {
    const high = toolById('admin.write.clients.protocol-security');
    const all = [...BULK_PERMISSIONS, 'admin:clients:update'];
    mocks.getGrant.mockResolvedValue({
      ...bulkAdapterRequest().grant,
      permissions: all,
      resolvedTools: [pinned(high)],
    });
    mocks.getActiveDelegatorPermissions.mockResolvedValue(all);
    mocks.loadMachineGrantSnapshot.mockResolvedValue(
      machineSnapshot({ principalPermissions: all })
    );
    const incoming = validateStored(
      bulkPlanDefinition([
        { ...BULK_CLIENT_WRITE_STEP, operation: high.id, input: { client_id: 'c' } },
      ])
    );
    await expect(adapter().execute(incoming)).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_BULK_PLAN_RESOURCE_SCOPE_REQUIRED' },
    });
  });

  it('requires the tool scope on the stored Grant', async () => {
    mocks.getGrant.mockResolvedValue({ ...bulkAdapterRequest().grant, scopes: ['agent:read'] });
    await expectCreate(bulkAdapterRequest(), 403, 'AGENT_BULK_PLAN_RESOURCE_SCOPE_REQUIRED');
  });
});
