/**
 * Self-service enrollment and sign-in share the account's Core store. Metadata, account Core
 * and account PII are independent SQLite databases built from the executable migrations.
 * Context helpers, repositories, TOTP cryptography, authentication-state consumption and the
 * last-login-method check are real. Only Lookup, Durable Objects and audit delivery are fakes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalRuntimeUserStore,
  encryptValue,
  generateTotpCode,
  getTotpTimeStep,
  hashTotpBackupCode,
  TotpCredentialRepository,
  type AccountDataContext,
  type DatabaseAdapter,
  type Env,
  type PreparedStatement,
  type TotpCredential,
  type TotpProfile,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

const TENANT = 'default';
const OTHER_TENANT = 'tenant_other';
const USER = 'user_routed';
const OTHER_USER = 'user_other';
const EMAIL = 'routed@example.com';
const SESSION = 'g1:apac:1:session_account';
const ORIGIN = 'https://login.example.com';
const ENCRYPTION_KEY = 'a'.repeat(64);
const BACKUP_SECRET = 'test-only-backup-hmac';
const SEED_SECRET = 'JBSWY3DPEHPK3PXP';
const PROFILE = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 } as const;
type Topology = 'shared_pool' | 'tenant_exclusive' | 'single';
type TestSession = {
  id: string;
  tenantId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  data: { authTime: number; amr: string[]; [key: string]: unknown };
};
type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter };
type Challenge = {
  id: string;
  tenantId: string;
  type: string;
  userId: string;
  challenge: string;
  metadata?: Record<string, unknown>;
};

const world = vi.hoisted(() => ({
  resolveById:
    vi.fn<(c: Context<{ Bindings: Env }>, accountId: string) => Promise<AccountDataContext>>(),
  resolveByIdentifier: vi.fn(),
  resolveIdentifierFromHono: vi.fn(),
  sessions: new Map<string, TestSession>(),
  challenges: new Map<string, Challenge>(),
  accountStates: new Map<string, { lifecycle: string; sourceVersionMs: number }>(),
  acceptedSteps: new Map<string, number>(),
  hydrations: [] as Array<{ tenantId: string; userId: string; lifecycle: string }>,
  cleanups: [] as Array<{ tenantId: string; userId: string; credentialId: string }>,
  audits: [] as Array<{ tenantId: string; userId: string; action: string; metadata: string }>,
  afterResponse: [] as Array<Promise<unknown>>,
  createdSessions: [] as Array<{ userId: string; tenantId: string; data: Record<string, unknown> }>,
  emailLogin: false,
  routeFailure: false,
}));

// Mock the Lookup boundary inside the shared removal-safety helper too. Its real SQL queries
// and the canonical account/PII reads still run, including the directory reachability check.
vi.mock('../../../ar-lib-core/dist/services/runtime-data-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/services/runtime-data-context')>()),
  resolveAccountDataContextFromHono: world.resolveById,
  resolveAccountDataContextByIdentifier: world.resolveByIdentifier,
  resolveAccountDataContextByIdentifierFromHono: world.resolveIdentifierFromHono,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const challengeStore = {
    storeChallengeRpc: vi.fn(async (challenge: Challenge) => {
      world.challenges.set(`${challenge.tenantId}:${challenge.id}`, challenge);
    }),
    consumeChallengeRpc: vi.fn(async (input: { tenantId: string; id: string; type: string }) => {
      const key = `${input.tenantId}:${input.id}`;
      const challenge = world.challenges.get(key);
      if (!challenge || challenge.type !== input.type) throw new Error('challenge_not_found');
      world.challenges.delete(key);
      return challenge;
    }),
  };
  return {
    ...actual,
    getChallengeStoreByChallengeId: vi.fn(async () => challengeStore),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        getSessionRpc: vi.fn(async (id: string) => world.sessions.get(id) ?? null),
        updateSessionDataRpc: vi.fn(async (id: string, data: TestSession['data']) => {
          const session = world.sessions.get(id);
          if (!session) return null;
          session.data = { ...session.data, ...data };
          return session;
        }),
      },
    })),
    getSessionStoreForNewSession: vi.fn(async () => ({
      sessionId: `g1:apac:1:login_${world.createdSessions.length}`,
      stub: {
        createSessionRpc: vi.fn(
          async (
            _id: string,
            userId: string,
            _ttl: number,
            data: Record<string, unknown>,
            tenantId: string
          ) => {
            world.createdSessions.push({ userId, tenantId, data });
            return { id: _id };
          }
        ),
      },
    })),
    resolvePostLoginRedirectUrl: vi.fn(async () => ({ redirectUrl: '/account' })),
    publishEvent: vi.fn(async () => undefined),
    createAuditLog: vi.fn(async (_env: unknown, input: (typeof world.audits)[number]) => {
      world.audits.push(input);
    }),
  };
});

vi.mock('../../../ar-auth/src/session-ttl', () => ({
  resolveSessionTtl: vi.fn(async () => ({ seconds: 3600, milliseconds: 3_600_000 })),
}));

import {
  activateAccountTotpCredentialHandler,
  completeAccountTotpReauthHandler,
  createAccountTotpOptionsHandler,
  deleteAccountTotpCredentialHandler,
  listAccountTotpCredentialsHandler,
  regenerateAccountTotpBackupCodesHandler,
  updateAccountTotpCredentialHandler,
} from '../account-totp';

// Load the actual ar-auth handlers without adding its source tree to this package's tsc rootDir.
type Handler = (c: Context<{ Bindings: Env }>) => Promise<Response>;
const authModuleUrl = new URL('../../../ar-auth/src/totp.ts', import.meta.url).href;
const { totpLoginStartHandler, totpLoginVerifyHandler } = (await import(authModuleUrl)) as {
  totpLoginStartHandler: Handler;
  totpLoginVerifyHandler: Handler;
};

function openStore(family: 'core' | 'pii'): Store {
  const db = new DatabaseSync(':memory:');
  const directory = new URL(`../../../../migrations/${family}/d1/`, import.meta.url);
  for (const filename of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(
      renderPortableMigrationSql(readFileSync(new URL(filename, directory), 'utf8'), 'sqlite')
    );
  }
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const run = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run({ sql, params }),
    batch: async (statements: PreparedStatement[]) => {
      db.exec('BEGIN');
      try {
        const result = statements.map(run);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: async (operation: (tx: DatabaseAdapter) => Promise<unknown>) => {
      db.exec('BEGIN');
      try {
        const result = await operation(adapter);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'sqlite' }),
    getType: () => 'sqlite',
    close: async () => db.close(),
  } as DatabaseAdapter;
  return { db, adapter };
}

function count(store: Store, table: 'totp_credentials' | 'totp_backup_codes'): number {
  return Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function credentialSummary(store: Store): unknown[] {
  return store.db
    .prepare(
      'SELECT id, tenant_id, user_id, label, status, last_used_time_step FROM totp_credentials ORDER BY id'
    )
    .all();
}

function backupSummary(store: Store): unknown[] {
  return store.db
    .prepare(
      'SELECT id, tenant_id, user_id, credential_id, used_at FROM totp_backup_codes ORDER BY id'
    )
    .all();
}

function currentSession(): TestSession {
  const session = world.sessions.get(SESSION);
  if (!session) throw new Error('fixture_session_missing');
  return session;
}

describe.each(['shared_pool', 'tenant_exclusive', 'single'] as const)(
  'self-service TOTP account storage: %s (real SQL)',
  (topology: Topology) => {
    let metadata: Store;
    let account: Store;
    let pii: Store;
    let app: Hono<{ Bindings: Env }>;
    let env: Env;

    function accountContext(tenantId: string, userId: string): AccountDataContext {
      return {
        tenantId,
        accountId: `account:${userId}`,
        legacyUserId: userId,
        membership: {
          tenantId,
          accountId: `account:${userId}`,
          accountRouteGeneration: 1,
          hmacKeyGeneration: 1,
          normalizationVersion: 1,
          routeProjection: {
            schemaVersion: 1,
            accountRouteGeneration: 1,
            residencyPolicyId: 'test-default',
            targets: [
              {
                dataRole: 'tenant_core/users',
                residencyPartition: 'default',
                shardId: 'users-1',
                bindingRef: 'TDB_USERS_1',
                requiredBindingRouteGeneration: 1,
              },
              {
                dataRole: 'tenant_pii',
                residencyPartition: 'default',
                shardId: 'pii-1',
                bindingRef: 'TDB_PII_1',
                requiredBindingRouteGeneration: 1,
              },
            ],
          },
        },
        coreDb: account.adapter,
        piiDb: pii.adapter,
        coreBindingRef: 'TDB_USERS_1',
        piiBindingRef: 'TDB_PII_1',
        coreResidencyPartition: 'default',
        piiResidencyPartition: 'default',
        accountRouteGeneration: 1,
        userCacheScope: {
          routeGeneration: 1,
          bindingGeneration: 'core:1:pii:1',
          schemaGeneration: 'core:1:pii:1',
        },
        piiCacheMode: 'no_cross_request_pii',
      };
    }

    async function resolve(tenantId: string, userId: string): Promise<AccountDataContext> {
      if (world.routeFailure) throw new Error('account_data_route_not_found');
      const found = await account.adapter.queryOne(
        'SELECT 1 AS found FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
        [tenantId, userId]
      );
      if (!found) throw new Error('account_data_route_not_found');
      return accountContext(tenantId, userId);
    }

    function revocationStore() {
      return {
        initializeAccountStateRpc: async (
          tenantId: string,
          userId: string,
          _accountId: string,
          lifecycle: string,
          sourceVersionMs: number
        ) => {
          const state = { lifecycle, sourceVersionMs };
          world.hydrations.push({ tenantId, userId, lifecycle });
          world.accountStates.set(`${tenantId}:${userId}`, state);
          return state;
        },
        consumeTotpTimeStepRpc: async (
          tenantId: string,
          userId: string,
          _accountId: string,
          credentialId: string,
          storedLastUsedTimeStep: number | null,
          observedTimeStep: number
        ) => {
          const state = world.accountStates.get(`${tenantId}:${userId}`);
          if (!state) throw new Error('account_auth_state_uninitialized');
          if (state.lifecycle !== 'active') throw new Error('account_authentication_not_allowed');
          const key = `${tenantId}:${userId}:${credentialId}`;
          const last = Math.max(storedLastUsedTimeStep ?? -1, world.acceptedSteps.get(key) ?? -1);
          if (observedTimeStep <= last) throw new Error('totp_time_step_replay');
          world.acceptedSteps.set(key, observedTimeStep);
          return { lastAcceptedTimeStep: observedTimeStep };
        },
        deleteCredentialStateRpc: async (
          tenantId: string,
          userId: string,
          _accountId: string,
          _kind: string,
          credentialId: string
        ) => {
          world.cleanups.push({ tenantId, userId, credentialId });
          return world.acceptedSteps.delete(`${tenantId}:${userId}:${credentialId}`);
        },
      };
    }

    async function seedUser(userId = USER, tenantId = TENANT, email = EMAIL): Promise<void> {
      await new CanonicalRuntimeUserStore({
        coreAdapter: account.adapter,
        piiAdapter: pii.adapter,
        tenantId,
      }).syncUser({
        userId,
        email,
        active: true,
        emailVerified: true,
        userType: 'end_user',
        sourceRef: 'test',
        piiFields: { email: true },
        sensitiveValues: { email },
      });
      // Provisioning publishes the directory only after the canonical account graph is ready.
      // A signed-in account is already published; syncUser alone intentionally leaves it pending.
      await account.adapter.execute(
        "UPDATE identity_accounts SET directory_publication_state = 'active' WHERE tenant_id = ? AND legacy_user_id = ?",
        [tenantId, userId]
      );
    }

    async function seedCredential(
      id: string,
      options: {
        store?: Store;
        tenantId?: string;
        userId?: string;
        status?: 'active' | 'pending';
      } = {}
    ): Promise<TotpCredential> {
      const { encrypted } = await encryptValue(SEED_SECRET, ENCRYPTION_KEY, 'AES-256-GCM', 1);
      return new TotpCredentialRepository(
        (options.store ?? account).adapter,
        options.tenantId ?? TENANT
      ).create({
        id,
        user_id: options.userId ?? USER,
        secret_encrypted: encrypted,
        ...PROFILE,
        label: id,
        status: options.status ?? 'active',
      });
    }

    async function request(
      pathname: string,
      method = 'GET',
      body?: unknown,
      sessionId: string | null = SESSION,
      tenantId = TENANT
    ): Promise<Response> {
      const response = await app.request(
        pathname,
        {
          method,
          headers: {
            Origin: ORIGIN,
            'Content-Type': 'application/json',
            'X-Test-Tenant': tenantId,
            ...(sessionId ? { Cookie: `authrim_session=${encodeURIComponent(sessionId)}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
        {
          waitUntil: (promise: Promise<unknown>) => void world.afterResponse.push(promise),
          passThroughOnException: () => undefined,
          props: {},
        }
      );
      await Promise.all(world.afterResponse.splice(0));
      return response;
    }

    async function code(secret = SEED_SECRET, profile: TotpProfile = PROFILE): Promise<string> {
      return generateTotpCode(secret, profile, getTotpTimeStep(Date.now(), profile.period));
    }

    async function login(secret: string, profile: TotpProfile): Promise<Response> {
      const started = await request(
        '/api/auth/totp/login/start',
        'POST',
        { identifier: EMAIL },
        null
      );
      expect(started.status).toBe(200);
      const challenge = await started.json<{ challenge_id: string }>();
      return request(
        '/api/auth/totp/login/verify',
        'POST',
        { challenge_id: challenge.challenge_id, code: await code(secret, profile) },
        null
      );
    }

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
      metadata = openStore('core');
      account = topology === 'single' ? metadata : openStore('core');
      pii = openStore('pii');
      world.sessions.clear();
      world.challenges.clear();
      world.accountStates.clear();
      world.acceptedSteps.clear();
      world.hydrations = [];
      world.cleanups = [];
      world.audits = [];
      world.afterResponse = [];
      world.createdSessions = [];
      world.emailLogin = false;
      world.routeFailure = false;
      world.resolveById.mockImplementation(
        async (c: Context<{ Bindings: Env }>, accountId: string) => {
          const tenantId = c.req.header('X-Test-Tenant') ?? TENANT;
          const userId = accountId.replace(/^account:/u, '');
          const attached = (
            c as unknown as { get(key: string): AccountDataContext | undefined }
          ).get('accountDataContext');
          if (
            attached &&
            (attached.tenantId !== tenantId || attached.accountId !== `account:${userId}`)
          ) {
            throw new Error('account_data_context_conflict');
          }
          const context = await resolve(tenantId, userId);
          (c as unknown as { set(key: string, value: unknown): void }).set(
            'accountDataContext',
            context
          );
          return context;
        }
      );
      world.resolveByIdentifier.mockImplementation(
        async (_env: unknown, input: { tenantId: string; identifier: unknown }) => {
          if (input.identifier !== EMAIL) throw new Error('account_data_route_not_found');
          return resolve(input.tenantId, USER);
        }
      );
      world.resolveIdentifierFromHono.mockImplementation(
        async (c: Context<{ Bindings: Env }>, input: { identifier: unknown }) => {
          if (input.identifier !== EMAIL) throw new Error('account_data_route_not_found');
          return world.resolveById(c, USER);
        }
      );
      world.sessions.set(SESSION, {
        id: SESSION,
        tenantId: TENANT,
        userId: USER,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        data: { authTime: Math.floor(Date.now() / 1000), amr: ['passkey'] },
      });
      const lease = {
        claimChallengeRpc: async () => ({ claimed: true }),
        isClaimHeldRpc: async () => ({ held: true }),
        consumeChallengeRpc: async () => ({}),
      };
      env = {
        ALLOWED_ORIGINS: ORIGIN,
        ISSUER_URL: ORIGIN,
        PII_ENCRYPTION_KEY: ENCRYPTION_KEY,
        OTP_HMAC_SECRET: BACKUP_SECRET,
        SETTINGS: {
          get: async (key: string) =>
            key.endsWith(':authentication-methods')
              ? JSON.stringify({
                  'authentication-methods.totp.login_enabled': true,
                  'authentication-methods.totp.account_link_enabled': true,
                  'authentication-methods.totp.reauth_enabled': true,
                  'authentication-methods.email_otp.login_enabled': world.emailLogin,
                  'authentication-methods.passkey.login_enabled': true,
                })
              : null,
        },
        RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ incrementRpc: async () => ({ allowed: true }) }),
        },
        SESSION_REVOCATION_STORE: {
          idFromName: (name: string) => name,
          get: () => revocationStore(),
        },
        CHALLENGE_STORE: { idFromName: (name: string) => name, get: () => lease },
      } as unknown as Env;
      await seedUser();
      app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        const tenantId = c.req.header('X-Test-Tenant') ?? TENANT;
        const context = c as unknown as { set(key: string, value: unknown): void };
        context.set('tenantId', tenantId);
        context.set('tenantMetadataContext', {
          tenantId,
          coreDb: metadata.adapter,
          route: topology === 'single' ? {} : { allocationScope: topology },
        });
        // A single-database host still supplies an explicit account context; no helper fallback.
        if (topology === 'single')
          context.set('accountDataContext', accountContext(tenantId, USER));
        await next();
      });
      app.get('/api/account/totp', listAccountTotpCredentialsHandler);
      app.post('/api/account/totp/options', createAccountTotpOptionsHandler);
      app.post('/api/account/totp/activate', activateAccountTotpCredentialHandler);
      app.patch('/api/account/totp/:id', updateAccountTotpCredentialHandler);
      app.delete('/api/account/totp/:id', deleteAccountTotpCredentialHandler);
      app.post(
        '/api/account/totp/backup-codes/regenerate',
        regenerateAccountTotpBackupCodesHandler
      );
      app.post('/api/account/reauth/totp/complete', completeAccountTotpReauthHandler);
      app.post('/api/auth/totp/login/start', totpLoginStartHandler);
      app.post('/api/auth/totp/login/verify', totpLoginVerifyHandler);
    });

    afterEach(async () => {
      await Promise.all(world.afterResponse.splice(0));
      metadata.db.close();
      if (account !== metadata) account.db.close();
      pii.db.close();
      vi.useRealTimers();
    });

    it('enrolls, signs in, replaces backup codes and removes the same authoritative credential', async () => {
      const started = await request('/api/account/totp/options', 'POST', { label: 'Phone' });
      expect(started.status).toBe(201);
      const enrollment = await started.json<{
        credential: { id: string };
        secret: string;
        otpauth_uri: string;
        profile: TotpProfile;
      }>();
      expect(count(account, 'totp_credentials')).toBe(1);
      expect(decodeURIComponent(new URL(enrollment.otpauth_uri).pathname)).toContain(EMAIL);
      if (topology !== 'single') expect(count(metadata, 'totp_credentials')).toBe(0);
      const activated = await request('/api/account/totp/activate', 'POST', {
        credential_id: enrollment.credential.id,
        code: await code(enrollment.secret, enrollment.profile),
      });
      expect(activated.status).toBe(200);
      const originalCodes = await activated.json<{ backup_codes: string[] }>();
      expect(originalCodes.backup_codes).toHaveLength(10);
      const oldHash = await hashTotpBackupCode({
        tenantId: TENANT,
        userId: USER,
        code: originalCodes.backup_codes[0],
        secret: BACKUP_SECRET,
      });
      vi.setSystemTime(Date.now() + 30_000);
      expect((await login(enrollment.secret, enrollment.profile)).status).toBe(200);
      expect(world.createdSessions).toEqual([
        expect.objectContaining({ userId: USER, tenantId: TENANT }),
      ]);
      expect(world.hydrations).toEqual([{ tenantId: TENANT, userId: USER, lifecycle: 'active' }]);
      const oldBackups = backupSummary(account);
      const regenerated = await request('/api/account/totp/backup-codes/regenerate', 'POST', {});
      expect(regenerated.status).toBe(200);
      expect(backupSummary(account)).not.toEqual(oldBackups);
      const repository = new TotpCredentialRepository(account.adapter, TENANT);
      expect(await repository.consumeBackupCode(USER, oldHash)).toBeNull();
      world.emailLogin = true;
      const replacement = await regenerated.json<{ backup_codes: string[] }>();
      currentSession().data.amr = ['email'];
      expect(
        (
          await request(`/api/account/totp/${enrollment.credential.id}`, 'DELETE', {
            backup_code: replacement.backup_codes[0],
          })
        ).status
      ).toBe(200);
      expect(count(account, 'totp_credentials')).toBe(0);
      expect(count(account, 'totp_backup_codes')).toBe(0);
      expect(world.cleanups).toEqual([
        { tenantId: TENANT, userId: USER, credentialId: enrollment.credential.id },
      ]);
      expect((await login(enrollment.secret, enrollment.profile)).status).toBe(400);
      expect(world.audits.map((audit) => audit.action)).toEqual([
        'account.totp.enrollment_started',
        'account.totp.activated',
        'user.login',
        'account.totp.backup_codes_regenerated',
        'account.totp.removed',
      ]);
      if (topology !== 'single') {
        expect(count(metadata, 'totp_credentials')).toBe(0);
        expect(count(metadata, 'totp_backup_codes')).toBe(0);
      }
    });

    it('lists and renames only the session user and leaves metadata decoys untouched', async () => {
      await seedCredential('own');
      await seedCredential('other-user', { userId: OTHER_USER });
      await seedCredential('other-tenant', { tenantId: OTHER_TENANT });
      if (topology !== 'single') await seedCredential('metadata-decoy', { store: metadata });
      const metadataBefore = credentialSummary(metadata);
      const listed = await request('/api/account/totp');
      expect(listed.status).toBe(200);
      const body = await listed.json<{ credentials: Array<{ id: string }> }>();
      expect(body.credentials.map((credential) => credential.id)).toEqual(['own']);
      expect((await request('/api/account/totp/own', 'PATCH', { label: 'Renamed' })).status).toBe(
        200
      );
      expect(
        (await new TotpCredentialRepository(account.adapter, TENANT).findById('own'))?.label
      ).toBe('Renamed');
      if (topology !== 'single') expect(credentialSummary(metadata)).toEqual(metadataBefore);
    });

    it('refuses credential IDs from another user or tenant without mutations or audit success', async () => {
      await seedCredential('other-user', { userId: OTHER_USER, status: 'pending' });
      await seedCredential('other-tenant', { tenantId: OTHER_TENANT, status: 'pending' });
      const before = credentialSummary(account);
      for (const id of ['other-user', 'other-tenant']) {
        expect(
          (
            await request('/api/account/totp/activate', 'POST', {
              credential_id: id,
              code: await code(),
            })
          ).status
        ).toBe(404);
        expect(
          (await request(`/api/account/totp/${id}`, 'PATCH', { label: 'Denied' })).status
        ).toBe(404);
        expect(
          (await request(`/api/account/totp/${id}`, 'DELETE', { code: await code() })).status
        ).toBe(404);
      }
      expect(credentialSummary(account)).toEqual(before);
      expect(world.audits).toHaveLength(0);
    });

    it('uses the account for reauthentication hydration and rejects reuse of the accepted time step', async () => {
      await seedCredential('reauth');
      if (topology !== 'single') await seedCredential('metadata-decoy', { store: metadata });
      const before = credentialSummary(metadata);
      const proof = await code();
      expect(
        (await request('/api/account/reauth/totp/complete', 'POST', { code: proof })).status
      ).toBe(200);
      expect(world.hydrations).toEqual([{ tenantId: TENANT, userId: USER, lifecycle: 'active' }]);
      const credential = await new TotpCredentialRepository(account.adapter, TENANT).findById(
        'reauth'
      );
      expect(credential?.last_used_time_step).toBe(getTotpTimeStep(Date.now(), PROFILE.period));
      expect(world.sessions.get(SESSION)?.data.reauth_proven_amr).toEqual(['totp']);
      expect(
        (await request('/api/account/reauth/totp/complete', 'POST', { code: proof })).status
      ).toBe(400);
      expect(world.audits.map((audit) => audit.action)).toEqual(['account.totp.reauthenticated']);
      if (topology !== 'single') expect(credentialSummary(metadata)).toEqual(before);
    });

    it('checks the remaining login methods in the account before allowing active deletion', async () => {
      await seedCredential('last-method');
      // If only the safety helper still used metadata, this absent canonical account would make
      // the target look unusable and wrongly allow removal. The real account has one valid TOTP.
      if (topology !== 'single') await seedCredential('last-method', { store: metadata });
      currentSession().data.amr = ['totp'];
      const before = credentialSummary(account);
      const denied = await request('/api/account/totp/last-method', 'DELETE', {});
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: 'remaining_login_method_required' });
      expect(credentialSummary(account)).toEqual(before);
      expect(world.cleanups).toHaveLength(0);
      expect(world.audits).toHaveLength(0);
      world.emailLogin = true;
      expect((await request('/api/account/totp/last-method', 'DELETE', {})).status).toBe(200);
      expect(count(account, 'totp_credentials')).toBe(0);
    });

    it('verifies a fresh code when regenerating and consumes a backup code for active removal', async () => {
      await seedCredential('with-backups');
      currentSession().data.amr = ['email'];
      const regenerated = await request('/api/account/totp/backup-codes/regenerate', 'POST', {
        code: await code(),
      });
      expect(regenerated.status).toBe(200);
      const body = await regenerated.json<{ backup_codes: string[] }>();
      expect(body.backup_codes).toHaveLength(10);
      expect(count(account, 'totp_backup_codes')).toBe(10);
      const otherHash = await hashTotpBackupCode({
        tenantId: TENANT,
        userId: OTHER_USER,
        code: body.backup_codes[0],
        secret: BACKUP_SECRET,
      });
      expect(
        await new TotpCredentialRepository(account.adapter, TENANT).consumeBackupCode(
          USER,
          otherHash
        )
      ).toBeNull();
      world.emailLogin = true;
      expect(
        (
          await request('/api/account/totp/with-backups', 'DELETE', {
            backup_code: body.backup_codes[0],
          })
        ).status
      ).toBe(200);
      expect(count(account, 'totp_backup_codes')).toBe(0);
    });

    it('fails closed when account resolution fails or a session belongs to another tenant', async () => {
      await seedCredential('unchanged');
      const before = credentialSummary(account);
      world.routeFailure = true;
      expect((await request('/api/account/totp')).status).toBe(500);
      expect((await request('/api/account/totp/options', 'POST', {})).status).toBe(500);
      world.routeFailure = false;
      expect(
        (await request('/api/account/totp', 'GET', undefined, SESSION, OTHER_TENANT)).status
      ).toBe(401);
      expect(credentialSummary(account)).toEqual(before);
      expect(world.audits).toHaveLength(0);
    });
  }
);
