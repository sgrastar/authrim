import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
const DatabaseSync = SqliteDatabase as unknown as new (path: string) => Database;

/** The tenant's `login-ui` settings document, standing in for the settings save. */
interface FakeDocument {
  own: Record<string, unknown>;
  revision: number;
  /** Saves that fail with a version conflict before one succeeds. */
  staleSaves: number;
  saves: Array<{ ifMatch: string; set: Record<string, unknown>; clear: string[] }>;
  /** Dry runs (the trial before the save), counted apart from the saves. */
  trials: number;
  /** Keys the settings refuse (as a value a tenant's settings no longer accept would be). */
  refuseKeys: string[];
}

const mocks = vi.hoisted(() => {
  const state: {
    adapter?: DatabaseAdapter;
    auth: Record<string, unknown>;
    tenantId: string;
    document: FakeDocument;
    refuseSave?: Response;
  } = {
    auth: {},
    tenantId: 'tenant-a',
    document: { own: {}, revision: 1, staleSaves: 0, saves: [], trials: 0, refuseKeys: [] },
  };
  return { state, writeAdminAuditLog: vi.fn(), limited: [] as string[] };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('../routes/settings-v2/settings-support', () => ({
  getSettingsManager: () => ({
    getAll: async () => ({
      version: `rev-${mocks.state.document.revision}`,
      values: { ...mocks.state.document.own },
    }),
  }),
}));

vi.mock('../routes/settings-v2/tenant-settings-apply', () => ({
  applyTenantSettingsChange: async (input: {
    dryRun?: boolean;
    readBody: () => Promise<{ ifMatch: string; set: Record<string, unknown>; clear: string[] }>;
  }) => {
    const document = mocks.state.document;
    if (mocks.state.refuseSave) return mocks.state.refuseSave;
    const body = await input.readBody();
    if (input.dryRun) document.trials += 1;
    else document.saves.push(body);
    if (document.staleSaves > 0 || body.ifMatch !== `rev-${document.revision}`) {
      // The document moved on since its version was read.
      if (document.staleSaves > 0) {
        document.staleSaves -= 1;
        document.revision += 1;
      }
      return Response.json(
        { error: 'conflict', currentVersion: `rev-${document.revision}` },
        { status: 409 }
      );
    }
    const rejected = Object.fromEntries(
      document.refuseKeys.filter((key) => key in body.set).map((key) => [key, 'refused'])
    );
    const set = Object.fromEntries(Object.entries(body.set).filter(([key]) => !(key in rejected)));
    if (!input.dryRun) {
      for (const key of body.clear) delete document.own[key];
      Object.assign(document.own, set);
      document.revision += 1;
    }
    return Response.json({
      version: `rev-${document.revision}`,
      applied: Object.keys(set),
      cleared: body.clear,
      disabled: [],
      rejected,
      ...(input.dryRun ? { dryRun: true } : {}),
    });
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.state.adapter),
    getRateLimitProfileAsync: vi.fn(async (_env: unknown, profile: string) => ({ profile })),
    rateLimitMiddleware:
      (options: { profile: string }) => async (_c: unknown, next: () => Promise<void>) => {
        mocks.limited.push(options.profile);
        await next();
      },
    getTenantIdFromContext: vi.fn(() => mocks.state.tenantId),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.state.auth);
        await next();
      },
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status: number) => Response },
        code: string,
        options?: { extensions?: Record<string, unknown> }
      ) => c.json({ error: 'error', error_code: code, ...options?.extensions }, status[code] ?? 500)
    ),
  };
});

import { loginUIThemesRouter } from '../routes/admin-management/login-ui-themes';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);

function database(): { db: Database; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  db.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, '009_login_ui_themes.sql'));
  const run = (sql: string) => db.prepare(sql);
  const adapter = {
    query: async (sql: string, params: unknown[] = []) => run(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => run(sql).get(...params) ?? null,
    execute: async (sql: string, params: unknown[] = []) => ({
      rowsAffected: Number(run(sql).run(...params).changes),
      success: true,
    }),
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

const ADMIN = {
  userId: 'admin-1',
  sessionId: 'sess-1',
  authMethod: 'session',
  actorType: 'human',
  roles: ['ar_tenant_admin'],
  globalRoles: [],
  permissions: ['admin:settings:read', 'admin:settings:login_ui:update'],
  globalPermissions: [],
  tenantScope: ['tenant-a'],
  tenantId: 'tenant-a',
};

/** The request arrives on another tenant, for an admin of that tenant. */
function onTenant(tenantId: string) {
  mocks.state.tenantId = tenantId;
  mocks.state.auth = { ...ADMIN, tenantId, tenantScope: [tenantId] };
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return loginUIThemesRouter.request(
    path,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {}
  );
}

interface ThemeBody {
  theme: {
    id: string;
    name: string;
    values: Record<string, unknown>;
    version: number;
    created_by: string | null;
  };
}

async function createTheme(name: string, values: Record<string, unknown> = {}) {
  const response = await call('POST', '/', { name, values });
  expect(response.status).toBe(201);
  return (await response.json<ThemeBody>()).theme;
}

describe('login UI theme routes', () => {
  let db: Database;

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = database());
    mocks.state.adapter = adapter;
    mocks.state.tenantId = 'tenant-a';
    mocks.state.auth = ADMIN;
    mocks.state.document = {
      own: {},
      revision: 1,
      staleSaves: 0,
      saves: [],
      trials: 0,
      refuseKeys: [],
    };
    mocks.state.refuseSave = undefined;
    mocks.writeAdminAuditLog.mockReset();
    mocks.limited.length = 0;
  });

  it('limits requests as the settings do: lenient to read, moderate to change', async () => {
    await call('GET', '/');
    await call('POST', '/', { name: 'X', values: {} });
    expect(mocks.limited).toEqual(['lenient', 'moderate']);
  });

  it('lists themes without their values', async () => {
    await createTheme('T', { 'login-ui.template': 'split', 'login-ui.brand_name': 'Acme' });
    const listed = await (await call('GET', '/')).json<{ themes: Record<string, unknown>[] }>();
    expect(listed.themes[0]).toMatchObject({ name: 'T', template: 'split', palette: null });
    expect(listed.themes[0]).not.toHaveProperty('values');
  });

  it('starts empty and answers with no-store', async () => {
    const response = await call('GET', '/');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ themes: [], active: null });
  });

  it('creates, lists, reads, updates and deletes a theme', async () => {
    const created = await call('POST', '/', {
      name: '  Night split  ',
      values: { 'login-ui.template': 'split', 'login-ui.palette': 'glass' },
    });
    expect(created.status).toBe(201);
    const { theme } = await created.json<ThemeBody>();
    expect(theme).toMatchObject({
      name: 'Night split',
      values: { 'login-ui.template': 'split', 'login-ui.palette': 'glass' },
      version: 1,
      created_by: 'admin-1',
    });
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'login_ui.theme.created', resourceId: theme.id })
    );

    await createTheme('Plain');
    const list = await (
      await call('GET', '/')
    ).json<{
      themes: Array<{ name: string; template: string | null; palette: string | null }>;
    }>();
    expect(list.themes).toHaveLength(2);
    expect(list.themes.find((t) => t.name === 'Night split')).toMatchObject({
      template: 'split',
      palette: 'glass',
      version: 1,
    });
    expect(list.themes.find((t) => t.name === 'Plain')).toMatchObject({
      template: null,
      palette: null,
    });

    const got = await call('GET', `/${theme.id}`);
    expect(await got.json()).toMatchObject({ theme: { id: theme.id }, active: false });

    const updated = await call(
      'PUT',
      `/${theme.id}`,
      { name: 'Night', values: { 'login-ui.template': 'minimal' } },
      { 'If-Match': '"1"' }
    );
    expect(updated.status).toBe(200);
    expect((await updated.json<ThemeBody>()).theme).toMatchObject({
      name: 'Night',
      values: { 'login-ui.template': 'minimal' },
      version: 2,
    });
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'login_ui.theme.updated' })
    );

    const deleted = await call('DELETE', `/${theme.id}`);
    expect(deleted.status).toBe(204);
    expect((await call('GET', `/${theme.id}`)).status).toBe(404);
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'login_ui.theme.deleted' })
    );
  });

  it('keeps bar colours and dark images through save, read, update and apply', async () => {
    const colours = {
      'login-ui.brand_panel_background_color': '#090d1e61',
      'login-ui.theme_toggle_background_color': '#111111',
      'login-ui.language_select_background_color': '#f0f0f0',
      'login-ui.header_background_color': '#11223380',
      'login-ui.header_text_color': '#fefefe',
      'login-ui.footer_background_color': '#445566',
      'login-ui.footer_text_color': '#eeeeee',
      'login-ui.dark_images': JSON.stringify({
        logo: '',
        background: 'https://example.com/dark-bg.png',
        form_area: '',
      }),
    };
    const created = await call('POST', '/', { name: 'Bars', values: colours });
    expect(created.status).toBe(201);
    const { theme } = await created.json<ThemeBody>();
    expect(
      (await (await call('GET', `/${theme.id}`)).json<ThemeBody>()).theme.values
    ).toMatchObject(colours);

    const changed = {
      ...colours,
      'login-ui.brand_panel_background_color': '#01020380',
      'login-ui.theme_toggle_background_color': '#eeeeee',
      'login-ui.language_select_background_color': '#222222',
      'login-ui.footer_background_color': '#66778899',
      'login-ui.dark_images': JSON.stringify({
        logo: 'https://example.com/dark-logo.png',
        background: '',
        form_area: '',
      }),
    };
    const updated = await call(
      'PUT',
      `/${theme.id}`,
      { name: 'Bars', values: changed },
      { 'If-Match': '"1"' }
    );
    expect(updated.status).toBe(200);
    expect(
      (await (await call('GET', `/${theme.id}`)).json<ThemeBody>()).theme.values
    ).toMatchObject(changed);
    expect((await call('POST', `/${theme.id}/apply`, { version: 2 })).status).toBe(200);
    expect(mocks.state.document.own).toMatchObject(changed);
  });

  it('keeps the tenants apart', async () => {
    const theme = await createTheme('Mine', { 'login-ui.template': 'split' });
    onTenant('tenant-b');
    expect(await (await call('GET', '/')).json()).toEqual({ themes: [], active: null });
    expect((await call('GET', `/${theme.id}`)).status).toBe(404);
    expect(
      (await call('PUT', `/${theme.id}`, { name: 'x', values: {} }, { 'If-Match': '"1"' })).status
    ).toBe(404);
    expect((await call('DELETE', `/${theme.id}`)).status).toBe(404);
    expect((await call('POST', `/${theme.id}/apply`)).status).toBe(404);
    // The same name is free in another tenant.
    await createTheme('Mine');
    onTenant('tenant-a');
    expect((await call('GET', `/${theme.id}`)).status).toBe(200);
  });

  it('refuses unknown keys and invalid values, naming the keys', async () => {
    const unknown = await call('POST', '/', {
      name: 'x',
      values: { 'login-ui.default_locale': 'en', 'login-ui.template': 'split' },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      error: 'invalid_request',
      rejected_keys: ['login-ui.default_locale'],
    });

    const bad = await call('POST', '/', {
      name: 'x',
      values: {
        'login-ui.template': 'wide',
        'login-ui.header_enabled': 'yes',
        'login-ui.background_image_opacity': 500,
        'login-ui.accent_color': '#fff',
      },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json<{ rejected_keys: string[] }>()).rejected_keys.sort()).toEqual([
      'login-ui.background_image_opacity',
      'login-ui.header_enabled',
      'login-ui.template',
    ]);

    const css = await call('POST', '/', {
      name: 'x',
      values: { 'login-ui.custom_css': '@import url(https://evil.example/x.css);' },
    });
    expect(css.status).toBe(400);
    expect(await css.json()).toMatchObject({ rejected_keys: ['login-ui.custom_css'] });

    expect((await call('POST', '/', { name: 'x', values: [] })).status).toBe(400);
    expect((await call('POST', '/', { name: 'x' })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM login_ui_themes').get()).toEqual({ n: 0 });
  });

  it('checks the name: length, case-insensitive uniqueness, and the per-tenant limit', async () => {
    expect((await call('POST', '/', { name: '   ', values: {} })).status).toBe(400);
    expect((await call('POST', '/', { name: 'a'.repeat(81), values: {} })).status).toBe(400);
    expect((await call('POST', '/', { name: 'a'.repeat(80), values: {} })).status).toBe(201);

    await createTheme('Brand');
    const duplicate = await call('POST', '/', { name: ' BRAND ', values: {} });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: 'theme_name_taken' });

    const other = await createTheme('Other');
    const rename = await call(
      'PUT',
      `/${other.id}`,
      { name: 'brand', values: {} },
      { 'If-Match': '"1"' }
    );
    expect(rename.status).toBe(409);
    expect(await rename.json()).toMatchObject({ error: 'theme_name_taken' });
    // Keeping its own name (changing the case only) is allowed.
    expect(
      (await call('PUT', `/${other.id}`, { name: 'OTHER', values: {} }, { 'If-Match': '"1"' }))
        .status
    ).toBe(200);

    // 3 themes so far; fill up to 50.
    for (let i = 3; i < 50; i++) await createTheme(`Theme ${i}`);
    const full = await call('POST', '/', { name: 'One too many', values: {} });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: 'theme_limit_reached' });
    // Another tenant has its own allowance.
    onTenant('tenant-b');
    await createTheme('Fresh');
  });

  it('requires If-Match to update and refuses a stale version', async () => {
    const theme = await createTheme('T');
    const body = { name: 'T2', values: { 'login-ui.template': 'split' } };

    const missing = await call('PUT', `/${theme.id}`, body);
    expect(missing.status).toBe(428);
    expect((await call('PUT', `/${theme.id}`, body, { 'If-Match': 'abc' })).status).toBe(400);

    expect((await call('PUT', `/${theme.id}`, body, { 'If-Match': '"1"' })).status).toBe(200);
    const stale = await call('PUT', `/${theme.id}`, body, { 'If-Match': '"1"' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current_version: 2 });
    expect((await call('PUT', `/${theme.id}`, body, { 'If-Match': '"2"' })).status).toBe(200);
  });

  it('applies a theme: sets its keys, clears the other theme keys, records the theme', async () => {
    mocks.state.document.own = {
      'login-ui.template': 'standard',
      'login-ui.accent_color': '#112233',
      'login-ui.footer_text': 'Old footer',
      'login-ui.default_locale': 'ja',
    };
    const theme = await createTheme('Split', {
      'login-ui.template': 'split',
      'login-ui.palette': 'glass',
    });

    const applied = await call('POST', `/${theme.id}/apply`);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({
      active: { theme_id: theme.id, version: 1 },
      settings_version: 'rev-2',
    });

    const save = mocks.state.document.saves[0];
    expect(save.ifMatch).toBe('rev-1');
    expect(save.set).toMatchObject({
      'login-ui.template': 'split',
      'login-ui.palette': 'glass',
      'login-ui.active_theme_id': theme.id,
      'login-ui.active_theme_version': 1,
    });
    // Every theme key the theme does not hold is cleared; keys outside the theme are untouched.
    expect(save.clear).toContain('login-ui.accent_color');
    expect(save.clear).toContain('login-ui.footer_text');
    expect(save.clear).not.toContain('login-ui.template');
    expect(save.clear).not.toContain('login-ui.default_locale');
    expect(mocks.state.document.own).toEqual({
      'login-ui.template': 'split',
      'login-ui.palette': 'glass',
      'login-ui.default_locale': 'ja',
      'login-ui.active_theme_id': theme.id,
      'login-ui.active_theme_version': 1,
    });
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'login_ui.theme.applied', resourceId: theme.id })
    );

    const list = await (await call('GET', '/')).json();
    expect(list).toMatchObject({ active: { theme_id: theme.id, version: 1 } });
    expect(await (await call('GET', `/${theme.id}`)).json()).toMatchObject({ active: true });
  });

  it('refuses to delete the applied theme until another one is applied', async () => {
    const first = await createTheme('First', { 'login-ui.template': 'split' });
    const second = await createTheme('Second');
    await call('POST', `/${first.id}/apply`);

    const refused = await call('DELETE', `/${first.id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'theme_active' });
    expect((await call('DELETE', `/${second.id}`)).status).toBe(204);

    const third = await createTheme('Third');
    await call('POST', `/${third.id}/apply`);
    expect((await call('DELETE', `/${first.id}`)).status).toBe(204);
  });

  it('applies the version asked for and refuses one that changed', async () => {
    const theme = await createTheme('T', { 'login-ui.template': 'split' });
    await call('PUT', `/${theme.id}`, { name: 'T', values: {} }, { 'If-Match': '"1"' });

    const stale = await call('POST', `/${theme.id}/apply`, { version: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current_version: 2 });
    expect(mocks.state.document.saves).toHaveLength(0);

    expect((await call('POST', `/${theme.id}/apply`, { version: 'x' })).status).toBe(400);
    const ok = await call('POST', `/${theme.id}/apply`, { version: 2 });
    expect(ok.status).toBe(200);
    expect(mocks.state.document.own['login-ui.active_theme_version']).toBe(2);
  });

  it('retries once when the settings document moved, then gives up with 409', async () => {
    const theme = await createTheme('T', { 'login-ui.template': 'split' });

    mocks.state.document.staleSaves = 1;
    const retried = await call('POST', `/${theme.id}/apply`);
    expect(retried.status).toBe(200);
    // The first trial met the moved document; the second trial and the save went through.
    expect(mocks.state.document.trials).toBe(2);
    expect(mocks.state.document.saves).toHaveLength(1);

    mocks.state.document.saves = [];
    mocks.state.document.trials = 0;
    mocks.state.document.staleSaves = 2;
    const conflict = await call('POST', `/${theme.id}/apply`);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'settings_conflict' });
    expect(mocks.state.document.trials).toBe(2);
  });

  it('applies a theme whole or not at all: a value the settings refuse stops it', async () => {
    const theme = await createTheme('T', {
      'login-ui.template': 'split',
      'login-ui.palette': 'glass',
    });
    mocks.state.document.refuseKeys = ['login-ui.palette'];
    const refused = await call('POST', `/${theme.id}/apply`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: 'theme_not_applicable',
      rejected_keys: ['login-ui.palette'],
    });
    // Nothing was saved, and the theme is not recorded as applied.
    expect(mocks.state.document.saves).toHaveLength(0);
    expect(mocks.state.document.own).not.toHaveProperty('login-ui.active_theme_id');
    expect(mocks.writeAdminAuditLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'login_ui.theme.applied' })
    );
  });

  it('passes on a refusal of the settings save', async () => {
    const theme = await createTheme('T');
    mocks.state.refuseSave = Response.json({ error: 'forbidden' }, { status: 403 });
    const refused = await call('POST', `/${theme.id}/apply`);
    expect(refused.status).toBe(403);
    expect(mocks.writeAdminAuditLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'login_ui.theme.applied' })
    );
  });

  it('passes on a 409 that is not a version conflict, without retrying', async () => {
    const theme = await createTheme('T');
    mocks.state.refuseSave = Response.json(
      { error: 'conflict', message: 'A runtime profile changed' },
      { status: 409 }
    );
    const refused = await call('POST', `/${theme.id}/apply`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'conflict' });
  });

  it('asks what the login-ui settings ask: the category role and the reach of the tenant', async () => {
    const theme = await createTheme('T');
    // A person whose roles do not cover the login-ui settings is refused, whatever permissions.
    mocks.state.auth = { ...ADMIN, roles: [] };
    expect((await call('GET', '/')).status).toBe(403);
    expect((await call('GET', `/${theme.id}`)).status).toBe(403);
    expect((await call('POST', '/', { name: 'X', values: {} })).status).toBe(403);
    // A viewer reads but does not write.
    mocks.state.auth = { ...ADMIN, roles: ['ar_viewer'] };
    expect((await call('GET', '/')).status).toBe(200);
    expect((await call('DELETE', `/${theme.id}`)).status).toBe(403);
    expect((await call('POST', `/${theme.id}/apply`)).status).toBe(403);
    // An agent reaches only the tenants of its scope.
    mocks.state.auth = {
      ...ADMIN,
      actorType: 'agent',
      permissions: ['admin:settings:read', 'admin:settings:login_ui:update'],
      tenantScope: ['tenant-b'],
    };
    expect((await call('GET', '/')).status).toBe(403);
  });
});
