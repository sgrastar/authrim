import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callArg } from './helpers/mock-args';

const m = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  scanQuery: vi.fn(),
  adminExecute: vi.fn(),
  ensureAdmin: vi.fn(),
  listTenants: vi.fn(),
  listShards: vi.fn(),
  getProvider: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({ module: () => m.log }),
  ensureAdminDatabaseAdapter: m.ensureAdmin,
  ensureDatabaseAdapter: () => ({ query: m.scanQuery }),
  getDefaultTenantId: () => 'default-tenant',
  listEnvironmentTenantDefaultStores: m.listTenants,
  storeImmediateChunkedSensitiveDetailJson: vi.fn(),
}));
vi.mock('../services/provider-store', () => ({ getProvider: m.getProvider }));
vi.mock('../services/linked-identity-store', () => ({
  updateLinkedIdentity: m.update,
  decryptLinkedIdentityTokens: async () => ({ refreshToken: 'r' }),
}));
vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: { fromProvider: () => ({ refreshTokens: async () => ({}) }) },
}));
vi.mock('../utils/crypto', () => ({
  decrypt: async () => 's',
  getEncryptionKeyOrUndefined: () => 'key',
}));

import { refreshExpiringTokensForScheduledTenants } from '../services/token-refresh';

const NOW = 1_700_000_000_000;
const CONFIG_KEY = 'external_idp_token_refresh';
const CURSOR_KEY = 'external_idp_token_refresh:tenant_cursor';

function makeEnv(initial: Record<string, string>, cursorThrows = false) {
  const store = new Map(Object.entries(initial));
  const s = {
    get: vi.fn(async (k: string) => {
      if (cursorThrows && k === CURSOR_KEY) throw new Error('kv');
      return store.get(k) ?? null;
    }),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
  const env = {
    SETTINGS: s,
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: { listExternalIdpPiiSourceShards: m.listShards },
    DB_A: {},
  };
  return { s, env: env as never };
}

const enabled = (extra: Record<string, unknown> = {}) => ({
  [CONFIG_KEY]: JSON.stringify({ enabled: true, ...extra }),
});
const tenants = (...ids: string[]) => ids.map((tenantId) => ({ tenantId }));
const dbRow = (id: string) => ({
  id,
  tenant_id: 't',
  user_id: 'u',
  provider_id: 'p',
  provider_user_id: 'pu',
  email_verified: 0,
  refresh_token_encrypted: 'enc',
  token_expires_at: 10,
  linked_at: 1,
  updated_at: 2,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  m.scanQuery.mockReset().mockResolvedValue([]);
  m.adminExecute.mockReset().mockResolvedValue({});
  m.ensureAdmin.mockReset().mockReturnValue({ query: vi.fn(), execute: m.adminExecute });
  m.listTenants.mockReset().mockResolvedValue([]);
  m.listShards
    .mockReset()
    .mockResolvedValue([
      { shardId: 'a', bindingRef: 'DB_A', residencyPartition: 'default', routeGeneration: 1 },
    ]);
  m.getProvider.mockReset().mockResolvedValue({ id: 'p', clientSecretEncrypted: 'e' });
  m.update.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

function updateParams(): unknown[] {
  const call = m.adminExecute.mock.calls.find((c) =>
    String(c[0]).includes('UPDATE admin_external_token_refresh_runs')
  );
  if (!call) throw new Error('no summary update');
  return call[1] as unknown[];
}

describe('scheduled refresh', () => {
  it('does nothing while scheduled scanning is disabled', async () => {
    const { env } = makeEnv({});
    await expect(refreshExpiringTokensForScheduledTenants(env)).resolves.toEqual({
      runId: null,
      selectedTenants: [],
      processedTenants: 0,
      failedTenants: 0,
      tokensRefreshed: 0,
      cursorBefore: null,
      cursor: null,
      tenantResults: [],
    });
    expect(m.listTenants).not.toHaveBeenCalled();
    expect(m.adminExecute).not.toHaveBeenCalled();
  });

  it('selects the batch after the stored cursor and records the run before it starts', async () => {
    const { s, env } = makeEnv({
      [CURSOR_KEY]: 'tenant-b',
      ...enabled({ scheduledTenantBatchSize: 7 }),
    });
    m.listTenants.mockResolvedValue(tenants('tenant-c', 'tenant-d'));
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(m.listTenants.mock.calls).toEqual([[env, { limit: 7, afterTenantId: 'tenant-b' }]]);
    expect(out).toMatchObject({
      selectedTenants: ['tenant-c', 'tenant-d'],
      processedTenants: 2,
      failedTenants: 0,
      tokensRefreshed: 0,
      cursorBefore: 'tenant-b',
      cursor: 'tenant-d',
    });
    expect(out.runId).toMatch(/^etr_[0-9a-f]{32}$/);
    expect(out.tenantResults).toEqual([
      {
        tenantId: 'tenant-c',
        status: 'completed',
        tokensRefreshed: 0,
        startedAt: NOW,
        completedAt: NOW,
      },
      {
        tenantId: 'tenant-d',
        status: 'completed',
        tokensRefreshed: 0,
        startedAt: NOW,
        completedAt: NOW,
      },
    ]);
    expect(s.put).toHaveBeenCalledWith(CURSOR_KEY, 'tenant-d');

    const first = m.adminExecute.mock.calls[0];
    expect(String(first?.[0])).toContain('INSERT INTO admin_external_token_refresh_runs');
    const startParams = first?.[1] as unknown[];
    expect(startParams.slice(1, 5)).toEqual(['scheduled', null, null, null]);
    expect(startParams[6]).toBe('tenant-b');
    expect(updateParams()).toEqual([
      'completed',
      2,
      2,
      0,
      0,
      'tenant-d',
      null,
      null,
      NOW,
      out.runId,
    ]);
  });

  it('starts from the first tenant without a cursor', async () => {
    const { env } = makeEnv(enabled());
    m.listTenants.mockResolvedValue(tenants('tenant-a'));
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(m.listTenants).toHaveBeenCalledTimes(1);
    expect(m.listTenants).toHaveBeenCalledWith(env, { limit: 100, afterTenantId: undefined });
    expect(out.cursorBefore).toBeNull();
    const startParams = callArg(m.adminExecute, 0, 1) as unknown[];
    expect(startParams[6]).toBeNull();
  });

  it('wraps to the first tenants when the cursor passed the last one', async () => {
    const { s, env } = makeEnv({
      [CURSOR_KEY]: 'tenant-z',
      ...enabled({ scheduledTenantBatchSize: 3 }),
    });
    m.listTenants.mockResolvedValueOnce([]).mockResolvedValueOnce(tenants('tenant-a'));
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(m.listTenants.mock.calls).toEqual([
      [env, { limit: 3, afterTenantId: 'tenant-z' }],
      [env, { limit: 3 }],
    ]);
    expect(out.selectedTenants).toEqual(['tenant-a']);
    expect(s.put).toHaveBeenCalledWith(CURSOR_KEY, 'tenant-a');
  });

  it('keeps the cursor when no tenant exists at all', async () => {
    const { s, env } = makeEnv({ [CURSOR_KEY]: 'tenant-z', ...enabled() });
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(out.selectedTenants).toEqual([]);
    expect(out.cursor).toBeNull();
    expect(s.put).not.toHaveBeenCalled();
    expect(updateParams()).toEqual(['completed', 0, 0, 0, 0, null, null, null, NOW, out.runId]);
  });

  it('does not wrap when there was no cursor and the page is empty', async () => {
    const { env } = makeEnv(enabled());
    await refreshExpiringTokensForScheduledTenants(env);
    expect(m.listTenants).toHaveBeenCalledTimes(1);
  });

  it('ends the run as failed, keeping the stored cursor, when the cursor cannot be read', async () => {
    const { s, env } = makeEnv({ [CURSOR_KEY]: 'tenant-b', ...enabled() }, true);
    m.listTenants.mockResolvedValue(tenants('tenant-c'));
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(out).toMatchObject({
      selectedTenants: [],
      processedTenants: 0,
      failedTenants: 0,
      tokensRefreshed: 0,
      cursor: null,
      tenantResults: [],
    });
    expect(out.runId).toMatch(/^etr_/);
    // no tenant was listed or refreshed, and the stored cursor was not touched
    expect(m.listTenants).not.toHaveBeenCalled();
    expect(s.put).not.toHaveBeenCalled();
    expect(s.get.mock.calls.filter((c) => c[0] === CURSOR_KEY)).toHaveLength(1);
    // the run row does not stay 'running'
    expect(updateParams()).toEqual([
      'failed',
      0,
      0,
      0,
      0,
      null,
      null,
      'token_refresh_cursor_unavailable',
      NOW,
      out.runId,
    ]);
    expect(m.log.error).toHaveBeenCalledWith(
      'Scheduled token refresh skipped: the tenant cursor could not be read',
      { errorName: 'Error' }
    );
  });

  it('starts from the first tenant when the cursor key does not exist', async () => {
    const { env } = makeEnv(enabled());
    m.listTenants.mockResolvedValue(tenants('tenant-a'));
    await refreshExpiringTokensForScheduledTenants(env);
    expect(m.listTenants.mock.calls).toEqual([[env, { limit: 100, afterTenantId: undefined }]]);
  });

  it('sums the refreshed tokens of every tenant', async () => {
    const { env } = makeEnv(enabled());
    m.listTenants.mockResolvedValue(tenants('tenant-a', 'tenant-b'));
    m.scanQuery
      .mockResolvedValueOnce([dbRow('l1'), dbRow('l2')])
      .mockResolvedValueOnce([dbRow('l3')]);
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(out.tokensRefreshed).toBe(3);
    expect(out.tenantResults.map((r) => r.tokensRefreshed)).toEqual([2, 1]);
    expect(updateParams().slice(0, 5)).toEqual(['completed', 2, 2, 0, 3]);
  });

  it('isolates a failing tenant and marks the run partially failed', async () => {
    const { s, env } = makeEnv(enabled());
    m.listTenants.mockResolvedValue(tenants('tenant-a', 'tenant-b'));
    m.listShards.mockRejectedValueOnce(new Error('x'.repeat(700)));
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(out).toMatchObject({ processedTenants: 1, failedTenants: 1, cursor: 'tenant-b' });
    expect(out.tenantResults[0]).toEqual({
      tenantId: 'tenant-a',
      status: 'failed',
      tokensRefreshed: 0,
      errorMessage: 'x'.repeat(500),
      startedAt: NOW,
      completedAt: NOW,
    });
    expect(out.tenantResults[1]?.status).toBe('completed');
    expect(m.log.error).toHaveBeenCalledWith(
      'Scheduled token refresh failed for tenant',
      { tenantId: 'tenant-a' },
      expect.any(Error)
    );
    expect(s.put).toHaveBeenCalledWith(CURSOR_KEY, 'tenant-b');
    expect(updateParams().slice(0, 5)).toEqual(['partial_failure', 2, 1, 1, 0]);
    const tenantRow = m.adminExecute.mock.calls
      .filter((c) => String(c[0]).includes('tenant_runs'))
      .map((c) => c[1] as unknown[]);
    expect(tenantRow.map((r) => r.slice(1, 3))).toEqual([
      ['tenant-a', 'failed'],
      ['tenant-b', 'completed'],
    ]);
  });

  it('marks the run failed when every tenant failed', async () => {
    const { env } = makeEnv(enabled());
    m.listTenants.mockResolvedValue(tenants('tenant-a', 'tenant-b'));
    m.listShards.mockRejectedValue('plain');
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(out.failedTenants).toBe(2);
    expect(out.tenantResults.map((r) => r.errorMessage)).toEqual(['plain', 'plain']);
    expect(updateParams().slice(0, 5)).toEqual(['failed', 2, 0, 2, 0]);
  });

  it('still returns the result when run storage is unavailable', async () => {
    m.ensureAdmin.mockReturnValue(null);
    const { env } = makeEnv(enabled());
    m.listTenants.mockResolvedValue(tenants('tenant-a'));
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(out.runId).toBeNull();
    expect(out.processedTenants).toBe(1);
    expect(m.adminExecute).not.toHaveBeenCalled();
  });

  it('does not touch the cursor store when SETTINGS vanished mid-run', async () => {
    const { s, env } = makeEnv(enabled());
    m.listTenants.mockImplementation(async (e: { SETTINGS?: unknown }) => {
      e.SETTINGS = undefined;
      return tenants('tenant-a');
    });
    m.listShards.mockResolvedValue([]);
    const out = await refreshExpiringTokensForScheduledTenants(env);
    expect(out.failedTenants).toBe(1);
    expect(s.put).not.toHaveBeenCalled();
  });
});
