/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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

import { putTenantExistsCache, usesNakedDomainIssuer } from '@authrim/ar-lib-core';
import {
  activateProvisionedTenantLifecycle,
  processNextTenantProvisioning,
  resolveActiveTenantRuntimeRouteObservation,
} from '../admin-tenants';
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

const T0 = 1767225600;

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

describe('prepareTenant, activateLookup and activateTenant', () => {
  it('prepares a clone through the clone service and a plain create with nothing', async () => {
    const { deps, env } = await dependencies();
    fakes.clonePrepare.mockResolvedValue({ copied: 3 });
    const clone = operation({ operationKind: 'clone' });
    expect(await deps.prepareTenant(clone, coreRoute())).toEqual({ copied: 3 });
    expect(fakes.clonePrepare).toHaveBeenCalledWith(env, clone, coreRoute());
    fakes.clonePrepare.mockClear();
    expect(await deps.prepareTenant(operation(), coreRoute())).toBeNull();
    expect(fakes.clonePrepare).not.toHaveBeenCalled();
  });

  it('activates the alias directory for the route', async () => {
    const { deps, env } = await dependencies();
    fakes.alias.activate.mockResolvedValue('activated');
    expect(await deps.activateLookup(operation(), coreRoute())).toBe('activated');
    expect(fakes.alias.activate).toHaveBeenCalledWith(env, {
      tenantId: 'second',
      tenantCode: 'second-code',
      tenantSlug: 'second',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 4,
        residencyPolicyId: 'policy-1',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'eu',
          shardId: 'shard-tenant_core/default',
          bindingRef: 'DB_tenant_core/default',
          requiredBindingRouteGeneration: 4,
        },
      },
    });
  });

  async function activate(op = operation()) {
    const platform = createAdapter((sql) =>
      sql.startsWith('SELECT lifecycle_state') ? { lifecycle_state: 'active' } : { rowsAffected: 1 }
    );
    const tenantAdapter = createAdapter((sql) =>
      sql.startsWith('SELECT lifecycle_state') ? { lifecycle_state: 'active' } : { rowsAffected: 1 }
    );
    fakes.d1.set('tenant-provisioning:second', tenantAdapter);
    fakes.resolveSource.mockImplementation(
      async (_env: unknown, input: { role: string; shardGroup: string }) => ({
        role: input.role,
        shardGroup: input.shardGroup,
        shardIndex: 0,
        generation: 4,
        runtimeGeneration: 7,
        bindingRef: `DB_${input.role}_${input.shardGroup}`,
      })
    );
    fakes.registry.getRegistryRow.mockImplementation(
      async (key: { role: string; shard_group: string }) => ({
        status: 'active',
        generation: 4,
        binding_ref: `DB_${key.role}_${key.shard_group}`,
        metadata_json: JSON.stringify({
          control_data_role:
            key.role === 'tenant_pii'
              ? 'tenant_pii'
              : key.shard_group === 'users'
                ? 'tenant_core/users'
                : 'tenant_core/default',
          control_shard_id: `shard-${key.role}-${key.shard_group}`,
        }),
      })
    );
    const { deps, env } = await dependencies({ DB: platform });
    const observation = await deps.activateTenant(op, coreRoute());
    return { platform, tenantAdapter, observation, env: env as Record<string, any> };
  }

  it('activates the tenant in both databases, caches it and observes the route', async () => {
    const { platform, tenantAdapter, observation, env } = await activate();
    for (const adapter of [platform, tenantAdapter]) {
      expect(adapter.calls[0]).toEqual({
        op: 'execute',
        sql: "UPDATE tenants SET lifecycle_state = 'active', updated_at = ? WHERE id = ? AND lifecycle_state = 'provisioning'",
        params: [T0, 'second'],
      });
    }
    expect(putTenantExistsCache).toHaveBeenCalledWith(env.AUTHRIM_CONFIG, 'second');
    expect(fakes.auditLog).not.toHaveBeenCalled();
    expect(observation).toEqual({
      runtimeGeneration: 7,
      registryPublicationGeneration: 7,
      tenantLifecycleState: 'active',
      routeStatus: 'active',
      targets: [
        {
          dataRole: 'tenant_core/default',
          shardId: 'shard-tenant_core-default',
          bindingRef: 'DB_tenant_core_default',
          generation: 4,
        },
        {
          dataRole: 'tenant_core/users',
          shardId: 'shard-tenant_core-users',
          bindingRef: 'DB_tenant_core_users',
          generation: 4,
        },
        {
          dataRole: 'tenant_pii',
          shardId: 'shard-tenant_pii-default',
          bindingRef: 'DB_tenant_pii_default',
          generation: 4,
        },
      ],
    });
  });

  it('audits a clone with its source and preparation result', async () => {
    await activate(
      operation({
        operationKind: 'clone',
        sourceTenantId: 'source',
        preparationResult: { copied: 3 },
        createdBy: 'creator',
      })
    );
    expect(fakes.auditLog).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'second',
      userId: 'creator',
      action: 'tenant.cloned',
      resource: 'tenant',
      resourceId: 'second',
      ipAddress: 'internal',
      userAgent: 'tenant-provisioning-saga',
      metadata: JSON.stringify({ operation_id: 'op-1', source_tenant_id: 'source', copied: 3 }),
      severity: 'info',
    });
    fakes.auditLog.mockClear();
    await activate(
      operation({ operationKind: 'clone', sourceTenantId: 'source', preparationResult: null })
    );
    expect(fakes.auditLog.mock.calls[0][1].metadata).toBe(
      JSON.stringify({ operation_id: 'op-1', source_tenant_id: 'source' })
    );
  });
});

describe('activateProvisionedTenantLifecycle', () => {
  function pair(
    options: { platformState?: string | null; tenantState?: string | null; type?: string } = {}
  ) {
    const make = (state: string | null | undefined) => {
      const adapter = createAdapter((sql) =>
        sql.startsWith('SELECT lifecycle_state')
          ? state === null
            ? null
            : { lifecycle_state: state ?? 'active' }
          : { rowsAffected: 1 }
      );
      adapter.getType.mockReturnValue(options.type ?? 'd1');
      return adapter;
    };
    return {
      platformAdapter: make(options.platformState),
      tenantAdapter: make(options.tenantState),
    };
  }
  const input = (adapters: ReturnType<typeof pair>, extra: Record<string, unknown> = {}) =>
    ({
      ...adapters,
      tenantId: 'second',
      now: 100,
      ...extra,
    }) as never;

  it('activates the platform row first, then the tenant row, and reads both back with primary consistency', async () => {
    const both = pair();
    await activateProvisionedTenantLifecycle(input(both));
    const order = [both.platformAdapter.execute, both.tenantAdapter.execute].map(
      (fn) => fn.mock.invocationCallOrder[0]
    );
    expect(order[0]).toBeLessThan(order[1]);
    for (const adapter of [both.platformAdapter, both.tenantAdapter]) {
      expect(adapter.queryOne).toHaveBeenCalledWith(
        'SELECT lifecycle_state FROM tenants WHERE id = ?',
        ['second'],
        { consistencyClass: 'primary_required' }
      );
    }
  });

  it.each([
    ['the platform row is not active', { platformState: 'provisioning' }],
    ['the tenant row is not active', { tenantState: 'provisioning' }],
    ['the platform row is missing', { platformState: null }],
    ['the tenant row is missing', { tenantState: null }],
  ])('fails when %s after the update', async (_name, options) => {
    await expect(activateProvisionedTenantLifecycle(input(pair(options)))).rejects.toThrow(
      'tenant_provisioning_lifecycle_commit_failed'
    );
  });

  it.each([0, -5, 1.5, Number.NaN])('refuses the admission deadline %s', async (deadline) => {
    const both = pair();
    await expect(
      activateProvisionedTenantLifecycle(input(both, { admissionDeadlineMs: deadline }))
    ).rejects.toThrow('tenant_provisioning_lifecycle_commit_failed');
    expect(both.platformAdapter.execute).not.toHaveBeenCalled();
  });

  it('refuses a deadline on a database that cannot evaluate it', async () => {
    const both = pair({ type: 'sqlite' });
    await expect(
      activateProvisionedTenantLifecycle(input(both, { admissionDeadlineMs: 5 }))
    ).rejects.toThrow('tenant_provisioning_lifecycle_commit_failed');
    expect(both.platformAdapter.execute).not.toHaveBeenCalled();
  });

  it('guards each statement with the deadline against the database clock', async () => {
    const d1 = pair({ type: 'd1' });
    await activateProvisionedTenantLifecycle(input(d1, { admissionDeadlineMs: 5000 }));
    const update = d1.platformAdapter.calls[0];
    expect(update.sql).toContain(
      " AND ? > MAX(?,CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER))"
    );
    expect(update.params).toEqual([100, 'second', 5000, 100000]);
    const read = must(d1.tenantAdapter.calls.find((call) => call.op === 'queryOne'));
    expect(read.sql).toBe(
      "SELECT lifecycle_state FROM tenants WHERE id = ? AND ? > MAX(?,CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER))"
    );
    expect(read.params).toEqual(['second', 5000, 100000]);

    const postgres = pair({ type: 'postgres' });
    await activateProvisionedTenantLifecycle(input(postgres, { admissionDeadlineMs: 5000 }));
    expect(postgres.tenantAdapter.calls[0].sql).toContain(
      ' AND ? > GREATEST(?,CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000) AS BIGINT))'
    );
  });
});

describe('resolveActiveTenantRuntimeRouteObservation', () => {
  function sources(overrides: Record<string, Record<string, unknown>> = {}) {
    fakes.resolveSource.mockImplementation(
      async (_env: unknown, input: { role: string; shardGroup: string }) => ({
        role: input.role,
        shardGroup: input.shardGroup,
        shardIndex: 0,
        generation: 4,
        runtimeGeneration: 7,
        bindingRef: `DB_${input.role}_${input.shardGroup}`,
        ...overrides[`${input.role}/${input.shardGroup}`],
      })
    );
  }
  const dataRoleOf = (key: { role: string; shard_group: string }) =>
    key.role === 'tenant_pii'
      ? 'tenant_pii'
      : key.shard_group === 'users'
        ? 'tenant_core/users'
        : 'tenant_core/default';
  function rows(
    change?: (row: Record<string, unknown>, key: { role: string; shard_group: string }) => unknown
  ) {
    fakes.registry.getRegistryRow.mockImplementation(
      async (key: { role: string; shard_group: string }) => {
        const row = {
          status: 'active',
          generation: 4,
          binding_ref: `DB_${key.role}_${key.shard_group}`,
          metadata_json: JSON.stringify({
            control_data_role: dataRoleOf(key),
            control_shard_id: 'shard-1',
          }),
        };
        return change ? change(row, key) : row;
      }
    );
  }
  const observe = () => resolveActiveTenantRuntimeRouteObservation({ DB: {} } as never, 'second');

  it('resolves the three stores with a shared request cache and reads each registry row', async () => {
    sources();
    rows();
    const result = await observe();
    expect(result.targets.map((t) => t.dataRole)).toEqual([
      'tenant_core/default',
      'tenant_core/users',
      'tenant_pii',
    ]);
    expect(result.runtimeGeneration).toBe(7);
    const calls = fakes.resolveSource.mock.calls.map(([, input]) => input);
    expect(calls.map((input) => [input.role, input.shardGroup, input.shardIndex])).toEqual([
      ['tenant_core', 'default', 0],
      ['tenant_core', 'users', 0],
      ['tenant_pii', 'default', 0],
    ]);
    expect(calls[0].requestCache).toBe(calls[1].requestCache);
    expect(calls[1].requestCache).toBe(calls[2].requestCache);
    expect(fakes.registry.getRegistryRow).toHaveBeenCalledWith({
      tenant_id: 'second',
      role: 'tenant_pii',
      generation: 4,
      shard_group: 'default',
      shard_index: 0,
    });
  });

  it.each([
    ['no runtime generation', { 'tenant_core/default': { runtimeGeneration: undefined } }],
    ['a zero runtime generation', { 'tenant_core/default': { runtimeGeneration: 0 } }],
    ['a fractional runtime generation', { 'tenant_core/default': { runtimeGeneration: 1.5 } }],
    ['a differing runtime generation', { 'tenant_pii/default': { runtimeGeneration: 8 } }],
  ])('refuses %s', async (_name, overrides) => {
    sources(overrides);
    rows();
    await expect(observe()).rejects.toThrow(
      'tenant_runtime_registry_route_observation_generation_invalid'
    );
  });

  it('accepts a runtime generation of exactly 1', async () => {
    sources({
      'tenant_core/default': { runtimeGeneration: 1 },
      'tenant_core/users': { runtimeGeneration: 1 },
      'tenant_pii/default': { runtimeGeneration: 1 },
    });
    rows();
    expect((await observe()).runtimeGeneration).toBe(1);
  });

  it.each([
    ['a missing row', () => null],
    ['an inactive row', (row: Record<string, unknown>) => ({ ...row, status: 'retired' })],
    ['another binding', (row: Record<string, unknown>) => ({ ...row, binding_ref: 'other' })],
    ['another generation', (row: Record<string, unknown>) => ({ ...row, generation: 3 })],
  ])('refuses %s in the registry', async (_name, change) => {
    sources();
    rows(change);
    await expect(observe()).rejects.toThrow(
      'tenant_runtime_registry_route_observation_registry_mismatch'
    );
  });

  it.each([
    [
      'unreadable metadata',
      (row: Record<string, unknown>) => ({ ...row, metadata_json: '{broken' }),
    ],
    ['null metadata', (row: Record<string, unknown>) => ({ ...row, metadata_json: null })],
    ['array metadata', (row: Record<string, unknown>) => ({ ...row, metadata_json: '[1]' })],
    [
      'metadata of another role',
      (row: Record<string, unknown>) => ({
        ...row,
        metadata_json: '{"control_data_role":"x","control_shard_id":"s"}',
      }),
    ],
    [
      'no shard id',
      (row: Record<string, unknown>, key: { role: string; shard_group: string }) => ({
        ...row,
        metadata_json: JSON.stringify({ control_data_role: dataRoleOf(key) }),
      }),
    ],
    [
      'an empty shard id',
      (row: Record<string, unknown>, key: { role: string; shard_group: string }) => ({
        ...row,
        metadata_json: JSON.stringify({ control_data_role: dataRoleOf(key), control_shard_id: '' }),
      }),
    ],
  ])('refuses %s', async (_name, change) => {
    sources();
    rows(change);
    await expect(observe()).rejects.toThrow(
      'tenant_runtime_registry_route_observation_metadata_invalid'
    );
  });

  it('refuses a store without a binding', async () => {
    sources({ 'tenant_pii/default': { bindingRef: undefined } });
    rows((row, key) => (key.role === 'tenant_pii' ? { ...row, binding_ref: undefined } : row));
    await expect(observe()).rejects.toThrow(
      'tenant_runtime_registry_route_observation_metadata_invalid'
    );
  });
});
