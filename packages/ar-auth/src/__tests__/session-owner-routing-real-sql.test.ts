/**
 * Real canonical Core/PII and context helpers; only Lookup and SessionStore are fixture doubles.
 * No account context is injected initially. The same-store case retains a verified owner route:
 * it is not a claim that the old unscoped/no-registry topology is supported.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalRuntimeUserStore, type DatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { adapterOver, migrate, type RealSqlAdapter } from './helpers/real-sql';

import { realOwnerRuntime } from './helpers/owner-runtime-registry';

const TENANT = 'default';
const USER = 'user_owned';
const EMAIL = 'owner@example.test';
const NAME = 'Account Owner';
const SESSION = 'g1:apac:1:session_owned';
const INTERACTION = 'int-owner-email';
const world = vi.hoisted(() => ({
  core: undefined as unknown,
  pii: undefined as unknown,
  routeError: null as string | null,
  actualResolver: false,
  actualResolverErrors: [] as Array<{ message: string; cause: unknown }>,
  tenantId: 'default',
  existingAccount: false,
  resolutions: [] as string[],
  session: null as null | {
    id: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
    data: { amr: string[]; authTime: number; runtime_interaction_id: string; acr: string };
  },
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
    getSessionStoreBySessionId: () => ({ stub: { getSessionRpc: async () => world.session } }),
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
      const normalized = `account:${id}`;
      const existing = c.get('accountDataContext') as
        | { tenantId: string; accountId: string }
        | undefined;
      if (
        tenantId !== TENANT ||
        (existing && (existing.tenantId !== tenantId || existing.accountId !== normalized))
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
        accountId: normalized,
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
    getLogger: () => ({ module: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }),
  };
});

function fixtureSession() {
  if (!world.session) throw new Error('fixture-session-required');
  return world.session;
}

import { sessionStatusHandler } from '../session-management';
import { getRecentVerifiedEmailSessionUserId } from '../login-runtime-flow';

type Stores = {
  metadata: RealSqlAdapter;
  metadataPii: RealSqlAdapter;
  account: RealSqlAdapter;
  pii: RealSqlAdapter;
};
async function seed(core: RealSqlAdapter, pii: RealSqlAdapter, email: string, name: string) {
  await new CanonicalRuntimeUserStore({
    coreAdapter: core,
    piiAdapter: pii,
    tenantId: TENANT,
  }).syncUser({
    userId: USER,
    email,
    name,
    active: true,
    emailVerified: true,
    userType: 'end_user',
    sourceRef: 'fixture',
    piiFields: { email: true, name: true },
    sensitiveValues: { email, name },
  });
  await core.execute(
    "UPDATE identity_accounts SET directory_publication_state='active' WHERE tenant_id=? AND legacy_user_id=?",
    [TENANT, USER]
  );
}

for (const topology of ['same_store', 'shared_pool', 'tenant_exclusive'] as const) {
  describe(`session profile and verified-email ownership: ${topology}`, () => {
    let stores: Stores;
    let app: Hono<{ Bindings: Env }>;
    const env = {
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
      await seed(stores.account, stores.pii, EMAIL, NAME);
      if (topology !== 'same_store') {
        await seed(
          stores.metadata,
          stores.metadataPii,
          'metadata-decoy@example.test',
          'Metadata Decoy'
        );
        await stores.metadata.execute(
          "UPDATE contact_points SET verification_state='unverified' WHERE tenant_id=?",
          [TENANT]
        );
      }
      const now = Math.floor(Date.now() / 1000);
      await stores.metadata.execute(
        `INSERT INTO flow_interactions
        (id,tenant_id,flow_id,flow_version_id,state,contract_hash,signature,expires_at,created_at,updated_at)
        VALUES(?,?,'flow-default-login-no-consent','flow-version-default-login-no-consent-v1','active','contract','signature',?,?,?)`,
        [INTERACTION, TENANT, now + 600, now, now]
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
          context.set('accountDataContext', { tenantId: TENANT, accountId: 'account:other-owner' });
        await next();
      });
      app.get('/status', sessionStatusHandler);
      app.get('/proof', async (c) =>
        c.json({
          userId: await getRecentVerifiedEmailSessionUserId(
            c,
            world.tenantId,
            Math.floor(Date.now() / 1000) - 60,
            INTERACTION
          ),
        })
      );
    }, 20_000);
    afterAll(() => {
      for (const store of new Set(Object.values(stores)))
        (store.raw as unknown as { close(): void }).close();
    });
    beforeEach(async () => {
      world.core = stores.account;
      world.pii = stores.pii;
      world.routeError = null;
      world.actualResolver = false;
      world.actualResolverErrors = [];
      world.tenantId = TENANT;
      world.existingAccount = false;
      world.resolutions = [];
      const now = Date.now();
      world.session = {
        id: SESSION,
        userId: USER,
        createdAt: now,
        expiresAt: now + 60_000,
        data: {
          amr: ['email_verification_protocol'],
          authTime: Math.floor(now / 1000),
          runtime_interaction_id: INTERACTION,
          acr: 'urn:fixture:assurance',
        },
      };
      await stores.account.execute(
        "UPDATE identity_accounts SET lifecycle_state='active',directory_publication_state='active' WHERE tenant_id=? AND legacy_user_id=?",
        [TENANT, USER]
      );
      await stores.account.execute(
        "UPDATE identity_subjects SET lifecycle_state='active' WHERE tenant_id=?",
        [TENANT]
      );
      await stores.account.execute(
        "UPDATE contact_points SET verification_state='verified' WHERE tenant_id=?",
        [TENANT]
      );
    });
    const request = (path: string, cookie = true) =>
      app.request(path, { headers: cookie ? { Cookie: `authrim_session=${SESSION}` } : {} }, env);
    const metadataState = async () => ({
      interaction: await stores.metadata.queryOne('SELECT * FROM flow_interactions WHERE id=?', [
        INTERACTION,
      ]),
      audits: await stores.metadata.query('SELECT * FROM flow_audit_events'),
    });

    it('reads the profile only from the owner and retains session assurance and lifetime', async () => {
      const before = await metadataState();
      const response = await request('/status');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        active: true,
        user_id: USER,
        email: EMAIL,
        name: NAME,
        session_id: SESSION,
        expires_at: fixtureSession().expiresAt,
        acr: 'urn:fixture:assurance',
        amr: ['email_verification_protocol'],
      });
      expect(world.resolutions).toEqual([USER]);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await metadataState()).toEqual(before);
    });
    it('does not resolve or read an account when profile was not requested', async () => {
      world.routeError = 'unexpected-owner-io';
      const response = await request('/status?include=basic');
      expect(await response.json()).toMatchObject({ active: true, user_id: USER });
      expect(world.resolutions).toEqual([]);
    });
    it('verifies the recent email proof against the owning account, leaving Flow state and audits in metadata', async () => {
      const before = await metadataState();
      const response = await request('/proof');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ userId: USER });
      expect(world.resolutions).toEqual([USER]);
      expect(await metadataState()).toEqual(before);
      expect(await stores.account.query('SELECT * FROM flow_audit_events')).toEqual([]);
    });
    it.each(['method', 'interaction', 'old', 'future', 'expired', 'absent'])(
      'rejects %s proof before account I/O',
      async (invalid) => {
        if (invalid === 'method') fixtureSession().data.amr = ['passkey'];
        if (invalid === 'interaction')
          fixtureSession().data.runtime_interaction_id = 'another-interaction';
        if (invalid === 'old') fixtureSession().data.authTime -= 120;
        if (invalid === 'future') fixtureSession().data.authTime += 120;
        if (invalid === 'expired') fixtureSession().expiresAt = Date.now() - 1;
        if (invalid === 'absent') world.session = null;
        expect(await (await request('/proof')).json()).toEqual({ userId: null });
        expect(world.resolutions).toEqual([]);
      }
    );
    it.each(['unverified', 'inactive'])(
      'does not verify the email of an %s owning account',
      async (invalid) => {
        if (invalid === 'unverified')
          await stores.account.execute(
            "UPDATE contact_points SET verification_state='unverified' WHERE tenant_id=?",
            [TENANT]
          );
        else
          await stores.account.execute(
            "UPDATE identity_subjects SET lifecycle_state='suspended' WHERE tenant_id=?",
            [TENANT]
          );
        expect(await (await request('/proof')).json()).toEqual({ userId: null });
        expect(world.resolutions).toEqual([USER]);
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
      'retains denial semantics for account state %s / publication %s',
      async (lifecycle, publication) => {
        await stores.account.execute(
          'UPDATE identity_accounts SET lifecycle_state=?,directory_publication_state=? WHERE tenant_id=? AND legacy_user_id=?',
          [lifecycle, publication, TENANT, USER]
        );
        const before = await metadataState();
        expect(await (await request('/proof')).json()).toEqual({ userId: null });
        const status = await request('/status');
        const profile = await status.json<Record<string, unknown>>();
        expect(profile.active).toBe(true);
        expect(profile).not.toHaveProperty('email');
        expect(profile).not.toHaveProperty('name');
        expect(await metadataState()).toEqual(before);
        expect(status.headers.get('set-cookie')).toBeNull();
      }
    );
    it.each([
      'account_data_route_not_found',
      'account_data_destination_account_invalid',
      'account_data_runtime_registry_unavailable',
    ])('fails closed on %s without using the metadata decoy', async (failure) => {
      world.routeError = failure;
      const status = await request('/status');
      const body = await status.json<Record<string, unknown>>();
      expect(status.status).toBe(200);
      expect(body.active).toBe(true);
      expect(body).not.toHaveProperty('email');
      expect(body).not.toHaveProperty('name');
      const before = await metadataState();
      expect((await request('/proof')).status).toBe(500);
      expect(await metadataState()).toEqual(before);
      expect(status.headers.get('set-cookie')).toBeNull();
    });
    it('uses the actual signed-registry resolver to read the owner for profile and verified-email proof', async () => {
      Object.assign(
        env,
        await realOwnerRuntime(
          stores.account,
          stores.pii,
          topology === 'tenant_exclusive' ? topology : 'shared_pool'
        )
      );
      world.actualResolver = true;
      const before = await metadataState();
      expect(await (await request('/proof')).json()).toEqual({ userId: USER });
      expect(await (await request('/status')).json()).toMatchObject({
        active: true,
        email: EMAIL,
        name: NAME,
      });
      expect(world.actualResolverErrors).toEqual([]);
      expect(await metadataState()).toEqual(before);
    });
    it.each(['suspended', 'unpublished'])(
      'preserves denial when the actual destination resolver classifies the owner as %s',
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
        const before = await metadataState();
        const proof = await request('/proof');
        expect(proof.status).toBe(200);
        expect(await proof.json()).toEqual({ userId: null });
        const profile = await request('/status');
        expect(profile.status).toBe(200);
        const body = await profile.json<Record<string, unknown>>();
        expect(body.active).toBe(true);
        expect(body).not.toHaveProperty('email');
        expect(body).not.toHaveProperty('name');
        expect(world.actualResolverErrors).toEqual([
          { message: 'lookup_destination_revalidation_failed', cause: 'account_inactive' },
          { message: 'lookup_destination_revalidation_failed', cause: 'account_inactive' },
        ]);
        expect(await metadataState()).toEqual(before);
        expect(profile.headers.get('set-cookie')).toBeNull();
      }
    );
    it.each(['foreign-membership', 'missing-membership', 'wrong-shard'])(
      'does not normalize the actual %s routing failure into an inactive-account denial',
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
        expect((await request('/proof')).status).toBe(500);
        const body = await (await request('/status')).json<Record<string, unknown>>();
        expect(body.active).toBe(true);
        expect(body).not.toHaveProperty('email');
        expect(world.actualResolverErrors).toHaveLength(2);
        expect(world.actualResolverErrors.every((e) => e.cause !== 'account_inactive')).toBe(true);
      }
    );
    it.each(['foreign-tenant', 'conflicting-owner'])(
      'does not expose a %s account',
      async (invalid) => {
        if (invalid === 'foreign-tenant') world.tenantId = 'foreign-tenant';
        else world.existingAccount = true;
        const response = await request('/status');
        const body = await response.json<Record<string, unknown>>();
        expect(body.active).toBe(true);
        expect(body).not.toHaveProperty('email');
        expect(body).not.toHaveProperty('name');
        expect((await request('/proof')).status).toBe(500);
      }
    );
    it('does no owner I/O for an expired or absent session', async () => {
      fixtureSession().expiresAt = Date.now() - 1;
      expect(await (await request('/status')).json()).toMatchObject({
        active: false,
        error: 'session_expired',
      });
      expect(await (await request('/status', false)).json()).toMatchObject({
        active: false,
        error: 'no_session',
      });
      expect(world.resolutions).toEqual([]);
    });
  });
}
