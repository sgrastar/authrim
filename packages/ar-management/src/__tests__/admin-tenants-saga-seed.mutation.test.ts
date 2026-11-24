/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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

import { TENANT_POLICY_PRESETS, buildIssuerUrl, usesNakedDomainIssuer } from '@authrim/ar-lib-core';
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

describe('processNextTenantProvisioning', () => {
  it('requires the environment name', async () => {
    await expect(
      processNextTenantProvisioning({ AUTHRIM_ENVIRONMENT_NAME: undefined, DB: {} } as never)
    ).rejects.toThrow('tenant_provisioning_environment_missing');
  });

  it('does nothing when no operation can be claimed', async () => {
    fakes.repository.claimNext.mockResolvedValue(null);
    expect(
      await processNextTenantProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test', DB: {} } as never)
    ).toBe(false);
    expect(fakes.saga).not.toHaveBeenCalled();
    expect(fakes.repository.claimNext).toHaveBeenCalledWith(
      'test',
      expect.stringMatching(/^management:[0-9a-f-]{36}$/),
      T0
    );
  });

  it('runs the saga for a claimed operation with the clock in seconds', async () => {
    const env = { AUTHRIM_ENVIRONMENT_NAME: 'test', DB: {} } as never;
    fakes.repository.claimNext.mockResolvedValue({ lease: true });
    fakes.saga.mockResolvedValue(undefined);
    expect(await processNextTenantProvisioning(env)).toBe(true);
    const input = fakes.saga.mock.calls[0][0];
    expect(input).toMatchObject({ env, repository: fakes.repository, lease: { lease: true } });
    expect(input.now()).toBe(T0);
    expect(Object.keys(input.dependencies).sort()).toEqual(
      [
        'activateLookup',
        'activateTenant',
        'prepareTenant',
        'publishRegistry',
        'seedTenant',
        'smokeTenant',
        'validatePlatformDraft',
      ].sort()
    );
  });
});

describe('validatePlatformDraft', () => {
  const draft = (overrides: Record<string, unknown> = {}) => ({
    id: 'second',
    tenant_code: 'second-code',
    name: 'Second Tenant',
    description: 'about',
    lifecycle_state: 'provisioning',
    ...overrides,
  });

  async function validate(options: { draft?: unknown; owner?: unknown } = {}) {
    const platform = createAdapter((sql) => {
      if (sql.includes('FROM tenants WHERE id = ?')) return options.draft ?? null;
      if (sql === 'SELECT id FROM tenants WHERE tenant_code = ?') return options.owner ?? null;
      return null;
    });
    const { deps } = await dependencies({ DB: platform });
    return { run: () => deps.validatePlatformDraft(operation()), platform };
  }

  it('accepts a draft that matches the operation', async () => {
    const { run, platform } = await validate({ draft: draft() });
    await expect(run()).resolves.toBeUndefined();
    expect(platform.calls).toHaveLength(1);
    expect(platform.calls[0].params).toEqual(['second']);
  });

  it.each([
    ['code', { tenant_code: 'other' }],
    ['name', { name: 'Other' }],
    ['description', { description: null }],
    ['lifecycle state', { lifecycle_state: 'active' }],
  ])('refuses a draft whose %s differs', async (_name, change) => {
    const { run } = await validate({ draft: draft(change) });
    await expect(run()).rejects.toThrow('tenant_provisioning_platform_draft_conflict');
  });

  it('reports a missing draft, and a conflict when another tenant owns the code', async () => {
    const missing = await validate();
    await expect(missing.run()).rejects.toThrow('tenant_provisioning_platform_draft_missing');
    expect(missing.platform.calls[1].params).toEqual(['second-code']);
    const same = await validate({ owner: { id: 'second' } });
    await expect(same.run()).rejects.toThrow('tenant_provisioning_platform_draft_missing');
    const other = await validate({ owner: { id: 'someone-else' } });
    await expect(other.run()).rejects.toThrow('tenant_provisioning_platform_draft_conflict');
  });
});

describe('seedTenant', () => {
  async function seed(env: Record<string, unknown> = {}, op = operation()) {
    const tenantAdapter = createAdapter();
    fakes.d1.set('tenant-provisioning:second', tenantAdapter);
    const { deps, env: fullEnv } = await dependencies(env);
    await deps.seedTenant(op, coreRoute());
    return { tenantAdapter, env: fullEnv as Record<string, any> };
  }

  it('writes the tenant row, claim schemas and the default contract', async () => {
    const { tenantAdapter, env } = await seed();
    const insert = tenantAdapter.calls[0];
    expect(insert.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(insert.params[0]).toBe('second');
    expect(insert.params[1]).toBe('second-code');
    expect(insert.params[2]).toEqual(expect.any(String));
    expect(insert.params.slice(3, 10)).toEqual([
      'Second Tenant',
      'about',
      'tenant_exclusive',
      'provisioning',
      null,
      T0,
      T0,
    ]);
    const { seedBuiltinProfileClaimSchemas } =
      await import('./helpers/admin-tenants-mutation-harness');
    expect(seedBuiltinProfileClaimSchemas).toHaveBeenCalledWith({
      db: tenantAdapter,
      tenantId: 'second',
      now: T0,
    });
    const contract = JSON.parse(await env.AUTHRIM_CONFIG.get('tenant:second'));
    expect(contract).toMatchObject({
      tenantId: 'second',
      version: 1,
      preset: 'b2c-standard',
      profile: 'human',
      maxSessionAgeSeconds: 3600,
      metadata: {
        createdBy: 'system',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('refuses to seed when the default policy preset is missing', async () => {
    const original = [...TENANT_POLICY_PRESETS];
    TENANT_POLICY_PRESETS.length = 0;
    try {
      await expect(seed()).rejects.toThrow('tenant_default_policy_preset_missing');
    } finally {
      TENANT_POLICY_PRESETS.push(...original);
    }
  });

  it('seeds every settings category, in KV and in the canonical store, and marks them projected', async () => {
    const { env } = await seed();
    const tenantSettings = {
      'tenant.allowed_origins':
        'https://second.auth.example.com,https://ui.example.com,https://admin.example.com',
      'tenant.allowed_domains': 'second.auth.example.com',
      'tenant.allowed_identifiers':
        'https://second.auth.example.com,did:web:second.auth.example.com',
    };
    expect(JSON.parse(await env.AUTHRIM_CONFIG.get('settings:tenant:second:tenant'))).toEqual(
      tenantSettings
    );
    expect(
      JSON.parse(await env.AUTHRIM_CONFIG.get('settings:tenant:second:email-settings'))
    ).toEqual({
      strategy: 'priority_failover',
      providerOrder: [],
    });
    const replaced: Record<string, { scope: unknown; data: unknown; version: string }> =
      Object.fromEntries(
        fakes.canonical.replace.mock.calls.map(([category, scope, value]) => [
          category,
          { scope, data: value.data, version: value.version },
        ])
      );
    expect(Object.keys(replaced).sort()).toEqual(
      [
        'authentication-methods',
        'directory-connectors',
        'email-settings',
        'login-entry',
        'login-ui',
        'tenant',
        'tenant-discovery-ui',
      ].sort()
    );
    expect(replaced.tenant.data).toEqual(tenantSettings);
    expect(replaced['login-ui'].data).toEqual({ 'login-ui.brand_name': 'second' });
    expect(replaced['directory-connectors'].data).toEqual({
      enabled: false,
      default_connector_id: 'campus',
      auto_provision: false,
      connectors: [],
    });
    expect(replaced['authentication-methods'].data).toEqual({});
    expect(replaced['login-entry'].data).toEqual({});
    expect(replaced['tenant-discovery-ui'].data).toEqual({});
    for (const entry of Object.values(replaced)) {
      expect(entry.scope).toEqual({ type: 'tenant', id: 'second' });
      expect(entry.version).toBe(`v:${JSON.stringify(entry.data)}`);
    }
    expect(fakes.canonical.markProjected).toHaveBeenCalledTimes(7);
    expect(fakes.canonical.markProjected).toHaveBeenCalledWith(
      'login-ui',
      { type: 'tenant', id: 'second' },
      replaced['login-ui'].version
    );
    expect(JSON.parse(await env.SETTINGS.get('settings:tenant:second:login-ui'))).toEqual({
      'login-ui.brand_name': 'second',
    });
    expect(fakes.canonical.adapters[0]).toBe(adapters.lifecycleJobsAdapter);
    expect(fakes.emailOrder).toHaveBeenCalledWith(env, 'second');
  });

  it('keeps settings out of the UI KV and unprojected when there is no SETTINGS binding', async () => {
    await seed({ SETTINGS: undefined });
    expect(fakes.canonical.replace).toHaveBeenCalledTimes(7);
    expect(fakes.canonical.markProjected).not.toHaveBeenCalled();
  });

  it('builds the allowed origins from the base domain, the naked domain of the primary tenant and the UIs', async () => {
    vi.mocked(usesNakedDomainIssuer).mockReturnValue(true);
    const naked = await seed();
    expect(
      JSON.parse(await naked.env.AUTHRIM_CONFIG.get('settings:tenant:second:tenant'))[
        'tenant.allowed_origins'
      ]
    ).toBe(
      'https://second.auth.example.com,https://auth.example.com,https://ui.example.com,https://admin.example.com'
    );
    expect(usesNakedDomainIssuer).toHaveBeenCalledWith(expect.anything(), 'second');
    vi.mocked(usesNakedDomainIssuer).mockReturnValue(false);
    const noBase = await seed({ BASE_DOMAIN: undefined, UI_URL: undefined });
    expect(
      JSON.parse(await noBase.env.AUTHRIM_CONFIG.get('settings:tenant:second:tenant'))[
        'tenant.allowed_origins'
      ]
    ).toBe('https://admin.example.com');
    const none = await seed({ BASE_DOMAIN: undefined, UI_URL: undefined, ADMIN_UI_URL: undefined });
    expect(
      JSON.parse(await none.env.AUTHRIM_CONFIG.get('settings:tenant:second:tenant'))[
        'tenant.allowed_origins'
      ]
    ).toBe('');
  });

  it('leaves the issuer-derived settings empty when the issuer URL cannot be built', async () => {
    vi.mocked(buildIssuerUrl).mockImplementation(() => {
      throw new Error('no issuer');
    });
    try {
      const { env } = await seed();
      const settings = JSON.parse(await env.AUTHRIM_CONFIG.get('settings:tenant:second:tenant'));
      expect(settings['tenant.allowed_domains']).toBe('');
      expect(settings['tenant.allowed_identifiers']).toBe('');
    } finally {
      vi.mocked(buildIssuerUrl).mockImplementation(
        (env: any, tenantId: string) => `https://${tenantId}.${env.BASE_DOMAIN}`
      );
    }
  });

  it('seeds screens, flows, consent statements, keys and the Login UI client in the tenant database', async () => {
    const { tenantAdapter, env } = await seed();
    expect(fakes.screens).toHaveBeenCalledWith(tenantAdapter, 'second');
    expect(fakes.loginFlow).toHaveBeenCalledWith(tenantAdapter, 'second', T0);
    expect(fakes.registrationFlow).toHaveBeenCalledWith(tenantAdapter, 'second', T0);
    expect(fakes.consent).toHaveBeenCalledWith(tenantAdapter, 'second');
    expect(fakes.loginUiClient).toHaveBeenCalledWith(env, tenantAdapter, 'second');
    expect(env.KEY_MANAGER.idFromName).toHaveBeenCalledWith('second-v3');
    const manager = env.KEY_MANAGER.get.mock.results[0].value;
    expect(manager.rotateKeysRpc).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing signing key of a tenant that already has one', async () => {
    const keyManager = createKeyManager() as any;
    keyManager.get().getStatusRpc.mockResolvedValue({ activeKeyId: 'key-1' });
    await seed({ KEY_MANAGER: keyManager });
    expect(keyManager.get().rotateKeysRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['not an object', 'text'],
    ['without prepare', { other: 1 }],
    ['with a non-function prepare', { prepare: 'x' }],
  ])('refuses a default binding that is %s', async (_name, value) => {
    const { deps } = await dependencies({ 'DB_tenant_core/default': value });
    await expect(deps.seedTenant(operation(), coreRoute())).rejects.toThrow(
      'tenant_provisioning_default_binding_unavailable'
    );
    expect(fakes.canonical.replace).not.toHaveBeenCalled();
  });
});
