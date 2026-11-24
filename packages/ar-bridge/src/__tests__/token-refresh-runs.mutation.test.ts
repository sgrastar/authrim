import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, callArg } from './helpers/mock-args';

const m = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  scanQuery: vi.fn(),
  adminQuery: vi.fn(),
  adminExecute: vi.fn(),
  ensureDb: vi.fn(),
  ensureAdmin: vi.fn(),
  getDefaultTenantId: vi.fn(),
  listTenants: vi.fn(),
  store: vi.fn(),
  getKey: vi.fn(),
  listShards: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({ module: () => m.log }),
  ensureAdminDatabaseAdapter: m.ensureAdmin,
  ensureDatabaseAdapter: m.ensureDb,
  getDefaultTenantId: m.getDefaultTenantId,
  listEnvironmentTenantDefaultStores: m.listTenants,
  storeImmediateChunkedSensitiveDetailJson: m.store,
}));
vi.mock('../services/provider-store', () => ({ getProvider: vi.fn() }));
vi.mock('../services/linked-identity-store', () => ({
  updateLinkedIdentity: vi.fn(),
  decryptLinkedIdentityTokens: vi.fn(),
}));
vi.mock('../clients/oidc-client', () => ({ OIDCRPClient: { fromProvider: vi.fn() } }));
vi.mock('../utils/crypto', () => ({ decrypt: vi.fn(), getEncryptionKeyOrUndefined: m.getKey }));

import {
  getTokenRefreshConfig,
  listTokenRefreshRuns,
  normalizeTokenRefreshConfig,
  refreshExpiringTokensForScheduledTenants,
  refreshExpiringTokensForTenantManual,
  setTokenRefreshConfig,
} from '../services/token-refresh';

const NOW = 1_700_000_000_000;
const CONFIG_KEY = 'external_idp_token_refresh';
const DEFAULTS = {
  enabled: false,
  refreshThresholdSeconds: 3600,
  batchSize: 100,
  scheduledTenantBatchSize: 100,
  piiShardPageSize: 4,
};

function settings(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

function envWith(initial: Record<string, string>, extra: Record<string, unknown> = {}) {
  const s = settings(initial);
  const env = {
    SETTINGS: s,
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: { listExternalIdpPiiSourceShards: m.listShards },
    DB_A: {},
    ...extra,
  };
  return { s, env: env as never };
}

const ENABLED = { [CONFIG_KEY]: JSON.stringify({ enabled: true }) };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  m.scanQuery.mockReset().mockResolvedValue([]);
  m.ensureDb.mockReset().mockReturnValue({ query: m.scanQuery });
  m.adminQuery.mockReset().mockResolvedValue([]);
  m.adminExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  m.ensureAdmin.mockReset().mockReturnValue({ query: m.adminQuery, execute: m.adminExecute });
  m.getDefaultTenantId.mockReset().mockReturnValue('default-tenant');
  m.listTenants.mockReset().mockResolvedValue([]);
  m.store.mockReset().mockResolvedValue({ catalogId: 'cat-1' });
  m.getKey.mockReset().mockReturnValue('enc-key');
  m.listShards.mockReset().mockResolvedValue([
    {
      shardId: 'a',
      bindingRef: 'DB_A',
      residencyPartition: 'default',
      routeGeneration: 1,
    },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('token refresh configuration', () => {
  it('uses the defaults when nothing is stored', async () => {
    await expect(getTokenRefreshConfig(envWith({}).env)).resolves.toEqual(DEFAULTS);
  });

  it('uses the defaults without SETTINGS, on unreadable KV and on invalid JSON', async () => {
    await expect(getTokenRefreshConfig({} as never)).resolves.toEqual(DEFAULTS);
    const broken = { SETTINGS: { get: vi.fn().mockRejectedValue(new Error('kv down')) } };
    await expect(getTokenRefreshConfig(broken as never)).resolves.toEqual(DEFAULTS);
    await expect(getTokenRefreshConfig(envWith({ [CONFIG_KEY]: '{nope' }).env)).resolves.toEqual(
      DEFAULTS
    );
  });

  it('normalizes the stored value', async () => {
    const stored = JSON.stringify({ enabled: true, batchSize: 5, refreshThresholdSeconds: 10 });
    await expect(getTokenRefreshConfig(envWith({ [CONFIG_KEY]: stored }).env)).resolves.toEqual({
      ...DEFAULTS,
      enabled: true,
      batchSize: 5,
      refreshThresholdSeconds: 10,
    });
  });

  it('persists and returns the normalized configuration', async () => {
    const { s, env } = envWith({});
    const out = await setTokenRefreshConfig(env, { enabled: true, batchSize: 5000 });
    expect(out).toEqual({ ...DEFAULTS, enabled: true, batchSize: 1000 });
    expect(s.put).toHaveBeenCalledWith(CONFIG_KEY, JSON.stringify(out));
  });

  it('refuses to persist without SETTINGS', async () => {
    await expect(setTokenRefreshConfig({} as never, {})).rejects.toThrow(
      'SETTINGS is not configured'
    );
  });

  it('accepts the boundaries and rejects non-positive, non-finite and non-numeric values', () => {
    expect(normalizeTokenRefreshConfig({})).toEqual(DEFAULTS);
    const limits = normalizeTokenRefreshConfig({
      batchSize: 1000,
      scheduledTenantBatchSize: 100,
      piiShardPageSize: 32,
    });
    expect(limits).toMatchObject({ batchSize: 1000, scheduledTenantBatchSize: 100 });
    expect(limits.piiShardPageSize).toBe(32);
    const over = normalizeTokenRefreshConfig({
      batchSize: 1001,
      scheduledTenantBatchSize: 101,
      piiShardPageSize: 33,
    });
    expect([over.batchSize, over.scheduledTenantBatchSize, over.piiShardPageSize]).toEqual([
      1000, 100, 32,
    ]);
    // threshold has no upper cap
    expect(normalizeTokenRefreshConfig({ refreshThresholdSeconds: 10 ** 9 })).toMatchObject({
      refreshThresholdSeconds: 10 ** 9,
    });
    expect(normalizeTokenRefreshConfig({ batchSize: 2.9 }).batchSize).toBe(2);
    expect(normalizeTokenRefreshConfig({ batchSize: 1 }).batchSize).toBe(1);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      const n = normalizeTokenRefreshConfig({
        batchSize: bad as never,
        refreshThresholdSeconds: bad as never,
        scheduledTenantBatchSize: bad as never,
        piiShardPageSize: bad as never,
      });
      expect(n).toEqual(DEFAULTS);
    }
    expect(normalizeTokenRefreshConfig({ enabled: 'true' as never }).enabled).toBe(false);
    expect(normalizeTokenRefreshConfig({ enabled: true }).enabled).toBe(true);
  });
});

describe('listTokenRefreshRuns', () => {
  it('returns nothing without an admin database', async () => {
    m.ensureAdmin.mockReturnValue(null);
    await expect(listTokenRefreshRuns({} as never, 't1')).resolves.toEqual([]);
    expect(m.ensureAdmin).toHaveBeenCalledWith({}, 'bridge-token-refresh-runs');
  });

  it('platform view lists whole runs with no column parameters', async () => {
    m.adminQuery.mockResolvedValue([{ id: 'r1' }]);
    await expect(listTokenRefreshRuns({} as never, 't1', 10, 'platform')).resolves.toEqual([
      { id: 'r1' },
    ]);
    const sql = String(callArg(m.adminQuery, 0, 0));
    expect(sql).toContain('r.cursor_before, r.cursor_after, r.detail_object_catalog_id');
    expect(sql).toContain('FROM admin_external_token_refresh_runs r');
    expect(sql).toContain('ORDER BY r.started_at DESC');
    expect(callArg(m.adminQuery, 0, 1)).toEqual(['t1', 't1', 10]);
  });

  it('tenant view hides cursors and other tenants, binding the tenant for each column', async () => {
    await listTokenRefreshRuns({} as never, 't1');
    const sql = String(callArg(m.adminQuery, 0, 0));
    expect(sql).toContain('NULL AS cursor_before, NULL AS cursor_after');
    expect(sql).toContain('NULL AS detail_object_catalog_id');
    expect(callArg(m.adminQuery, 0, 1)).toEqual([
      't1',
      't1',
      't1',
      't1',
      't1',
      't1',
      't1',
      't1',
      50,
    ]);
  });

  it.each([
    [0, 1],
    [-5, 1],
    [1, 1],
    [2.9, 2],
    [100, 100],
    [101, 100],
    [10_000, 100],
  ])('clamps the limit %s to %s', async (input, expected) => {
    await listTokenRefreshRuns({} as never, 't1', input, 'platform');
    expect(callArg(m.adminQuery, 0, 1)).toEqual(['t1', 't1', expected]);
  });

  it('returns nothing and warns when the history tables are unavailable', async () => {
    m.adminQuery.mockRejectedValue(new RangeError('no table'));
    await expect(listTokenRefreshRuns({} as never, 't1')).resolves.toEqual([]);
    expect(m.log.warn).toHaveBeenCalledWith('Token refresh run history unavailable', {
      errorName: 'RangeError',
    });
    m.adminQuery.mockRejectedValue('text');
    await listTokenRefreshRuns({} as never, 't1');
    expect(m.log.warn).toHaveBeenLastCalledWith('Token refresh run history unavailable', {
      errorName: 'UnknownError',
    });
  });
});

describe('manual tenant refresh', () => {
  it('runs even when scheduled scanning is disabled and records the run', async () => {
    const { env } = envWith({});
    const out = await refreshExpiringTokensForTenantManual(env, 'tenant-a', {
      actorType: 'user',
      actorId: 'admin-1',
      authMethod: 'session',
    } as never);
    expect(out).toMatchObject({ tenantId: 'tenant-a', tokensRefreshed: 0, status: 'completed' });
    expect(out.runId).toMatch(/^etr_[0-9a-f]{32}$/);

    const insert = m.adminExecute.mock.calls[0];
    expect(String(insert?.[0])).toContain('INSERT INTO admin_external_token_refresh_runs');
    expect(String(insert?.[0])).toContain("'running'");
    expect(insert?.[1]).toEqual([
      out.runId,
      'manual_tenant',
      'tenant-a',
      'user',
      'admin-1',
      '{"refreshThresholdSeconds":3600,"batchSize":100,"scheduledTenantBatchSize":100,"piiShardPageSize":4,"enabled":false}',
      null,
      NOW,
    ]);
    const tenantRun = m.adminExecute.mock.calls[1];
    expect(String(tenantRun?.[0])).toContain(
      'INSERT OR REPLACE INTO admin_external_token_refresh_tenant_runs'
    );
    expect(tenantRun?.[1]).toEqual([out.runId, 'tenant-a', 'completed', 0, null, NOW, NOW]);
    const update = m.adminExecute.mock.calls[2];
    expect(String(update?.[0])).toContain('UPDATE admin_external_token_refresh_runs');
    expect(update?.[1]).toEqual(['completed', 1, 1, 0, 0, null, null, null, NOW, out.runId]);
    expect(m.adminExecute).toHaveBeenCalledTimes(3);
    // the run record is opened and closed through the admin database only
    expect(m.ensureAdmin.mock.calls.map((c): unknown => c[1])).toEqual([
      'bridge-token-refresh-runs',
      'bridge-token-refresh-runs',
    ]);
  });

  it('labels a machine-token actor and leaves anonymous actors empty', async () => {
    const { env } = envWith({});
    await refreshExpiringTokensForTenantManual(env, 't', {
      authMethod: 'machine_access_token',
    } as never);
    expect(callArg(m.adminExecute, 0, 1)).toEqual([
      expect.any(String),
      'manual_tenant',
      't',
      'machine',
      null,
      expect.any(String),
      null,
      NOW,
    ]);
    m.adminExecute.mockClear();
    await refreshExpiringTokensForTenantManual(env, 't', { authMethod: 'session' } as never);
    expect((callArg(m.adminExecute, 0, 1) as unknown[]).slice(3, 5)).toEqual([null, null]);
    m.adminExecute.mockClear();
    await refreshExpiringTokensForTenantManual(env, 't');
    expect((callArg(m.adminExecute, 0, 1) as unknown[]).slice(3, 5)).toEqual([null, null]);
  });

  it('records a failed run and rethrows the original error', async () => {
    const { env } = envWith({});
    m.listShards.mockResolvedValue([]);
    await expect(refreshExpiringTokensForTenantManual(env, 'tenant-a')).rejects.toThrow(
      'external_idp_token_refresh_shard_inventory_empty'
    );
    const tenantRun = m.adminExecute.mock.calls[1]?.[1] as unknown[];
    expect(tenantRun.slice(1)).toEqual([
      'tenant-a',
      'failed',
      0,
      'external_idp_token_refresh_shard_inventory_empty',
      NOW,
      NOW,
    ]);
    const update = m.adminExecute.mock.calls[2]?.[1] as unknown[];
    expect(update.slice(0, 9)).toEqual([
      'failed',
      1,
      0,
      1,
      0,
      null,
      null,
      'external_idp_token_refresh_shard_inventory_empty',
      NOW,
    ]);
  });

  it('truncates the recorded error message to 500 characters', async () => {
    const { env } = envWith({});
    m.listShards.mockRejectedValue(new Error('x'.repeat(600)));
    await expect(refreshExpiringTokensForTenantManual(env, 't')).rejects.toThrow();
    const tenantRun = m.adminExecute.mock.calls[1]?.[1] as unknown[];
    expect(tenantRun[4]).toBe('x'.repeat(500));
  });

  it('records a non-Error throw as text', async () => {
    const { env } = envWith({});
    m.listShards.mockRejectedValue('y'.repeat(600));
    await expect(refreshExpiringTokensForTenantManual(env, 't')).rejects.toBe('y'.repeat(600));
    const tenantRun = m.adminExecute.mock.calls[1]?.[1] as unknown[];
    expect(tenantRun[4]).toBe('y'.repeat(500));
  });

  it('requires SETTINGS for the shard inventory', async () => {
    await expect(
      refreshExpiringTokensForTenantManual({ RP_TOKEN_ENCRYPTION_KEY: 'k' } as never, 't')
    ).rejects.toThrow('external_idp_token_refresh_shard_inventory_unavailable');
  });

  it('skips the run summary when run storage is unavailable', async () => {
    m.ensureAdmin.mockReturnValue(null);
    const out = await refreshExpiringTokensForTenantManual(envWith({}).env, 't');
    expect(out).toEqual({ runId: null, tenantId: 't', tokensRefreshed: 0, status: 'completed' });
    expect(m.adminExecute).not.toHaveBeenCalled();
  });

  it('does not write the summary when the admin database went away during the run', async () => {
    const adapter = { query: m.adminQuery, execute: m.adminExecute };
    m.ensureAdmin.mockReset().mockReturnValueOnce(adapter).mockReturnValue(null);
    const out = await refreshExpiringTokensForTenantManual(envWith({}).env, 't');
    expect(out.status).toBe('completed');
    expect(m.adminExecute).toHaveBeenCalledTimes(1);
  });

  it('skips the failure summary when run storage is unavailable', async () => {
    m.ensureAdmin.mockReturnValue(null);
    m.listShards.mockResolvedValue([]);
    await expect(refreshExpiringTokensForTenantManual(envWith({}).env, 't')).rejects.toThrow();
    expect(m.adminExecute).not.toHaveBeenCalled();
  });

  it('proceeds without a run id when the start insert fails', async () => {
    m.adminExecute.mockRejectedValueOnce(new SyntaxError('no table'));
    const out = await refreshExpiringTokensForTenantManual(envWith({}).env, 't');
    expect(out.runId).toBeNull();
    expect(m.adminExecute).toHaveBeenCalledTimes(1);
    expect(m.log.warn).toHaveBeenCalledWith('Token refresh run storage unavailable', {
      errorName: 'SyntaxError',
    });
  });

  it('warns and survives a failure while persisting the summary', async () => {
    m.adminExecute.mockResolvedValueOnce({}).mockRejectedValueOnce(new EvalError('boom'));
    const out = await refreshExpiringTokensForTenantManual(envWith({}).env, 't');
    expect(out.status).toBe('completed');
    expect(m.log.warn).toHaveBeenCalledWith('Failed to persist token refresh run summary', {
      errorName: 'EvalError',
    });
    m.log.warn.mockClear();
    m.adminExecute.mockResolvedValueOnce({}).mockRejectedValueOnce('str');
    await refreshExpiringTokensForTenantManual(envWith({}).env, 't');
    expect(m.log.warn).toHaveBeenCalledWith('Failed to persist token refresh run summary', {
      errorName: 'UnknownError',
    });
  });
});

describe('run detail artifact', () => {
  const objectKeys = {
    SENSITIVE_DETAILS: { bucket: 1 },
    OBJECT_ENCRYPTION_ROOT_KEY: 'ab'.repeat(32),
  };

  it('stores the run detail encrypted and links its catalog id', async () => {
    const { env } = envWith({}, objectKeys);
    const out = await refreshExpiringTokensForTenantManual(env, 'tenant-a');
    const arg = argRec(m.store);
    expect(arg).toMatchObject({
      bucket: objectKeys.SENSITIVE_DETAILS,
      rootKeyHex: objectKeys.OBJECT_ENCRYPTION_ROOT_KEY,
      tenantId: 'tenant-a',
      objectClass: 'operational_log_detail',
      contentType: 'application/json',
      surface: 'external_token_refresh',
      logType: 'operational',
    });
    expect(arg.adapter).toEqual({ query: m.adminQuery, execute: m.adminExecute });
    expect(arg.payload).toEqual({
      runId: out.runId,
      triggerType: 'manual_tenant',
      requestedTenantId: 'tenant-a',
      selectedTenants: ['tenant-a'],
      tenantResults: [
        {
          tenantId: 'tenant-a',
          status: 'completed',
          tokensRefreshed: 0,
          startedAt: NOW,
          completedAt: NOW,
        },
      ],
      tokensRefreshed: 0,
      cursorBefore: null,
      cursorAfter: null,
      errorMessage: null,
      generatedAt: NOW,
    });
    const update = m.adminExecute.mock.calls[2]?.[1] as unknown[];
    expect(update[6]).toBe('cat-1');
    expect(m.log.warn).not.toHaveBeenCalled();
  });

  it('falls back to the default tenant for the artifact of a scheduled run', async () => {
    const { env } = envWith(ENABLED, objectKeys);
    await refreshExpiringTokensForScheduledTenants(env);
    expect(argRec(m.store).tenantId).toBe('default-tenant');
    expect(m.getDefaultTenantId).toHaveBeenCalledWith(env);
  });

  it.each([
    ['SENSITIVE_DETAILS', { OBJECT_ENCRYPTION_ROOT_KEY: 'k' }],
    ['OBJECT_ENCRYPTION_ROOT_KEY', { SENSITIVE_DETAILS: {} }],
  ])('skips the artifact when %s is missing', async (_n, extra) => {
    await refreshExpiringTokensForTenantManual(envWith({}, extra).env, 't');
    expect(m.store).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith(
      'Token refresh detail artifact unavailable: encrypted object storage is not configured'
    );
    expect((m.adminExecute.mock.calls[2]?.[1] as unknown[])[6]).toBeNull();
  });

  it('stores no catalog id when writing the artifact fails', async () => {
    m.store.mockRejectedValue(new TypeError('r2 down'));
    await refreshExpiringTokensForTenantManual(envWith({}, objectKeys).env, 't');
    expect(m.log.warn).toHaveBeenCalledWith('Token refresh detail artifact unavailable', {
      errorName: 'TypeError',
    });
    expect((m.adminExecute.mock.calls[2]?.[1] as unknown[])[6]).toBeNull();
    m.store.mockRejectedValue('text');
    await refreshExpiringTokensForTenantManual(envWith({}, objectKeys).env, 't');
    expect(m.log.warn).toHaveBeenLastCalledWith('Token refresh detail artifact unavailable', {
      errorName: 'UnknownError',
    });
  });
});
