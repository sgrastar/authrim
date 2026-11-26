/**
 * What a delegated customer profile update leaves in the account's databases, on real SQLite
 * databases built from the migrations: the address members that remain, a full address clear, the
 * stored email value (and the lookup by it) and the verified state.
 *
 * Real: the profile updater, the canonical user store, step-up and idempotency. Fakes: Lookup (the
 * account route) and the write actor's token introspection.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalRuntimeUserStore, type Env } from '@authrim/ar-lib-core';
import { createProtectedCustomerProfileRouter } from '../protected-customer-profile';
import { createEnv, mintReceipt, patch } from './helpers/customer-profile-write-harness';
import { adapterOver, migrate, type RealSqlAdapter } from './helpers/real-sql';

const TENANT = 'tenant-a';
const USER = 'user-update';
const EMAIL = 'update@example.com';
const PII_ENCRYPTION_KEY = 'a'.repeat(64);

const world = vi.hoisted(() => ({
  accountCore: undefined as RealSqlAdapter | undefined,
  accountPii: undefined as RealSqlAdapter | undefined,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    introspectTokenFromContext: vi.fn(async () => ({
      valid: true,
      claims: { sub: USER, aud: 'https://tenant.example.com', client_id: 'rp-1', scope: 'openid' },
    })),
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { set(key: string, value: unknown): void }, accountId: string) => {
        const userId = accountId.replace(/^account:/u, '');
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

let metadata: RealSqlAdapter;
let accountCore: RealSqlAdapter;
let accountPii: RealSqlAdapter;
let counter = 0;

function store(): CanonicalRuntimeUserStore {
  return new CanonicalRuntimeUserStore({
    coreAdapter: accountCore,
    piiAdapter: accountPii,
    tenantId: TENANT,
  });
}

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    const context = c as unknown as { set(key: string, value: unknown): void };
    context.set('tenantId', TENANT);
    context.set('tenantMetadataContext', {
      tenantId: TENANT,
      coreDb: metadata,
      route: { allocationScope: 'shared_pool', bindingRef: 'TDB_TENANT_CORE', ownerTenantId: null },
    });
    await next();
  });
  hono.route(
    '/api/protected/customer-profiles',
    createProtectedCustomerProfileRouter({ verifyToken: async () => ({}) })
  );
  return hono;
}

async function update(input: Record<string, unknown>): Promise<Response> {
  counter += 1;
  const { env: baseEnv } = createEnv();
  const env = { ...baseEnv, PII_ENCRYPTION_KEY } as Env;
  const idempotencyKey = `update-real-sql-${counter}`;
  const receipt = await mintReceipt({
    env,
    actorId: USER,
    subjectUserId: USER,
    idempotencyKey,
    bodyInput: input,
  });
  return patch(app(), env, { userId: USER, idempotencyKey, body: { input }, receipt });
}

async function storedAddress(): Promise<Record<string, unknown> | null> {
  const stored = await store().findById(USER);
  return stored?.address_json ? (JSON.parse(stored.address_json) as Record<string, unknown>) : null;
}

describe('customer profile update, as persisted (real SQL)', () => {
  beforeEach(async () => {
    metadata = adapterOver(migrate('core'));
    accountCore = adapterOver(migrate('core'));
    accountPii = adapterOver(migrate('pii'));
    world.accountCore = accountCore;
    world.accountPii = accountPii;
    metadata.raw
      .prepare(
        `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
         VALUES (?, ?, ?, 'Tenant A', 1, 1)`
      )
      .run(TENANT, TENANT, TENANT);
    await store().syncUser({
      userId: USER,
      email: EMAIL,
      name: 'Update User',
      active: true,
      emailVerified: true,
      userType: 'end_user',
      sourceRef: 'test',
      piiFields: { email: true, name: true },
      sensitiveValues: { email: EMAIL, name: 'Update User' },
      addressJson: JSON.stringify({
        street_address: '1 Main St',
        locality: 'Springfield',
        country: 'US',
      }),
    });
    accountCore.raw
      .prepare(
        `UPDATE identity_accounts SET directory_publication_state = 'active'
          WHERE tenant_id = ? AND legacy_user_id = ?`
      )
      .run(TENANT, USER);
  });

  it('keeps the address members that the update does not send', async () => {
    const response = await update({ address: { locality: 'Shelbyville' } });
    expect(response.status).toBe(200);
    expect(await storedAddress()).toEqual({
      street_address: '1 Main St',
      locality: 'Shelbyville',
      country: 'US',
    });
  });

  it('clears one member sent as null and keeps the rest', async () => {
    const response = await update({ address: { street_address: null } });
    expect(response.status).toBe(200);
    expect(await storedAddress()).toEqual({
      street_address: null,
      locality: 'Springfield',
      country: 'US',
    });
  });

  it('removes the whole stored address when address is null', async () => {
    const response = await update({ address: null });
    expect(response.status).toBe(200);
    expect(await storedAddress()).toBeNull();
    const body = await response.json<{ customer_profile: { address: unknown } }>();
    expect(body.customer_profile.address).toBeNull();
  });

  it('stores a re-cased email in the form the lookup uses and keeps it verified', async () => {
    const response = await update({ email: '  UPDATE@Example.com ' });
    expect(response.status).toBe(200);
    const stored = await store().findById(USER);
    expect(stored?.email).toBe(EMAIL);
    expect(Boolean(stored?.email_verified)).toBe(true);
    expect((await store().findByEmail(EMAIL))?.id).toBe(USER);
  });

  it('stores a changed email normalized, unverified, and finds the account by it', async () => {
    const response = await update({ email: 'New.Address@Example.com' });
    expect(response.status).toBe(200);
    const stored = await store().findById(USER);
    expect(stored?.email).toBe('new.address@example.com');
    expect(Boolean(stored?.email_verified)).toBe(false);
    expect((await store().findByEmail('new.address@example.com'))?.id).toBe(USER);
    expect(await store().findByEmail(EMAIL)).toBeNull();
  });
});
