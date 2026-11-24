/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the tenant provisioning saga's dependencies as wired by
 * `processNextTenantProvisioning`: the platform draft check, seeding, runtime registry
 * publication, the read-back smoke test, activation and the route observation. The saga itself is
 * a fake that hands its dependencies over; databases are in-memory fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  saga: vi.fn(),
  repository: { claimNext: vi.fn() },
  registry: {
    upsertRegistryRow: vi.fn(),
    setActivePointer: vi.fn(),
    getRegistryRow: vi.fn(),
  },
  canonical: { replace: vi.fn(), markProjected: vi.fn(), adapters: [] as unknown[] },
  resolveSource: vi.fn(),
  publishSnapshot: vi.fn(),
  placement: vi.fn(),
  regionShard: vi.fn(),
  alias: { prepare: vi.fn(), activate: vi.fn() },
  signer: vi.fn(),
  loginUiClient: vi.fn(),
  emailOrder: vi.fn(),
  screens: vi.fn(),
  loginFlow: vi.fn(),
  registrationFlow: vi.fn(),
  clonePrepare: vi.fn(),
  consent: vi.fn(),
  auditLog: vi.fn(),
  d1: new Map<string, unknown>(),
  backupCovered: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const harness = await import('./helpers/admin-tenants-mutation-harness');
  return {
    ...harness.buildCoreMock(),
    runTenantBackupCoveredEffect: fakes.backupCovered,
    ensureDatabaseAdapter: vi.fn((db: unknown) => db),
    createD1Adapter: vi.fn((db: unknown, name: string) => fakes.d1.get(name) ?? db),
    createAuditLog: fakes.auditLog,
    seedDefaultConsentStatements: fakes.consent,
    resolveTenantDatabaseSourceFromRegistry: fakes.resolveSource,
    publishTenantRuntimeRegistrySnapshot: fakes.publishSnapshot,
    generateVersion: vi.fn((data: unknown) => `v:${JSON.stringify(data)}`),
    TenantDatabaseRegistryRepository: vi.fn().mockImplementation(function MockRegistry() {
      return fakes.registry;
    }),
  };
});
vi.mock('@authrim/ar-lib-core/services/settings-canonical-store', () => ({
  DatabaseSettingsCanonicalStore: vi.fn().mockImplementation(function MockCanonical(adapter) {
    fakes.canonical.adapters.push(adapter);
    return { replace: fakes.canonical.replace, markProjected: fakes.canonical.markProjected };
  }),
}));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: vi.fn(),
  refuseAdminFreshAuth: vi.fn(),
}));
vi.mock('../single-tenant-guard', () => ({
  createSingleTenantMutationError: vi.fn(),
  ensureSupportedTenantId: vi.fn(),
  getSingleTenantId: vi.fn(() => 'default'),
  isSingleTenantMode: vi.fn(() => false),
}));
vi.mock('../tenant-region-shard-policy', () => ({
  ensureTenantProvisioningRegionShardConfig: fakes.regionShard,
}));
vi.mock('../tenant-provisioning-operation', () => ({
  TenantProvisioningOperationRepository: vi.fn().mockImplementation(function MockRepository() {
    return fakes.repository;
  }),
}));
vi.mock('../tenant-provisioning-orchestrator', () => ({
  decodeTenantProvisioningRoute: vi.fn(),
  runTenantProvisioningSaga: fakes.saga,
}));
vi.mock('../tenant-alias-directory', () => ({
  activateTenantAliasDirectory: fakes.alias.activate,
  disableTenantAliasDirectory: vi.fn(),
  prepareTenantAliasDirectory: fakes.alias.prepare,
}));
vi.mock('../tenant-runtime-placement', () => ({
  resolveTenantRuntimePlacementSnapshot: fakes.placement,
}));
vi.mock('../control-runtime-registry-signer', () => ({
  createControlRuntimeRegistrySigner: fakes.signer,
}));
vi.mock('../tenant-login-ui-client', () => ({ ensureTenantLoginUiClient: fakes.loginUiClient }));
vi.mock('../notification-provider-projection', () => ({
  materializeDisabledTenantEmailProviderOrder: fakes.emailOrder,
}));
vi.mock('../admin-screens', () => ({ ensureDefaultScreensIn: fakes.screens }));
vi.mock('../admin-flows', () => ({
  seedDefaultLoginFlow: fakes.loginFlow,
  seedDefaultRegistrationFlow: fakes.registrationFlow,
}));
vi.mock('../admin-tenant-clone', () => ({
  cleanupTenantCloneKvArtifacts: vi.fn(),
  prepareTenantCloneForProvisioning: fakes.clonePrepare,
}));

import { usesNakedDomainIssuer } from '@authrim/ar-lib-core';
import { processNextTenantProvisioning } from '../admin-tenants';
import {
  adapters,
  createAdapter,
  createKVNamespace,
  createKeyManager,
} from './helpers/admin-tenants-mutation-harness';
import { must } from './helpers/must';

type Dependencies = {
  validatePlatformDraft(operation: unknown): Promise<void>;
  seedTenant(operation: unknown, route: unknown): Promise<void>;
  publishRegistry(operation: unknown, route: unknown): Promise<void>;
  smokeTenant(operation: unknown, route: unknown): Promise<void>;
  prepareTenant(operation: unknown, route: unknown): Promise<unknown>;
  activateLookup(operation: unknown, route: unknown): Promise<unknown>;
  activateTenant(operation: unknown, route: unknown): Promise<unknown>;
};

const operation = (overrides: Record<string, unknown> = {}) => ({
  operationId: 'op-1',
  tenantId: 'second',
  tenantCode: 'second-code',
  tenantName: 'Second Tenant',
  tenantDescription: 'about',
  operationKind: 'create',
  sourceTenantId: null,
  preparationResult: null,
  residencyPolicyId: 'policy-1',
  residencyPartition: 'eu',
  isolationPolicy: 'tenant_exclusive',
  createdBy: 'platform-admin',
  ...overrides,
});

const route = (overrides: Record<string, unknown> = {}) => ({
  allocationId: 'alloc-1',
  tenantId: 'second',
  state: 'reserved',
  target: {
    shardId: 'shard-core',
    dataRole: 'tenant_core/default',
    bindingRef: 'DB_TENANT_1',
    databaseId: 'db-core',
    databaseName: 'name-core',
    routeGeneration: 4,
    ...overrides,
  },
});

const target = (dataRole: string, overrides: Record<string, unknown> = {}) => ({
  dataRole,
  shardId: `shard-${dataRole}`,
  bindingRef: `DB_${dataRole}`,
  databaseId: `db-${dataRole}`,
  databaseName: `name-${dataRole}`,
  routeGeneration: 4,
  assignmentGeneration: 9,
  residencyPolicyId: 'policy-1',
  residencyPartition: 'eu',
  allocationScope: 'tenant_exclusive',
  ownerTenantId: 'second',
  ...overrides,
});
const ROLES = ['tenant_core/default', 'tenant_core/users', 'tenant_pii'];
const targets = (override?: (list: Record<string, unknown>[]) => unknown) => {
  const list = ROLES.map((role) => target(role));
  return override ? override(list) : list;
};
// The default target's shard and binding follow the role names above.
const coreRoute = () =>
  route({
    shardId: 'shard-tenant_core/default',
    bindingRef: 'DB_tenant_core/default',
    databaseId: 'db-tenant_core/default',
    databaseName: 'name-tenant_core/default',
  });

async function dependencies(env: Record<string, unknown> = {}): Promise<{
  deps: Dependencies;
  env: Record<string, unknown>;
}> {
  const fullEnv = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    BASE_DOMAIN: 'auth.example.com',
    DB: { platform: true },
    UI_URL: 'https://ui.example.com',
    ADMIN_UI_URL: 'https://admin.example.com',
    AUTHRIM_CONFIG: createKVNamespace(),
    SETTINGS: createKVNamespace(),
    TENANT_RUNTIME_REGISTRY: createKVNamespace(),
    KEY_MANAGER: createKeyManager(),
    DB_TENANT_1: { prepare: vi.fn() },
    'DB_tenant_core/default': { prepare: vi.fn() },
    ...env,
  };
  fakes.repository.claimNext.mockResolvedValue({ lease: true });
  fakes.saga.mockResolvedValue(undefined);
  await processNextTenantProvisioning(fullEnv as never);
  return { deps: must(fakes.saga.mock.calls.at(-1))[0].dependencies as Dependencies, env: fullEnv };
}

beforeEach(() => {
  adapters.defaultAdapter = null;
  adapters.adminAdapter = createAdapter();
  adapters.lifecycleJobsAdapter = createAdapter();
  vi.clearAllMocks();
  fakes.d1.clear();
  fakes.canonical.adapters.length = 0;
  fakes.repository.claimNext.mockReset();
  fakes.saga.mockReset();
  for (const fn of Object.values(fakes.registry)) fn.mockReset();
  fakes.resolveSource.mockReset();
  fakes.publishSnapshot.mockReset();
  fakes.placement.mockReset();
  fakes.regionShard.mockReset();
  fakes.alias.prepare.mockReset();
  fakes.alias.activate.mockReset();
  fakes.signer.mockReset();
  fakes.clonePrepare.mockReset();
  fakes.auditLog.mockReset();
  vi.mocked(usesNakedDomainIssuer).mockReturnValue(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

describe('publishRegistry', () => {
  function control(list: unknown) {
    return { getTenantProvisioningRouteTargets: vi.fn(async () => list) };
  }
  const publishedSnapshot = (overrides: Record<string, unknown> = {}) => ({
    snapshot: {
      runtimeGeneration: 4,
      stores: ROLES.map((role) => ({
        role: role === 'tenant_pii' ? 'tenant_pii' : 'tenant_core',
        shardGroup: role === 'tenant_core/users' ? 'users' : 'default',
        bindingRef: `DB_${role}`,
        databaseId: `db-${role}`,
      })),
      ...overrides,
    },
  });

  async function publish(
    list: unknown,
    op = operation(),
    selectedRoute = coreRoute(),
    envExtra: Record<string, unknown> = {}
  ) {
    const { deps, env } = await dependencies({ CONTROL: control(list), ...envExtra });
    fakes.placement.mockResolvedValue({ isolationPolicy: 'tenant_exclusive', policyGeneration: 6 });
    fakes.publishSnapshot.mockResolvedValue(publishedSnapshot());
    fakes.signer.mockResolvedValue('signer-object');
    return { run: () => deps.publishRegistry(op, selectedRoute), env: env as Record<string, any> };
  }

  it('requires the Control binding', async () => {
    const { deps } = await dependencies({ CONTROL: undefined });
    await expect(deps.publishRegistry(operation(), coreRoute())).rejects.toThrow(
      'tenant_provisioning_control_unavailable'
    );
    const noMethod = await dependencies({ CONTROL: {} });
    await expect(noMethod.deps.publishRegistry(operation(), coreRoute())).rejects.toThrow(
      'tenant_provisioning_control_unavailable'
    );
  });

  it('asks Control for the route targets of the tenant with its residency', async () => {
    const { run, env } = await publish(targets());
    await run();
    expect(env.CONTROL.getTenantProvisioningRouteTargets).toHaveBeenCalledWith({
      tenantId: 'second',
      residencyPolicyId: 'policy-1',
      residencyPartition: 'eu',
    });
  });

  it.each([
    ['not a list', () => 'nope'],
    ['two targets', (list: Record<string, unknown>[]) => list.slice(0, 2)],
    ['four targets', (list: Record<string, unknown>[]) => [...list, target('tenant_pii')]],
    ['a repeated role', (list: Record<string, unknown>[]) => [list[0], list[0], list[2]]],
    [
      'an unknown role',
      (list: Record<string, unknown>[]) => [list[0], list[1], target('other_role')],
    ],
    ['a null entry', (list: Record<string, unknown>[]) => [list[0], list[1], null]],
    ['a non-object entry', (list: Record<string, unknown>[]) => [list[0], list[1], 7]],
    [
      'another residency policy',
      (list: Record<string, unknown>[]) => [
        list[0],
        list[1],
        target('tenant_pii', { residencyPolicyId: 'x' }),
      ],
    ],
    [
      'another residency partition',
      (list: Record<string, unknown>[]) => [
        list[0],
        list[1],
        target('tenant_pii', { residencyPartition: 'x' }),
      ],
    ],
    [
      'another allocation scope',
      (list: Record<string, unknown>[]) => [
        list[0],
        list[1],
        target('tenant_pii', { allocationScope: 'shared_pool' }),
      ],
    ],
    [
      'another owner',
      (list: Record<string, unknown>[]) => [
        list[0],
        list[1],
        target('tenant_pii', { ownerTenantId: 'x' }),
      ],
    ],
    [
      'no owner',
      (list: Record<string, unknown>[]) => [
        list[0],
        list[1],
        target('tenant_pii', { ownerTenantId: null }),
      ],
    ],
  ])('refuses route targets with %s', async (_name, change) => {
    const { run } = await publish(targets(change));
    await expect(run()).rejects.toThrow('tenant_provisioning_runtime_routes_invalid');
    expect(fakes.registry.upsertRegistryRow).not.toHaveBeenCalled();
  });

  it('requires an ownerless pool target for a shared pool tenant, and refuses an owned one', async () => {
    const shared = (owner: string | null) =>
      ROLES.map((role) => target(role, { allocationScope: 'shared_pool', ownerTenantId: owner }));
    const op = operation({ isolationPolicy: 'shared_pool' });
    const refused = await publish(shared('second'), op);
    await expect(refused.run()).rejects.toThrow('tenant_provisioning_runtime_routes_invalid');
    const accepted = await publish(shared(null), op);
    fakes.placement.mockResolvedValue({ isolationPolicy: 'shared_pool', policyGeneration: 6 });
    await expect(accepted.run()).resolves.toBeUndefined();
  });

  it.each([
    ['shard', { shardId: 'other' }],
    ['binding', { bindingRef: 'other' }],
    ['database id', { databaseId: 'other' }],
    ['database name', { databaseName: 'other' }],
    ['route generation', { routeGeneration: 5 }],
  ])('refuses a reserved default route whose %s differs from the target', async (_name, change) => {
    const { run } = await publish(targets(), operation(), {
      ...coreRoute(),
      target: { ...coreRoute().target, ...change },
    });
    await expect(run()).rejects.toThrow('tenant_provisioning_default_route_mismatch');
  });

  it('refuses when the placement policy differs from the operation', async () => {
    const { run } = await publish(targets());
    fakes.placement.mockResolvedValue({ isolationPolicy: 'shared_pool', policyGeneration: 6 });
    await expect(run()).rejects.toThrow('tenant_provisioning_runtime_placement_mismatch');
    expect(fakes.registry.upsertRegistryRow).not.toHaveBeenCalled();
  });

  it('writes a registry row and an active pointer for each target', async () => {
    const { run } = await publish(targets());
    await run();
    expect(fakes.registry.upsertRegistryRow).toHaveBeenCalledTimes(3);
    expect(fakes.registry.upsertRegistryRow.mock.calls[0][0]).toEqual({
      tenant_id: 'second',
      role: 'tenant_core',
      generation: 4,
      provider: 'd1',
      database_id: 'db-tenant_core/default',
      database_name: 'name-tenant_core/default',
      binding_ref: 'DB_tenant_core/default',
      schema_version: 1,
      status: 'active',
      shard_group: 'default',
      shard_index: 0,
      shard_count: 1,
      shard_key_strategy: 'none',
      worker_shard: 'primary',
      actor_id: 'platform-admin',
      region_hint: null,
      jurisdiction: null,
      metadata_json: JSON.stringify({
        control_allocation_id: 'alloc-1',
        control_shard_id: 'shard-tenant_core/default',
        control_assignment_generation: 9,
        control_data_role: 'tenant_core/default',
        control_residency_policy_id: 'policy-1',
        control_residency_partition: 'eu',
        control_allocation_scope: 'tenant_exclusive',
        control_owner_tenant_id: 'second',
        control_placement_policy_generation: 6,
      }),
    });
    const roles = fakes.registry.upsertRegistryRow.mock.calls.map(([row]) => [
      row.role,
      row.shard_group,
    ]);
    expect(roles).toEqual([
      ['tenant_core', 'default'],
      ['tenant_core', 'users'],
      ['tenant_pii', 'default'],
    ]);
    // Only the default target carries the allocation id.
    expect(
      JSON.parse(fakes.registry.upsertRegistryRow.mock.calls[1][0].metadata_json)
        .control_allocation_id
    ).toBeNull();
    expect(fakes.registry.setActivePointer.mock.calls.map(([pointer]) => pointer)).toEqual(
      roles.map(([role, group]) => ({
        tenant_id: 'second',
        role,
        shard_group: group,
        generation: 4,
        runtime_generation: 4,
        status: 'active',
        updated_by: 'platform-admin',
      }))
    );
  });

  it('configures region shards, publishes the snapshot signed by Control, and prepares the alias directory', async () => {
    const { run, env } = await publish(targets(), operation(), coreRoute(), {
      AUTHRIM_DEPLOYMENT_TARGET: 'edge',
    });
    await run();
    expect(fakes.regionShard).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'second',
      residencyPolicyId: 'policy-1',
      residencyPartition: 'eu',
    });
    expect(fakes.publishSnapshot).toHaveBeenCalledWith({
      tenantId: 'second',
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 6 },
      repository: fakes.registry,
      snapshotStore: env.TENANT_RUNTIME_REGISTRY,
      deploymentTarget: 'edge',
      actorId: 'platform-admin',
      externalSigner: 'signer-object',
    });
    expect(fakes.alias.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'second',
        tenantCode: 'second-code',
        tenantSlug: 'second',
        routeProjection: expect.objectContaining({
          tenantRouteGeneration: 4,
          residencyPolicyId: 'policy-1',
        }),
      })
    );
  });

  it.each([
    ['another runtime generation', publishedSnapshot({ runtimeGeneration: 9 })],
    ['two stores', publishedSnapshot({ stores: publishedSnapshot().snapshot.stores.slice(0, 2) })],
    [
      'a store with another binding',
      publishedSnapshot({
        stores: publishedSnapshot().snapshot.stores.map((s, i) =>
          i === 2 ? { ...s, bindingRef: 'other' } : s
        ),
      }),
    ],
    [
      'a store with another database',
      publishedSnapshot({
        stores: publishedSnapshot().snapshot.stores.map((s, i) =>
          i === 1 ? { ...s, databaseId: 'other' } : s
        ),
      }),
    ],
    [
      'a store in another shard group',
      publishedSnapshot({
        stores: publishedSnapshot().snapshot.stores.map((s, i) =>
          i === 1 ? { ...s, shardGroup: 'default' } : s
        ),
      }),
    ],
    [
      'a store in another role',
      publishedSnapshot({
        stores: publishedSnapshot().snapshot.stores.map((s, i) =>
          i === 2 ? { ...s, role: 'tenant_core' } : s
        ),
      }),
    ],
  ])('refuses a published snapshot with %s', async (_name, snapshot) => {
    const { run } = await publish(targets());
    fakes.publishSnapshot.mockResolvedValue(snapshot);
    await expect(run()).rejects.toThrow('tenant_provisioning_registry_generation_mismatch');
    expect(fakes.alias.prepare).not.toHaveBeenCalled();
  });
});

describe('smokeTenant', () => {
  async function smoke(resolved: Record<string, unknown>, tenantRow: unknown) {
    const tenantDb = createAdapter(() => tenantRow);
    fakes.resolveSource.mockResolvedValue({
      bindingRef: 'DB_tenant_core/default',
      runtimeGeneration: 4,
      source: tenantDb,
      ...resolved,
    });
    const { deps, env } = await dependencies();
    return {
      run: () => deps.smokeTenant(operation(), coreRoute()),
      tenantDb,
      env: env as Record<string, any>,
    };
  }

  it('reads the tenant back through the published registry and touches the login settings', async () => {
    const { run, tenantDb, env } = await smoke(
      {},
      { id: 'second', lifecycle_state: 'provisioning' }
    );
    await run();
    expect(fakes.resolveSource).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'second',
      role: 'tenant_core',
      shardGroup: 'default',
      shardIndex: 0,
    });
    expect(tenantDb.calls[0]).toEqual({
      op: 'queryOne',
      sql: 'SELECT id, lifecycle_state FROM tenants WHERE id = ?',
      params: ['second'],
    });
    expect(env.SETTINGS.get).toHaveBeenCalledWith('settings:tenant:second:login-entry');
    expect(env.SETTINGS.get).toHaveBeenCalledWith('settings:tenant:second:login-ui');
  });

  it('works without a SETTINGS binding', async () => {
    fakes.resolveSource.mockResolvedValue({
      bindingRef: 'DB_tenant_core/default',
      runtimeGeneration: 4,
      source: createAdapter(() => ({ id: 'second', lifecycle_state: 'provisioning' })),
    });
    const { deps } = await dependencies({ SETTINGS: undefined });
    await expect(deps.smokeTenant(operation(), coreRoute())).resolves.toBeUndefined();
  });

  it.each([
    ['binding', { bindingRef: 'other' }],
    ['runtime generation', { runtimeGeneration: 5 }],
  ])('refuses a registry read-back with another %s', async (_name, change) => {
    const { run, tenantDb } = await smoke(change, {
      id: 'second',
      lifecycle_state: 'provisioning',
    });
    await expect(run()).rejects.toThrow('tenant_provisioning_registry_readback_mismatch');
    expect(tenantDb.calls).toHaveLength(0);
  });

  it.each([
    ['missing', null],
    ['another tenant', { id: 'other', lifecycle_state: 'provisioning' }],
    ['already active', { id: 'second', lifecycle_state: 'active' }],
  ])('refuses a tenant read-back that is %s', async (_name, row) => {
    const { run, env } = await smoke({}, row);
    await expect(run()).rejects.toThrow('tenant_provisioning_tenant_readback_failed');
    expect(env.SETTINGS.get).not.toHaveBeenCalled();
  });
});
