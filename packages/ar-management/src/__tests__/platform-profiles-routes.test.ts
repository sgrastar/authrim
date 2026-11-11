import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
}
const DatabaseSync = SqliteDatabase as unknown as new (path: string) => Database;

interface MockState {
  adapter: DatabaseAdapter | undefined;
  auth: Record<string, unknown>;
  tenantId: string;
  audit: ReturnType<typeof vi.fn>;
  /** Tenants whose Flows name a profile; tenants whose Core database cannot be read. */
  naming: Set<string>;
  unreadable: Set<string>;
  switches: Record<string, boolean>;
}
const mocks = vi.hoisted(
  (): MockState => ({
    adapter: undefined,
    auth: {},
    tenantId: 'tenant-a',
    audit: vi.fn(),
    naming: new Set<string>(),
    unreadable: new Set<string>(),
    switches: {},
  })
);

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.audit }));
vi.mock('../routes/settings-v2/settings-support', () => ({
  getSettingsManager: () => ({
    getAll: async (category: string) => ({ version: `${category}-1`, values: {}, sources: {} }),
  }),
}));
vi.mock('../tenant-backup-writer', () => ({
  runTenantBackupCoveredMutation: (input: { run: () => Promise<Response> }) => input.run(),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    readProfileSwitch: vi.fn(
      async (_env: unknown, kind: string, name: string) => mocks.switches[`${kind}.${name}`] ?? true
    ),
    ensureDatabaseAdapter: vi.fn(() => ({
      query: async () => [{ id: 'tenant-a' }, { id: 'tenant-b' }, { id: 'tenant-c' }],
    })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (_env: unknown, _partition: string, { tenantId }: { tenantId: string }) =>
        mocks.unreadable.has(tenantId)
          ? null
          : { queryOne: async () => (mocks.naming.has(tenantId) ? { hit: 1 } : null) }
    ),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: { queryOne: async () => null },
    })),
    getRateLimitProfileAsync: vi.fn(async () => ({ profile: 'lenient' })),
    rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    getTenantIdFromContext: vi.fn(() => mocks.tenantId),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    createErrorResponse: vi.fn((c: { json: (body: unknown, status: number) => Response }) =>
      c.json({ error: 'forbidden' }, 403)
    ),
  };
});

import { createPlatformProfilesRouter } from '../routes/platform-profiles';
import { sessionProfilesRouter } from '../routes/admin-management/session-profiles';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);
const PLATFORM_ADMIN = {
  userId: 'op-1',
  authMethod: 'session',
  actorType: 'human',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  permissions: ['admin:settings:read', 'admin:settings:write'],
  globalPermissions: [],
  tenantScope: ['*'],
  tenantId: 'tenant-a',
};
const TENANT_ADMIN = {
  userId: 'admin-1',
  authMethod: 'session',
  actorType: 'human',
  roles: ['ar_tenant_admin'],
  globalRoles: [],
  permissions: ['admin:settings:read', 'admin:settings:write'],
  globalPermissions: [],
  tenantScope: ['tenant-a'],
  tenantId: 'tenant-a',
};

const platform = createPlatformProfilesRouter('session');

function request(
  router: ReturnType<typeof createPlatformProfilesRouter>,
  method: string,
  path: string,
  body?: unknown
) {
  return router.request(
    path,
    {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB: {} }
  );
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  for (const file of [
    '013_authentication_method_profiles.sql',
    '014_session_profiles.sql',
    '015_platform_profiles.sql',
  ]) {
    db.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, file));
  }
  const run = (sql: string) => db.prepare(sql);
  mocks.adapter = {
    query: async (sql: string, params: unknown[] = []) => run(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => run(sql).get(...params) ?? null,
    execute: async (sql: string, params: unknown[] = []) => ({
      rowsAffected: Number(run(sql).run(...params).changes),
      success: true,
    }),
  } as unknown as DatabaseAdapter;
  mocks.auth = { ...PLATFORM_ADMIN };
  mocks.audit.mockClear();
  mocks.naming = new Set();
  mocks.unreadable = new Set();
  mocks.switches = {};
});

async function createPlatformProfile(
  values: Record<string, unknown> = { 'session.default_ttl': 600_000 }
) {
  mocks.auth = { ...PLATFORM_ADMIN };
  const response = await request(platform, 'POST', '/', { name: 'Short', values });
  expect(response.status).toBe(201);
  return (await response.json<{ profile: { id: string; version: number } }>()).profile;
}

describe('the platform’s profiles (platform API)', () => {
  it('are for platform administrators with a global assignment only', async () => {
    mocks.auth = { ...TENANT_ADMIN };
    expect((await request(platform, 'GET', '/')).status).toBe(403);
    expect((await request(platform, 'POST', '/', { name: 'X', values: {} })).status).toBe(403);
    // A role given for one tenant does not reach every tenant's profiles.
    mocks.auth = { ...TENANT_ADMIN, roles: ['ar_super_admin'] };
    expect((await request(platform, 'GET', '/')).status).toBe(403);
  });

  it('are created, changed by version, locked, and audited', async () => {
    const profile = await createPlatformProfile();
    expect(profile.id.startsWith('psp_')).toBe(true);
    const changed = await request(platform, 'PUT', `/${profile.id}`, {
      name: 'Shorter',
      values: { 'session.default_ttl': 300_000 },
      version: 1,
    });
    expect(changed.status).toBe(200);
    const stale = await request(platform, 'PUT', `/${profile.id}`, {
      name: 'Again',
      values: {},
      version: 1,
    });
    expect(stale.status).toBe(409);
    const locked = await request(platform, 'PUT', `/${profile.id}/lock`, {
      locked: true,
      version: 2,
    });
    expect(locked.status).toBe(200);
    expect(await locked.json()).toMatchObject({ profile: { locked: true, version: 3 } });
    expect(mocks.audit.mock.calls.map(([, entry]) => (entry as { action: string }).action)).toEqual(
      [
        'platform.session_profile.created',
        'platform.session_profile.updated',
        'platform.session_profile.locked',
      ]
    );
  });

  it('refuse a setting that names something of one tenant', async () => {
    const method = createPlatformProfilesRouter('method');
    const response = await request(method, 'POST', '/', {
      name: 'Social',
      values: { 'authentication-methods.external_provider_usage': [] },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      rejected: {
        'authentication-methods.external_provider_usage':
          'A platform profile cannot hold a setting that names something of one tenant',
      },
    });
  });

  it('are not deleted while a tenant’s Flow names them, or when a tenant cannot be read', async () => {
    const profile = await createPlatformProfile();
    mocks.naming = new Set(['tenant-b']);
    const inUse = await request(platform, 'DELETE', `/${profile.id}`);
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({ error: 'profile_in_use', tenants: ['tenant-b'] });
    mocks.naming = new Set();
    mocks.unreadable = new Set(['tenant-c']);
    const incomplete = await request(platform, 'DELETE', `/${profile.id}`);
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({ error: 'reference_check_incomplete' });
    // Refused, it is usable again (not left marked as being deleted).
    const after = await request(platform, 'GET', `/${profile.id}`);
    expect(await after.json()).toMatchObject({ profile: { state: 'active' } });
    mocks.unreadable = new Set();
    expect((await request(platform, 'DELETE', `/${profile.id}`)).status).toBe(204);
    expect((await request(platform, 'GET', `/${profile.id}`)).status).toBe(404);
  });
});

describe('deleting a platform profile', () => {
  it('is refused while another delete of it is under way', async () => {
    const profile = await createPlatformProfile();
    const { PlatformProfileRepository } = await import('@authrim/ar-lib-core');
    const repo = new PlatformProfileRepository(mocks.adapter as DatabaseAdapter, 'session');
    expect(await repo.claimDeleting(profile.id, 'other-operation')).toBe(true);
    const second = await request(platform, 'DELETE', `/${profile.id}`);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'delete_in_progress' });
    // The first operation's claim is untouched.
    expect((await repo.find(profile.id))?.state).toBe('deleting');
  });

  it('hides it from the platform and the tenants, and stops new copies', async () => {
    const profile = await createPlatformProfile();
    expect((await request(platform, 'DELETE', `/${profile.id}`)).status).toBe(204);
    expect((await request(platform, 'GET', `/${profile.id}`)).status).toBe(404);
    const listed = await (await request(platform, 'GET', '/')).json<{ profiles: unknown[] }>();
    expect(listed.profiles).toEqual([]);
    mocks.auth = { ...TENANT_ADMIN };
    expect((await request(sessionProfilesRouter, 'GET', `/${profile.id}`)).status).toBe(404);
    const copy = await request(sessionProfilesRouter, 'PUT', `/${profile.id}`, {
      values: {},
      version: null,
    });
    expect(copy.status).toBe(404);
  });

  it('records the lock state a change was made from', async () => {
    const profile = await createPlatformProfile();
    await request(platform, 'PUT', `/${profile.id}/lock`, { locked: true, version: 1 });
    mocks.audit.mockClear();
    // Locked again (no change of state): recorded as locked before and after.
    await request(platform, 'PUT', `/${profile.id}/lock`, { locked: true, version: 2 });
    expect(mocks.audit.mock.calls[0][1]).toMatchObject({
      before: { locked: true },
      after: { locked: true },
    });
  });
});

describe('a platform profile as a tenant sees and changes it', () => {
  it('is listed with what holds for the tenant, and changed into the tenant’s copy', async () => {
    const profile = await createPlatformProfile();
    mocks.auth = { ...TENANT_ADMIN };
    const listed = await request(sessionProfilesRouter, 'GET', '/');
    const { profiles } = await listed.json<{ profiles: Array<Record<string, unknown>> }>();
    expect(profiles.find((p) => p.id === profile.id)).toMatchObject({
      scope: 'platform',
      values: { 'session.default_ttl': 600_000 },
      version: null,
      editable: true,
      overridden: false,
    });

    const copied = await request(sessionProfilesRouter, 'PUT', `/${profile.id}`, {
      values: { 'session.default_ttl': 300_000 },
      version: null,
    });
    expect(copied.status).toBe(200);
    expect(await copied.json()).toMatchObject({
      profile: { overridden: true, values: { 'session.default_ttl': 300_000 }, version: 1 },
    });

    // The platform changes it: the tenant keeps its copy and is told.
    mocks.auth = { ...PLATFORM_ADMIN };
    await request(platform, 'PUT', `/${profile.id}`, {
      name: 'Short',
      values: { 'session.default_ttl': 900_000 },
      version: 1,
    });
    mocks.auth = { ...TENANT_ADMIN };
    const seen = await request(sessionProfilesRouter, 'GET', `/${profile.id}`);
    expect(await seen.json()).toMatchObject({
      profile: {
        values: { 'session.default_ttl': 300_000 },
        platform_updated: true,
        platform_version: 2,
      },
    });

    // Back to the platform's.
    const removed = await request(sessionProfilesRouter, 'DELETE', `/${profile.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      profile: { overridden: false, values: { 'session.default_ttl': 900_000 } },
    });
  });

  it('cannot be changed when locked or when the platform does not allow it; the copy is set aside', async () => {
    const profile = await createPlatformProfile();
    mocks.auth = { ...TENANT_ADMIN };
    await request(sessionProfilesRouter, 'PUT', `/${profile.id}`, {
      values: { 'session.default_ttl': 300_000 },
      version: null,
    });
    mocks.switches = { 'session.tenant_change_allowed': false };
    const refused = await request(sessionProfilesRouter, 'PUT', `/${profile.id}`, {
      values: { 'session.default_ttl': 100_000 },
      version: 1,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: 'changes_not_allowed' });
    const seen = await request(sessionProfilesRouter, 'GET', `/${profile.id}`);
    expect(await seen.json()).toMatchObject({
      profile: {
        values: { 'session.default_ttl': 600_000 },
        override_inactive: true,
        override_inactive_reason: 'changes_not_allowed',
        editable: false,
      },
    });
    mocks.switches = {};
    mocks.auth = { ...PLATFORM_ADMIN };
    await request(platform, 'PUT', `/${profile.id}/lock`, { locked: true, version: 1 });
    mocks.auth = { ...TENANT_ADMIN };
    const locked = await request(sessionProfilesRouter, 'PUT', `/${profile.id}`, {
      values: {},
      version: 1,
    });
    expect(await locked.json()).toMatchObject({ reason: 'locked' });
  });

  it('leaves the tenant’s own profiles creatable only with the platform’s leave', async () => {
    mocks.auth = { ...TENANT_ADMIN };
    mocks.switches = { 'session.tenant_create_allowed': false };
    const refused = await request(sessionProfilesRouter, 'POST', '/', {
      name: 'Mine',
      values: {},
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'profile_creation_not_allowed' });
  });
});
