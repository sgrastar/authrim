/**
 * Real clients, canonical Core/PII, context helpers and SQL single-consumption artifact.
 * Lookup, DPoP proof validation, rate limiting and SessionStore are explicit fixture doubles.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalRuntimeUserStore, type DatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { adapterOver, migrate, type RealSqlAdapter } from './helpers/real-sql';

import { realOwnerRuntime } from './helpers/owner-runtime-registry';

const TENANT = 'default';
const USER = 'user_owned';
const CLIENT = 'client_owned';
const AS_SESSION = 'g1:apac:1:session_as_owner';
const RP_SESSION = 'g1:apac:1:session_rp_owner';
const ORIGIN = 'https://rp.example.test';
const world = vi.hoisted(() => ({
  metadata: undefined as unknown,
  core: undefined as unknown,
  pii: undefined as unknown,
  routeError: null as string | null,
  actualResolver: false,
  logErrors: [] as Array<unknown>,
  actualResolverErrors: [] as Array<{ message: string; cause: unknown }>,
  tenantId: 'default',
  providerEnabled: true,
  sessionActive: true,
  existingAccount: false,
  resolutions: [] as string[],
  created: [] as Array<{
    id: string;
    userId: string;
    ttl: number;
    data: Record<string, unknown>;
    tenantId: string;
  }>,
}));

vi.mock('../../../ar-lib-core/dist/services/lookup-directory', async (load) => {
  const actual = await load<typeof import('../../../ar-lib-core/dist/services/lookup-directory')>();
  return {
    ...actual,
    createLookupBlindIndexes: vi.fn(async () => [
      {
        indexKind: 'account_id',
        normalizationVersion: 1,
        hmacKeyGeneration: 1,
        digest: 'a'.repeat(64),
        virtualBucket: 42,
      },
    ]),
    loadVerifiedLookupHmacKeyState: vi.fn(async () => ({})),
    resolveLookupHmacKeys: vi.fn(async () => ({ readKeys: [{}], writeKeys: [{}] })),
    loadVerifiedLookupBucketAssignmentProvider: vi.fn(async () => ({
      resolveActiveAssignment: vi.fn(async () => ({
        virtualBucket: 42,
        assignmentGeneration: 1,
        lookupShardId: 'lookup-owner',
        bindingRef: 'LOOKUP_OWNER',
        state: 'active',
      })),
    })),
  };
});

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true }),
    extractDPoPProof: () => 'fixture-proof',
    validateDPoPProof: async () => ({ valid: true, jkt: 'fixture-jkt' }),
    resolveEffectiveSettings: async () => ({}),
    readExternalProviderUsagePolicy: async () => ({
      loginEnabled: world.providerEnabled,
      signupEnabled: true,
    }),
    resolvePostLoginRedirectUrl: async () => ({ redirectUrl: '/account', behavior: 'home' }),
    getSessionStoreBySessionId: () => ({
      stub: {
        getSessionRpc: async (id: string) =>
          id === AS_SESSION && world.sessionActive
            ? {
                id,
                userId: USER,
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                data: {
                  amr: ['external_idp'],
                  acr: 'urn:fixture:assurance',
                  upstream_acr: 'upstream-assurance',
                  reauth_proven_amr: ['external_idp'],
                  reauth_proven_at: 1_800_000_000_000,
                },
              }
            : null,
      },
    }),
    getSessionStoreForNewSession: async () => ({
      sessionId: RP_SESSION,
      stub: {
        createSessionRpc: async (
          id: string,
          userId: string,
          ttl: number,
          data: Record<string, unknown>,
          tenantId: string
        ) => {
          world.created.push({ id, userId, ttl, data, tenantId });
          return { id };
        },
      },
    }),
    getChallengeStoreByChallengeId: async () => ({
      consumeChallengeRpc: async (input: { id: string; tenantId: string; type: string }) => {
        const metadata = world.metadata as DatabaseAdapter;
        const changed = await metadata.execute(
          'UPDATE fixture_handoff SET consumed=1 WHERE id=? AND tenant_id=? AND consumed=0 AND type=?',
          [input.id, input.tenantId, input.type]
        );
        if (changed.rowsAffected !== 1) throw new Error('challenge_not_found_or_consumed');
        const row = await metadata.queryOne<{
          challenge: string;
          user_id: string;
          metadata_json: string;
        }>('SELECT * FROM fixture_handoff WHERE id=? AND tenant_id=?', [input.id, input.tenantId]);
        if (!row) throw new Error('challenge_not_found');
        return {
          challenge: row.challenge,
          userId: row.user_id,
          metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
        };
      },
    }),
    resolveAccountDataContextFromHono: async (
      c: { get(key: string): unknown; set(key: string, value: unknown): void },
      accountId: string
    ) => {
      world.resolutions.push(accountId);
      if (world.actualResolver) {
        try {
          return await actual.resolveAccountDataContextFromHono(
            c as Parameters<typeof actual.resolveAccountDataContextFromHono>[0],
            accountId
          );
        } catch (error) {
          if (error instanceof Error)
            world.actualResolverErrors.push({ message: error.message, cause: error.cause });
          throw error;
        }
      }
      if (world.routeError) throw new Error(world.routeError);
      const tenantId = c.get('tenantId');
      const id = accountId.replace(/^account:/u, '');
      const existing = c.get('accountDataContext') as
        | { tenantId: string; accountId: string }
        | undefined;
      if (
        tenantId !== TENANT ||
        (existing && (existing.tenantId !== tenantId || existing.accountId !== `account:${id}`))
      )
        throw new Error('account_data_context_conflict');
      const core = world.core as DatabaseAdapter;
      const row = await core.queryOne<{
        id: string;
        lifecycle_state: string;
        directory_publication_state: string;
      }>(
        'SELECT id,lifecycle_state,directory_publication_state FROM identity_accounts WHERE tenant_id=? AND legacy_user_id=?',
        [tenantId, id]
      );
      if (!row) throw new Error('account_data_route_not_found');
      if (row.lifecycle_state !== 'active' || row.directory_publication_state !== 'active')
        throw new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' });
      const resolved = {
        tenantId,
        accountId: `account:${id}`,
        legacyUserId: id,
        membership: {},
        coreDb: core,
        piiDb: world.pii,
        coreBindingRef: 'TDB_USERS_1',
        piiBindingRef: 'TDB_PII_1',
        coreResidencyPartition: 'default',
        piiResidencyPartition: 'default',
        accountRouteGeneration: 1,
        userCacheScope: { routeGeneration: '1', bindingGeneration: '1', schemaGeneration: '1' },
        piiCacheMode: 'no_cross_request_pii',
      };
      c.set('accountDataContext', resolved);
      return resolved;
    },
    getLogger: () => ({
      module: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: (_message: string, fields: unknown) => {
          world.logErrors.push(fields);
        },
        debug: vi.fn(),
      }),
    }),
  };
});

import { handleHandoffFinalize, handleHandoffVerify } from '../handlers/handoff';
type Stores = {
  metadata: RealSqlAdapter;
  metadataPii: RealSqlAdapter;
  account: RealSqlAdapter;
  pii: RealSqlAdapter;
};
async function seed(core: RealSqlAdapter, pii: RealSqlAdapter, email: string) {
  await new CanonicalRuntimeUserStore({
    coreAdapter: core,
    piiAdapter: pii,
    tenantId: TENANT,
  }).syncUser({
    userId: USER,
    email,
    name: 'Owned User',
    active: true,
    emailVerified: true,
    userType: 'end_user',
    sourceRef: 'fixture',
    piiFields: { email: true, name: true },
    sensitiveValues: { email, name: 'Owned User' },
  });
  await core.execute(
    "UPDATE identity_accounts SET directory_publication_state='active' WHERE tenant_id=? AND legacy_user_id=?",
    [TENANT, USER]
  );
}
async function seedClient(core: RealSqlAdapter, redirect = `${ORIGIN}/callback`) {
  await core.execute(
    `INSERT INTO oauth_clients(client_id,tenant_id,client_name,redirect_uris,grant_types,response_types,created_at,updated_at)
    VALUES(?,?,'Fixture RP',?,'["authorization_code"]','["code"]',1,1)`,
    [CLIENT, TENANT, JSON.stringify([redirect])]
  );
}

for (const topology of ['same_store', 'shared_pool', 'tenant_exclusive'] as const) {
  describe(`handoff verified-artifact owner: ${topology}`, () => {
    let stores: Stores;
    let app: Hono<{ Bindings: Env }>;
    const env = {
      ENVIRONMENT: 'production',
      SETTINGS: { get: async () => null },
      ISSUER_URL: 'https://auth.example.test',
    } as unknown as Env;
    beforeAll(async () => {
      const metadata = adapterOver(migrate('core'));
      const metadataPii = adapterOver(migrate('pii'));
      stores = {
        metadata,
        metadataPii,
        account: topology === 'same_store' ? metadata : adapterOver(migrate('core')),
        pii: topology === 'same_store' ? metadataPii : adapterOver(migrate('pii')),
      };
      await seed(stores.account, stores.pii, 'owner@example.test');
      await seedClient(stores.metadata);
      if (topology !== 'same_store') {
        await seed(stores.metadata, stores.metadataPii, 'decoy@example.test');
        await stores.metadata.execute(
          "UPDATE identity_accounts SET lifecycle_state='suspended' WHERE tenant_id=? AND legacy_user_id=?",
          [TENANT, USER]
        );
        await seedClient(stores.account, 'https://wrong-owner.example.test/callback');
      }
      stores.metadata.raw.exec(
        'CREATE TABLE fixture_handoff(id TEXT PRIMARY KEY,tenant_id TEXT,type TEXT,challenge TEXT,user_id TEXT,metadata_json TEXT,consumed INTEGER DEFAULT 0)'
      );
      app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        const context = c as unknown as { set(key: string, value: unknown): void };
        context.set('tenantId', world.tenantId);
        context.set('tenantMetadataContext', {
          tenantId: world.tenantId,
          coreDb: stores.metadata,
          route: {
            allocationScope: topology === 'tenant_exclusive' ? topology : 'shared_pool',
            bindingRef: 'TDB_METADATA',
          },
        });
        if (world.existingAccount)
          context.set('accountDataContext', {
            tenantId: TENANT,
            accountId: 'account:another-owner',
          });
        await next();
      });
      app.post('/verify', handleHandoffVerify);
      app.post('/finalize', handleHandoffFinalize);
    }, 20_000);
    afterAll(() => {
      for (const db of new Set(Object.values(stores)))
        (db.raw as unknown as { close(): void }).close();
    });
    beforeEach(async () => {
      world.metadata = stores.metadata;
      world.core = stores.account;
      world.pii = stores.pii;
      world.routeError = null;
      world.actualResolver = false;
      world.actualResolverErrors = [];
      world.logErrors = [];
      world.tenantId = TENANT;
      world.providerEnabled = true;
      world.sessionActive = true;
      world.existingAccount = false;
      world.resolutions = [];
      world.created = [];
      await stores.account.execute(
        "UPDATE identity_accounts SET lifecycle_state='active',directory_publication_state='active' WHERE tenant_id=? AND legacy_user_id=?",
        [TENANT, USER]
      );
      await stores.metadata.execute('DELETE FROM fixture_handoff');
      await stores.metadata.execute(
        'INSERT INTO fixture_handoff(id,tenant_id,type,challenge,user_id,metadata_json) VALUES(?,?,?,?,?,?)',
        [
          'handoff:fixture-token',
          TENANT,
          'handoff',
          AS_SESSION,
          USER,
          JSON.stringify({
            client_id: CLIENT,
            state: 'fixture-state',
            aud: 'handoff',
            created_at: Date.now(),
            external_provider_usage_key: { providerId: 'provider-owned', ids: ['provider-owned'] },
          }),
        ]
      );
    });
    const request = (
      path = '/verify?include=session,user',
      body: Record<string, string> = {},
      origin = ORIGIN
    ) =>
      app.request(
        path,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: origin, DPoP: 'fixture-proof' },
          body: JSON.stringify({
            handoff_token: 'fixture-token',
            state: 'fixture-state',
            client_id: CLIENT,
            ...body,
          }),
        },
        env
      );

    it('reads the client from metadata and the user from its owner, issuing a distinct DPoP RP session', async () => {
      const response = await request();
      expect(response.status, JSON.stringify(world.logErrors)).toBe(200);
      const body = await response.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        token_type: 'DPoP',
        access_token: RP_SESSION,
        user: { id: USER, email: 'owner@example.test', emailVerified: true },
        session: { id: RP_SESSION, userId: USER },
      });
      expect(body.access_token).not.toBe(AS_SESSION);
      expect(world.resolutions).toEqual([USER]);
      expect(world.created).toHaveLength(1);
      expect(world.created[0]).toMatchObject({
        id: RP_SESSION,
        userId: USER,
        tenantId: TENANT,
        data: {
          audience: 'rp',
          source_session_id: AS_SESSION,
          cnf: { jkt: 'fixture-jkt' },
          amr: ['external_idp'],
          acr: 'urn:fixture:assurance',
          upstream_acr: 'upstream-assurance',
          reauth_proven_amr: ['external_idp'],
          reauth_proven_at: 1_800_000_000_000,
        },
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect((await request()).status).toBeGreaterThanOrEqual(400);
      expect(world.created).toHaveLength(1);
    });
    it('retains cookie-only finalize, post-login redirect and the separate RP session', async () => {
      const response = await request('/finalize');
      expect(response.status, JSON.stringify(world.logErrors)).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, redirect_url: '/account' });
      expect(response.headers.get('set-cookie')).toContain(
        `authrim_session=${encodeURIComponent(RP_SESSION)}`
      );
      expect(response.headers.get('set-cookie')).not.toContain(encodeURIComponent(AS_SESSION));
      expect(world.created[0].data.token_type).toBe('Cookie');
      expect(world.created[0].data).not.toHaveProperty('cnf');
      expect(world.resolutions).toEqual([USER]);
    });
    it.each(['state', 'client', 'origin', 'session', 'provider'])(
      'rejects invalid %s before owner lookup or RP session creation',
      async (invalid) => {
        if (invalid === 'session') world.sessionActive = false;
        if (invalid === 'provider') world.providerEnabled = false;
        const response = await request(
          undefined,
          invalid === 'state'
            ? { state: 'wrong' }
            : invalid === 'client'
              ? { client_id: 'wrong-client' }
              : {},
          invalid === 'origin' ? 'https://untrusted.example.test' : ORIGIN
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(world.resolutions).toEqual([]);
        expect(world.created).toEqual([]);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    );
    it.each([
      ['suspended', 'active'],
      ['locked', 'active'],
      ['deleting', 'active'],
      ['deleted', 'active'],
      ['active', 'pending'],
      ['active', 'active_pending_directory'],
      ['active', 'disabled'],
    ])(
      'retains invalid-credentials response for account state %s / publication %s',
      async (lifecycle, publication) => {
        await stores.account.execute(
          'UPDATE identity_accounts SET lifecycle_state=?,directory_publication_state=? WHERE tenant_id=? AND legacy_user_id=?',
          [lifecycle, publication, TENANT, USER]
        );
        const response = await request();
        expect(response.status).toBe(400);
        expect(world.created).toEqual([]);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(JSON.stringify(await response.json())).not.toContain('owner@example.test');
      }
    );
    it.each([
      'account_data_route_not_found',
      'account_data_destination_account_invalid',
      'account_data_runtime_registry_unavailable',
    ])('fails closed on %s without a metadata user fallback', async (failure) => {
      world.routeError = failure;
      const response = await request();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(world.resolutions).toEqual([USER]);
      expect(world.created).toEqual([]);
      expect(response.headers.get('set-cookie')).toBeNull();
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain('owner@example.test');
      expect(body).not.toContain('decoy@example.test');
    });
    it('uses the actual signed-registry owner resolver before creating an RP session', async () => {
      Object.assign(
        env,
        await realOwnerRuntime(
          stores.account,
          stores.pii,
          topology === 'tenant_exclusive' ? topology : 'shared_pool'
        )
      );
      world.actualResolver = true;
      const response = await request();
      expect(response.status, JSON.stringify(world.logErrors)).toBe(200);
      expect(await response.json()).toMatchObject({
        user: { email: 'owner@example.test' },
        access_token: RP_SESSION,
      });
      expect(world.actualResolverErrors).toEqual([]);
      expect(world.created).toHaveLength(1);
    });
    it.each(['suspended', 'unpublished'])(
      'returns invalid credentials for actual destination owner state %s without issuing an RP session',
      async (invalid) => {
        Object.assign(
          env,
          await realOwnerRuntime(
            stores.account,
            stores.pii,
            topology === 'tenant_exclusive' ? topology : 'shared_pool'
          )
        );
        world.actualResolver = true;
        await stores.account.execute(
          invalid === 'suspended'
            ? "UPDATE identity_accounts SET lifecycle_state='suspended' WHERE tenant_id=? AND legacy_user_id=?"
            : "UPDATE identity_accounts SET directory_publication_state='pending' WHERE tenant_id=? AND legacy_user_id=?",
          [TENANT, USER]
        );
        const response = await request();
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error_code: 'AR030001' });
        expect(world.actualResolverErrors).toEqual([
          { message: 'lookup_destination_revalidation_failed', cause: 'account_inactive' },
        ]);
        expect(world.created).toEqual([]);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    );
    it.each(['foreign-membership', 'missing-membership', 'wrong-shard'])(
      'keeps actual %s routing failures distinct from invalid credentials and never issues a session',
      async (invalid) => {
        Object.assign(
          env,
          await realOwnerRuntime(
            stores.account,
            stores.pii,
            topology === 'tenant_exclusive' ? topology : 'shared_pool',
            {
              lookupTenantId: invalid === 'foreign-membership' ? 'foreign-tenant' : TENANT,
              missingMembership: invalid === 'missing-membership',
            }
          )
        );
        world.actualResolver = true;
        if (invalid === 'wrong-shard')
          await stores.account.execute(
            "UPDATE authrim_control_plane_shard_metadata SET binding_ref='AUTHRIM_TDB_WRONG_OWNER' WHERE singleton_id=1"
          );
        const response = await request();
        expect(response.status).toBe(500);
        expect(world.actualResolverErrors).toHaveLength(1);
        expect(world.actualResolverErrors[0]?.cause).not.toBe('account_inactive');
        expect(world.created).toEqual([]);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    );
    it.each(['foreign-tenant', 'conflicting-owner'])(
      'does not resolve or issue a session for %s',
      async (invalid) => {
        if (invalid === 'foreign-tenant') world.tenantId = 'foreign-tenant';
        else world.existingAccount = true;
        const response = await request('/finalize');
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(world.created).toEqual([]);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    );
  });
}
