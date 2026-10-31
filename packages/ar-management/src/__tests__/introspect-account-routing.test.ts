/**
 * Introspection reads the token user's state from the user's ACCOUNT database, never the tenant
 * metadata database (which holds no users since tenant D1 routing). The two databases are
 * separate mocks here, so a read from the wrong one is visible: the metadata database holds only
 * the client, the account database holds the user, its consent withdrawals and device secrets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  parseToken: vi.fn(),
  verifyToken: vi.fn(),
  getRefreshToken: vi.fn(),
  isTokenRevoked: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  resolveAccountDataContext: vi.fn(),
  readAccountAuthenticationState: vi.fn(),
  resolveDeviceSecretRouteHint: vi.fn(),
  resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(),
  requireDedicatedAdminDatabaseAdapter: vi.fn(),
  applyIntrospectionIdentityMapping: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // The tenant has turned extended claims on: the Resource Server's mapping applies.
    resolveEffectiveSettings: async () => ({ 'tokens.introspection_extended_claims': true }),
    getTenantIdFromContext: () => 'tenant-a',
    verifyClientSecretHash: async (secret: string, hash: string) => hash === `hash_${secret}`,
    getKeyByKid: async () => ({ kty: 'RSA', kid: 'key-1', n: 'n', e: 'AQAB' }),
    parseToken: mocks.parseToken,
    verifyToken: mocks.verifyToken,
    getRefreshToken: mocks.getRefreshToken,
    isTokenRevoked: mocks.isTokenRevoked,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    resolveAccountDataContext: mocks.resolveAccountDataContext,
    readAccountAuthenticationState: mocks.readAccountAuthenticationState,
    resolveDeviceSecretRouteHint: mocks.resolveDeviceSecretRouteHint,
    resolveTenantAssignedDatabaseSourcesFromRegistry:
      mocks.resolveTenantAssignedDatabaseSourcesFromRegistry,
    publishEvent: async () => undefined,
    requireDedicatedAdminDatabaseAdapter: mocks.requireDedicatedAdminDatabaseAdapter,
    applyIntrospectionIdentityMapping: mocks.applyIntrospectionIdentityMapping,
  };
});

vi.mock('jose', () => ({
  importJWK: vi.fn(async () => ({})),
  decodeProtectedHeader: vi.fn(() => ({ kid: 'key-1' })),
}));

vi.mock('../request-issuer', () => ({
  getRequestAwareIssuerUrl: () => 'https://op.example.com',
}));

import { introspectHandler } from '../introspect';
import { batchRevokeHandler, revokeHandler } from '../revoke';

interface AccountRow {
  account_lifecycle_state: string;
  directory_publication_state: string;
  subject_lifecycle_state: string | null;
  metadata_json: string | null;
}

interface FakeDatabase {
  name: string;
  accounts: Map<string, AccountRow>;
  revocations: Map<string, { generation: number; revoked_at: number }>;
  deviceSecrets: Record<string, unknown>[];
  clients: Map<string, Record<string, unknown>>;
  failRevocationRead?: boolean;
  failAccountRead?: boolean;
  queries: string[];
}

function createFakeDatabase(name: string): FakeDatabase {
  return {
    name,
    accounts: new Map(),
    revocations: new Map(),
    deviceSecrets: [],
    clients: new Map(),
    queries: [],
  };
}

/** A DatabaseAdapter over a fake database, answering the reads introspection makes. */
function adapterFor(db: FakeDatabase): DatabaseAdapter {
  const queryOne = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.queries.push(sql);
    if (sql.includes('FROM oauth_clients')) {
      return db.clients.get(String(params[1])) ?? null;
    }
    if (sql.includes('FROM identity_accounts')) {
      if (db.failAccountRead) throw new Error(`${db.name} account read failed`);
      // Any parameter naming a stored user (the legacy query bound it first, this one second).
      const userId = params.find((param) => db.accounts.has(String(param)));
      return userId === undefined ? null : (db.accounts.get(String(userId)) ?? null);
    }
    if (sql.includes('FROM oauth_client_consent_revocations')) {
      if (db.failRevocationRead) throw new Error(`${db.name} revocation read failed`);
      return db.revocations.get(`${params[1]}:${params[2]}`) ?? null;
    }
    if (sql.includes('FROM device_secrets')) {
      // By secret hash (a raw secret) or by ID.
      return (
        db.deviceSecrets.find((row) => row.secret_hash === params[0] || row.id === params[0]) ??
        null
      );
    }
    return null;
  });
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.queries.push(sql);
    if (sql.includes('UPDATE device_secrets') && sql.includes('revoked_at = ?')) {
      const row = db.deviceSecrets.find(
        (candidate) => candidate.id === params[3] && candidate.revoked_at == null
      );
      if (!row) return { rowsAffected: 0 };
      row.revoked_at = params[0];
      row.revoke_reason = params[1];
      return { rowsAffected: 1 };
    }
    return { rowsAffected: 0 };
  });
  return {
    query: vi.fn(async () => []),
    queryOne,
    execute,
    transaction: vi.fn(),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(async () => undefined),
  } as unknown as DatabaseAdapter;
}

const ACTIVE_ACCOUNT: AccountRow = {
  account_lifecycle_state: 'active',
  directory_publication_state: 'active',
  subject_lifecycle_state: 'active',
  metadata_json: null,
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function accessTokenPayload(overrides: Record<string, unknown> = {}) {
  return {
    jti: 'at-jti-1',
    sub: 'user-1',
    aud: 'https://op.example.com',
    scope: 'openid',
    iss: 'https://op.example.com',
    exp: nowSeconds() + 3600,
    iat: nowSeconds() - 600,
    client_id: 'client-a',
    token_use: 'access',
    ...overrides,
  };
}

function refreshTokenPayload(overrides: Record<string, unknown> = {}) {
  return accessTokenPayload({
    jti: 'rt-jti-1',
    aud: 'client-a',
    rtv: 1,
    token_use: 'refresh',
    ...overrides,
  });
}

let metadataDb: FakeDatabase;
let accountDb: FakeDatabase;
/** Account route per user ID: the account database, or the error resolution throws. */
let routes: Map<string, FakeDatabase | Error>;
/** Authentication-state lifecycle per user ID (none: never an account), or the error reading it. */
let authStates: Map<string, string | Error>;

function createApp(env: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const vars = c as unknown as { set(key: string, value: unknown): void };
    vars.set('tenantId', 'tenant-a');
    vars.set('tenantMetadataContext', { tenantId: 'tenant-a', coreDb: adapterFor(metadataDb) });
    await next();
  });
  app.post('/introspect', introspectHandler);
  return {
    introspect: (body: Record<string, string>) =>
      app.request(
        'https://op.example.com/introspect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'client-a',
            client_secret: 'secret-a',
            ...body,
          }).toString(),
        },
        { ISSUER_URL: 'https://op.example.com', ...env } as Env
      ),
  };
}

async function introspectToken(
  payload: Record<string, unknown>,
  body: Record<string, string> = {},
  env: Partial<Env> = {}
) {
  mocks.parseToken.mockReturnValue(payload);
  mocks.verifyToken.mockResolvedValue(payload);
  const response = await createApp(env).introspect({ token: 'signed.jwt.token', ...body });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  metadataDb = createFakeDatabase('metadata');
  accountDb = createFakeDatabase('account');
  metadataDb.clients.set('client-a', {
    client_id: 'client-a',
    client_secret_hash: 'hash_secret-a',
  });
  accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT });
  routes = new Map([['user-1', accountDb]]);
  authStates = new Map([['user-1', 'active']]);

  mocks.isTokenRevoked.mockResolvedValue(false);
  mocks.requireDedicatedAdminDatabaseAdapter.mockImplementation(() => {
    throw new Error('admin database not configured');
  });
  mocks.applyIntrospectionIdentityMapping.mockImplementation(
    async (input: { claims: Record<string, unknown> }) => ({ active: true, sub: input.claims.sub })
  );
  mocks.getRefreshToken.mockResolvedValue(null);
  mocks.resolveAccountDataContextFromHono.mockImplementation(
    async (c: { set(key: string, value: unknown): void }, accountId: string) => {
      const userId = accountId.replace(/^account:/u, '');
      const route = routes.get(userId);
      if (route instanceof Error) throw route;
      if (!route) throw new Error('account_data_route_not_found');
      const context = {
        tenantId: 'tenant-a',
        accountId: `account:${userId}`,
        coreDb: adapterFor(route),
        piiDb: adapterFor(route),
        userCacheScope: 'account',
        piiCacheMode: 'encrypted_short_ttl',
      };
      c.set('accountDataContext', context);
      return context;
    }
  );
  mocks.resolveAccountDataContext.mockImplementation(
    async (_env: unknown, input: { tenantId: string; accountId: string }) => {
      const userId = input.accountId.replace(/^account:/u, '');
      const route = routes.get(userId);
      if (route instanceof Error) throw route;
      if (!route) throw new Error('account_data_route_not_found');
      return {
        tenantId: input.tenantId,
        accountId: `account:${userId}`,
        coreDb: adapterFor(route),
        piiDb: adapterFor(route),
      };
    }
  );
  mocks.readAccountAuthenticationState.mockImplementation(
    async (_env: unknown, _tenantId: string, userId: string) => {
      const state = authStates.get(userId);
      if (state instanceof Error) throw state;
      return { lifecycle: state ?? null, revokedAfterMs: null };
    }
  );
});

describe('introspection account state (account database)', () => {
  it('answers active for an active account read from the account database', async () => {
    const { status, body } = await introspectToken(accessTokenPayload());
    expect(status).toBe(200);
    expect(body).toMatchObject({ active: true, sub: 'user-1', client_id: 'client-a' });
    expect(accountDb.queries.some((sql) => sql.includes('FROM identity_accounts'))).toBe(true);
    expect(metadataDb.queries.some((sql) => sql.includes('FROM identity_accounts'))).toBe(false);
  });

  it.each([
    ['suspended account', { account_lifecycle_state: 'suspended' }],
    ['locked account', { account_lifecycle_state: 'locked' }],
    ['deleting account', { account_lifecycle_state: 'deleting' }],
    ['suspended subject', { subject_lifecycle_state: 'suspended' }],
    ['legacy suspended status', { metadata_json: JSON.stringify({ status: 'suspended' }) }],
  ])('answers inactive for a %s held only in the account database', async (_label, change) => {
    accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT, ...change });
    const { body } = await introspectToken(accessTokenPayload());
    expect(body).toEqual({ active: false });
  });

  it('answers inactive when the account route revalidation refuses a non-active account', async () => {
    routes.set('user-1', new Error('lookup_destination_revalidation_failed'));
    const { body } = await introspectToken(accessTokenPayload());
    expect(body).toEqual({ active: false });
  });

  it('answers inactive for a user token whose account no longer exists', async () => {
    routes.delete('user-1');
    const { body } = await introspectToken(accessTokenPayload());
    expect(body).toEqual({ active: false });
  });

  it('answers inactive when the routed account row is missing', async () => {
    accountDb.accounts.delete('user-1');
    const { body } = await introspectToken(accessTokenPayload());
    expect(body).toEqual({ active: false });
  });

  it('refuses (503, never active) when the account route cannot be resolved', async () => {
    routes.set('user-1', new Error('account_data_runtime_registry_unavailable'));
    const { status, body } = await introspectToken(accessTokenPayload());
    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'server_error' });
    expect(body.active).toBeUndefined();
  });

  it('refuses (503, never active) when the account cannot be read', async () => {
    accountDb.failAccountRead = true;
    const { status, body } = await introspectToken(accessTokenPayload());
    expect(status).toBe(503);
    expect(body.active).toBeUndefined();
  });

  it('does not look for an account behind a client credentials subject', async () => {
    const { body } = await introspectToken(accessTokenPayload({ sub: 'client:client-a' }));
    expect(body).toMatchObject({ active: true, sub: 'client:client-a' });
    expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
  });

  it('accepts an RFC 7523 assertion subject that is not an account', async () => {
    metadataDb.clients.set('client-rs', {
      client_id: 'client-rs',
      client_secret_hash: 'hash_secret-rs',
    });
    const { body } = await introspectToken(
      accessTokenPayload({
        sub: 'service-7',
        client_id: 'https://issuer.example.com',
        aud: 'client-rs',
        authrim_subject_issuer: 'https://issuer.example.com',
      }),
      { client_id: 'client-rs', client_secret: 'secret-rs' }
    );
    expect(body).toMatchObject({ active: true, sub: 'service-7' });
  });

  it('does not take a client_id or original_issuer for evidence of an external subject', async () => {
    metadataDb.clients.set('client-rs', {
      client_id: 'client-rs',
      client_secret_hash: 'hash_secret-rs',
    });
    // Only the subject-issuer claim the authorization server writes is evidence: these claims
    // could come from a custom claim or identity mapping on another token.
    const { body } = await introspectToken(
      accessTokenPayload({
        sub: 'service-7',
        client_id: 'https://issuer.example.com',
        aud: 'client-rs',
        original_issuer: 'https://idp.example.com',
      }),
      { client_id: 'client-rs', client_secret: 'secret-rs' },
      {
        TRUSTED_JWT_ISSUERS: JSON.stringify({
          'https://issuer.example.com': { jwks: { keys: [] } },
        }),
      }
    );
    expect(body).toEqual({ active: false });
  });

  it('still holds an RFC 7523 subject that is an account to its state', async () => {
    metadataDb.clients.set('client-rs', {
      client_id: 'client-rs',
      client_secret_hash: 'hash_secret-rs',
    });
    accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT, account_lifecycle_state: 'suspended' });
    const { body } = await introspectToken(
      accessTokenPayload({ client_id: 'https://issuer.example.com', aud: 'client-rs' }),
      { client_id: 'client-rs', client_secret: 'secret-rs' },
      {
        TRUSTED_JWT_ISSUERS: JSON.stringify({
          'https://issuer.example.com': { jwks: { keys: [] } },
        }),
      }
    );
    expect(body).toEqual({ active: false });
  });
});

describe('introspection and consent withdrawal (consent generation)', () => {
  const revokedAt = Date.now() - 60_000;

  function withdrawConsent(generation: number) {
    accountDb.revocations.set('user-1:client-a', { generation, revoked_at: revokedAt });
  }

  it('answers inactive for a refresh token of a family issued under an earlier generation', async () => {
    withdrawConsent(2);
    mocks.getRefreshToken.mockResolvedValue({
      sub: 'user-1',
      client_id: 'client-a',
      family_consent_generation: 1,
      family_created_at: revokedAt + 1_000,
    });
    const { body } = await introspectToken(refreshTokenPayload(), {
      token_type_hint: 'refresh_token',
    });
    expect(body).toEqual({ active: false });
    expect(metadataDb.queries.some((sql) => sql.includes('oauth_client_consent_revocations'))).toBe(
      false
    );
  });

  it('answers active for a refresh token of a current-generation family', async () => {
    withdrawConsent(2);
    mocks.getRefreshToken.mockResolvedValue({
      sub: 'user-1',
      client_id: 'client-a',
      family_consent_generation: 2,
      family_created_at: revokedAt - 1_000,
    });
    const { body } = await introspectToken(refreshTokenPayload(), {
      token_type_hint: 'refresh_token',
    });
    expect(body).toMatchObject({ active: true });
  });

  it.each([
    ['created before', revokedAt - 1_000, false],
    ['created after', revokedAt + 1_000, true],
  ])(
    'compares a legacy family without a generation by its creation time (%s the withdrawal)',
    async (_label, familyCreatedAt, active) => {
      withdrawConsent(1);
      mocks.getRefreshToken.mockResolvedValue({
        sub: 'user-1',
        client_id: 'client-a',
        family_created_at: familyCreatedAt,
      });
      const { body } = await introspectToken(refreshTokenPayload(), {
        token_type_hint: 'refresh_token',
      });
      expect(body.active).toBe(active);
    }
  );

  it('refuses (503, never active) when the withdrawal state cannot be read', async () => {
    accountDb.failRevocationRead = true;
    mocks.getRefreshToken.mockResolvedValue({
      sub: 'user-1',
      client_id: 'client-a',
      family_consent_generation: 0,
      family_created_at: Date.now() - 1_000,
    });
    const { status, body } = await introspectToken(refreshTokenPayload(), {
      token_type_hint: 'refresh_token',
    });
    expect(status).toBe(503);
    expect(body.active).toBeUndefined();
  });

  it('answers inactive for an access token issued before the withdrawal', async () => {
    withdrawConsent(1);
    const { body } = await introspectToken(
      accessTokenPayload({ iat: Math.floor(revokedAt / 1000) - 5 })
    );
    expect(body).toEqual({ active: false });
  });

  it('answers inactive for an access token issued within the second of the withdrawal', async () => {
    withdrawConsent(1);
    const { body } = await introspectToken(
      accessTokenPayload({ iat: Math.floor(revokedAt / 1000) })
    );
    expect(body).toEqual({ active: false });
  });

  it('answers active for an access token issued after the withdrawal', async () => {
    withdrawConsent(1);
    const { body } = await introspectToken(
      accessTokenPayload({ iat: Math.floor(revokedAt / 1000) + 5 })
    );
    expect(body).toMatchObject({ active: true });
  });

  it('refuses an access token (503, never active) when the withdrawal cannot be read', async () => {
    accountDb.failRevocationRead = true;
    const { status, body } = await introspectToken(accessTokenPayload());
    expect(status).toBe(503);
    expect(body.active).toBeUndefined();
  });
});

const RAW_DEVICE_SECRET = 'device-secret-raw-value-0123456789abcdef';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('device secret introspection and revocation (account database)', () => {
  const createdAt = Date.now() - 120_000;

  /** As Native SSO issues it: stored with its owner's account data, routed by a hint. */
  async function issueDeviceSecret(db: FakeDatabase) {
    db.deviceSecrets.push({
      id: 'ds-1',
      tenant_id: 'tenant-a',
      user_id: 'user-1',
      client_id: 'client-a',
      session_id: 'sid-1',
      secret_hash: await sha256Hex(RAW_DEVICE_SECRET),
      device_platform: 'ios',
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: Date.now() + 3_600_000,
      use_count: 0,
      is_active: 1,
      revoked_at: null,
    });
  }

  async function introspectDeviceSecret() {
    const response = await createApp().introspect({
      token: RAW_DEVICE_SECRET,
      token_type_hint: 'device_secret',
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function revokeDeviceSecret() {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      const vars = c as unknown as { set(key: string, value: unknown): void };
      vars.set('tenantId', 'tenant-a');
      vars.set('tenantMetadataContext', { tenantId: 'tenant-a', coreDb: adapterFor(metadataDb) });
      await next();
    });
    app.post('/revoke', revokeHandler);
    return app.request(
      'https://op.example.com/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: RAW_DEVICE_SECRET,
          token_type_hint: 'device_secret',
          client_id: 'client-a',
          client_secret: 'secret-a',
        }).toString(),
      },
      { ISSUER_URL: 'https://op.example.com' } as Env
    );
  }

  beforeEach(() => {
    metadataDb.clients.set('client-a', {
      client_id: 'client-a',
      client_secret_hash: 'hash_secret-a',
      device_secret_revoke_enabled: true,
    });
    mocks.resolveDeviceSecretRouteHint.mockResolvedValue({
      tenantId: 'tenant-a',
      accountId: 'account:user-1',
      issuedAt: createdAt,
      expiresAt: Date.now() + 3_600_000,
    });
  });

  it('reads the device secret from its owner account database', async () => {
    await issueDeviceSecret(accountDb);
    const { body } = await introspectDeviceSecret();
    expect(body).toMatchObject({ active: true, token_type: 'device_secret', sub: 'user-1' });
    expect(metadataDb.queries.some((sql) => sql.includes('FROM device_secrets'))).toBe(false);
  });

  it('revokes the device secret in its owner account database, ending it at introspection', async () => {
    await issueDeviceSecret(accountDb);
    await expect(introspectDeviceSecret()).resolves.toMatchObject({ body: { active: true } });

    const revoked = await revokeDeviceSecret();
    expect(revoked.status).toBe(200);
    expect(accountDb.deviceSecrets[0]?.revoked_at).toEqual(expect.any(Number));
    expect(metadataDb.queries.some((sql) => sql.includes('device_secrets'))).toBe(false);

    await expect(introspectDeviceSecret()).resolves.toEqual({
      status: 200,
      body: { active: false },
    });
  });

  it('persists the revocation of a suspended owner secret, so a reactivation does not revive it', async () => {
    await issueDeviceSecret(accountDb);
    mocks.resolveTenantAssignedDatabaseSourcesFromRegistry.mockResolvedValue([
      { source: adapterFor(metadataDb), bindingRef: 'DB' },
      { source: adapterFor(accountDb), bindingRef: 'DB_ACCOUNTS' },
    ]);
    // Suspended: the account route resolver refuses the non-active account.
    routes.set('user-1', new Error('lookup_destination_revalidation_failed'));

    const revoked = await revokeDeviceSecret();
    expect(revoked.status).toBe(200);
    expect(accountDb.deviceSecrets[0]?.revoked_at).toEqual(expect.any(Number));

    // Reactivated: the secret stays revoked.
    routes.set('user-1', accountDb);
    await expect(introspectDeviceSecret()).resolves.toEqual({
      status: 200,
      body: { active: false },
    });
  });

  async function batchRevoke(clientId: string, secret: string) {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      const vars = c as unknown as { set(key: string, value: unknown): void };
      vars.set('tenantId', 'tenant-a');
      vars.set('tenantMetadataContext', { tenantId: 'tenant-a', coreDb: adapterFor(metadataDb) });
      await next();
    });
    app.post('/revoke/batch', batchRevokeHandler);
    const response = await app.request(
      'https://op.example.com/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
        },
        body: JSON.stringify({
          tokens: [{ token: RAW_DEVICE_SECRET, token_type_hint: 'device_secret' }],
        }),
      },
      { ISSUER_URL: 'https://op.example.com' } as Env
    );
    return {
      status: response.status,
      body: (await response.json()) as { results: Array<{ status: string }> },
    };
  }

  it('batch-revokes only a device secret the caller may revoke', async () => {
    await issueDeviceSecret(accountDb);
    // Another client of the tenant, with no revocation policy over client-a's secrets.
    metadataDb.clients.set('client-b', {
      client_id: 'client-b',
      client_secret_hash: 'hash_secret-b',
    });

    const denied = await batchRevoke('client-b', 'secret-b');
    expect(denied.status).toBe(200);
    expect(denied.body.results).toEqual([expect.objectContaining({ status: 'invalid' })]);
    expect(accountDb.deviceSecrets[0]?.revoked_at).toBeNull();

    const allowed = await batchRevoke('client-a', 'secret-a');
    expect(allowed.body.results).toEqual([expect.objectContaining({ status: 'revoked' })]);
    expect(accountDb.deviceSecrets[0]?.revoked_at).toEqual(expect.any(Number));
  });

  it('refuses a revocation (503) when the device secret route cannot be read', async () => {
    await issueDeviceSecret(accountDb);
    mocks.resolveDeviceSecretRouteHint.mockRejectedValue(new Error('route store unavailable'));
    const revoked = await revokeDeviceSecret();
    expect(revoked.status).toBe(503);
    expect(accountDb.deviceSecrets[0]?.revoked_at).toBeNull();
  });

  it('answers inactive for a device secret whose owner is suspended', async () => {
    await issueDeviceSecret(accountDb);
    accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT, account_lifecycle_state: 'suspended' });
    const { body } = await introspectDeviceSecret();
    expect(body).toEqual({ active: false });
  });

  it('answers inactive for a device secret issued before a consent withdrawal', async () => {
    await issueDeviceSecret(accountDb);
    accountDb.revocations.set('user-1:client-a', { generation: 1, revoked_at: createdAt + 1 });
    const { body } = await introspectDeviceSecret();
    expect(body).toEqual({ active: false });
  });

  it('answers inactive for a secret without a route hint', async () => {
    mocks.resolveDeviceSecretRouteHint.mockResolvedValue(null);
    const { body } = await introspectDeviceSecret();
    expect(body).toEqual({ active: false });
  });

  it('refuses (503, never active) when the route hint cannot be read', async () => {
    mocks.resolveDeviceSecretRouteHint.mockRejectedValue(new Error('route store unavailable'));
    const { status, body } = await introspectDeviceSecret();
    expect(status).toBe(503);
    expect(body.active).toBeUndefined();
  });
});

describe('external subjects and deleted accounts', () => {
  const TRUSTED_ISSUERS = JSON.stringify({ 'https://issuer.example.com': { jwks: { keys: [] } } });

  beforeEach(() => {
    metadataDb.clients.set('client-rs', {
      client_id: 'client-rs',
      client_secret_hash: 'hash_secret-rs',
    });
  });

  /** An access token of an RFC 7523 JWT bearer grant, as issued with its subject issuer. */
  function jwtBearerToken(sub: string, overrides: Record<string, unknown> = {}) {
    return accessTokenPayload({
      sub,
      client_id: 'https://issuer.example.com',
      aud: 'client-rs',
      authrim_subject_issuer: 'https://issuer.example.com',
      ...overrides,
    });
  }

  const asResourceServer = { client_id: 'client-rs', client_secret: 'secret-rs' };

  it('keeps a deleted local subject inactive after its lookup entry is removed', async () => {
    const env = { TRUSTED_JWT_ISSUERS: TRUSTED_ISSUERS };
    const token = jwtBearerToken('user-1');
    // Active account.
    await expect(introspectToken(token, asResourceServer, env)).resolves.toMatchObject({
      body: { active: true },
    });
    // Deleted: the account row and its authentication state say so, the lookup entry remains
    // (the route resolver refuses a non-active account).
    accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT, account_lifecycle_state: 'deleted' });
    authStates.set('user-1', 'deleted');
    routes.set('user-1', new Error('lookup_destination_revalidation_failed'));
    await expect(introspectToken(token, asResourceServer, env)).resolves.toMatchObject({
      body: { active: false },
    });
    // The lookup entry is removed and caches expire: the account has no route at all.
    routes.delete('user-1');
    await expect(introspectToken(token, asResourceServer, env)).resolves.toMatchObject({
      body: { active: false },
    });
  });

  it('reads no account attributes for a subject that was never an account', async () => {
    mocks.requireDedicatedAdminDatabaseAdapter.mockReturnValue({});
    const { body } = await introspectToken(jwtBearerToken('service-7'), asResourceServer);
    expect(body).toMatchObject({ active: true, sub: 'service-7' });
    expect(mocks.applyIntrospectionIdentityMapping).toHaveBeenCalledWith(
      expect.objectContaining({ subjectAccountId: null })
    );
  });

  it('accepts a subject that was never an account', async () => {
    const { body } = await introspectToken(jwtBearerToken('service-7'), asResourceServer, {
      TRUSTED_JWT_ISSUERS: TRUSTED_ISSUERS,
    });
    expect(body).toMatchObject({ active: true, sub: 'service-7' });
  });

  it('refuses (503, never active) when a routeless subject state cannot be read', async () => {
    authStates.set('service-7', new Error('DO unavailable'));
    const { status, body } = await introspectToken(jwtBearerToken('service-7'), asResourceServer, {
      TRUSTED_JWT_ISSUERS: TRUSTED_ISSUERS,
    });
    expect(status).toBe(503);
    expect(body.active).toBeUndefined();
  });

  it('accepts an exchanged token that carries the external subject issuer', async () => {
    // A standard Token Exchange of the JWT bearer token: a new client_id, no original_issuer, but
    // the subject issuer carried on. The issuer need not still be configured as trusted.
    const { body } = await introspectToken(
      accessTokenPayload({
        sub: 'service-7',
        client_id: 'client-exchanger',
        aud: 'client-rs',
        authrim_subject_issuer: 'https://issuer.example.com',
      }),
      asResourceServer
    );
    expect(body).toMatchObject({ active: true, sub: 'service-7' });
  });

  it('keeps a deleted local subject of an exchanged external token inactive', async () => {
    routes.delete('user-1');
    authStates.set('user-1', 'deleted');
    const { body } = await introspectToken(
      accessTokenPayload({
        client_id: 'client-exchanger',
        aud: 'client-rs',
        authrim_subject_issuer: 'https://issuer.example.com',
      }),
      asResourceServer
    );
    expect(body).toEqual({ active: false });
  });

  it.each([
    ['client credentials', { sub: 'client:client-a', client_id: 'client-a' }],
    ['an admin machine', { sub: 'machine:m-1', actor_type: 'machine', actor_id: 'm-1' }],
    [
      'an admin agent delegation',
      { sub: 'admin_user:a-1', grant_id: 'grant-1', actor_mode: 'mode_a' },
    ],
  ])('answers active for a %s token without looking for an account', async (_label, claims) => {
    const { body } = await introspectToken(accessTokenPayload(claims));
    expect(body).toMatchObject({ active: true });
    expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
  });

  it('answers active for an exchanged client credentials token without looking for an account', async () => {
    const { body } = await introspectToken(
      accessTokenPayload({
        sub: 'client:payments',
        client_id: 'client-a',
        authrim_subject_principal: 'client',
      })
    );
    expect(body).toMatchObject({ active: true, sub: 'client:payments' });
    expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
  });

  it('does not take a recorded principal on a user grant', async () => {
    // A user's access token cannot be passed off as a principal's by carrying the claim.
    accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT, account_lifecycle_state: 'suspended' });
    const { body } = await introspectToken(
      accessTokenPayload({ authrim_consent_generation: 0, authrim_subject_principal: 'client' })
    );
    expect(body).toEqual({ active: false });
  });

  it('holds a token whose sub only looks like a principal to an account', async () => {
    // An access token exchanged from a legacy ID token whose mapping issued sub=client:alice:
    // its client is not the one the sub names, so it names a user whose account is not found.
    const { body } = await introspectToken(
      accessTokenPayload({ sub: 'client:alice', client_id: 'client-a' })
    );
    expect(body).toEqual({ active: false });
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      expect.anything(),
      'client:alice'
    );
  });

  it('does not route an elevation token whose target is not a user', async () => {
    const { body } = await introspectToken(
      accessTokenPayload({
        sub: 'artifact-42',
        authrim_elevation: { target_subject_type: 'artifact', grant_id: 'g-1' },
      })
    );
    expect(body).toMatchObject({ active: true });
    expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
  });
});

describe('access token consent generation claim', () => {
  const revokedAt = Date.now() - 60_000;

  it('answers inactive for an access token of an earlier consent generation', async () => {
    accountDb.revocations.set('user-1:client-a', { generation: 2, revoked_at: revokedAt });
    const { body } = await introspectToken(
      accessTokenPayload({
        // Issued after the withdrawal time, but under the generation it withdrew.
        iat: Math.floor(revokedAt / 1000) + 5,
        authrim_consent_generation: 1,
      })
    );
    expect(body).toEqual({ active: false });
  });

  it('answers active for a current-generation token issued within the second of a withdrawal', async () => {
    // Consent was withdrawn and given again in the same second: the token records the new
    // generation, so the iat comparison (legacy tokens only) does not apply.
    accountDb.revocations.set('user-1:client-a', { generation: 2, revoked_at: revokedAt });
    const { body } = await introspectToken(
      accessTokenPayload({ iat: Math.floor(revokedAt / 1000), authrim_consent_generation: 2 })
    );
    expect(body).toMatchObject({ active: true });
  });

  it('checks an exchanged token against the consent of its subject token client', async () => {
    metadataDb.clients.set('client-rs', {
      client_id: 'client-rs',
      client_secret_hash: 'hash_secret-rs',
    });
    accountDb.revocations.set('user-1:client-a', { generation: 2, revoked_at: revokedAt });
    const exchanged = accessTokenPayload({
      client_id: 'client-exchanger',
      aud: 'client-rs',
      iat: nowSeconds(),
      authrim_consent_client_id: 'client-a',
      authrim_consent_generation: 1,
    });
    const { body } = await introspectToken(exchanged, {
      client_id: 'client-rs',
      client_secret: 'secret-rs',
    });
    expect(body).toEqual({ active: false });
  });
});

describe('pairwise subject reference', () => {
  const ROOT_KEY = 'cd'.repeat(32);

  async function sealedFor(clientId: string) {
    const { sealSubjectReference } = await import('@authrim/ar-lib-core');
    return sealSubjectReference(
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY },
      { tenantId: 'tenant-a', clientId },
      'user-1'
    );
  }

  it('reads the account a pairwise sub stands for from the sealed reference', async () => {
    const { body } = await introspectToken(
      accessTokenPayload({ sub: 'pairwise-abc', authrim_subject_ref: await sealedFor('client-a') }),
      {},
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
    );
    expect(body).toMatchObject({ active: true, sub: 'pairwise-abc' });
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      expect.anything(),
      'user-1'
    );
  });

  it("maps a Resource Server's attributes for the account, not for the public sub", async () => {
    mocks.requireDedicatedAdminDatabaseAdapter.mockReturnValue({});
    // The pairwise sub happens to equal another user's id.
    const { body } = await introspectToken(
      accessTokenPayload({ sub: 'user-2', authrim_subject_ref: await sealedFor('client-a') }),
      {},
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
    );
    expect(body).toMatchObject({ active: true, sub: 'user-2' });
    expect(mocks.applyIntrospectionIdentityMapping).toHaveBeenCalledWith(
      expect.objectContaining({ subjectAccountId: 'user-1' })
    );
  });

  it('ignores a reserved-looking public sub when the token records a user grant', async () => {
    accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT, account_lifecycle_state: 'suspended' });
    const { body } = await introspectToken(
      accessTokenPayload({
        sub: 'client:alice',
        authrim_consent_generation: 0,
        authrim_subject_ref: await sealedFor('client-a'),
      }),
      {},
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
    );
    expect(body).toEqual({ active: false });
  });

  it('holds a pairwise sub to the state of the account it stands for', async () => {
    accountDb.accounts.set('user-1', { ...ACTIVE_ACCOUNT, account_lifecycle_state: 'suspended' });
    const { body } = await introspectToken(
      accessTokenPayload({ sub: 'pairwise-abc', authrim_subject_ref: await sealedFor('client-a') }),
      {},
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
    );
    expect(body).toEqual({ active: false });
  });

  it.each(['invalid', 'unavailable'])(
    'resolves a reference to a user whose id is %s like any other',
    async (userId) => {
      const { sealSubjectReference } = await import('@authrim/ar-lib-core');
      routes.set(userId, accountDb);
      accountDb.accounts.set(userId, { ...ACTIVE_ACCOUNT });
      const reference = await sealSubjectReference(
        { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY },
        { tenantId: 'tenant-a', clientId: 'client-a' },
        userId
      );
      const { status, body } = await introspectToken(
        accessTokenPayload({ sub: 'pairwise-abc', authrim_subject_ref: reference }),
        {},
        { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ active: true });
    }
  );

  it('answers inactive for a reference sealed for another client', async () => {
    const { body } = await introspectToken(
      accessTokenPayload({ sub: 'pairwise-abc', authrim_subject_ref: await sealedFor('client-b') }),
      {},
      { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
    );
    expect(body).toEqual({ active: false });
  });

  it('refuses (503, never active) when the reference key is unavailable', async () => {
    const { status, body } = await introspectToken(
      accessTokenPayload({ sub: 'pairwise-abc', authrim_subject_ref: await sealedFor('client-a') })
    );
    expect(status).toBe(503);
    expect(body.active).toBeUndefined();
  });
});
