import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, callArg, rec } from './helpers/mock-args';

const m = vi.hoisted(() => ({
  moduleNames: [] as string[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  query: vi.fn(),
  ensureDb: vi.fn(),
  getDefaultTenantId: vi.fn(),
  getProvider: vi.fn(),
  update: vi.fn(),
  decryptTokens: vi.fn(),
  fromProvider: vi.fn(),
  refreshTokens: vi.fn(),
  decrypt: vi.fn(),
  getKey: vi.fn(),
  listShards: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({
    module: (name: string) => {
      m.moduleNames.push(name);
      return m.log;
    },
  }),
  ensureAdminDatabaseAdapter: vi.fn(),
  ensureDatabaseAdapter: m.ensureDb,
  getDefaultTenantId: m.getDefaultTenantId,
  listEnvironmentTenantDefaultStores: vi.fn(),
  storeImmediateChunkedSensitiveDetailJson: vi.fn(),
}));
vi.mock('../services/provider-store', () => ({ getProvider: m.getProvider }));
vi.mock('../services/linked-identity-store', () => ({
  updateLinkedIdentity: m.update,
  decryptLinkedIdentityTokens: m.decryptTokens,
}));
vi.mock('../clients/oidc-client', () => ({ OIDCRPClient: { fromProvider: m.fromProvider } }));
vi.mock('../utils/crypto', () => ({ decrypt: m.decrypt, getEncryptionKeyOrUndefined: m.getKey }));

import {
  refreshExpiringTokens,
  refreshExpiringTokensForTenant,
  refreshIdentityToken,
} from '../services/token-refresh';

const NOW = 1_700_000_000_000;
const DB0 = { name: 'db0' };
const DB1 = { name: 'db1' };

interface Settings {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function settings(initial: Record<string, string> = {}): Settings {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

function shard(id: string, extra: Record<string, unknown> = {}) {
  return {
    shardId: id,
    bindingRef: `DB_${id.toUpperCase()}`,
    residencyPartition: 'default',
    routeGeneration: 1,
    ...extra,
  };
}

function env(s: Settings, extra: Record<string, unknown> = {}) {
  s.store.set('external_idp_token_refresh', JSON.stringify({ enabled: true, ...cfg }));
  return {
    SETTINGS: s,
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: { listExternalIdpPiiSourceShards: m.listShards },
    DB_A: DB0,
    DB_B: DB1,
    ...extra,
  } as never;
}

let cfg: Record<string, unknown> = {};

function row(id: string, expires: number | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: 'tenant-a',
    user_id: `user-${id}`,
    provider_id: 'prov',
    provider_user_id: `pu-${id}`,
    provider_email: null,
    email_verified: 0,
    access_token_encrypted: null,
    refresh_token_encrypted: 'enc-r',
    token_expires_at: expires,
    raw_claims: null,
    profile_data: null,
    linked_at: 5,
    last_login_at: null,
    updated_at: 6,
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  cfg = {};
  vi.clearAllMocks();
  m.query.mockReset().mockResolvedValue([]);
  m.ensureDb.mockReset().mockReturnValue({ query: m.query });
  m.getDefaultTenantId.mockReset().mockReturnValue('default-tenant');
  m.getKey.mockReset().mockReturnValue('enc-key');
  m.getProvider.mockReset().mockResolvedValue({ id: 'prov', clientSecretEncrypted: 'enc-secret' });
  m.decryptTokens.mockReset().mockResolvedValue({ refreshToken: 'plain-refresh' });
  m.decrypt.mockReset().mockResolvedValue('plain-secret');
  m.refreshTokens.mockReset().mockResolvedValue({ access_token: 'new' });
  m.fromProvider.mockReset().mockReturnValue({ refreshTokens: m.refreshTokens });
  m.update.mockReset().mockResolvedValue(true);
  m.listShards.mockReset().mockResolvedValue([shard('a')]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshExpiringTokensForTenant gates', () => {
  it('logs under the TOKEN-REFRESH module', () => {
    expect(m.moduleNames).toEqual(['TOKEN-REFRESH']);
  });

  it('returns 0 without scanning when refresh is disabled', async () => {
    const s = settings({ external_idp_token_refresh: JSON.stringify({ enabled: false }) });
    const e = {
      SETTINGS: s,
      EXTERNAL_IDP_ACCOUNT_PROVISIONER: { listExternalIdpPiiSourceShards: m.listShards },
    } as never;
    await expect(refreshExpiringTokensForTenant(e, 'tenant-a')).resolves.toBe(0);
    expect(m.getKey).not.toHaveBeenCalled();
    expect(m.listShards).not.toHaveBeenCalled();
  });

  it('returns 0 and warns when the encryption key is not configured', async () => {
    m.getKey.mockReturnValue(undefined);
    await expect(refreshExpiringTokensForTenant(env(settings()), 'tenant-a')).resolves.toBe(0);
    expect(m.log.warn).toHaveBeenCalledWith(
      'Token refresh skipped: RP_TOKEN_ENCRYPTION_KEY not configured'
    );
    expect(m.listShards).not.toHaveBeenCalled();
  });

  it('returns 0 when no identity expires soon', async () => {
    await expect(refreshExpiringTokensForTenant(env(settings()), 'tenant-a')).resolves.toBe(0);
    expect(m.fromProvider).not.toHaveBeenCalled();
  });

  it('refreshExpiringTokens scans the deployment default tenant', async () => {
    const e = env(settings());
    await expect(refreshExpiringTokens(e)).resolves.toBe(0);
    expect(m.getDefaultTenantId).toHaveBeenCalledWith(e);
    expect(callArg(m.query, 0, 1)).toEqual(['default-tenant', NOW + 3_600_000, NOW, 100]);
  });
});

describe('expiring-token query', () => {
  it('binds tenant, threshold, now and remaining, and filters on the active/refreshable rows', async () => {
    cfg = { refreshThresholdSeconds: 60, batchSize: 7 };
    await refreshExpiringTokensForTenant(env(settings()), 'tenant-a');
    expect(m.ensureDb).toHaveBeenCalledWith(DB0, 'bridge-token-refresh');
    const sql = String(callArg(m.query, 0, 0));
    expect(sql).toContain('FROM linked_identities');
    expect(sql).toContain('tenant_id = ?');
    expect(sql).toContain("provisioning_state = 'active'");
    expect(sql).toContain('token_expires_at IS NOT NULL');
    expect(sql).toContain('token_expires_at < ?');
    expect(sql).toContain('token_expires_at > ?');
    expect(sql).toContain('refresh_token_encrypted IS NOT NULL');
    expect(sql).toContain('ORDER BY token_expires_at ASC');
    expect(sql).toContain('LIMIT ?');
    expect(callArg(m.query, 0, 1)).toEqual(['tenant-a', NOW + 60_000, NOW, 7]);
  });

  it('asks the provisioner for the shard page after the stored cursor', async () => {
    cfg = { piiShardPageSize: 3 };
    await refreshExpiringTokensForTenant(
      env(settings({ 'external_idp_token_refresh:pii_shard_cursor:tenant-a': 'prev' })),
      'tenant-a'
    );
    expect(m.listShards.mock.calls).toEqual([
      [{ schemaVersion: 1, afterShardId: 'prev', limit: 3 }],
    ]);
  });

  it('maps rows to identities and refreshes each against its own shard source', async () => {
    m.listShards.mockResolvedValue([shard('a'), shard('b')]);
    m.query
      .mockResolvedValueOnce([
        row('l1', 1000, {
          provider_email: 'x@example.com',
          email_verified: 1,
          access_token_encrypted: 'enc-a',
          raw_claims: '{"sub":"s"}',
          profile_data: '{"p":1}',
          last_login_at: 9,
        }),
      ])
      .mockResolvedValueOnce([row('l2', 2000)]);
    await expect(refreshExpiringTokensForTenant(env(settings()), 'tenant-a')).resolves.toBe(2);

    expect(m.getProvider).toHaveBeenCalledTimes(2);
    const first = argRec(m.decryptTokens, 0, 1);
    expect(first).toEqual({
      id: 'l1',
      tenantId: 'tenant-a',
      userId: 'user-l1',
      providerId: 'prov',
      providerUserId: 'pu-l1',
      providerEmail: 'x@example.com',
      emailVerified: true,
      accessTokenEncrypted: 'enc-a',
      refreshTokenEncrypted: 'enc-r',
      tokenExpiresAt: 1000,
      rawClaims: { sub: 's' },
      profileData: { p: 1 },
      linkedAt: 5,
      lastLoginAt: 9,
      updatedAt: 6,
    });
    const second = argRec(m.decryptTokens, 1, 1);
    expect(second.providerEmail).toBeUndefined();
    expect(second.emailVerified).toBe(false);
    expect(second.accessTokenEncrypted).toBeUndefined();
    expect(second.rawClaims).toBeUndefined();
    expect(second.profileData).toBeUndefined();
    expect(second.lastLoginAt).toBeUndefined();
    expect(callArg(m.update, 0, 4)).toBe(DB0);
    expect(callArg(m.update, 1, 4)).toBe(DB1);
  });

  it('stops scanning further shards once the batch size is filled and keeps the soonest first', async () => {
    cfg = { batchSize: 2 };
    m.listShards.mockResolvedValue([shard('a'), shard('b'), shard('c')]);
    m.query
      .mockResolvedValueOnce([row('z', 3000), row('y', 1000)])
      .mockResolvedValueOnce([row('x', 2000)]);
    const s = settings();
    await expect(refreshExpiringTokensForTenant(env(s), 'tenant-a')).resolves.toBe(2);
    expect(m.query).toHaveBeenCalledTimes(1);
    expect(callArg(m.query, 0, 1)).toEqual(['tenant-a', NOW + 3_600_000, NOW, 2]);
    expect(m.decryptTokens.mock.calls.map((c) => rec(c[1]).id)).toEqual(['y', 'z']);
    // the page was cut short, so the cursor is the last shard scanned
    expect(s.put).toHaveBeenCalledWith('external_idp_token_refresh:pii_shard_cursor:tenant-a', 'a');
  });

  it('asks later shards only for the remaining room and truncates the sorted result', async () => {
    cfg = { batchSize: 3, piiShardPageSize: 2 };
    m.listShards.mockResolvedValue([shard('a'), shard('b')]);
    m.query
      .mockResolvedValueOnce([row('q', 5000), row('p', 4000)])
      .mockResolvedValueOnce([row('o', 1000)]);
    await refreshExpiringTokensForTenant(env(settings()), 'tenant-a');
    expect(callArg(m.query, 1, 1)).toEqual(['tenant-a', NOW + 3_600_000, NOW, 1]);
    expect(m.decryptTokens.mock.calls.map((c) => rec(c[1]).id)).toEqual(['o', 'p', 'q']);
  });

  it('orders equal expiries by identity id and rows without expiry last', async () => {
    m.listShards.mockResolvedValue([shard('a')]);
    m.query.mockResolvedValueOnce([row('b', 100), row('c', null), row('a', 100), row('d', 50)]);
    await refreshExpiringTokensForTenant(env(settings()), 'tenant-a');
    expect(m.decryptTokens.mock.calls.map((c) => rec(c[1]).id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('never refreshes more identities than the batch size, whatever the shard returns', async () => {
    cfg = { batchSize: 2 };
    m.query.mockResolvedValueOnce([row('a', 1), row('b', 2), row('c', 3)]);
    await expect(refreshExpiringTokensForTenant(env(settings()), 'tenant-a')).resolves.toBe(2);
  });

  it('counts only successful refreshes and keeps going after a failure', async () => {
    m.query.mockResolvedValueOnce([row('l1', 1), row('l2', 2), row('l3', 3), row('l4', 4)]);
    m.getProvider
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new TypeError('boom'))
      .mockRejectedValueOnce('plain string')
      .mockResolvedValueOnce({ id: 'prov', clientSecretEncrypted: 'e' });
    await expect(refreshExpiringTokensForTenant(env(settings()), 'tenant-a')).resolves.toBe(1);
    expect(m.log.error.mock.calls).toEqual([
      ['Failed to refresh token for identity', { errorName: 'TypeError' }],
      ['Failed to refresh token for identity', { errorName: 'Unknown error' }],
    ]);
  });

  it('does not count a refresh that could not be saved', async () => {
    m.query.mockResolvedValueOnce([row('l1', 1)]);
    m.update.mockResolvedValue(false);
    await expect(refreshExpiringTokensForTenant(env(settings()), 'tenant-a')).resolves.toBe(0);
  });
});

describe('PII shard cursor', () => {
  const key = 'external_idp_token_refresh:pii_shard_cursor:tenant-a';

  it('clears the cursor when a short (wrapping) page was fully scanned', async () => {
    cfg = { piiShardPageSize: 4 };
    m.listShards.mockResolvedValue([shard('a'), shard('b')]);
    const s = settings({ [key]: 'old' });
    await refreshExpiringTokensForTenant(env(s), 'tenant-a');
    expect(s.delete).toHaveBeenCalledWith(key);
    expect(s.put).not.toHaveBeenCalledWith(key, expect.anything());
  });

  it('stores the last shard when a full page was scanned', async () => {
    cfg = { piiShardPageSize: 2 };
    m.listShards.mockResolvedValue([shard('a'), shard('b')]);
    const s = settings();
    await refreshExpiringTokensForTenant(env(s), 'tenant-a');
    expect(s.put).toHaveBeenCalledWith(key, 'b');
    expect(s.delete).not.toHaveBeenCalled();
  });

  it('stores the last scanned shard when the batch filled before the page end', async () => {
    cfg = { batchSize: 1, piiShardPageSize: 2 };
    m.listShards.mockResolvedValue([shard('a'), shard('b')]);
    m.query.mockResolvedValueOnce([row('l1', 1)]);
    const s = settings();
    await refreshExpiringTokensForTenant(env(s), 'tenant-a');
    expect(s.put).toHaveBeenCalledWith(key, 'a');
  });

  it('wraps to the first page when the cursor is past the last shard', async () => {
    cfg = { piiShardPageSize: 3 };
    m.listShards.mockResolvedValueOnce([]).mockResolvedValueOnce([shard('a')]);
    const s = settings({ [key]: 'zzz' });
    await refreshExpiringTokensForTenant(env(s), 'tenant-a');
    expect(m.listShards.mock.calls).toEqual([
      [{ schemaVersion: 1, afterShardId: 'zzz', limit: 3 }],
      [{ schemaVersion: 1, afterShardId: null, limit: 3 }],
    ]);
    expect(s.delete).toHaveBeenCalledWith(key);
  });

  it('keeps a full wrapped-around page as a cursor, not a reset', async () => {
    cfg = { piiShardPageSize: 1 };
    m.listShards.mockResolvedValueOnce([]).mockResolvedValueOnce([shard('a')]);
    const s = settings({ [key]: 'zzz' });
    await refreshExpiringTokensForTenant(env(s), 'tenant-a');
    expect(s.put).toHaveBeenCalledWith(key, 'a');
    expect(s.delete).not.toHaveBeenCalled();
  });

  it('does not advance when the scan of the first shard fails', async () => {
    m.query.mockRejectedValueOnce(new Error('db down'));
    const s = settings();
    await expect(refreshExpiringTokensForTenant(env(s), 'tenant-a')).rejects.toThrow('db down');
    expect(s.put).not.toHaveBeenCalledWith(key, expect.anything());
    expect(s.delete).not.toHaveBeenCalled();
  });
});

describe('shard inventory validation', () => {
  async function failWith(shards: unknown, message: string, e = env(settings())) {
    m.listShards.mockResolvedValue(shards);
    await expect(refreshExpiringTokensForTenant(e, 'tenant-a')).rejects.toThrow(message);
  }
  const INVALID = 'external_idp_token_refresh_shard_inventory_invalid';

  it('requires the provisioner binding', async () => {
    const full = env(settings()) as unknown as Record<string, unknown>;
    await expect(
      refreshExpiringTokensForTenant(
        { ...full, EXTERNAL_IDP_ACCOUNT_PROVISIONER: undefined } as never,
        'tenant-a'
      )
    ).rejects.toThrow('external_idp_token_refresh_shard_inventory_unavailable');
  });

  it('rejects a non-array or oversized inventory', async () => {
    cfg = { piiShardPageSize: 1 };
    await failWith('nope', INVALID);
    await failWith([shard('a'), shard('b')], INVALID);
  });

  it('rejects an empty inventory', async () => {
    await failWith([], 'external_idp_token_refresh_shard_inventory_empty');
    // with no cursor there is nothing to wrap around to
    expect(m.listShards).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid inventory returned by the wrap-around call', async () => {
    cfg = { piiShardPageSize: 1 };
    m.listShards.mockResolvedValueOnce([]).mockResolvedValueOnce([shard('a'), shard('b')]);
    const s = settings({ 'external_idp_token_refresh:pii_shard_cursor:tenant-a': 'x' });
    await expect(refreshExpiringTokensForTenant(env(s), 'tenant-a')).rejects.toThrow(INVALID);
    m.listShards.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce('bad');
    await expect(refreshExpiringTokensForTenant(env(s), 'tenant-a')).rejects.toThrow(INVALID);
  });

  it('rejects an empty inventory after wrapping', async () => {
    m.listShards.mockResolvedValue([]);
    const s = settings({ 'external_idp_token_refresh:pii_shard_cursor:tenant-a': 'x' });
    await expect(refreshExpiringTokensForTenant(env(s), 'tenant-a')).rejects.toThrow(
      'external_idp_token_refresh_shard_inventory_empty'
    );
    expect(m.listShards).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['null entry', null],
    ['array entry', ['a']],
    ['extra key', { ...shard('a'), extra: 1 }],
    ['missing key', { shardId: 'a', bindingRef: 'DB_A', residencyPartition: 'default' }],
    ['unsafe shard id', shard('-bad')],
    ['unsafe shard id chars', shard('a b')],
    ['trailing junk in shard id', shard('ok!')],
    ['trailing junk in binding', { ...shard('a'), bindingRef: 'DB_A!' }],
    ['trailing junk in residency', { ...shard('a'), residencyPartition: 'ok!' }],
    ['lowercase binding', { ...shard('a'), bindingRef: 'db_a' }],
    ['binding with dash', { ...shard('a'), bindingRef: 'DB-A' }],
    ['unsafe residency', { ...shard('a'), residencyPartition: '/x' }],
    ['zero generation', { ...shard('a'), routeGeneration: 0 }],
    ['fractional generation', { ...shard('a'), routeGeneration: 1.5 }],
    ['string generation', { ...shard('a'), routeGeneration: '1' }],
  ])('rejects %s', async (_name, entry) => {
    await failWith([entry], INVALID);
  });

  it('rejects a duplicated shard id', async () => {
    cfg = { piiShardPageSize: 2 };
    await failWith([shard('a'), shard('a')], INVALID);
  });

  it('accepts the documented edge values', async () => {
    m.listShards.mockResolvedValue([
      shard('A.b_c:d-e', { bindingRef: 'X', residencyPartition: '0', routeGeneration: 1 }),
    ]);
    const bound = {};
    const e = env(settings(), { X: bound });
    await expect(refreshExpiringTokensForTenant(e, 'tenant-a')).resolves.toBe(0);
    expect(m.ensureDb).toHaveBeenCalledWith(bound, 'bridge-token-refresh-shard-binding');
  });

  it('fails closed when the bound database is unusable', async () => {
    m.ensureDb.mockImplementationOnce(() => {
      throw new Error('no adapter');
    });
    await expect(refreshExpiringTokensForTenant(env(settings()), 'tenant-a')).rejects.toThrow(
      'no adapter'
    );
    expect(m.ensureDb).toHaveBeenCalledWith(DB0, 'bridge-token-refresh-shard-binding');
  });
});

describe('refreshIdentityToken', () => {
  const identity = {
    id: 'link-a',
    tenantId: 'tenant-a',
    providerId: 'google',
    refreshTokenEncrypted: 'enc-read',
  } as never;

  it('returns false and warns when the provider is gone', async () => {
    m.getProvider.mockResolvedValue(null);
    await expect(refreshIdentityToken(env(settings()), identity, 'k', DB0 as never)).resolves.toBe(
      false
    );
    expect(m.getProvider).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'google');
    expect(m.log.warn).toHaveBeenCalledWith('Provider not found for token refresh');
    expect(m.decryptTokens).not.toHaveBeenCalled();
  });

  it('returns false and warns when no refresh token can be decrypted', async () => {
    m.decryptTokens.mockResolvedValue({ refreshToken: undefined });
    await expect(refreshIdentityToken(env(settings()), identity, 'k', DB0 as never)).resolves.toBe(
      false
    );
    expect(m.log.warn).toHaveBeenCalledWith('No refresh token available for identity');
    expect(m.refreshTokens).not.toHaveBeenCalled();
  });

  it('refreshes with the decrypted secret and saves guarded by the token it read', async () => {
    const e = env(settings());
    await expect(refreshIdentityToken(e, identity, 'the-key', DB1 as never)).resolves.toBe(true);
    expect(m.decrypt).toHaveBeenCalledWith('enc-secret', 'the-key');
    expect(m.fromProvider).toHaveBeenCalledWith(
      { id: 'prov', clientSecretEncrypted: 'enc-secret' },
      '',
      'plain-secret'
    );
    expect(m.refreshTokens).toHaveBeenCalledWith('plain-refresh');
    expect(m.update).toHaveBeenCalledWith(
      e,
      'tenant-a',
      'link-a',
      { tokens: { access_token: 'new' }, expectedRefreshTokenEncrypted: 'enc-read' },
      DB1
    );
    expect(m.log.info).toHaveBeenCalledWith('Successfully refreshed external IdP token');
  });

  it('does not add an expectation when the identity has no stored refresh token', async () => {
    const bare = { id: 'link-a', tenantId: 'tenant-a', providerId: 'google' } as never;
    await refreshIdentityToken(env(settings()), bare, 'k', DB0 as never);
    expect(callArg(m.update, 0, 3)).toEqual({ tokens: { access_token: 'new' } });
    expect(callArg(m.update, 0, 3)).not.toHaveProperty('expectedRefreshTokenEncrypted');
  });

  it('reports false and logs when the update lost the race', async () => {
    m.update.mockResolvedValue(false);
    await expect(refreshIdentityToken(env(settings()), identity, 'k', DB0 as never)).resolves.toBe(
      false
    );
    expect(m.log.warn).toHaveBeenCalledWith(
      'Refreshed external IdP token not saved: the link changed meanwhile'
    );
    expect(m.log.info).not.toHaveBeenCalled();
  });
});
