/**
 * Linked identity store against a real SQLite PII database built from the migrations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { adapterOver, count, migrate, type RealSqlAdapter } from './helpers/real-sql';
import { decrypt } from '../utils/crypto';

const mocks = vi.hoisted(() => ({ resolveAccount: vi.fn(), ensure: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveAccountDataContextByIdentifier: mocks.resolveAccount,
  ensureDatabaseAdapter: mocks.ensure,
}));

import {
  activatePendingLinkedIdentity,
  countLinkedIdentities,
  createLinkedIdentity,
  decryptLinkedIdentityTokens,
  deleteLinkedIdentity,
  findLinkedIdentitiesAcrossTenantsByProviderSub,
  findLinkedIdentitiesByProviderSub,
  findLinkedIdentity,
  findPendingLinkedIdentityProvisioning,
  getLinkedIdentityById,
  getLinkedIdentityForUserAndProvider,
  listLinkedIdentities,
  updateLinkedIdentity,
} from '../services/linked-identity-store';

const KEY = '3f9a1c7e5b2d48a06c91e7f3d5a8b2c4e6f10a9b8c7d6e5f4a3b2c1d0e9f8a7b';
const env = { RP_TOKEN_ENCRYPTION_KEY: KEY } as unknown as Env;
const T0 = Date.UTC(2026, 3, 1, 10, 0, 0);

let pii: RealSqlAdapter;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  pii = adapterOver(migrate('pii'));
  mocks.resolveAccount.mockReset();
  mocks.ensure.mockReset();
  mocks.ensure.mockImplementation((source: unknown) => source);
});
afterEach(() => vi.useRealTimers());

interface Row {
  id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  provider_email: string | null;
  email_verified: number;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: number | null;
  raw_claims: string | null;
  profile_data: string | null;
  linked_at: number;
  last_login_at: number | null;
  updated_at: number;
  provisioning_state: string;
}

const row = (id: string): Row => {
  const found = pii.raw.prepare('SELECT * FROM linked_identities WHERE id = ?').get(id);
  if (!found) throw new Error(`no row ${id}`);
  return found as unknown as Row;
};

const seed = (overrides: Partial<Row> & { id: string }): void => {
  const values: Row = {
    tenant_id: 't1',
    user_id: 'u1',
    provider_id: 'p1',
    provider_user_id: 'sub-1',
    provider_email: null,
    email_verified: 0,
    access_token_encrypted: null,
    refresh_token_encrypted: null,
    token_expires_at: null,
    raw_claims: null,
    profile_data: null,
    linked_at: 1000,
    last_login_at: null,
    updated_at: 1000,
    provisioning_state: 'active',
    ...overrides,
  };
  pii.raw
    .prepare(
      `INSERT INTO linked_identities (id, tenant_id, user_id, provider_id, provider_user_id,
        provider_email, email_verified, access_token_encrypted, refresh_token_encrypted,
        token_expires_at, raw_claims, profile_data, linked_at, last_login_at, updated_at,
        provisioning_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      values.id,
      values.tenant_id,
      values.user_id,
      values.provider_id,
      values.provider_user_id,
      values.provider_email,
      values.email_verified,
      values.access_token_encrypted,
      values.refresh_token_encrypted,
      values.token_expires_at,
      values.raw_claims,
      values.profile_data,
      values.linked_at,
      values.last_login_at,
      values.updated_at,
      values.provisioning_state
    );
};

const tokens = { access_token: 'access-1', token_type: 'Bearer' };

describe('createLinkedIdentity', () => {
  it('stores an encrypted full identity and returns its id', async () => {
    const id = await createLinkedIdentity(
      env,
      {
        userId: 'u1',
        providerId: 'p1',
        providerUserId: 'sub-1',
        providerEmail: 'a@example.com',
        emailVerified: true,
        tokens: { ...tokens, refresh_token: 'refresh-1', expires_in: 3600 },
        rawClaims: { sub: 'sub-1', n: 1 },
        tenantId: 't1',
      },
      pii
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const stored = row(id);
    expect(stored).toMatchObject({
      tenant_id: 't1',
      user_id: 'u1',
      provider_id: 'p1',
      provider_user_id: 'sub-1',
      provider_email: 'a@example.com',
      email_verified: 1,
      token_expires_at: T0 + 3_600_000,
      raw_claims: '{"sub":"sub-1","n":1}',
      profile_data: null,
      linked_at: T0,
      last_login_at: T0,
      updated_at: T0,
      provisioning_state: 'active',
    });
    expect(stored.access_token_encrypted).not.toContain('access-1');
    expect(await decrypt(must(stored.access_token_encrypted), KEY)).toBe('access-1');
    expect(await decrypt(must(stored.refresh_token_encrypted), KEY)).toBe('refresh-1');
  });

  it('stores nulls for what is absent', async () => {
    const id = await createLinkedIdentity(
      env,
      { userId: 'u1', providerId: 'p1', providerUserId: 'sub-1', tokens, tenantId: 't1' },
      pii
    );
    expect(row(id)).toMatchObject({
      provider_email: null,
      email_verified: 0,
      refresh_token_encrypted: null,
      token_expires_at: null,
      raw_claims: '{}',
    });
  });

  it('requires an encryption key', async () => {
    await expect(
      createLinkedIdentity(
        {} as Env,
        { userId: 'u1', providerId: 'p1', providerUserId: 's', tokens, tenantId: 't1' },
        pii
      )
    ).rejects.toThrow('RP_TOKEN_ENCRYPTION_KEY is not configured');
    expect(count(pii.raw, 'SELECT COUNT(*) AS n FROM linked_identities')).toBe(0);
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

describe('reading', () => {
  beforeEach(() => {
    seed({
      id: 'i1',
      provider_email: 'a@example.com',
      email_verified: 1,
      access_token_encrypted: 'enc-a',
      refresh_token_encrypted: 'enc-r',
      token_expires_at: 5000,
      raw_claims: '{"a":1}',
      profile_data: '{"p":2}',
      last_login_at: 3000,
      updated_at: 4000,
    });
    seed({ id: 'i2', provider_id: 'p2', provider_user_id: 'sub-2', linked_at: 2000 });
    seed({ id: 'i3', provider_id: 'p3', provider_user_id: 'sub-3', linked_at: 3000 });
    seed({ id: 'other-tenant', tenant_id: 't2' });
    seed({
      id: 'pending',
      provider_id: 'p9',
      provider_user_id: 'sub-9',
      provisioning_state: 'pending',
    });
  });

  it('maps a row to the identity', async () => {
    expect(await getLinkedIdentityById(env, 't1', 'i1', pii)).toEqual({
      id: 'i1',
      tenantId: 't1',
      userId: 'u1',
      providerId: 'p1',
      providerUserId: 'sub-1',
      providerEmail: 'a@example.com',
      emailVerified: true,
      accessTokenEncrypted: 'enc-a',
      refreshTokenEncrypted: 'enc-r',
      tokenExpiresAt: 5000,
      rawClaims: { a: 1 },
      profileData: { p: 2 },
      linkedAt: 1000,
      lastLoginAt: 3000,
      updatedAt: 4000,
    });
  });

  it('maps absent columns to undefined', async () => {
    expect(await getLinkedIdentityById(env, 't1', 'i2', pii)).toEqual({
      id: 'i2',
      tenantId: 't1',
      userId: 'u1',
      providerId: 'p2',
      providerUserId: 'sub-2',
      providerEmail: undefined,
      emailVerified: false,
      accessTokenEncrypted: undefined,
      refreshTokenEncrypted: undefined,
      tokenExpiresAt: undefined,
      rawClaims: undefined,
      profileData: undefined,
      linkedAt: 2000,
      lastLoginAt: undefined,
      updatedAt: 1000,
    });
  });

  it('is scoped to the tenant and hides pending rows', async () => {
    expect(await getLinkedIdentityById(env, 't2', 'i1', pii)).toBeNull();
    expect(await getLinkedIdentityById(env, 't1', 'pending', pii)).toBeNull();
    expect(await getLinkedIdentityById(env, 't1', 'nope', pii)).toBeNull();
    expect(await findLinkedIdentity(env, 't1', 'p9', 'sub-9', pii)).toBeNull();
    expect(await findLinkedIdentity(env, 't2', 'p1', 'sub-1', pii)).toMatchObject({
      id: 'other-tenant',
    });
    expect(await findLinkedIdentity(env, 't1', 'p1', 'sub-1', pii)).toMatchObject({ id: 'i1' });
    expect(await findLinkedIdentity(env, 't1', 'p1', 'other', pii)).toBeNull();
    expect(await findLinkedIdentity(env, 't1', 'p2', 'sub-1', pii)).toBeNull();
  });

  it('lists a user newest first, hiding pending rows and other users', async () => {
    seed({ id: 'u2-link', user_id: 'u2', provider_id: 'p5', provider_user_id: 's5' });
    const list = await listLinkedIdentities(env, 't1', 'u1', pii);
    expect(list.map((item) => item.id)).toEqual(['i3', 'i2', 'i1']);
    expect(await listLinkedIdentities(env, 't1', 'nobody', pii)).toEqual([]);
    expect(await listLinkedIdentities(env, 't2', 'u1', pii)).toHaveLength(1);
  });

  it('finds by user and provider', async () => {
    expect(await getLinkedIdentityForUserAndProvider(env, 't1', 'u1', 'p2', pii)).toMatchObject({
      id: 'i2',
    });
    expect(await getLinkedIdentityForUserAndProvider(env, 't1', 'u2', 'p2', pii)).toBeNull();
    expect(await getLinkedIdentityForUserAndProvider(env, 't1', 'u1', 'p9', pii)).toBeNull();
    expect(await getLinkedIdentityForUserAndProvider(env, 't2', 'u1', 'p2', pii)).toBeNull();
  });

  it('counts a user active identities', async () => {
    expect(await countLinkedIdentities(env, 't1', 'u1', pii)).toBe(3);
    expect(await countLinkedIdentities(env, 't1', 'nobody', pii)).toBe(0);
    expect(await countLinkedIdentities(env, 't2', 'u1', pii)).toBe(1);
  });

  it('lists identities by provider subject within a tenant', async () => {
    const found = await findLinkedIdentitiesByProviderSub(env, 't1', 'p1', 'sub-1', pii);
    expect(found.map((item) => item.id)).toEqual(['i1']);
    expect(await findLinkedIdentitiesByProviderSub(env, 't2', 'p1', 'sub-1', pii)).toHaveLength(1);
    expect(await findLinkedIdentitiesByProviderSub(env, 't1', 'p9', 'sub-9', pii)).toEqual([]);
    expect(await findLinkedIdentitiesByProviderSub(env, 't9', 'p1', 'sub-1', pii)).toEqual([]);
    expect(await findLinkedIdentitiesByProviderSub(env, 't1', 'p1', 'sub-2', pii)).toEqual([]);
  });
});

describe('findLinkedIdentitiesAcrossTenantsByProviderSub', () => {
  it('asks each tenant for the account route and flattens the results', async () => {
    seed({ id: 'a', tenant_id: 't1' });
    seed({ id: 'b', tenant_id: 't2', user_id: 'u2' });
    mocks.resolveAccount.mockResolvedValue({ piiDb: pii });
    const found = await findLinkedIdentitiesAcrossTenantsByProviderSub(
      env,
      ['t1', 't2', 't3'],
      'p1',
      'sub-1'
    );
    expect(found.map((item) => item.id).sort()).toEqual(['a', 'b']);
    expect(mocks.resolveAccount).toHaveBeenCalledTimes(3);
    expect(mocks.resolveAccount).toHaveBeenCalledWith(env, {
      tenantId: 't2',
      indexKind: 'external_subject',
      identifier: { issuer: 'p1', subject: 'sub-1' },
    });
  });

  it('skips tenants without a route and rethrows any other failure', async () => {
    seed({ id: 'a', tenant_id: 't1' });
    mocks.resolveAccount.mockImplementation(async (_env: unknown, input: { tenantId: string }) => {
      if (input.tenantId === 't1') return { piiDb: pii };
      throw new Error('account_data_route_not_found');
    });
    expect(
      (await findLinkedIdentitiesAcrossTenantsByProviderSub(env, ['t1', 't2'], 'p1', 'sub-1')).map(
        (item) => item.id
      )
    ).toEqual(['a']);
    mocks.resolveAccount.mockRejectedValue(new Error('directory down'));
    await expect(
      findLinkedIdentitiesAcrossTenantsByProviderSub(env, ['t1'], 'p1', 'sub-1')
    ).rejects.toThrow('directory down');
    mocks.resolveAccount.mockRejectedValue('not an error');
    await expect(
      findLinkedIdentitiesAcrossTenantsByProviderSub(env, ['t1'], 'p1', 'sub-1')
    ).rejects.toBe('not an error');
    expect(await findLinkedIdentitiesAcrossTenantsByProviderSub(env, [], 'p1', 'sub-1')).toEqual(
      []
    );
  });
});

describe('pending provisioning', () => {
  const pending = (overrides: Partial<Row> = {}) =>
    seed({
      id: 'pend',
      provisioning_state: 'pending',
      profile_data: 'encrypted-profile',
      ...overrides,
    });
  const input = {
    id: 'pend',
    tenantId: 't1',
    userId: 'u1',
    providerId: 'p1',
    providerUserId: 'sub-1',
    profileDataEncrypted: 'encrypted-profile',
  };

  it('finds the pending record with its encrypted profile', async () => {
    pending();
    expect(await findPendingLinkedIdentityProvisioning(env, 't1', 'p1', 'sub-1', pii)).toEqual(
      input
    );
  });

  it('ignores active rows, rows without a profile and other keys', async () => {
    seed({ id: 'act', profile_data: 'x' });
    expect(await findPendingLinkedIdentityProvisioning(env, 't1', 'p1', 'sub-1', pii)).toBeNull();
    pending({ id: 'noprofile', profile_data: null, provider_user_id: 'sub-n' });
    expect(await findPendingLinkedIdentityProvisioning(env, 't1', 'p1', 'sub-n', pii)).toBeNull();
    pending({ provider_user_id: 'sub-1x' });
    expect(await findPendingLinkedIdentityProvisioning(env, 't1', 'p1', 'sub-1', pii)).toBeNull();
    expect(await findPendingLinkedIdentityProvisioning(env, 't2', 'p1', 'sub-1x', pii)).toBeNull();
    expect(await findPendingLinkedIdentityProvisioning(env, 't1', 'p2', 'sub-1x', pii)).toBeNull();
  });

  it('activates the pending record, dropping the profile and stamping the time', async () => {
    pending();
    const check = vi.spyOn(pii, 'queryOne');
    await activatePendingLinkedIdentity(env, input, pii);
    // Nothing needs double-checking when the pending row itself was activated.
    expect(check).not.toHaveBeenCalled();
    expect(row('pend')).toMatchObject({
      provisioning_state: 'active',
      profile_data: null,
      updated_at: T0,
    });
  });

  it('is idempotent once the same identity is active', async () => {
    pending();
    await activatePendingLinkedIdentity(env, input, pii);
    vi.setSystemTime(T0 + 5000);
    await activatePendingLinkedIdentity(env, input, pii);
    expect(row('pend').updated_at).toBe(T0);
  });

  it.each([
    ['tenant', { tenantId: 't2' }],
    ['user', { userId: 'u9' }],
    ['provider', { providerId: 'p9' }],
    ['provider user', { providerUserId: 'sub-9' }],
    ['id', { id: 'missing' }],
  ])('refuses to activate a record with another %s', async (_name, change) => {
    pending();
    await expect(activatePendingLinkedIdentity(env, { ...input, ...change }, pii)).rejects.toThrow(
      'external_idp_pending_identity_activation_conflict'
    );
    expect(row('pend').provisioning_state).toBe('pending');
  });
});

describe('updateLinkedIdentity', () => {
  beforeEach(() => {
    seed({
      id: 'i1',
      access_token_encrypted: 'old-access',
      refresh_token_encrypted: 'old-refresh',
      token_expires_at: 111,
      raw_claims: '{"old":true}',
      last_login_at: 222,
    });
  });

  it('only stamps updated_at when nothing else changes', async () => {
    expect(await updateLinkedIdentity(env, 't1', 'i1', {}, pii)).toBe(true);
    expect(row('i1')).toMatchObject({
      updated_at: T0,
      access_token_encrypted: 'old-access',
      refresh_token_encrypted: 'old-refresh',
      token_expires_at: 111,
      raw_claims: '{"old":true}',
      last_login_at: 222,
    });
  });

  it('replaces the tokens, encrypted, with the new expiry', async () => {
    await updateLinkedIdentity(
      env,
      't1',
      'i1',
      {
        tokens: {
          access_token: 'new-a',
          token_type: 'Bearer',
          refresh_token: 'new-r',
          expires_in: 60,
        },
      },
      pii
    );
    const stored = row('i1');
    expect(await decrypt(must(stored.access_token_encrypted), KEY)).toBe('new-a');
    expect(await decrypt(must(stored.refresh_token_encrypted), KEY)).toBe('new-r');
    expect(stored.token_expires_at).toBe(T0 + 60_000);
  });

  it('keeps the old refresh token but not the old expiry when the new tokens carry none', async () => {
    await updateLinkedIdentity(env, 't1', 'i1', { tokens }, pii);
    const stored = row('i1');
    expect(await decrypt(must(stored.access_token_encrypted), KEY)).toBe('access-1');
    expect(stored.refresh_token_encrypted).toBe('old-refresh');
    expect(stored.token_expires_at).toBeNull();
  });

  it('clears all tokens, ignoring any given alongside', async () => {
    await updateLinkedIdentity(env, 't1', 'i1', { clearTokens: true, tokens }, pii);
    expect(row('i1')).toMatchObject({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
    });
  });

  it('updates the last login and the raw claims', async () => {
    await updateLinkedIdentity(env, 't1', 'i1', { lastLoginAt: 999, rawClaims: { x: 1 } }, pii);
    expect(row('i1')).toMatchObject({ last_login_at: 999, raw_claims: '{"x":1}' });
  });

  it('does not touch the last login for a zero timestamp', async () => {
    await updateLinkedIdentity(env, 't1', 'i1', { lastLoginAt: 0 }, pii);
    expect(row('i1').last_login_at).toBe(222);
  });

  it('reports no change for another tenant or a missing identity', async () => {
    expect(await updateLinkedIdentity(env, 't2', 'i1', {}, pii)).toBe(false);
    expect(await updateLinkedIdentity(env, 't1', 'nope', {}, pii)).toBe(false);
    expect(row('i1').updated_at).toBe(1000);
  });

  it('writes only while the link still holds the expected refresh token', async () => {
    expect(
      await updateLinkedIdentity(
        env,
        't1',
        'i1',
        { tokens, expectedRefreshTokenEncrypted: 'stale-refresh' },
        pii
      )
    ).toBe(false);
    expect(row('i1').access_token_encrypted).toBe('old-access');
    expect(
      await updateLinkedIdentity(
        env,
        't1',
        'i1',
        { tokens, expectedRefreshTokenEncrypted: 'old-refresh' },
        pii
      )
    ).toBe(true);
    expect(row('i1').access_token_encrypted).not.toBe('old-access');
  });

  it('requires an encryption key to write tokens, and writes nothing without one', async () => {
    await expect(updateLinkedIdentity({} as Env, 't1', 'i1', { tokens }, pii)).rejects.toThrow(
      'RP_TOKEN_ENCRYPTION_KEY is not configured'
    );
    expect(row('i1').access_token_encrypted).toBe('old-access');
    expect(await updateLinkedIdentity({} as Env, 't1', 'i1', { clearTokens: true }, pii)).toBe(
      true
    );
  });
});

describe('deleteLinkedIdentity', () => {
  it('deletes within the tenant only', async () => {
    seed({ id: 'i1' });
    expect(await deleteLinkedIdentity(env, 't2', 'i1', pii)).toBe(false);
    expect(count(pii.raw, 'SELECT COUNT(*) AS n FROM linked_identities')).toBe(1);
    expect(await deleteLinkedIdentity(env, 't1', 'i1', pii)).toBe(true);
    expect(await deleteLinkedIdentity(env, 't1', 'i1', pii)).toBe(false);
    expect(count(pii.raw, 'SELECT COUNT(*) AS n FROM linked_identities')).toBe(0);
  });
});

describe('decryptLinkedIdentityTokens', () => {
  const identity = (extra: Record<string, string | undefined>) => ({
    id: 'i1',
    tenantId: 't1',
    userId: 'u1',
    providerId: 'p1',
    providerUserId: 's',
    emailVerified: false,
    linkedAt: 1,
    updatedAt: 1,
    ...extra,
  });

  it('decrypts what is present and returns null for the rest', async () => {
    const id = await createLinkedIdentity(
      env,
      {
        userId: 'u1',
        providerId: 'p1',
        providerUserId: 's',
        tokens: { ...tokens, refresh_token: 'r-1' },
        tenantId: 't1',
      },
      pii
    );
    const stored = row(id);
    expect(
      await decryptLinkedIdentityTokens(
        env,
        identity({
          accessTokenEncrypted: must(stored.access_token_encrypted),
          refreshTokenEncrypted: must(stored.refresh_token_encrypted),
        })
      )
    ).toEqual({ accessToken: 'access-1', refreshToken: 'r-1' });
    expect(await decryptLinkedIdentityTokens(env, identity({}))).toEqual({
      accessToken: null,
      refreshToken: null,
    });
  });

  it('requires the encryption key', async () => {
    await expect(decryptLinkedIdentityTokens({} as Env, identity({}))).rejects.toThrow(
      'RP_TOKEN_ENCRYPTION_KEY is not configured'
    );
  });
});

describe('database partitions', () => {
  const partitionOf = (): unknown => mocks.ensure.mock.calls.at(-1)?.[1];

  it('names the partition each operation reads or writes through', async () => {
    seed({ id: 'i1' });
    seed({
      id: 'pend',
      provider_id: 'p9',
      provider_user_id: 's9',
      provisioning_state: 'pending',
      profile_data: 'x',
    });
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['linked-identity:get-by-id', () => getLinkedIdentityById(env, 't1', 'i1', pii)],
      [
        'linked-identity:find-by-provider-sub',
        () => findLinkedIdentity(env, 't1', 'p1', 'sub-1', pii),
      ],
      [
        'linked-identity:find-pending-provisioning',
        () => findPendingLinkedIdentityProvisioning(env, 't1', 'p9', 's9', pii),
      ],
      [
        'linked-identity:activate-pending-provisioning',
        () =>
          activatePendingLinkedIdentity(
            env,
            {
              id: 'pend',
              tenantId: 't1',
              userId: 'u1',
              providerId: 'p9',
              providerUserId: 's9',
              profileDataEncrypted: 'x',
            },
            pii
          ),
      ],
      [
        'linked-identity:list-by-provider-sub',
        () => findLinkedIdentitiesByProviderSub(env, 't1', 'p1', 'sub-1', pii),
      ],
      ['linked-identity:list', () => listLinkedIdentities(env, 't1', 'u1', pii)],
      [
        'linked-identity:get-for-user-provider',
        () => getLinkedIdentityForUserAndProvider(env, 't1', 'u1', 'p1', pii),
      ],
      [
        'linked-identity:create',
        () =>
          createLinkedIdentity(
            env,
            { userId: 'u1', providerId: 'p7', providerUserId: 's7', tokens, tenantId: 't1' },
            pii
          ),
      ],
      ['linked-identity:update', () => updateLinkedIdentity(env, 't1', 'i1', {}, pii)],
      ['linked-identity:count', () => countLinkedIdentities(env, 't1', 'u1', pii)],
      ['linked-identity:delete', () => deleteLinkedIdentity(env, 't1', 'i1', pii)],
    ];
    for (const [partition, run] of cases) {
      await run();
      expect(partitionOf()).toBe(partition);
      expect(mocks.ensure.mock.calls.at(-1)?.[0]).toBe(pii);
    }
  });

  it('reads the pending record and its activation check from the primary', async () => {
    seed({ id: 'pend', provisioning_state: 'pending', profile_data: 'x' });
    const spy = vi.spyOn(pii, 'queryOne');
    await findPendingLinkedIdentityProvisioning(env, 't1', 'p1', 'sub-1', pii);
    expect(spy.mock.calls[0]?.[2]).toEqual({ consistencyClass: 'primary_required' });
    spy.mockClear();
    const input = {
      id: 'other',
      tenantId: 't1',
      userId: 'u1',
      providerId: 'p1',
      providerUserId: 'sub-1',
      profileDataEncrypted: 'x',
    };
    await expect(activatePendingLinkedIdentity(env, input, pii)).rejects.toThrow();
    expect(spy.mock.calls[0]?.[2]).toEqual({ consistencyClass: 'primary_required' });
  });
});
