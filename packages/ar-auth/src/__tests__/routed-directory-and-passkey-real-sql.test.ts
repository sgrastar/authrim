/**
 * Where the directory password sign-in (`/api/auth/directory-password/*`) and a signed-in user's
 * Direct Auth passkey registration start (`/api/v1/auth/direct/passkey/register/start`) read and
 * write an account, for both allocation scopes, on real SQLite databases built from the
 * migrations: the tenant metadata database and the account's own Core and PII databases.
 *
 * Where accounts are routed, the account, its passkeys and its directory identity link are in the
 * account's databases (ar-management links a directory identity there and publishes its Lookup
 * route); the directory's tenant records (pending users, migration campaigns and transactions)
 * are in the metadata database. These endpoints never resolved the account: a correct password
 * then failed with account_data_context_required, as did the passkey registration start.
 *
 * Real: the context helpers, the canonical user store, the passkey repository and the directory
 * auth records. Fakes: Lookup (identifier and account-id routes in a map, attaching the account
 * context the way the real resolvers do), the directory connector (its HTTP endpoint), the
 * challenge and session stores, WebAuthn's cryptographic verification.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalRuntimeUserStore,
  createDirectoryAuthMigrationTransaction,
  directoryIdentityLookupSubject,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { adapterOver, count, migrate, type RealSqlAdapter } from './helpers/real-sql';

const TENANT = 'default';
const ORIGIN = 'https://login.example.com';
const USER = 'user_routed';
const EMAIL = 'routed@example.com';
const CONNECTOR = 'wwcon_8K4M2Q9F7D3H6P1X';
const DIRECTORY_SUBJECT = 'uid=routed,ou=People,dc=example,dc=com';
const SESSION = 'g1:apac:1:session_signed_in';
const PII_ENCRYPTION_KEY = 'a'.repeat(64);

const world = vi.hoisted(() => ({
  accountCore: undefined as unknown,
  accountPii: undefined as unknown,
  /** Lookup's identifier routes: identifier -> legacy user id. */
  identifierRoutes: new Map<string, string>(),
  storedChallenges: [] as Array<Record<string, unknown>>,
  challenge: undefined as undefined | Record<string, unknown>,
  createdSessions: [] as Array<{ id: string; userId: string }>,
  publishedDirectoryRoutes: [] as Array<Record<string, unknown>>,
  publishedPasskeyRoutes: [] as Array<Record<string, unknown>>,
  /** The error the Control Plane fails the next directory route publications with. */
  failDirectoryRoutePublication: undefined as string | undefined,
}));

function routeKey(identifier: string | { issuer: string; subject: string }): string {
  return typeof identifier === 'string' ? identifier : `${identifier.issuer}|${identifier.subject}`;
}

async function attachAccount(c: { set(key: string, value: unknown): void }, userId: string) {
  // Lookup routes only accounts that exist at their destination.
  const exists = await (world.accountCore as DatabaseAdapter).queryOne(
    'SELECT 1 AS found FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
    [TENANT, userId]
  );
  if (!exists) throw new Error('account_data_route_not_found');
  const context = {
    tenantId: TENANT,
    accountId: `account:${userId}`,
    legacyUserId: userId,
    membership: { routeProjection: {} },
    coreDb: world.accountCore,
    piiDb: world.accountPii,
    coreBindingRef: 'TDB_USERS_1',
    piiBindingRef: 'TDB_PII_1',
    coreResidencyPartition: 'default',
    piiResidencyPartition: 'default',
    accountRouteGeneration: 1,
    userCacheScope: { storageProfileId: 'test', sourceGeneration: 'test', schemaVersion: 'test' },
    piiCacheMode: 'disabled',
  };
  c.set('accountDataContext', context);
  return context;
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const challengeStore = {
    storeChallengeRpc: vi.fn(async (challenge: Record<string, unknown>) => {
      world.storedChallenges.push(challenge);
    }),
    consumeChallengeRpc: vi.fn(async () => {
      if (!world.challenge) throw new Error('challenge_not_found');
      const challenge = world.challenge;
      world.challenge = undefined;
      return challenge;
    }),
    getChallengeRpc: vi.fn(async () => world.challenge ?? null),
  };
  return {
    ...actual,
    getChallengeStoreByUserId: vi.fn(async () => challengeStore),
    getChallengeStoreByChallengeId: vi.fn(async () => challengeStore),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        getSessionRpc: vi.fn(async (id: string) =>
          id === SESSION ? { id, userId: USER, expiresAt: Date.now() + 60_000, data: {} } : null
        ),
      },
    })),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: {
        createSessionRpc: vi.fn(async (id: string, userId: string) => {
          world.createdSessions.push({ id, userId });
          return { id };
        }),
      },
      sessionId: 'g1:apac:1:session_directory',
    })),
    getTenantSettingsDocument: vi.fn(async () => null),
    resolvePostLoginRedirectUrl: vi.fn(async () => ({ redirectUrl: '/account' })),
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { set(key: string, value: unknown): void }, accountId: string) =>
        attachAccount(c, accountId.replace(/^account:/u, ''))
    ),
    resolveAccountDataContextByIdentifierFromHono: vi.fn(
      async (
        c: { set(key: string, value: unknown): void },
        input: { identifier: string | { issuer: string; subject: string } }
      ) => {
        const userId = world.identifierRoutes.get(routeKey(input.identifier));
        if (!userId) throw new Error('account_data_route_not_found');
        return attachAccount(c, userId);
      }
    ),
    ensureAccountAuthenticationState: vi.fn(
      async (_env: unknown, _tenant: string, _user: string, loader: () => Promise<unknown>) =>
        loader()
    ),
    publishEvent: vi.fn(async () => undefined),
    createAuditLog: vi.fn(async () => undefined),
    createAuditLogFromContext: vi.fn(async () => undefined),
  };
});

vi.mock('@simplewebauthn/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simplewebauthn/server')>()),
  verifyRegistrationResponse: vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'bWlncmF0aW9uLWNyZWRlbnRpYWw',
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
      },
      aaguid: '00000000-0000-0000-0000-000000000000',
    },
  })),
}));

vi.mock('../human-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../human-verification')>()),
  verifyHumanVerificationForAction: vi.fn(async () => null),
}));

vi.mock('../session-ttl', () => ({
  resolveSessionTtl: vi.fn(async () => ({ seconds: 3600, milliseconds: 3_600_000 })),
}));

vi.mock('../account-provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../account-provisioning')>()),
  publishTenantD1PasskeyRoute: vi.fn(async (_c: unknown, input: Record<string, unknown>) => {
    world.publishedPasskeyRoutes.push(input);
    return 201;
  }),
}));

import { directPasskeyRegisterStartHandler } from '../direct-auth';
import {
  createDirectoryPasswordLoginHandler,
  directoryMigrationPasskeyOptionsHandler,
  directoryMigrationPasskeyVerifyHandler,
} from '../directory-password-login';

type Databases = {
  metadata: RealSqlAdapter;
  accountCore: RealSqlAdapter;
  accountPii: RealSqlAdapter;
};

/** A directory that accepts the password and answers with the subject and its address. */
function directoryFetcher(email: string | null) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return Response.json({
      request_id: body.request_id,
      tenant_id: TENANT,
      connector_id: CONNECTOR,
      result: 'success',
      subject: { directory_id: DIRECTORY_SUBJECT, username: 'routed' },
      attributes: email ? { mail: [email], displayName: ['Routed User'] } : {},
      directory_status: 'ok',
    });
  });
}

function app(
  allocationScope: 'shared_pool' | 'tenant_exclusive',
  databases: Databases,
  route: (app: Hono<{ Bindings: Env }>) => void
) {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    const context = c as unknown as { set(key: string, value: unknown): void };
    context.set('tenantId', TENANT);
    // What request-context sets: the metadata database and the route the registry resolved it by.
    context.set('tenantMetadataContext', {
      tenantId: TENANT,
      coreDb: databases.metadata,
      route: { allocationScope, bindingRef: 'TDB_TENANT_CORE', ownerTenantId: null },
    });
    await next();
  });
  route(hono);
  return hono;
}

function env(): Env {
  const settings: Record<string, unknown> = {
    [`settings:tenant:${TENANT}:directory-connectors`]: {
      enabled: true,
      default_connector_id: 'campus',
      auto_provision: false,
      connectors: [
        {
          id: 'campus',
          endpoint_url: 'https://wordwarden.example.com',
          auth_mode: 'hmac',
          connector_id: CONNECTOR,
          key_id: 'kid-active',
          secret_ref: 'env:WORDWARDEN_SECRET',
          timeouts: { request_ms: 1000 },
          attribute_names: ['mail', 'displayName'],
        },
      ],
    },
  };
  const kv = {
    get: async (key: string) => (key in settings ? JSON.stringify(settings[key]) : null),
  };
  const rateLimiter = {
    incrementRpc: async () => ({ allowed: true }),
    resetRpc: async () => true,
  };
  return {
    ALLOWED_ORIGINS: ORIGIN,
    ISSUER_URL: 'https://auth.example.com',
    PII_ENCRYPTION_KEY,
    WORDWARDEN_SECRET: 'active-secret',
    SETTINGS: kv,
    AUTHRIM_CONFIG: kv,
    RATE_LIMITER: { idFromName: (name: string) => ({ name }), get: () => rateLimiter },
    ACCOUNT_PROVISIONER: {
      publishAuthDirectoryRoute: async (input: { operationId: string; accountId: string }) => {
        if (world.failDirectoryRoutePublication) {
          throw new Error(world.failDirectoryRoutePublication);
        }
        world.publishedDirectoryRoutes.push(input);
        return { status: 201, operationId: input.operationId, accountId: input.accountId };
      },
    },
  } as unknown as Env;
}

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

async function seedAccount(databases: Databases): Promise<void> {
  // Written the way provisioning writes an account at its destination.
  await new CanonicalRuntimeUserStore({
    coreAdapter: databases.accountCore,
    piiAdapter: databases.accountPii,
    tenantId: TENANT,
  }).syncUser({
    userId: USER,
    email: EMAIL,
    name: 'Routed User',
    active: true,
    emailVerified: true,
    userType: 'end_user',
    sourceRef: 'test',
    piiFields: { email: true, name: true },
    sensitiveValues: { email: EMAIL, name: 'Routed User' },
  });
  // Published to Lookup, as the provisioner leaves an account it created.
  databases.accountCore.raw
    .prepare(
      `UPDATE identity_accounts SET directory_publication_state = 'active'
        WHERE tenant_id = ? AND legacy_user_id = ?`
    )
    .run(TENANT, USER);
  world.identifierRoutes.set(EMAIL, USER);
}

function insertPasskey(db: RealSqlAdapter, id: string, credentialId: string): void {
  db.raw
    .prepare(
      `INSERT INTO passkeys (id, tenant_id, user_id, credential_id, rp_id, public_key, counter,
                             created_at)
       VALUES (?, ?, ?, ?, 'login.example.com', 'cHVibGlj', 0, 1)`
    )
    .run(id, TENANT, USER, credentialId);
}

function insertDirectoryLink(db: RealSqlAdapter, userId: string): void {
  db.raw
    .prepare(
      `INSERT INTO directory_identity_links (id, tenant_id, connector_id, directory_subject,
                                             user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1)`
    )
    .run(`dirlink_${userId}`, TENANT, CONNECTOR, DIRECTORY_SUBJECT, userId);
}

async function migrationTransaction(databases: Databases): Promise<{ id: string; token: string }> {
  const token = 'migration-token';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${TENANT}:${token}`)
  );
  const tokenHash = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
  const transaction = await createDirectoryAuthMigrationTransaction(databases.metadata, {
    tenantId: TENANT,
    campaignId: null,
    userId: USER,
    connectorId: CONNECTOR,
    directorySubject: DIRECTORY_SUBJECT,
    requestId: 'request-1',
    authorizationChallengeId: null,
    scope: 'passkey_enrollment',
    ttlSeconds: 600,
    tokenHash,
  });
  return { id: transaction.id, token };
}

describe.each(['shared_pool', 'tenant_exclusive'] as const)(
  'directory password and Direct Auth passkey account stores of a %s tenant (real SQL)',
  (allocationScope) => {
    let databases: Databases;

    beforeEach(async () => {
      databases = {
        metadata: adapterOver(migrate('core')),
        accountCore: adapterOver(migrate('core')),
        accountPii: adapterOver(migrate('pii')),
      };
      world.accountCore = databases.accountCore;
      world.accountPii = databases.accountPii;
      world.identifierRoutes.clear();
      world.storedChallenges = [];
      world.challenge = undefined;
      world.createdSessions = [];
      world.publishedDirectoryRoutes = [];
      world.publishedPasskeyRoutes = [];
      world.failDirectoryRoutePublication = undefined;
      await seedAccount(databases);
    });

    async function signInWithDirectoryPassword(email: string | null): Promise<Response> {
      const handler = createDirectoryPasswordLoginHandler(directoryFetcher(email));
      return app(allocationScope, databases, (h) =>
        h.post('/api/auth/directory-password/login', handler)
      ).request(
        '/api/auth/directory-password/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ username: 'routed', password: 'correct' }),
        },
        env(),
        executionCtx
      );
    }

    it('signs a linked directory identity in through its route to the account database', async () => {
      insertDirectoryLink(databases.accountCore, USER);
      const { issuer, subject } = directoryIdentityLookupSubject({
        connectorId: CONNECTOR,
        directorySubject: DIRECTORY_SUBJECT,
      });
      world.identifierRoutes.set(`${issuer}|${subject}`, USER);
      // A link in the metadata database to another user must never be read as the account's.
      insertDirectoryLink(databases.metadata, 'user_planted');

      // No address from the directory: only the identity link can name the account.
      const response = await signInWithDirectoryPassword(null);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, user: { id: USER, email: EMAIL } });
      expect(world.createdSessions).toEqual([expect.objectContaining({ userId: USER })]);
      expect(
        count(
          databases.accountCore.raw,
          `SELECT COUNT(*) AS n FROM directory_identity_links
            WHERE user_id = ? AND last_login_at IS NOT NULL`,
          USER
        )
      ).toBe(1);
    });

    it('links a directory identity found by its address in the account database and publishes its route', async () => {
      const response = await signInWithDirectoryPassword(EMAIL);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, user: { id: USER } });
      expect(
        count(
          databases.accountCore.raw,
          `SELECT COUNT(*) AS n FROM directory_identity_links
            WHERE tenant_id = ? AND connector_id = ? AND directory_subject = ? AND user_id = ?`,
          TENANT,
          CONNECTOR,
          DIRECTORY_SUBJECT,
          USER
        )
      ).toBe(1);
      expect(
        count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM directory_identity_links')
      ).toBe(0);
      expect(world.publishedDirectoryRoutes).toEqual([
        expect.objectContaining({
          tenantId: TENANT,
          accountId: `account:${USER}`,
          userId: USER,
          connectorId: CONNECTOR,
          directorySubject: DIRECTORY_SUBJECT,
        }),
      ]);
    });

    it('removes a new link whose route was refused, and links it on the retry', async () => {
      world.failDirectoryRoutePublication = 'auth_directory_route_authority_not_found';

      const failed = await signInWithDirectoryPassword(EMAIL);

      expect(failed.status).toBe(503);
      expect(world.createdSessions).toEqual([]);
      // Not left linked without its route: a later sign-in with another address, routed to
      // another account's database, would not see this link.
      expect(
        count(databases.accountCore.raw, 'SELECT COUNT(*) AS n FROM directory_identity_links')
      ).toBe(0);

      world.failDirectoryRoutePublication = undefined;
      const retried = await signInWithDirectoryPassword(EMAIL);

      expect(retried.status).toBe(200);
      expect(world.publishedDirectoryRoutes).toHaveLength(1);
      expect(
        count(databases.accountCore.raw, 'SELECT COUNT(*) AS n FROM directory_identity_links')
      ).toBe(1);
    });

    it('keeps a new link whose publication may have been written, and publishes it again', async () => {
      // The Control Plane may have published the route before failing (or its answer was lost).
      world.failDirectoryRoutePublication = 'auth_directory_route_internal_error';

      const failed = await signInWithDirectoryPassword(EMAIL);

      expect(failed.status).toBe(503);
      expect(world.createdSessions).toEqual([]);
      expect(
        count(databases.accountCore.raw, 'SELECT COUNT(*) AS n FROM directory_identity_links')
      ).toBe(1);

      world.failDirectoryRoutePublication = undefined;
      const retried = await signInWithDirectoryPassword(EMAIL);

      expect(retried.status).toBe(200);
      expect(world.publishedDirectoryRoutes).toEqual([
        expect.objectContaining({ userId: USER, directorySubject: DIRECTORY_SUBJECT }),
      ]);
    });

    it('publishes the route of a link found by its address that has none yet', async () => {
      // Linked before (by an earlier sign-in or an administrator) without its route published.
      insertDirectoryLink(databases.accountCore, USER);

      const response = await signInWithDirectoryPassword(EMAIL);

      expect(response.status).toBe(200);
      expect(world.publishedDirectoryRoutes).toEqual([
        expect.objectContaining({ userId: USER, directorySubject: DIRECTORY_SUBJECT }),
      ]);
    });

    it('refuses an identity its route names an account for whose link names another user', async () => {
      insertDirectoryLink(databases.accountCore, 'user_other');
      const { issuer, subject } = directoryIdentityLookupSubject({
        connectorId: CONNECTOR,
        directorySubject: DIRECTORY_SUBJECT,
      });
      world.identifierRoutes.set(`${issuer}|${subject}`, USER);

      const response = await signInWithDirectoryPassword(EMAIL);

      expect(response.status).toBe(409);
      expect(world.createdSessions).toEqual([]);
    });

    it('answers an unknown directory identity as unmapped, not as a server error', async () => {
      const response = await signInWithDirectoryPassword('unknown@example.com');

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'directory_identity_unmapped' });
      expect(world.createdSessions).toEqual([]);
    });

    it('offers the migration passkey registration with the account database’s passkeys excluded', async () => {
      insertPasskey(databases.accountCore, 'passkey_account', 'YWNjb3VudC1jcmVkZW50aWFs');
      insertPasskey(databases.metadata, 'passkey_planted', 'cGxhbnRlZA');
      const transaction = await migrationTransaction(databases);

      const response = await app(allocationScope, databases, (h) =>
        h.post('/api/auth/directory-password/migration/passkey/options', (c) =>
          directoryMigrationPasskeyOptionsHandler(c)
        )
      ).request(
        '/api/auth/directory-password/migration/passkey/options',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({
            transaction_id: transaction.id,
            transaction_token: transaction.token,
          }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        options: { excludeCredentials: Array<{ id: string }> };
      };
      expect(body.options.excludeCredentials.map((credential) => credential.id)).toEqual([
        'YWNjb3VudC1jcmVkZW50aWFs',
      ]);
    });

    it('stores the migration passkey in the account database', async () => {
      const transaction = await migrationTransaction(databases);
      world.challenge = {
        challenge: 'migration-challenge',
        userId: USER,
        metadata: {
          transaction_id: transaction.id,
          token_hash: (
            (await databases.metadata.queryOne(
              'SELECT token_hash FROM directory_auth_migration_transactions WHERE id = ?',
              [transaction.id]
            )) as { token_hash: string }
          ).token_hash,
          origin: ORIGIN,
          rpID: 'login.example.com',
        },
      };

      const response = await app(allocationScope, databases, (h) =>
        h.post('/api/auth/directory-password/migration/passkey/verify', (c) =>
          directoryMigrationPasskeyVerifyHandler(c)
        )
      ).request(
        '/api/auth/directory-password/migration/passkey/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({
            transaction_id: transaction.id,
            transaction_token: transaction.token,
            challenge_id: 'challenge-1',
            credential: { id: 'x', rawId: 'x', response: {}, type: 'public-key' },
          }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      expect(
        count(
          databases.accountCore.raw,
          'SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ? AND credential_id = ?',
          USER,
          'bWlncmF0aW9uLWNyZWRlbnRpYWw'
        )
      ).toBe(1);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM passkeys')).toBe(0);
      expect(world.createdSessions).toEqual([expect.objectContaining({ userId: USER })]);
    });

    it('starts a signed-in user’s Direct Auth passkey registration from the account database', async () => {
      insertPasskey(databases.accountCore, 'passkey_account', 'YWNjb3VudC1jcmVkZW50aWFs');
      insertPasskey(databases.metadata, 'passkey_planted', 'cGxhbnRlZA');

      const response = await app(allocationScope, databases, (h) =>
        h.post('/api/v1/auth/direct/passkey/register/start', directPasskeyRegisterStartHandler)
      ).request(
        '/api/v1/auth/direct/passkey/register/start',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: `authrim_session=${SESSION}`,
          },
          body: JSON.stringify({}),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        options: { user: { name: string }; excludeCredentials: Array<{ id: string }> };
      };
      expect(body.options.user.name).toBe(EMAIL);
      expect(body.options.excludeCredentials.map((credential) => credential.id)).toEqual([
        'YWNjb3VudC1jcmVkZW50aWFs',
      ]);
      expect(world.storedChallenges).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: USER })])
      );
    });
  }
);
