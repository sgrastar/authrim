import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { Hono } from 'hono';
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
  admin: DatabaseAdapter | undefined;
  core: DatabaseAdapter | undefined;
  auth: Record<string, unknown>;
  tenantId: string;
  /** The tenants that exist (the others are refused as share targets). */
  tenants: string[];
  audit: ReturnType<typeof vi.fn>;
}
const mocks = vi.hoisted(
  (): MockState => ({
    admin: undefined,
    core: undefined,
    auth: {},
    tenantId: 'tenant-a',
    tenants: ['tenant-a', 'tenant-b'],
    audit: vi.fn(),
  })
);

vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  writeAdminAuditLog: mocks.audit,
}));
vi.mock('../tenant-backup-writer', () => ({
  runTenantBackupCoveredMutation: (input: { run: () => Promise<Response> }) => input.run(),
}));
vi.mock('../account-page', () => ({
  requireAccountSession: vi.fn(async () => ({ userId: 'user-1' })),
}));
vi.mock('../account-operation-log', () => ({ recordAccountOperation: vi.fn() }));
vi.mock('../request-issuer', () => ({
  getRequestAwareIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    ensureDatabaseAdapter: vi.fn(() => ({
      query: async (_sql: string, ids: string[]) =>
        ids.filter((id) => mocks.tenants.includes(id)).map((id) => ({ id })),
    })),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    createAuditLogFromContext: vi.fn(),
    getTenantIdFromContext: vi.fn(() => mocks.tenantId),
    getRateLimitProfileAsync: vi.fn(async () => ({ profile: 'lenient' })),
    rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    createErrorResponse: vi.fn((c: { json: (body: unknown, status: number) => Response }) =>
      c.json({ error: 'forbidden' }, 403)
    ),
    getLogger: vi.fn(() => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    })),
  };
});

import {
  adminLauncherCreateHandler,
  adminLauncherCustomizationDeleteHandler,
  adminLauncherDeleteHandler,
  adminLauncherOrderHandler,
  adminLauncherUpdateHandler,
  adminLaunchersListHandler,
  getAccountLaunchersHandler,
} from '../launchers';
import { createPlatformLaunchersRouter } from '../routes/platform-launchers';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);
const CORE_MIGRATIONS = new URL('../../../../migrations/core/d1/', import.meta.url);
const ENV = { DB: {}, DB_ADMIN: {} };
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
  ...PLATFORM_ADMIN,
  userId: 'admin-1',
  roles: ['ar_super_admin'],
  globalRoles: [],
  tenantScope: ['tenant-a'],
};

function sqliteAdapter(db: Database): DatabaseAdapter {
  const run = (sql: string) => db.prepare(sql);
  const execute = async (sql: string, params: unknown[] = []) => ({
    rowsAffected: Number(run(sql).run(...params).changes),
    success: true,
  });
  return {
    query: async (sql: string, params: unknown[] = []) => run(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => run(sql).get(...params) ?? null,
    execute,
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await execute(statement.sql, statement.params ?? []));
        }
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
}

const platform = createPlatformLaunchersRouter();

function call(path: string, method = 'GET', body?: unknown) {
  return platform.request(
    path,
    {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV
  );
}

const tenant = new Hono();
tenant.get('/launchers', adminLaunchersListHandler);
tenant.post('/launchers', adminLauncherCreateHandler);
tenant.put('/launchers/order', adminLauncherOrderHandler);
tenant.put('/launchers/:id', adminLauncherUpdateHandler);
tenant.delete('/launchers/:id', adminLauncherDeleteHandler);
tenant.delete('/launchers/:id/customization', adminLauncherCustomizationDeleteHandler);
tenant.get('/account/launchers', getAccountLaunchersHandler);

function tenantCall(path: string, method = 'GET', body?: unknown) {
  return tenant.request(
    path,
    {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV
  );
}

function linkBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Handbook',
    launch_type: 'bookmark',
    launch_url: 'https://handbook.example.com/',
    icon_type: 'phosphor',
    icon_value: 'book-open',
    ...overrides,
  };
}

interface PlatformView {
  id: string;
  version: number;
  share_mode: string;
  tenant_ids: string[];
  tenant_change_allowed: boolean;
  name: string;
}
interface TenantItem {
  id: string;
  name: string;
  enabled: boolean;
  sort_order: number;
  shared: null | {
    customized: boolean;
    platform_updated: boolean;
    tenant_change_allowed: boolean;
    customized_from_version: number | null;
  };
}

async function createShared(overrides: Record<string, unknown> = {}): Promise<PlatformView> {
  mocks.auth = { ...PLATFORM_ADMIN };
  const response = await call('/', 'POST', linkBody({ share_mode: 'all', ...overrides }));
  expect(response.status).toBe(201);
  return (await response.json<{ launcher: PlatformView }>()).launcher;
}

async function tenantList(): Promise<TenantItem[]> {
  const response = await tenantCall('/launchers');
  expect(response.status).toBe(200);
  return (await response.json<{ launchers: TenantItem[] }>()).launchers;
}

beforeEach(() => {
  const admin = new DatabaseSync(':memory:');
  admin.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, '026_platform_launchers.sql'));
  mocks.admin = sqliteAdapter(admin);
  const core = new DatabaseSync(':memory:');
  core.exec(`CREATE TABLE application_launchers (
      tenant_id TEXT NOT NULL DEFAULT 'default', id TEXT NOT NULL, config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, id));
    CREATE TABLE launcher_favorites (
      tenant_id TEXT NOT NULL DEFAULT 'default', user_id TEXT NOT NULL, launcher_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, user_id, launcher_id));`);
  core.exec(readRenderedMigrationSql(CORE_MIGRATIONS, '014_shared_launcher_states.sql'));
  mocks.core = sqliteAdapter(core);
  mocks.auth = { ...PLATFORM_ADMIN };
  mocks.tenantId = 'tenant-a';
  mocks.tenants = ['tenant-a', 'tenant-b'];
  mocks.audit.mockClear();
});

describe('the platform’s launchers (platform API)', () => {
  it('are for platform administrators with a global assignment only', async () => {
    mocks.auth = { ...TENANT_ADMIN };
    expect((await call('/')).status).toBe(403);
    expect((await call('/', 'POST', linkBody())).status).toBe(403);
    // A global assignment without settings, beside a tenant-limited admin role: the tenant role
    // does not reach the platform's launchers.
    mocks.auth = {
      ...PLATFORM_ADMIN,
      roles: ['ar_viewer_custom', 'ar_tenant_admin'],
      globalRoles: ['ar_viewer_custom'],
    };
    expect((await call('/')).status).toBe(403);
  });

  it('are created unshared and changeable by default, and audited', async () => {
    const response = await call('/', 'POST', linkBody());
    expect(response.status).toBe(201);
    const { launcher } = await response.json<{ launcher: PlatformView }>();
    expect(launcher).toMatchObject({
      share_mode: 'none',
      tenant_ids: [],
      tenant_change_allowed: true,
      version: 1,
      application_type: 'standalone',
    });
    expect(launcher.id).toMatch(/^plc_/u);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'platform.launcher.created' })
    );
  });

  it('are plain links shown to everyone', async () => {
    const linked = await call(
      '/',
      'POST',
      linkBody({ application_type: 'oidc_client', application_id: 'client-1' })
    );
    expect(linked.status).toBe(400);
    const narrowed = await call(
      '/',
      'POST',
      linkBody({ visibility: { mode: 'users', user_ids: ['user-1'] } })
    );
    expect(narrowed.status).toBe(400);
  });

  it('are shared with existing tenants only, at least one', async () => {
    expect((await call('/', 'POST', linkBody({ share_mode: 'selected' }))).status).toBe(400);
    const unknown = await call(
      '/',
      'POST',
      linkBody({ share_mode: 'selected', tenant_ids: ['tenant-a', 'tenant-z'] })
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ tenant_ids: ['tenant-z'] });
    const created = await call(
      '/',
      'POST',
      linkBody({ share_mode: 'selected', tenant_ids: ['tenant-b', 'tenant-a', 'tenant-b'] })
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      launcher: { tenant_ids: ['tenant-a', 'tenant-b'] },
    });
  });

  it('are changed by version, with the tenant list replaced', async () => {
    const created = await createShared({ share_mode: 'selected', tenant_ids: ['tenant-a'] });
    const stale = await call(`/${created.id}`, 'PUT', { version: 9, name: 'X' });
    expect(stale.status).toBe(409);
    const changed = await call(`/${created.id}`, 'PUT', {
      version: created.version,
      name: 'Staff handbook',
      tenant_ids: ['tenant-b'],
      tenant_change_allowed: false,
    });
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toMatchObject({
      launcher: {
        name: 'Staff handbook',
        version: 2,
        tenant_ids: ['tenant-b'],
        tenant_change_allowed: false,
      },
    });
    const again = await call(`/${created.id}`, 'PUT', { version: 1, name: 'Old' });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ current_version: 2 });
  });

  it('stop at the platform’s most launchers', async () => {
    for (let index = 0; index < 100; index += 1) {
      expect((await call('/', 'POST', linkBody({ name: `L${index}` }))).status).toBe(201);
    }
    const refused = await call('/', 'POST', linkBody({ name: 'One too many' }));
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ error: 'limit_reached' });
    expect((await call('/')).status).toBe(200);
  });

  it('keep their place when a change names none (a move made meanwhile stays)', async () => {
    const first = await createShared({ name: 'First' });
    const second = await createShared({ name: 'Second' });
    await call('/order', 'PUT', { launcher_ids: [second.id, first.id] });
    // A change made from a read taken before the move, naming no place.
    await call(`/${first.id}`, 'PUT', { version: 1, description: 'Changed' });
    const { launchers } = await (await call('/')).json<{ launchers: PlatformView[] }>();
    expect(launchers.map((entry) => entry.id)).toEqual([second.id, first.id]);
  });

  it('are reordered without a new version, and deleted by version', async () => {
    const first = await createShared({ name: 'First' });
    const second = await createShared({ name: 'Second' });
    const ordered = await call('/order', 'PUT', { launcher_ids: [second.id, first.id] });
    expect(ordered.status).toBe(200);
    const { launchers } = await ordered.json<{ launchers: PlatformView[] }>();
    expect(launchers.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(launchers.every((entry) => entry.version === 1)).toBe(true);
    expect((await call('/order', 'PUT', { launcher_ids: [first.id] })).status).toBe(409);

    expect((await call(`/${first.id}?version=3`, 'DELETE')).status).toBe(409);
    expect((await call(`/${first.id}?version=1`, 'DELETE')).status).toBe(204);
    expect((await call(`/${first.id}`)).status).toBe(404);
  });

  it('accept an uploaded background image and refuse other addresses', async () => {
    const uploaded = await call(
      '/',
      'POST',
      linkBody({
        background_image_url:
          '/api/assets/_platform/login-ui/launcher-background/0f8fad5b-d9cb-469f-a165-70867728950e.webp',
        hide_icon: true,
        hide_name: true,
      })
    );
    expect(uploaded.status).toBe(201);
    await expect(uploaded.json()).resolves.toMatchObject({
      launcher: { hide_icon: true, hide_name: true },
    });
    for (const address of [
      'http://images.example.com/a.png',
      'javascript:alert(1)',
      '/api/assets/_platform/login-ui/logo/a.png',
      '/api/assets/../login-ui/launcher-background/a.png',
    ]) {
      const refused = await call('/', 'POST', linkBody({ background_image_url: address }));
      expect(refused.status).toBe(400);
    }
  });
});

describe('a tenant’s shared launchers', () => {
  it('lists the ones shared with it beside its own', async () => {
    const everyone = await createShared({ name: 'Everyone' });
    await createShared({ name: 'Only B', share_mode: 'selected', tenant_ids: ['tenant-b'] });
    await createShared({ name: 'Draft', share_mode: 'none' });
    const items = await tenantList();
    expect(items.map((item) => item.name)).toEqual(['Everyone']);
    expect(items[0]).toMatchObject({
      id: everyone.id,
      shared: { customized: false, platform_updated: false, tenant_change_allowed: true },
    });
  });

  it('makes a copy on change, notices a later platform change, and reverts', async () => {
    const shared = await createShared();
    const changed = await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Our handbook' });
    expect(changed.status).toBe(200);
    let [item] = await tenantList();
    expect(item).toMatchObject({
      name: 'Our handbook',
      shared: { customized: true, customized_from_version: 1, platform_updated: false },
    });

    mocks.auth = { ...PLATFORM_ADMIN };
    await call(`/${shared.id}`, 'PUT', { version: 1, description: 'Read me' });
    [item] = await tenantList();
    expect(item).toMatchObject({
      name: 'Our handbook',
      shared: { customized: true, platform_updated: true },
    });

    const reverted = await tenantCall(`/launchers/${shared.id}/customization`, 'DELETE');
    expect(reverted.status).toBe(200);
    [item] = await tenantList();
    expect(item).toMatchObject({ name: 'Handbook', shared: { customized: false } });
  });

  it('keeps a copy’s origin, and makes a new copy from the version the admin was shown', async () => {
    const shared = await createShared();
    mocks.auth = { ...PLATFORM_ADMIN };
    await call(`/${shared.id}`, 'PUT', { version: 1, description: 'Read me' });
    // The admin's page showed version 1; the platform is at 2 when the copy is saved.
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Ours', platform_version: 1 });
    let [item] = await tenantList();
    expect(item.shared).toMatchObject({ customized_from_version: 1, platform_updated: true });
    // Changing the copy again does not take over the platform's change.
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Ours again' });
    [item] = await tenantList();
    expect(item.shared).toMatchObject({ customized_from_version: 1, platform_updated: true });
  });

  it('writes only what a change changes: a hide keeps the copy, a change keeps the hide', async () => {
    const shared = await createShared();
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Ours' });
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { enabled: false });
    let [item] = await tenantList();
    expect(item).toMatchObject({ name: 'Ours', enabled: false });
    await tenantCall(`/launchers/${shared.id}/customization`, 'DELETE');
    [item] = await tenantList();
    expect(item).toMatchObject({ name: 'Handbook', enabled: false, shared: { customized: false } });
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Ours again' });
    [item] = await tenantList();
    expect(item).toMatchObject({ name: 'Ours again', enabled: false });
  });

  it('keeps favourites of a launcher the platform turned off for now', async () => {
    const shared = await createShared();
    const core = mocks.core;
    if (!core) throw new Error('core database missing');
    await core.execute(
      `INSERT INTO launcher_favorites (tenant_id, user_id, launcher_id, created_at)
       VALUES ('tenant-a', 'user-1', ?, 1)`,
      [shared.id]
    );
    mocks.auth = { ...PLATFORM_ADMIN };
    await call(`/${shared.id}`, 'PUT', { version: 1, enabled: false });
    expect((await tenantCall('/account/launchers')).status).toBe(200);
    const favorites = await core.query('SELECT launcher_id FROM launcher_favorites', []);
    expect(favorites).toEqual([{ launcher_id: shared.id }]);
  });

  it('does not offer a launcher the platform turned off', async () => {
    const shared = await createShared();
    mocks.auth = { ...PLATFORM_ADMIN };
    await call(`/${shared.id}`, 'PUT', { version: 1, enabled: false });
    expect(await tenantList()).toEqual([]);
    expect((await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'X' })).status).toBe(404);
    // Turned on again, it shows: no tenant hide was written meanwhile.
    await call(`/${shared.id}`, 'PUT', { version: 2, enabled: true });
    const [item] = await tenantList();
    expect(item).toMatchObject({ id: shared.id, enabled: true });
  });

  it('hides it without a copy, and refuses deleting it', async () => {
    const shared = await createShared();
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { enabled: false });
    const [item] = await tenantList();
    expect(item).toMatchObject({ enabled: false, shared: { customized: false } });
    expect((await tenantCall(`/launchers/${shared.id}`, 'DELETE')).status).toBe(409);
  });

  it('shows the platform’s launcher as it is while changes are not allowed', async () => {
    const shared = await createShared();
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Ours', enabled: false });
    mocks.auth = { ...PLATFORM_ADMIN };
    await call(`/${shared.id}`, 'PUT', { version: 1, tenant_change_allowed: false });

    const [item] = await tenantList();
    expect(item).toMatchObject({
      name: 'Handbook',
      enabled: true,
      shared: { tenant_change_allowed: false, customized: true },
    });
    expect((await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Again' })).status).toBe(
      403
    );
    // The copy is kept, set aside: it cannot be dropped either.
    expect((await tenantCall(`/launchers/${shared.id}/customization`, 'DELETE')).status).toBe(403);

    // Its place is still the tenant's.
    const own = await tenantCall('/launchers/order', 'PUT', { launcher_ids: [shared.id] });
    expect(own.status).toBe(200);
  });

  it('keeps a hide saved after a move was read (the move writes the place only)', async () => {
    const shared = await createShared();
    await tenantCall(`/launchers/${shared.id}`, 'PUT', { name: 'Ours', enabled: false });
    await tenantCall('/launchers/order', 'PUT', { launcher_ids: [shared.id] });
    const [item] = await tenantList();
    expect(item).toMatchObject({ name: 'Ours', enabled: false, shared: { customized: true } });
  });

  it('keeps shared favourites while the platform launchers cannot be read', async () => {
    const shared = await createShared();
    const core = mocks.core;
    if (!core) throw new Error('core database missing');
    await core.execute(
      `INSERT INTO launcher_favorites (tenant_id, user_id, launcher_id, created_at)
       VALUES ('tenant-a', 'user-1', ?, 1)`,
      [shared.id]
    );
    const working = mocks.admin;
    if (!working) throw new Error('admin database missing');
    mocks.admin = {
      ...working,
      query: async () => {
        throw new Error('admin database unavailable');
      },
    };
    const response = await tenantCall('/account/launchers');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ launchers: [] });
    mocks.admin = working;
    const favorites = await core.query('SELECT launcher_id FROM launcher_favorites', []);
    expect(favorites).toEqual([{ launcher_id: shared.id }]);
  });

  it('keeps a tenant to its most launchers, and deletes one without reading the rest', async () => {
    const core = mocks.core;
    if (!core) throw new Error('core database missing');
    const own = (id: string) =>
      JSON.stringify({
        id,
        application_type: 'standalone',
        application_id: null,
        name: id,
        launch_type: 'bookmark',
        launch_url: 'https://own.example.com/',
        icon_type: 'phosphor',
        icon_value: 'link',
      });
    // One over the most (as a race before the guarded insert could have left it).
    for (let index = 0; index <= 500; index += 1) {
      await core.execute(
        `INSERT INTO application_launchers (tenant_id, id, config_json, created_at, updated_at)
         VALUES ('tenant-a', ?, ?, 1, 1)`,
        [`own-${index}`, own(`own-${index}`)]
      );
    }
    expect((await tenantCall('/launchers')).status).toBe(500);
    expect((await tenantCall('/launchers/own-0', 'DELETE')).status).toBe(204);
    expect((await tenantCall('/launchers')).status).toBe(200);
    // At its most again: a new one is refused by the guarded insert.
    expect((await tenantCall('/launchers', 'POST', linkBody())).status).toBe(400);
  });

  it('orders the shared and own launchers together', async () => {
    const shared = await createShared();
    const core = mocks.core;
    if (!core) throw new Error('core database missing');
    await core.execute(
      `INSERT INTO application_launchers (tenant_id, id, config_json, created_at, updated_at)
       VALUES ('tenant-a', 'own-1', ?, 1, 1)`,
      [
        JSON.stringify({
          id: 'own-1',
          application_type: 'standalone',
          application_id: null,
          name: 'Own',
          launch_type: 'bookmark',
          launch_url: 'https://own.example.com/',
          icon_type: 'phosphor',
          icon_value: 'link',
          sort_order: 0,
        }),
      ]
    );
    const response = await tenantCall('/launchers/order', 'PUT', {
      launcher_ids: [shared.id, 'own-1'],
    });
    expect(response.status).toBe(200);
    expect((await tenantList()).map((item) => item.id)).toEqual([shared.id, 'own-1']);
  });

  it('reaches the account page with its tile settings, unless hidden', async () => {
    const shown = await createShared({
      name: 'Banner',
      background_image_url: 'https://images.example.com/banner.png',
      hide_icon: true,
      hide_name: true,
    });
    const hidden = await createShared({ name: 'Hidden' });
    await tenantCall(`/launchers/${hidden.id}`, 'PUT', { enabled: false });

    const response = await tenantCall('/account/launchers');
    expect(response.status).toBe(200);
    const { launchers } = await response.json<{ launchers: Array<Record<string, unknown>> }>();
    expect(launchers).toEqual([
      expect.objectContaining({
        id: shown.id,
        background_image_url: 'https://images.example.com/banner.png',
        hide_icon: true,
        hide_name: true,
        launch_href: `/api/account/launchers/${shown.id}/launch`,
      }),
    ]);
  });
});
