import { afterEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const recorder = (name: string, members: () => Record<string, unknown> = () => ({})) =>
    class {
      constructor(...args: unknown[]) {
        record(name, args);
        Object.assign(this, members());
      }
    };
  const statuses: { taskSetStatus?: string; scopePolicyStatus?: string } = {
    taskSetStatus: 'active',
    scopePolicyStatus: 'active',
  };
  return {
    calls,
    record,
    recorder,
    last: (name: string) => calls[name]?.at(-1) ?? [],
    settings: {
      highRiskPermissionsAdditional: ['x:y'],
      publicClientStandardToolIds: [] as string[],
    },
    ...statuses,
    tenantRows: {},
  };
});

vi.mock('agents/mcp', () => ({ McpAgent: class {} }));
vi.mock('../platform/cloudflare/mcp-agent', async (original) => ({
  ...(await original<typeof import('../platform/cloudflare/mcp-agent')>()),
  createCloudflareAgentAccessMcpAgent: (options: unknown) => {
    rec.record('agentOptions', [options]);
    return class {};
  },
  validateCloudflareAgentAccessMcpSession: vi.fn(async () => 'active'),
  destroyCloudflareAgentAccessMcpSession: vi.fn(async () => undefined),
}));
vi.mock('../platform/cloudflare/mcp-admission', async (original) => ({
  ...(await original<typeof import('../platform/cloudflare/mcp-admission')>()),
  createCloudflareAgentAccessMcpWorker: (agent: unknown, options: unknown) => {
    rec.record('workerOptions', [agent, options]);
    return { fetch: vi.fn() };
  },
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: (_env: unknown, name: string) => ({ database: name }),
  resolveTenantDatabaseSourceFromRegistry: async (_env: unknown, input: { tenantId: string }) => {
    rec.record('registry', [input]);
    return { source: { tenantId: input.tenantId } };
  },
  ensureDatabaseAdapter: (source: { tenantId: string }, name: string) => ({
    queryOne: async (sql: string, params: unknown[]) => {
      rec.record('tenantQuery', [name, sql, params]);
      const rows: Record<string, string | undefined> = rec.tenantRows;
      const id = rows[source.tenantId];
      return id ? { id } : null;
    },
  }),
}));
vi.mock('../core', async (original) => ({
  ...(await original<typeof import('../core')>()),
  AdminAgentAccessRepository: rec.recorder('AdminAgentAccessRepository', () => ({
    getActiveDelegatorPermissions: vi.fn(async () => ['perm']),
  })),
  AgentConfigurationRepository: rec.recorder('AgentConfigurationRepository', () => ({
    getScopePolicyVersion: vi.fn(async (...args: unknown[]) => {
      rec.record('scopePolicy', args);
      return rec.scopePolicyStatus ? { status: rec.scopePolicyStatus } : null;
    }),
  })),
  LiveAgentAuthorizationService: rec.recorder('LiveAgentAuthorizationService'),
  getAgentTaskSetWithBuiltins: vi.fn(async (input: unknown) => {
    rec.record('taskSet', [input]);
    return rec.taskSetStatus ? { status: rec.taskSetStatus } : null;
  }),
}));
vi.mock('../platform/cloudflare/tenant-settings', () => ({
  CloudflareAgentSettingsProvider: rec.recorder('CloudflareAgentSettingsProvider', () => ({
    get: vi.fn(async (tenantId: string) => {
      rec.record('settingsGet', [tenantId]);
      return rec.settings;
    }),
  })),
}));
vi.mock('../platform/cloudflare/token-authentication', () => ({
  createCloudflareAgentAccessTokenAuthenticator: () => 'token-authenticator',
  isCloudflareAgentAccessMcpEnabled: vi.fn(async (...args: unknown[]) => {
    rec.record('featureFlag', args);
    return true;
  }),
}));
vi.mock('../platform/cloudflare/machine-permission-limit', () => ({
  machinePermissionLimit: vi.fn(async (...args: unknown[]) => {
    rec.record('machineLimit', args);
    return ['limit'];
  }),
}));
vi.mock('../platform/cloudflare/elevation', () => ({
  CloudflareAgentElevationAdapter: rec.recorder('CloudflareAgentElevationAdapter'),
}));
vi.mock('../platform/cloudflare/bulk-plan-adapter', () => ({
  CloudflareAgentBulkPlanAdapter: rec.recorder('CloudflareAgentBulkPlanAdapter'),
}));
vi.mock('../platform/cloudflare/mcp-session-registry', () => ({
  CloudflareAgentMcpSessionRegistry: rec.recorder('CloudflareAgentMcpSessionRegistry'),
}));
vi.mock('../platform/cloudflare/durable-object-rate-limiter', () => ({
  CloudflareDurableObjectRateLimiter: rec.recorder('CloudflareDurableObjectRateLimiter'),
}));
vi.mock('../platform/cloudflare/mcp-admission-audit', () => ({
  CloudflareAgentMcpAdmissionAuditAdapter: rec.recorder('CloudflareAgentMcpAdmissionAuditAdapter'),
}));
vi.mock('../platform/cloudflare/service-binding', async (original) => ({
  ...(await original<typeof import('../platform/cloudflare/service-binding')>()),
  CloudflareServiceBindingManagementApi: rec.recorder('CloudflareServiceBindingManagementApi'),
}));

import '../platform/cloudflare/worker';
import { CLOUDFLARE_ADMIN_READ_ROUTES } from '../platform/cloudflare/admin-read-routes';
import { CLOUDFLARE_ADMIN_WRITE_ROUTES } from '../platform/cloudflare/admin-write-routes';
import { createAdminToolCatalog } from '../protocol/mcp';
import { isPublicClientStandardOptInEligibleTool } from '../core';

type AnyFn = (...args: unknown[]) => unknown;
const agentOptions = rec.last('agentOptions')[0] as {
  getEnvironmentName(env: unknown): unknown;
  createDependencies(env: unknown, getRequest: unknown, profiles: unknown): Record<string, unknown>;
};

function dependencies(env: Record<string, unknown> = {}) {
  return agentOptions.createDependencies(
    { RATE_LIMITER: 'rate-ns', OP_MANAGEMENT: 'mgmt', OP_DISCOVERY: 'disc', ...env },
    () => undefined,
    'profiles'
  );
}

const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
}

afterEach(() => {
  vi.useRealTimers();
});

function authorizationOptions() {
  return rec.last('LiveAgentAuthorizationService')[0] as Record<string, AnyFn>;
}

describe('McpAgent dependency composition', () => {
  it('reads the environment name and wires dedicated admin databases', () => {
    expect(agentOptions.getEnvironmentName({ AUTHRIM_ENVIRONMENT_NAME: 'prod-1' })).toBe('prod-1');
    const deps = dependencies();
    expect(rec.last('AdminAgentAccessRepository')[0]).toEqual({
      database: 'agent-access-mcp-worker',
    });
    expect(rec.last('AgentConfigurationRepository')[0]).toEqual({
      database: 'agent-access-mcp-worker',
    });
    expect(deps.discoveryProfiles).toBe('profiles');
    expect(Object.keys(deps).sort()).toEqual(
      [
        'toolCatalog',
        'authorization',
        'managementApi',
        'rateLimiter',
        'settings',
        'audit',
        'clock',
        'schemaValidator',
        'elevation',
        'resources',
        'resourceTemplates',
        'prompts',
        'configurationPlans',
        'bulkPlans',
        'runtimeDiagnostics',
        'discoveryProfiles',
      ].sort()
    );
    expect(rec.last('CloudflareDurableObjectRateLimiter')).toEqual(['rate-ns']);
    const clock = deps.clock as { now(): number };
    freezeClock();
    expect(clock.now()).toBe(FIXED_NOW);
  });

  it('routes Management calls through every read and write admin route', () => {
    dependencies();
    const [binding, routes] = rec.last('CloudflareServiceBindingManagementApi');
    expect(binding).toBe('mgmt');
    expect(Object.keys(routes as object).sort()).toEqual(
      Object.keys({ ...CLOUDFLARE_ADMIN_READ_ROUTES, ...CLOUDFLARE_ADMIN_WRITE_ROUTES }).sort()
    );
    expect(Object.keys(routes as object).length).toBeGreaterThan(0);
  });

  it('delegates live authorization lookups to the composed repositories', async () => {
    const env = { RATE_LIMITER: 'rate-ns' };
    agentOptions.createDependencies(env, () => undefined, 'profiles');
    const options = authorizationOptions();
    freezeClock();
    expect(options.now()).toBe(FIXED_NOW);
    await expect(options.isFeatureEnabled('tenant-1')).resolves.toBe(true);
    expect(rec.last('featureFlag')).toEqual([env, 'tenant-1']);
    await expect(options.getDelegatorPermissions('t', 'd', 5)).resolves.toEqual(['perm']);
    await expect(options.getPrincipalPermissionLimit('t', 'p', 'c')).resolves.toEqual(['limit']);
    expect(rec.last('machineLimit').slice(1)).toEqual(['t', 'p', 'c']);
    expect(rec.last('machineLimit')[0]).toBeDefined();
  });

  it('builds the tenant risk policy and keeps only opt-in eligible standard tools', async () => {
    const eligible = createAdminToolCatalog()
      .list()
      .filter(isPublicClientStandardOptInEligibleTool)
      .map((tool) => tool.id);
    rec.settings.publicClientStandardToolIds = [...eligible, 'not-a-tool', 'users.get'];
    dependencies();
    await expect(authorizationOptions().getRiskPolicy('tenant-1')).resolves.toEqual({
      allowedRiskByAssurance: {
        public_client_transaction: ['low'],
        confidential_client: ['low', 'standard'],
        machine_key: ['low', 'standard', 'high'],
      },
      highRiskRequiresElevation: true,
      dpopRequiredForModeB: true,
      highRiskPermissionsAdditional: ['x:y'],
      publicClientStandardToolIds: eligible,
    });
    expect(rec.last('settingsGet')).toEqual(['tenant-1']);
  });

  it.each([
    ['active', 'active', true],
    ['retired', 'active', false],
    ['active', 'retired', false],
    [undefined, 'active', false],
    ['active', undefined, false],
  ])(
    'treats task set %s and scope policy %s as snapshot active=%s',
    async (taskSet, scopePolicy, expected) => {
      rec.taskSetStatus = taskSet;
      rec.scopePolicyStatus = scopePolicy;
      dependencies();
      const snapshot = {
        taskSetId: 'ts',
        taskSetVersion: 2,
        scopePolicyId: 'sp',
        scopePolicyVersion: 3,
      };
      await expect(
        authorizationOptions().isConfigurationSnapshotActive('tenant-1', snapshot)
      ).resolves.toBe(expected);
      expect(rec.last('taskSet')[0]).toMatchObject({ tenantId: 'tenant-1', id: 'ts', version: 2 });
      expect(rec.last('scopePolicy')).toEqual(['tenant-1', 'sp', 3]);
      rec.taskSetStatus = 'active';
      rec.scopePolicyStatus = 'active';
    }
  );

  it('keys the elevation secret by the configured version, defaulting to v1', async () => {
    const hex = 'ab'.repeat(32);
    dependencies({ AGENT_ELEVATION_ENCRYPTION_KEY: hex });
    type ElevationArgs = [unknown, { getEncryptionKey(id: string): Promise<CryptoKey> }, unknown];
    let [, keys, options] = rec.last('CloudflareAgentElevationAdapter') as ElevationArgs;
    expect(options).toEqual({ payloadKeyId: 'v1' });
    await expect(keys.getEncryptionKey('v1')).resolves.toBeDefined();
    dependencies({ AGENT_ELEVATION_ENCRYPTION_KEY: hex, AGENT_ELEVATION_KEY_VERSION: 'v7' });
    [, keys, options] = rec.last('CloudflareAgentElevationAdapter') as ElevationArgs;
    expect(options).toEqual({ payloadKeyId: 'v7' });
    await expect(keys.getEncryptionKey('v7')).resolves.toBeDefined();
    await expect(keys.getEncryptionKey('v1')).rejects.toThrow('unavailable');
  });

  it('resolves only active bulk target tenants from their own core databases', async () => {
    rec.tenantRows = { 't-1': 't-1', 't-2': undefined, 't-3': 'other' };
    dependencies();
    const args = rec.last('CloudflareAgentBulkPlanAdapter');
    const resolve = args[4] as (ids: string[]) => Promise<Set<string>>;
    const now = args[5] as () => number;
    freezeClock();
    expect(now()).toBe(FIXED_NOW);
    rec.calls.registry = [];
    const active = await resolve(['t-1', 't-2', 't-3']);
    expect([...active]).toEqual(['t-1']);
    expect(rec.calls.registry?.map(([input]) => input)).toEqual(
      ['t-1', 't-2', 't-3'].map((tenantId) => ({
        tenantId,
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        shardGroup: 'default',
        shardIndex: 0,
      }))
    );
    expect(rec.last('tenantQuery')).toEqual([
      'agent-bulk-tenant-directory',
      "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active' LIMIT 1",
      ['t-3'],
    ]);
    await expect(resolve([])).resolves.toEqual(new Set());
  });

  it('checks every tenant even when there are more tenants than workers', async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `bulk-${index}`);
    rec.tenantRows = Object.fromEntries(ids.map((id) => [id, id]));
    dependencies();
    const resolve = rec.last('CloudflareAgentBulkPlanAdapter')[4] as (
      ids: string[]
    ) => Promise<Set<string>>;
    await expect(resolve(ids)).resolves.toEqual(new Set(ids));
  });
});
