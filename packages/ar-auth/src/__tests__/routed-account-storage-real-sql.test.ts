/**
 * Where the passkey and TOTP endpoints (`/api/auth/passkeys/*`, `/api/auth/totp/*`) read and write
 * an account, for both allocation scopes, on real SQLite databases built from the migrations: the
 * tenant metadata database (`tenant_core/default`) and the account's own Core and PII databases.
 *
 * Both scopes route accounts through Lookup to their own databases, so both must keep every
 * account read and write away from the metadata database. These endpoints used to decide with a
 * tenant-exclusive-only check: a shared-pool tenant's requests went to the metadata database and
 * failed (the passkey was not found there; the account context they needed was never resolved).
 *
 * Real: the context helpers (createAuthContextFromHono, createAccountAuthContextFromHono,
 * createPIIContextFromHono), the canonical user store and the passkey and TOTP repositories.
 * Fakes: Lookup (the identifier and account-id routes, kept in a map and attaching the account
 * context the way the real resolvers do), the challenge and session stores, WebAuthn's
 * cryptographic verification, and the per-account replay state (a Durable Object).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalRuntimeUserStore,
  encryptValue,
  generateTotpCode,
  getTotpTimeStep,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';

const TENANT = 'default';
const ORIGIN = 'https://login.example.com';
const USER = 'user_routed';
/** The user id a sign-up is given. */
const NEW_USER = 'user_signed_up';
const NEW_EMAIL = 'new@example.com';
const EMAIL = 'routed@example.com';
const CREDENTIAL_ID = 'Y3JlZGVudGlhbC1pZC0x';
const PUBLIC_KEY = btoa('public-key-bytes');
const PII_ENCRYPTION_KEY = 'a'.repeat(64);
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

const world = vi.hoisted(() => ({
  accountCore: undefined as unknown,
  accountPii: undefined as unknown,
  /** Lookup's identifier routes: identifier -> legacy user id. */
  identifierRoutes: new Map<string, string>(),
  challenge: undefined as undefined | Record<string, unknown>,
  storedChallenges: [] as Array<Record<string, unknown>>,
  /** The SessionStore's live sessions. */
  sessions: new Set<string>(),
  /** The next session creation commits, then its RPC fails. */
  failSessionRpcAfterCommit: false,
  /** Work a handler left to run after its response (waitUntil). */
  afterResponse: [] as Array<Promise<unknown>>,
}));

function accountContext(userId: string) {
  return {
    tenantId: TENANT,
    accountId: `account:${userId}`,
    legacyUserId: userId,
    membership: {},
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
}

async function attachAccount(c: { set(key: string, value: unknown): void }, userId: string) {
  // Lookup routes only accounts that exist at their destination.
  const exists = await (world.accountCore as DatabaseAdapter).queryOne(
    'SELECT 1 AS found FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
    [TENANT, userId]
  );
  if (!exists) throw new Error('account_data_route_not_found');
  const context = accountContext(userId);
  c.set('accountDataContext', context);
  return context;
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const challengeStore = {
    consumeChallengeRpc: vi.fn(async () => {
      if (!world.challenge) throw new Error('challenge_not_found');
      const challenge = world.challenge;
      world.challenge = undefined;
      return challenge;
    }),
    getChallengeRpc: vi.fn(async () => world.challenge ?? null),
    deleteChallengeRpc: vi.fn(async () => undefined),
    storeChallengeRpc: vi.fn(async (challenge: Record<string, unknown>) => {
      world.storedChallenges.push(challenge);
    }),
  };
  return {
    ...actual,
    getChallengeStoreByUserId: vi.fn(async () => challengeStore),
    getChallengeStoreByChallengeId: vi.fn(async () => challengeStore),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: {
        createSessionRpc: vi.fn(async (id: string) => {
          world.sessions.add(id);
          if (world.failSessionRpcAfterCommit) {
            world.failSessionRpcAfterCommit = false;
            throw new Error('Network connection lost.');
          }
          return { id };
        }),
        invalidateSessionRpc: vi.fn(async (id: string) => world.sessions.delete(id)),
      },
      sessionId: 'g1:apac:1:session_routed',
    })),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: { invalidateSessionRpc: vi.fn(async (id: string) => world.sessions.delete(id)) },
    })),
    getTenantSettingsDocument: vi.fn(async () => null),
    generateUserIdFromSettings: vi.fn(async () => NEW_USER),
    // No deleted account holds the address.
    checkEmailRegistration: vi.fn(async () => 'allowed'),
    resolvePostLoginRedirectUrl: vi.fn(async () => ({ redirectUrl: '/' })),
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { set(key: string, value: unknown): void }, accountId: string) =>
        attachAccount(c, accountId.replace(/^account:/u, ''))
    ),
    resolveAccountDataContextByIdentifierFromHono: vi.fn(
      async (
        c: { set(key: string, value: unknown): void },
        input: { identifier: string | { issuer: string; subject: string } }
      ) => {
        const key =
          typeof input.identifier === 'string'
            ? input.identifier
            : `${input.identifier.issuer}|${input.identifier.subject}`;
        const userId = world.identifierRoutes.get(key);
        if (!userId) throw new Error('account_data_route_not_found');
        return attachAccount(c, userId);
      }
    ),
    advancePasskeyAuthenticationState: vi.fn(async () => undefined),
    consumeTotpAuthenticationState: vi.fn(async () => undefined),
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
        id: CREDENTIAL_ID,
        publicKey: Uint8Array.from(atob(PUBLIC_KEY), (char) => char.charCodeAt(0)),
        counter: 0,
      },
      aaguid: '00000000-0000-0000-0000-000000000000',
    },
  })),
  verifyAuthenticationResponse: vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })),
}));

vi.mock('../authentication-method-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../authentication-method-settings')>()),
  isAuthenticationMethodUsageEnabled: vi.fn(async () => true),
  isAuthenticationMethodUsageAvailable: vi.fn(async () => true),
}));

vi.mock('../session-ttl', () => ({
  resolveSessionTtl: vi.fn(async () => ({ seconds: 3600 })),
}));

vi.mock('../account-provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../account-provisioning')>()),
  // Publishing the credential's Lookup route goes through the Control Plane provisioner.
  publishTenantD1PasskeyRoute: vi.fn(async () => 201),
  // The Control Plane provisioner: it creates the account at its destination (the account
  // databases) and publishes its address route.
  provisionTenantD1EmailAccount: vi.fn(
    async (
      _c: unknown,
      input: {
        tenantId: string;
        candidateUserId: string;
        email: string | null;
        runtimeUser: Record<string, unknown>;
      }
    ) => {
      const { CanonicalRuntimeUserStore: Store } =
        await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
      await new Store({
        coreAdapter: world.accountCore as DatabaseAdapter,
        piiAdapter: world.accountPii as DatabaseAdapter,
        tenantId: input.tenantId,
      }).syncUser({
        ...(input.runtimeUser as unknown as Parameters<CanonicalRuntimeUserStore['syncUser']>[0]),
        userId: input.candidateUserId,
        email: input.email,
      });
      if (input.email) world.identifierRoutes.set(input.email, input.candidateUserId);
      return {
        status: 'ready',
        accountId: `account:${input.candidateUserId}`,
        userId: input.candidateUserId,
      };
    }
  ),
}));

vi.mock('../registration-field-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../registration-field-utils')>()),
  validateRegistrationFieldSubmissionFromEnv: vi.fn(async () => ({
    ok: true,
    values: {},
    schemas: [],
  })),
  persistRegistrationFieldValuesFromEnv: vi.fn(async () => undefined),
}));

import {
  passkeyLoginVerifyHandler,
  passkeyRegisterOptionsHandler,
  passkeyRegisterVerifyHandler,
} from '../passkey';
import { totpLoginStartHandler, totpLoginVerifyHandler, totpSignupActivateHandler } from '../totp';
import { passkeyCredentialLookupSubject } from '@authrim/ar-lib-core';

function migrate(folder: string): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  const directory = path.resolve(__dirname, '../../../../migrations', folder, 'd1');
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(path.join(directory, file), 'utf8'), 'sqlite'));
  }
  return db;
}

function adapterOver(db: SqliteDatabase): DatabaseAdapter & { raw: SqliteDatabase } {
  const bind = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value));
  const adapter = {
    raw: db,
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      (db.prepare(sql).get(...bind(params)) as unknown) ?? null,
    execute: async (sql: string, params?: unknown[]) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...bind(params)).changes),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({
          success: true,
          rowsAffected: Number(db.prepare(statement.sql).run(...bind(statement.params)).changes),
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isHealthy: async () => true,
    getType: () => 'sqlite',
    close: async () => undefined,
  };
  return adapter as unknown as DatabaseAdapter & { raw: SqliteDatabase };
}

type Databases = {
  metadata: DatabaseAdapter & { raw: SqliteDatabase };
  accountCore: DatabaseAdapter & { raw: SqliteDatabase };
  accountPii: DatabaseAdapter & { raw: SqliteDatabase };
};

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
  return {
    ALLOWED_ORIGINS: ORIGIN,
    ISSUER_URL: 'https://auth.example.com',
    PII_ENCRYPTION_KEY,
    OTP_HMAC_SECRET: 'otp-hmac-secret',
    INVESTIGATION_SUBJECT_HMAC_KEYRING: JSON.stringify({
      current: 1,
      keys: { '1': 'k'.repeat(43) },
    }),
    // The tenant's authentication-method settings: TOTP sign-in is on.
    SETTINGS: {
      get: async () =>
        JSON.stringify({
          'authentication-methods.totp.login_enabled': true,
          'authentication-methods.totp.signup_enabled': true,
        }),
    },
  } as unknown as Env;
}

const executionCtx = {
  waitUntil: (promise: Promise<unknown>) => void world.afterResponse.push(promise),
  passThroughOnException: () => undefined,
  props: {},
};

function count(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

/** A code no step the verifier accepts now (the current one and one either side) produces. */
async function invalidTotpCode(): Promise<string> {
  const profile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 } as const;
  const step = getTotpTimeStep(Date.now(), profile.period);
  const accepted = new Set<string>();
  for (let offset = -2; offset <= 2; offset += 1) {
    accepted.add(await generateTotpCode(TOTP_SECRET, profile, step + offset));
  }
  return ['000000', '111111', '222222', '333333', '444444', '555555'].find(
    (code) => !accepted.has(code)
  )!;
}

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
}

describe.each(['shared_pool', 'tenant_exclusive'] as const)(
  'account reads and writes of a %s tenant (real SQL)',
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
      world.challenge = undefined;
      world.storedChallenges = [];
      world.sessions.clear();
      world.failSessionRpcAfterCommit = false;
      world.afterResponse = [];
      await seedAccount(databases);
    });

    it('signs a new address up into the account databases', async () => {
      // A row in the metadata database for the same user id must never be read as the account's.
      databases.metadata.raw
        .prepare(
          `INSERT INTO passkeys (id, tenant_id, user_id, credential_id, rp_id, public_key, counter,
                                 created_at)
           VALUES ('passkey_planted', ?, ?, 'cGxhbnRlZA', 'login.example.com', ?, 0, 1)`
        )
        .run(TENANT, NEW_USER, PUBLIC_KEY);
      const hono = app(allocationScope, databases, (h) =>
        h.post('/api/auth/passkeys/register/options', passkeyRegisterOptionsHandler)
      );

      const response = await hono.request(
        '/api/auth/passkeys/register/options',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ email: NEW_EMAIL, name: 'New User' }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        userId: string;
        options: { excludeCredentials?: unknown[] };
      };
      expect(body.userId).toBe(NEW_USER);
      // The new account has no passkeys yet: the planted metadata row is not offered for exclusion.
      expect(body.options.excludeCredentials ?? []).toEqual([]);
      expect(
        count(
          databases.accountCore.raw,
          'SELECT COUNT(*) AS n FROM identity_accounts WHERE legacy_user_id = ?',
          NEW_USER
        )
      ).toBe(1);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM identity_accounts')).toBe(0);
      expect(world.storedChallenges).toEqual([
        expect.objectContaining({ id: `passkey_reg:${NEW_USER}`, userId: NEW_USER }),
      ]);
    });

    it('stores a registered passkey in the account database, not the metadata database', async () => {
      world.challenge = { challenge: 'registration-challenge', userId: USER };
      const hono = app(allocationScope, databases, (h) =>
        h.post('/api/auth/passkeys/register/verify', passkeyRegisterVerifyHandler)
      );

      const response = await hono.request(
        '/api/auth/passkeys/register/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({
            userId: USER,
            credential: {
              id: CREDENTIAL_ID,
              rawId: CREDENTIAL_ID,
              response: {},
              type: 'public-key',
            },
          }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { user: { id: string; email: string } };
      // The user answered is read from the account's databases.
      expect(body.user).toMatchObject({ id: USER, email: EMAIL });
      expect([...world.sessions]).toEqual(['g1:apac:1:session_routed']);
      expect(
        count(
          databases.accountCore.raw,
          'SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ? AND credential_id = ?',
          USER,
          CREDENTIAL_ID
        )
      ).toBe(1);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM passkeys')).toBe(0);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM identity_accounts')).toBe(0);
    });

    it('ends the session it opened when the passkey cannot be stored', async () => {
      // The credential is already registered: storing it again fails after the session is open.
      databases.accountCore.raw
        .prepare(
          `INSERT INTO passkeys (id, tenant_id, user_id, credential_id, rp_id, public_key, counter,
                                 created_at)
           VALUES ('passkey_existing', ?, ?, ?, 'login.example.com', ?, 0, 1)`
        )
        .run(TENANT, USER, CREDENTIAL_ID, PUBLIC_KEY);
      world.challenge = { challenge: 'registration-challenge', userId: USER };
      const hono = app(allocationScope, databases, (h) =>
        h.post('/api/auth/passkeys/register/verify', passkeyRegisterVerifyHandler)
      );

      const response = await hono.request(
        '/api/auth/passkeys/register/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({
            userId: USER,
            credential: {
              id: CREDENTIAL_ID,
              rawId: CREDENTIAL_ID,
              response: {},
              type: 'public-key',
            },
          }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('session_routed');
      expect(world.sessions.size).toBe(0);
      expect(
        count(
          databases.accountCore.raw,
          'SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?',
          USER
        )
      ).toBe(1);
    });

    it('ends a session whose creation committed although its RPC failed', async () => {
      world.failSessionRpcAfterCommit = true;
      world.challenge = { challenge: 'registration-challenge', userId: USER };
      const hono = app(allocationScope, databases, (h) =>
        h.post('/api/auth/passkeys/register/verify', passkeyRegisterVerifyHandler)
      );

      const response = await hono.request(
        '/api/auth/passkeys/register/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({
            userId: USER,
            credential: {
              id: CREDENTIAL_ID,
              rawId: CREDENTIAL_ID,
              response: {},
              type: 'public-key',
            },
          }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(500);
      expect(world.sessions.size).toBe(0);
      // No passkey is stored for a registration whose session could not be confirmed.
      expect(count(databases.accountCore.raw, 'SELECT COUNT(*) AS n FROM passkeys')).toBe(0);
    });

    it('signs in with a passkey kept in the account database', async () => {
      databases.accountCore.raw
        .prepare(
          `INSERT INTO passkeys (id, tenant_id, user_id, credential_id, rp_id, public_key, counter,
                                 transports, device_name, created_at)
           VALUES ('passkey_1', ?, ?, ?, 'login.example.com', ?, 0, '[]', 'Key', 1)`
        )
        .run(TENANT, USER, CREDENTIAL_ID, PUBLIC_KEY);
      // The credential's Lookup route, as registration publishes it.
      const subject = passkeyCredentialLookupSubject({
        credentialId: CREDENTIAL_ID,
        rpId: 'login.example.com',
      });
      world.identifierRoutes.set(`${subject.issuer}|${subject.subject}`, USER);
      world.challenge = { challenge: 'authentication-challenge' };
      const hono = app(allocationScope, databases, (h) =>
        h.post('/api/auth/passkeys/login/verify', passkeyLoginVerifyHandler)
      );

      const response = await hono.request(
        '/api/auth/passkeys/login/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({
            challengeId: 'challenge-1',
            credential: {
              id: CREDENTIAL_ID,
              rawId: CREDENTIAL_ID,
              response: { userHandle: btoa(USER).replace(/=+$/u, '') },
              type: 'public-key',
            },
          }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { userId?: string; user?: { email?: string } };
      expect(body.user?.email ?? null).toBe(EMAIL);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM passkeys')).toBe(0);
    });

    it('signs in with a TOTP credential kept in the account database', async () => {
      const { encrypted } = await encryptValue(TOTP_SECRET, PII_ENCRYPTION_KEY, 'AES-256-GCM', 1);
      databases.accountCore.raw
        .prepare(
          `INSERT INTO totp_credentials (
             id, tenant_id, user_id, secret_encrypted, algorithm, digits, period, window,
             status, created_at, activated_at
           ) VALUES ('totp_1', ?, ?, ?, 'SHA1', 6, 30, 1, 'active', 1, 1)`
        )
        .run(TENANT, USER, encrypted);
      world.challenge = { challenge: 'totp', userId: USER, metadata: {} };
      const hono = app(allocationScope, databases, (h) =>
        h.post('/api/auth/totp/login/verify', totpLoginVerifyHandler)
      );
      const profile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 } as const;
      const timeStep = getTotpTimeStep(Date.now(), profile.period);
      const code = await generateTotpCode(TOTP_SECRET, profile, timeStep);

      const response = await hono.request(
        '/api/auth/totp/login/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ challenge_id: 'challenge-1', code }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      // The accepted code is recorded on the credential in the account database.
      expect(
        databases.accountCore.raw
          .prepare('SELECT last_used_time_step FROM totp_credentials WHERE id = ?')
          .get('totp_1')
      ).toEqual({ last_used_time_step: timeStep });
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM totp_credentials')).toBe(0);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM identity_accounts')).toBe(0);
    });

    it('activates a TOTP sign-up in the account databases', async () => {
      const { encrypted } = await encryptValue(TOTP_SECRET, PII_ENCRYPTION_KEY, 'AES-256-GCM', 1);
      const profile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 } as const;
      world.challenge = {
        challenge: 'signup-challenge',
        userId: NEW_USER,
        metadata: {
          credential_id: 'totp_signup',
          email: NEW_EMAIL,
          secret_encrypted: encrypted,
          secret_key_version: 1,
          ...profile,
        },
      };
      const code = await generateTotpCode(
        TOTP_SECRET,
        profile,
        getTotpTimeStep(Date.now(), profile.period)
      );
      const hono = app(allocationScope, databases, (h) =>
        h.post('/api/auth/totp/signup/activate', totpSignupActivateHandler)
      );

      const response = await hono.request(
        '/api/auth/totp/signup/activate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ challenge_id: 'signup-challenge', code }),
        },
        env(),
        executionCtx
      );

      expect(response.status).toBe(200);
      expect(
        databases.accountCore.raw
          .prepare('SELECT user_id, status FROM totp_credentials WHERE id = ?')
          .get('totp_signup')
      ).toEqual({ user_id: NEW_USER, status: 'active' });
      expect(
        count(
          databases.accountCore.raw,
          'SELECT COUNT(*) AS n FROM identity_accounts WHERE legacy_user_id = ?',
          NEW_USER
        )
      ).toBe(1);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM totp_credentials')).toBe(0);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM totp_backup_codes')).toBe(0);
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM identity_accounts')).toBe(0);
    });

    it('records a failed TOTP attempt with its interaction in the metadata database', async () => {
      // The Flow interaction lives in the tenant metadata database; the account and its
      // credential live in the account databases.
      const now = Math.floor(Date.now() / 1000);
      for (const db of [databases.metadata.raw, databases.accountCore.raw]) {
        db.prepare(
          `INSERT INTO flow_interactions (id, tenant_id, flow_id, flow_version_id, client_id, state,
             current_node_id, contract_hash, signature, expires_at, created_at, updated_at)
           VALUES ('interaction_1', ?, 'flow-default-login-no-consent',
                   'flow-version-default-login-no-consent-v1', 'login-ui', 'active',
                   'authentication', 'contract-1', 'sig', ?, ?, ?)`
        ).run(TENANT, now + 600, now, now);
      }
      // Only the metadata database's interaction is live: the account database's copy has expired.
      databases.accountCore.raw
        .prepare("UPDATE flow_interactions SET expires_at = ? WHERE id = 'interaction_1'")
        .run(now - 1);
      const { encrypted } = await encryptValue(TOTP_SECRET, PII_ENCRYPTION_KEY, 'AES-256-GCM', 1);
      databases.accountCore.raw
        .prepare(
          `INSERT INTO totp_credentials (
             id, tenant_id, user_id, secret_encrypted, algorithm, digits, period, window,
             status, created_at, activated_at
           ) VALUES ('totp_1', ?, ?, ?, 'SHA1', 6, 30, 1, 'active', 1, 1)`
        )
        .run(TENANT, USER, encrypted);
      world.identifierRoutes.set(EMAIL, USER);
      const hono = app(allocationScope, databases, (h) => {
        h.post('/api/auth/totp/login/start', totpLoginStartHandler);
        h.post('/api/auth/totp/login/verify', totpLoginVerifyHandler);
      });

      const start = await hono.request(
        '/api/auth/totp/login/start',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            'X-Authrim-Interaction-Id': 'interaction_1',
          },
          body: JSON.stringify({ identifier: EMAIL }),
        },
        env(),
        executionCtx
      );
      expect(start.status).toBe(200);
      const { challenge_id: challengeId } = (await start.json()) as { challenge_id: string };
      // The account and its credential were found in the account databases, and the interaction
      // was validated against the metadata database.
      expect(world.storedChallenges).toEqual([
        expect.objectContaining({
          userId: USER,
          metadata: expect.objectContaining({
            credential_count: 1,
            attempt_interaction_id: 'interaction_1',
          }),
        }),
      ]);

      world.challenge = world.storedChallenges[0];
      const verify = await hono.request(
        '/api/auth/totp/login/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ challenge_id: challengeId, code: await invalidTotpCode() }),
        },
        env(),
        executionCtx
      );
      await Promise.all(world.afterResponse);

      expect(verify.status).toBe(400);
      const attempts = `SELECT interaction_id, method, reason_code, subject_hash
                          FROM flow_audit_events WHERE reason_code IS NOT NULL`;
      expect(databases.metadata.raw.prepare(attempts).all()).toEqual([
        {
          interaction_id: 'interaction_1',
          method: 'totp',
          reason_code: 'invalid_code',
          subject_hash: expect.any(String),
        },
      ]);
      expect(databases.accountCore.raw.prepare(attempts).all()).toEqual([]);
    });
  }
);
