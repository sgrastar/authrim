/**
 * Where the protected customer profile (`/api/protected/customer-profiles/*`) reads and writes the
 * profile, for both allocation scopes, on real SQLite databases built from the migrations: the
 * tenant metadata database and the account's own Core and PII databases.
 *
 * The route resolved the account, then built its user store on the metadata database's Core and
 * the account's PII: a routed account is not in the metadata database, so the read was a 404 and
 * a delegated write found no profile to update.
 *
 * Real: the profile loader and updater, the context helpers, the canonical user store, step-up and
 * the idempotency middleware (on the metadata database). Fakes: Lookup (the account-id route, which
 * attaches the account context as the real resolver does), the grant token's verification and the
 * write actor's token introspection.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalRuntimeUserStore,
  DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  createProtectedCustomerProfileRouter,
  DEFAULT_USERINFO_PROTECTED_AUDIENCE,
} from '../protected-customer-profile';
import { createEnv, mintReceipt, patch } from './helpers/customer-profile-write-harness';
import { adapterOver, count, migrate, type RealSqlAdapter } from './helpers/real-sql';

const TENANT = 'tenant-a';
const USER = 'user-routed';
const EMAIL = 'routed@example.com';
const PII_ENCRYPTION_KEY = 'a'.repeat(64);

const world = vi.hoisted(() => ({
  accountCore: undefined as unknown,
  accountPii: undefined as unknown,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // The write actor signs in as the profile's own user.
    introspectTokenFromContext: vi.fn(async () => ({
      valid: true,
      claims: { sub: USER, aud: 'https://tenant.example.com', client_id: 'rp-1', scope: 'openid' },
    })),
    // Lookup: the account-id route, to the account's databases where the account exists.
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { set(key: string, value: unknown): void }, accountId: string) => {
        const userId = accountId.replace(/^account:/u, '');
        const exists = await (world.accountCore as DatabaseAdapter).queryOne(
          'SELECT 1 AS found FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
          [TENANT, userId]
        );
        if (!exists) throw new Error('account_data_route_not_found');
        const context = {
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
          userCacheScope: {
            storageProfileId: 'test',
            sourceGeneration: 'test',
            schemaVersion: 'test',
          },
          piiCacheMode: 'disabled',
        };
        c.set('accountDataContext', context);
        return context;
      }
    ),
  };
});

type Databases = {
  metadata: RealSqlAdapter;
  accountCore: RealSqlAdapter;
  accountPii: RealSqlAdapter;
};

/** An unsigned grant token: the route's token verification is replaced to decode it. */
function grantToken(): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const scope = {
    resource_class: 'customer_profile',
    resource_ids: [USER],
    detail_classes: ['profile_export'],
    audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
  };
  return `${encode({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${encode({
    authorization_details: [
      {
        type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
        grant_id: 'egr_1',
        request_id: 'apr_1',
        investigation_id: 'inv_1',
        request_surface: 'service_data',
        requested_action: 'detail_read',
        ...scope,
        redaction_level: 'masked',
        target_subject_type: 'user',
        target_subject_id: USER,
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        policy_preset: 'technical_debug_default',
        reuse_scope: 'request',
        partial_access_allowed: false,
      },
    ],
    authrim_elevation: {
      grant_id: 'egr_1',
      request_id: 'apr_1',
      investigation_id: 'inv_1',
      resource_class: 'customer_profile',
      redaction_level: 'masked',
      target_subject_type: 'user',
      target_subject_id: USER,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_audience: scope.audience,
      scope,
    },
    act: { sub: 'admin_user:admin-1', client_id: 'svc-client-1' },
    sub: USER,
    aud: scope.audience,
  })}.signature`;
}

function app(allocationScope: 'shared_pool' | 'tenant_exclusive', databases: Databases) {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    const context = c as unknown as { set(key: string, value: unknown): void };
    context.set('tenantId', TENANT);
    context.set('tenantMetadataContext', {
      tenantId: TENANT,
      coreDb: databases.metadata,
      route: { allocationScope, bindingRef: 'TDB_TENANT_CORE', ownerTenantId: null },
    });
    await next();
  });
  hono.route(
    '/api/protected/customer-profiles',
    createProtectedCustomerProfileRouter({
      verifyToken: async ({ token }) =>
        JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
          string,
          unknown
        >,
    })
  );
  return hono;
}

function withPiiKey(env: Env): Env {
  return { ...env, PII_ENCRYPTION_KEY } as Env;
}

describe.each(['shared_pool', 'tenant_exclusive'] as const)(
  'protected customer profile of a %s tenant (real SQL)',
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
      // The tenant, which the metadata database's idempotency keys reference.
      databases.metadata.raw
        .prepare(
          `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
           VALUES (?, ?, ?, 'Tenant A', 1, 1)`
        )
        .run(TENANT, TENANT, TENANT);
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
      databases.accountCore.raw
        .prepare(
          `UPDATE identity_accounts SET directory_publication_state = 'active'
            WHERE tenant_id = ? AND legacy_user_id = ?`
        )
        .run(TENANT, USER);
    });

    it('reads the profile from the account databases', async () => {
      const { env } = createEnv();
      const response = await app(allocationScope, databases).request(
        `http://localhost/api/protected/customer-profiles/${USER}`,
        { headers: { Authorization: `Bearer ${grantToken()}` } },
        withPiiKey(env)
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        redaction_level: 'masked',
        profile: { sub: USER, email: 'ro****@example.com' },
      });
    });

    it('writes a delegated profile update to the account databases', async () => {
      const { env: baseEnv } = createEnv();
      const env = withPiiKey(baseEnv);
      const hono = app(allocationScope, databases);
      const bodyInput = { name: 'Renamed User' };
      const receipt = await mintReceipt({
        env,
        actorId: USER,
        subjectUserId: USER,
        idempotencyKey: 'routed-write',
        bodyInput,
      });

      const response = await patch(hono, env, {
        userId: USER,
        idempotencyKey: 'routed-write',
        body: { input: bodyInput },
        receipt,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        customer_profile: { sub: USER, name: 'Renamed User' },
      });
      const stored = await new CanonicalRuntimeUserStore({
        coreAdapter: databases.accountCore,
        piiAdapter: databases.accountPii,
        tenantId: TENANT,
      }).findById(USER);
      expect(stored?.name).toBe('Renamed User');
      expect(count(databases.metadata.raw, 'SELECT COUNT(*) AS n FROM identity_accounts')).toBe(0);
    });
  }
);
