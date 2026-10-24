/**
 * Which database a logout revokes Native SSO device secrets in, for both allocation scopes, on real
 * SQLite databases built from the migrations: the tenant metadata database (`tenant_core/default`)
 * and the account's own Core database, where ar-token issues and validates device secrets.
 *
 * The three logouts (RP-initiated `/logout`, back-channel `/logout/backchannel` and Direct Auth
 * `/api/v1/auth/direct/logout`) used to revoke in the metadata database. A routed user's device
 * secrets are not there, so they stayed usable after logout: ar-token's exchange
 * (DeviceSecretRepository.validateAndUse on the account's Core database) still accepted them.
 * They also matched secrets by the OP session key, while ar-token records a secret under the ID
 * token's RP-specific `sid` (deriveOidcSid of the session, the client and the issuer).
 *
 * Real: the revocation (revokeDeviceSecretsForLogoutScope), the device secret repository and the
 * context helpers. Fakes: Lookup (the account-id route to the account database), the session
 * store, ID token / logout token verification and the logout notifications.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditLog,
  deriveOidcSid,
  DeviceInstallationRepository,
  DeviceSecretRepository,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { adapterOver, count, migrate, type RealSqlAdapter } from './helpers/real-sql';

const TENANT = 'default';
const USER = 'user_routed';
const OTHER_USER = 'user_other';
const SESSION = 'g1:apac:1:session_logout';
const OTHER_DEVICE_SESSION = 'g1:apac:1:session_other_device';
const OTHER_USER_SESSION = 'g1:apac:1:session_other_user';
/** The issuer the ID tokens (and so their sids) were issued under: the request issuer. */
const ISSUER = 'https://auth.example.com';

const world = vi.hoisted(() => ({
  /** The account databases Lookup routes each user to. */
  accountCores: new Map<string, unknown>(),
  /** A user whose account route cannot be read now (Lookup is unavailable). */
  unavailableUser: undefined as string | undefined,
  /** The SessionStore's live sessions: session id -> user id. */
  sessions: new Map<string, string>(),
  /** The claims the next logout token verifies to. */
  logoutClaims: undefined as undefined | Record<string, unknown>,
  /** The next session invalidation fails (after the device secrets were revoked). */
  failInvalidation: false,
  /** What the next id_token_hint validates to. */
  idTokenHint: undefined as undefined | { userId: string; clientId: string; sid: string },
}));

vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jose')>()),
  importJWK: vi.fn(async () => ({})),
  jwtVerify: vi.fn(async () => ({ payload: world.logoutClaims, protectedHeader: {} })),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const sessionStore = {
    getSessionRpc: vi.fn(async (id: string) =>
      world.sessions.has(id) ? { id, userId: world.sessions.get(id), data: {} } : null
    ),
    invalidateSessionRpc: vi.fn(async (id: string) => {
      if (world.failInvalidation) {
        world.failInvalidation = false;
        throw new Error('Network connection lost.');
      }
      return world.sessions.delete(id);
    }),
  };
  return {
    ...actual,
    // Lookup: the account-id route, to the account's Core database where the account exists.
    resolveAccountCoreDataContext: vi.fn(
      async (_env: unknown, input: { tenantId: string; accountId: string }) => {
        const userId = input.accountId.replace(/^account:/u, '');
        if (userId === world.unavailableUser) throw new Error('lookup_directory_unavailable');
        const coreDb = world.accountCores.get(userId);
        if (!coreDb) throw new Error('account_data_route_not_found');
        return {
          tenantId: input.tenantId,
          accountId: `account:${userId}`,
          legacyUserId: userId,
          membership: {},
          coreDb,
          coreBindingRef: 'TDB_USERS_1',
          coreResidencyPartition: 'default',
          accountRouteGeneration: 1,
        };
      }
    ),
    validateIdTokenHint: vi.fn(async () =>
      world.idTokenHint
        ? {
            valid: true,
            clientId: world.idTokenHint.clientId,
            sid: world.idTokenHint.sid,
            payload: { sub: world.idTokenHint.userId },
          }
        : { valid: false, error: 'missing' }
    ),
    resolvePresentedTokenAccount: vi.fn(async () =>
      world.idTokenHint ? { ok: true, userId: world.idTokenHint.userId } : { ok: false }
    ),
    isShardedSessionId: vi.fn(() => true),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: sessionStore })),
    revokeGuestResumeForSession: vi.fn(async () => undefined),
    isNativeSSOEnabled: vi.fn(async () => true),
    verifyClientSecretHash: vi.fn(async () => true),
    resolveLogoutTargetsFromSessionClientStore: vi.fn(async () => null),
    resolveLogoutIssuerWithRetry: vi.fn(async () => ISSUER),
    purgeEndedSessionsFromSessionClientStore: vi.fn(async () => undefined),
    reportLogoutNotSent: vi.fn(async () => ({ sessions: 0, clients: 0 })),
    reportIncompleteLogouts: vi.fn(async () => undefined),
    reportLogoutTargetsUnavailable: vi.fn(async () => undefined),
    sendBackchannelLogoutFanout: vi.fn(async () => null),
    sendLogoutWebhookFanout: vi.fn(async () => null),
    publishEvent: vi.fn(async () => undefined),
    createAuditLog: vi.fn(async () => undefined),
  };
});

import { directLogoutHandler } from '../direct-auth';
import { backChannelLogoutHandler, frontChannelLogoutHandler } from '../logout';

type Databases = { metadata: RealSqlAdapter; accountCore: RealSqlAdapter };
type Scope = 'shared_pool' | 'tenant_exclusive' | 'unrouted';

function app(scope: Scope, databases: Databases) {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    const context = c as unknown as { set(key: string, value: unknown): void };
    context.set('tenantId', TENANT);
    // What request-context sets: the metadata database and the route the registry resolved it by
    // (a single-database setup has none).
    context.set('tenantMetadataContext', {
      tenantId: TENANT,
      coreDb: databases.metadata,
      ...(scope === 'unrouted'
        ? {}
        : {
            route: { allocationScope: scope, bindingRef: 'TDB_TENANT_CORE', ownerTenantId: null },
          }),
    });
    await next();
  });
  hono.post('/api/v1/auth/direct/logout', directLogoutHandler);
  hono.post('/logout', frontChannelLogoutHandler);
  hono.post('/logout/backchannel', backChannelLogoutHandler);
  return hono;
}

function env(): Env {
  const keyManager = { getAllPublicKeysRpc: async () => [{ kty: 'RSA', kid: 'k1', e: 'AQAB' }] };
  return {
    ISSUER_URL: ISSUER,
    KEY_MANAGER: { idFromName: () => 'key-manager', get: () => keyManager },
  } as unknown as Env;
}

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

function seedUser(adapter: RealSqlAdapter, userId: string): void {
  // The user row device secrets reference.
  adapter.raw
    .prepare(
      `INSERT INTO users (id, tenant_id, email, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`
    )
    .run(userId, TENANT, `${userId}@example.com`);
}

/**
 * Issue a device secret the way ar-token does at the token endpoint: recorded under the ID token's
 * RP-specific sid, or (`legacy`) under the OP session key as before that derivation.
 */
async function issueDeviceSecret(
  adapter: DatabaseAdapter,
  input: {
    userId: string;
    sessionId: string;
    clientId: string;
    trustGroupId?: string;
    legacy?: boolean;
  }
): Promise<string> {
  const result = await new DeviceSecretRepository(adapter, TENANT).createSecret({
    user_id: input.userId,
    session_id: input.legacy
      ? input.sessionId
      : await deriveOidcSid(input.sessionId, input.clientId, ISSUER),
    client_id: input.clientId,
    ...(input.trustGroupId ? { trust_group_id: input.trustGroupId } : {}),
  });
  if (!('secret' in result)) throw new Error('device secret not issued');
  return result.secret;
}

/** What ar-token's Native SSO exchange decides about a presented device secret. */
async function exchangeOutcome(adapter: DatabaseAdapter, secret: string): Promise<string> {
  const result = await new DeviceSecretRepository(adapter, TENANT).validateAndUse(secret, {
    tenantId: TENANT,
  });
  return result.ok ? 'accepted' : result.reason;
}

function insertClient(metadata: RealSqlAdapter, clientId: string): void {
  metadata.raw
    .prepare(
      `INSERT INTO oauth_clients (client_id, tenant_id, client_name, client_secret_hash,
                                  redirect_uris, grant_types, response_types, created_at,
                                  updated_at)
       VALUES (?, ?, ?, 'secret-hash', '[]', '[]', '[]', 1, 1)`
    )
    .run(clientId, TENANT, clientId);
}

const scopes = ['shared_pool', 'tenant_exclusive', 'unrouted'] as const;

describe.each(scopes)('Native SSO device secrets at logout, %s tenant (real SQL)', (scope) => {
  let databases: Databases;
  /** Where ar-token keeps this tenant's device secrets. */
  let deviceSecretDb: RealSqlAdapter;
  let secrets: {
    ended: string;
    endedLegacy: string;
    otherDevice: string;
    otherUser: string;
  };

  beforeEach(async () => {
    // D1 binds at most 100 values in one statement.
    databases = {
      metadata: adapterOver(migrate('core'), { maxBoundParameters: 100 }),
      accountCore: adapterOver(migrate('core'), { maxBoundParameters: 100 }),
    };
    deviceSecretDb = scope === 'unrouted' ? databases.metadata : databases.accountCore;
    world.accountCores.clear();
    if (scope !== 'unrouted') {
      world.accountCores.set(USER, databases.accountCore);
      world.accountCores.set(OTHER_USER, databases.accountCore);
    }
    world.unavailableUser = undefined;
    world.sessions = new Map([
      [SESSION, USER],
      [OTHER_DEVICE_SESSION, USER],
      [OTHER_USER_SESSION, OTHER_USER],
    ]);
    world.logoutClaims = undefined;
    world.failInvalidation = false;
    world.idTokenHint = undefined;
    vi.mocked(createAuditLog).mockClear();
    seedUser(deviceSecretDb, USER);
    seedUser(deviceSecretDb, OTHER_USER);
    secrets = {
      ended: await issueDeviceSecret(deviceSecretDb, {
        userId: USER,
        sessionId: SESSION,
        clientId: 'client-a',
      }),
      endedLegacy: await issueDeviceSecret(deviceSecretDb, {
        userId: USER,
        sessionId: SESSION,
        clientId: 'client-a',
        legacy: true,
      }),
      otherDevice: await issueDeviceSecret(deviceSecretDb, {
        userId: USER,
        sessionId: OTHER_DEVICE_SESSION,
        clientId: 'client-b',
      }),
      otherUser: await issueDeviceSecret(deviceSecretDb, {
        userId: OTHER_USER,
        sessionId: OTHER_USER_SESSION,
        clientId: 'client-a',
      }),
    };
  });

  async function expectOnlyTheEndedSessionsSecretsRevoked(): Promise<void> {
    expect(await exchangeOutcome(deviceSecretDb, secrets.ended)).toBe('revoked');
    expect(await exchangeOutcome(deviceSecretDb, secrets.endedLegacy)).toBe('revoked');
    expect(await exchangeOutcome(deviceSecretDb, secrets.otherDevice)).toBe('accepted');
    expect(await exchangeOutcome(deviceSecretDb, secrets.otherUser)).toBe('accepted');
    if (scope !== 'unrouted') {
      // Nothing about the user is written to the metadata database.
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM device_secrets')).toBe(0);
    }
  }

  async function directLogout(): Promise<Response> {
    return app(scope, databases).request(
      '/api/v1/auth/direct/logout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `authrim_session=${SESSION}` },
        body: JSON.stringify({ client_id: 'client-a' }),
      },
      env(),
      executionCtx
    );
  }

  async function rpInitiatedLogout(
    form: Record<string, string> = {},
    browserSessionId: string | null = SESSION
  ): Promise<Response> {
    return app(scope, databases).request(
      '/logout',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: `${browserSessionId ? `authrim_session=${browserSessionId}; ` : ''}authrim_logout_confirmation=confirm-1`,
        },
        body: new URLSearchParams({ confirmation_token: 'confirm-1', ...form }).toString(),
      },
      env(),
      executionCtx
    );
  }

  async function backChannelLogout(): Promise<Response> {
    if (!count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM oauth_clients')) {
      insertClient(databases.metadata, 'client-a');
    }
    world.logoutClaims = {
      sub: USER,
      sid: SESSION,
      jti: 'logout-jti-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    };
    return app(scope, databases).request(
      '/logout/backchannel',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa('client-a:secret')}`,
        },
        body: new URLSearchParams({ logout_token: 'header.payload.signature' }).toString(),
      },
      env(),
      executionCtx
    );
  }

  it('Direct Auth logout revokes the ended session’s device secrets where ar-token validates them', async () => {
    const response = await directLogout();

    expect(response.status).toBe(200);
    expect(world.sessions.has(SESSION)).toBe(false);
    await expectOnlyTheEndedSessionsSecretsRevoked();
  });

  it('RP-initiated logout revokes the ended session’s device secrets where ar-token validates them', async () => {
    const response = await rpInitiatedLogout();

    expect(response.status).toBe(200);
    expect(world.sessions.has(SESSION)).toBe(false);
    await expectOnlyTheEndedSessionsSecretsRevoked();
  });

  it('back-channel logout revokes the ended session’s device secrets where ar-token validates them', async () => {
    const response = await backChannelLogout();

    expect(response.status).toBe(200);
    expect(world.sessions.has(SESSION)).toBe(false);
    await expectOnlyTheEndedSessionsSecretsRevoked();
  });

  it.each([
    ['RP-initiated', () => rpInitiatedLogout()],
    ['back-channel', () => backChannelLogout()],
    ['Direct Auth', () => directLogout()],
    [
      'RP-initiated with only an ID token hint',
      () => {
        world.idTokenHint = { userId: USER, clientId: 'client-a', sid: SESSION };
        return rpInitiatedLogout({ id_token_hint: 'hint' }, null);
      },
    ],
  ] as const)(
    '%s logout remains retryable when session invalidation fails',
    async (_label, logout) => {
      world.failInvalidation = true;

      const failed = await logout();

      expect(failed.status).toBe(503);
      expect(world.sessions.get(SESSION)).toBe(USER);
      expect(failed.headers.get('set-cookie')).toBeNull();
      await expectOnlyTheEndedSessionsSecretsRevoked();

      const retried = await logout();

      expect(retried.status).toBe(200);
      expect(world.sessions.has(SESSION)).toBe(false);
      await expectOnlyTheEndedSessionsSecretsRevoked();
    }
  );

  it.each(['local', 'group', 'global'] as const)(
    'records the %s device secret revocation scope in the logout audit',
    async (logoutScope) => {
      const sameAppOtherDevice = await issueDeviceSecret(deviceSecretDb, {
        userId: USER,
        sessionId: OTHER_DEVICE_SESSION,
        clientId: 'client-a',
      });

      const response = await rpInitiatedLogout({ logout_scope: logoutScope });

      expect(response.status).toBe(200);
      const audit = vi
        .mocked(createAuditLog)
        .mock.calls.find(
          ([, entry]) => entry.action === 'user.logout' && entry.resourceId === SESSION
        )?.[1];
      expect(audit).toBeDefined();
      expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({
        logout_scope: logoutScope,
        device_secret_revocation: {
          scope: logoutScope,
          revoked_device_secrets: logoutScope === 'local' ? 2 : logoutScope === 'group' ? 3 : 4,
        },
      });
      expect(await exchangeOutcome(deviceSecretDb, sameAppOtherDevice)).toBe(
        logoutScope === 'local' ? 'accepted' : 'revoked'
      );
      expect(await exchangeOutcome(deviceSecretDb, secrets.otherDevice)).toBe(
        logoutScope === 'global' ? 'revoked' : 'accepted'
      );
      expect(await exchangeOutcome(deviceSecretDb, secrets.otherUser)).toBe('accepted');
    }
  );

  it('records the default group scope in the back-channel logout audit', async () => {
    const response = await backChannelLogout();

    expect(response.status).toBe(200);
    const audit = vi
      .mocked(createAuditLog)
      .mock.calls.find(
        ([, entry]) => entry.action === 'user.logout' && entry.resourceId === SESSION
      )?.[1];
    expect(audit).toBeDefined();
    expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({
      logout_scope: 'group',
      device_secret_revocation: { scope: 'group', revoked_device_secrets: 2 },
    });
  });

  it('narrows to the id_token_hint’s client only the session the hint is for', async () => {
    // The browser's session is the user's; the hint is another user's, from client-b.
    const hintedSecret = await issueDeviceSecret(deviceSecretDb, {
      userId: OTHER_USER,
      sessionId: OTHER_USER_SESSION,
      clientId: 'client-b',
    });
    world.idTokenHint = { userId: OTHER_USER, clientId: 'client-b', sid: OTHER_USER_SESSION };

    const response = await rpInitiatedLogout({ id_token_hint: 'hint', logout_scope: 'local' });

    expect(response.status).toBe(200);
    expect(world.sessions.has(SESSION)).toBe(false);
    expect(world.sessions.has(OTHER_USER_SESSION)).toBe(false);
    // The browser session's secrets are not limited to client-b: both of its client-a ones end.
    expect(await exchangeOutcome(deviceSecretDb, secrets.ended)).toBe('revoked');
    expect(await exchangeOutcome(deviceSecretDb, secrets.endedLegacy)).toBe('revoked');
    // The hinted session: only its client-b secret.
    expect(await exchangeOutcome(deviceSecretDb, hintedSecret)).toBe('revoked');
    expect(await exchangeOutcome(deviceSecretDb, secrets.otherUser)).toBe('accepted');
    expect(await exchangeOutcome(deviceSecretDb, secrets.otherDevice)).toBe('accepted');
  });

  it('revokes every app’s secrets of a session that signed several apps in', async () => {
    const secondApp = await issueDeviceSecret(deviceSecretDb, {
      userId: USER,
      sessionId: SESSION,
      clientId: 'client-c',
    });

    const response = await rpInitiatedLogout();

    expect(response.status).toBe(200);
    expect(await exchangeOutcome(deviceSecretDb, secondApp)).toBe('revoked');
    await expectOnlyTheEndedSessionsSecretsRevoked();
  });

  it('revokes an app’s secrets of the session in its trust group and in none alike', async () => {
    // The app joined trust group tg-2 after the session's first secret (in none) was issued.
    const grouped = await issueDeviceSecret(deviceSecretDb, {
      userId: USER,
      sessionId: SESSION,
      clientId: 'client-a',
      trustGroupId: 'tg-2',
    });

    const response = await rpInitiatedLogout();

    expect(response.status).toBe(200);
    expect(await exchangeOutcome(deviceSecretDb, grouped)).toBe('revoked');
    await expectOnlyTheEndedSessionsSecretsRevoked();
  });

  it('logs out of a receiving app by revoking the secret its Native SSO installation came from', async () => {
    // client-a's secret (trust group tg-9); client-b signed in with it through Native SSO, which
    // leaves client-b an installation of its own carrying client-a's sid, and no secret.
    const sid = await deriveOidcSid(SESSION, 'client-a', ISSUER);
    const repository = new DeviceSecretRepository(deviceSecretDb, TENANT);
    const issued = await repository.createSecret({
      user_id: USER,
      session_id: sid,
      client_id: 'client-a',
      trust_group_id: 'tg-9',
    });
    if (!('secret' in issued)) throw new Error('device secret not issued');
    await new DeviceInstallationRepository(deviceSecretDb, TENANT).ensureForNativeSSOTokenExchange({
      sourceDeviceSecret: issued.entity,
      targetClientId: 'client-b',
      targetTrustGroupId: 'tg-9',
      sourceClientId: 'client-a',
      sameClient: false,
      lastSeenAt: Date.now(),
    });

    const response = await app(scope, databases).request(
      '/api/v1/auth/direct/logout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `authrim_session=${SESSION}` },
        body: JSON.stringify({ client_id: 'client-b', logout_scope: 'group' }),
      },
      env(),
      executionCtx
    );

    expect(response.status).toBe(200);
    expect(await exchangeOutcome(deviceSecretDb, issued.secret)).toBe('revoked');
    expect(await exchangeOutcome(deviceSecretDb, secrets.otherUser)).toBe('accepted');
    expect(await exchangeOutcome(deviceSecretDb, secrets.otherDevice)).toBe('accepted');
  });

  it('logs out a session that holds many historical apps without exceeding the parameter limit', async () => {
    const repository = new DeviceSecretRepository(deviceSecretDb, TENANT);
    for (let index = 0; index < 120; index += 1) {
      const issued = await repository.createSecret(
        {
          user_id: USER,
          session_id: await deriveOidcSid(SESSION, `client-hist-${index}`, ISSUER),
          client_id: `client-hist-${index}`,
        },
        { maxSecretsPerUser: 1000 }
      );
      if (!('secret' in issued)) throw new Error('device secret not issued');
      await repository.revoke(issued.entity.id, 'rotation', TENANT);
    }

    for (const logout of [rpInitiatedLogout, directLogout]) {
      world.sessions.set(SESSION, USER);
      const response = await logout();
      expect(response.status).toBe(200);
    }
    await expectOnlyTheEndedSessionsSecretsRevoked();
  });

  it('logs out a user with a long history of revoked device secrets', async () => {
    const repository = new DeviceSecretRepository(deviceSecretDb, TENANT);
    for (let index = 0; index < 120; index += 1) {
      const issued = await repository.createSecret(
        {
          user_id: USER,
          session_id: `g1:apac:1:session_old_${index}`,
          client_id: `client-old-${index}`,
        },
        { maxSecretsPerUser: 1000 }
      );
      if (!('secret' in issued)) throw new Error('device secret not issued');
      await repository.revoke(issued.entity.id, 'rotation', TENANT);
    }

    const response = await rpInitiatedLogout();

    expect(response.status).toBe(200);
    await expectOnlyTheEndedSessionsSecretsRevoked();
  });

  it('revokes the same group again when a logout is retried after the session survived', async () => {
    // The ended session's app is in trust group tg-1; another device of the same app is in none.
    const grouped = await issueDeviceSecret(deviceSecretDb, {
      userId: USER,
      sessionId: SESSION,
      clientId: 'client-g',
      trustGroupId: 'tg-1',
    });
    const ungrouped = await issueDeviceSecret(deviceSecretDb, {
      userId: USER,
      sessionId: OTHER_DEVICE_SESSION,
      clientId: 'client-g',
    });
    const logout = () =>
      app(scope, databases).request(
        '/api/v1/auth/direct/logout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: `authrim_session=${SESSION}` },
          body: JSON.stringify({ client_id: 'client-g', logout_scope: 'group' }),
        },
        env(),
        executionCtx
      );
    world.failInvalidation = true;

    expect((await logout()).status).toBe(503);
    expect(world.sessions.get(SESSION)).toBe(USER);
    expect(await exchangeOutcome(deviceSecretDb, grouped)).toBe('revoked');
    expect(await exchangeOutcome(deviceSecretDb, ungrouped)).toBe('accepted');

    expect((await logout()).status).toBe(200);
    expect(world.sessions.has(SESSION)).toBe(false);
    // The retry took trust group tg-1 again, not every client-g device of the user.
    expect(await exchangeOutcome(deviceSecretDb, ungrouped)).toBe('accepted');
  });

  it('revokes nothing for a session that has already ended', async () => {
    world.sessions.delete(SESSION);
    world.idTokenHint = { userId: USER, clientId: 'client-a', sid: SESSION };

    const response = await rpInitiatedLogout({ id_token_hint: 'old-hint' });

    expect(response.status).toBe(200);
    expect(await exchangeOutcome(deviceSecretDb, secrets.ended)).toBe('accepted');
    expect(await exchangeOutcome(deviceSecretDb, secrets.otherDevice)).toBe('accepted');
  });

  if (scope !== 'unrouted') {
    it.each([
      ['RP-initiated', () => rpInitiatedLogout()],
      ['back-channel', () => backChannelLogout()],
      ['Direct Auth', () => directLogout()],
    ] as const)(
      '%s logout keeps the session when the account database cannot be reached',
      async (_label, logout) => {
        world.unavailableUser = USER;

        const response = await logout();

        expect(response.status).toBe(503);
        // Kept for a retry, which can still find the user's database through it.
        expect(world.sessions.get(SESSION)).toBe(USER);
        expect(await exchangeOutcome(deviceSecretDb, secrets.ended)).toBe('accepted');

        world.unavailableUser = undefined;
        expect((await logout()).status).toBe(200);
        await expectOnlyTheEndedSessionsSecretsRevoked();
      }
    );

    it('ends the session of a user without an account route, who has no device secret', async () => {
      world.accountCores.delete(USER);

      const response = await directLogout();

      expect(response.status).toBe(200);
      expect(world.sessions.has(SESSION)).toBe(false);
    });
  }
});
