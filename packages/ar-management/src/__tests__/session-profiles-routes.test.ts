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

const mocks = vi.hoisted(() => {
  const state: {
    adapter?: DatabaseAdapter;
    tenantId: string;
    auth: Record<string, unknown>;
    /** The tenant's settings documents, by category. */
    settings: Record<string, { version: number; values: Record<string, unknown> }>;
    audit: ReturnType<typeof vi.fn>;
    /** The Flow (core database) that names a profile, when one does. */
    flowUsing: string | null;
  } = {
    flowUsing: null,
    tenantId: 'tenant-a',
    auth: {},
    settings: {},
    audit: vi.fn(),
  };
  return state;
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.audit }));
vi.mock('../routes/settings-v2/settings-support', () => ({
  getSettingsManager: () => ({
    getAll: async (category: string) => ({
      version: `${category}-${mocks.settings[category].version}`,
      values: { ...mocks.settings[category].values },
    }),
  }),
}));
vi.mock('../routes/settings-v2/tenant-settings-apply', () => ({
  applyTenantSettingsChange: async (input: {
    category: string;
    dryRun?: boolean;
    readBody: () => Promise<{ ifMatch: string; set: Record<string, unknown> }>;
  }) => {
    const body = await input.readBody();
    const doc = mocks.settings[input.category];
    if (body.ifMatch !== `${input.category}-${doc.version}`) {
      return Response.json({ error: 'conflict' }, { status: 409 });
    }
    if (!input.dryRun) {
      Object.assign(doc.values, body.set);
      doc.version++;
    }
    return Response.json({ version: `${input.category}-${doc.version}`, rejected: {} });
  },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: {
        queryOne: vi.fn(async (_sql: string, params: unknown[]) =>
          mocks.flowUsing && String(params[1]).includes(mocks.flowUsing) ? { id: 'flow-1' } : null
        ),
      },
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

import { sessionProfilesRouter } from '../routes/admin-management/session-profiles';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);
const ADMIN = {
  userId: 'admin-1',
  sessionId: 'sess-1',
  authMethod: 'session',
  actorType: 'human',
  roles: ['ar_tenant_admin'],
  globalRoles: [],
  permissions: ['admin:settings:read', 'admin:settings:write'],
  globalPermissions: [],
  tenantScope: ['tenant-a'],
  tenantId: 'tenant-a',
};

function call(method: string, path: string, body?: unknown) {
  return sessionProfilesRouter.request(
    path,
    {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {}
  );
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, '014_session_profiles.sql'));
  const run = (sql: string) => db.prepare(sql);
  mocks.adapter = {
    query: async (sql: string, params: unknown[] = []) => run(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => run(sql).get(...params) ?? null,
    execute: async (sql: string, params: unknown[] = []) => ({
      rowsAffected: Number(run(sql).run(...params).changes),
      success: true,
    }),
  } as unknown as DatabaseAdapter;
  mocks.tenantId = 'tenant-a';
  mocks.auth = { ...ADMIN };
  mocks.settings = {
    session: { version: 1, values: { 'session.default_ttl': 86_400_000 } },
    oauth: { version: 1, values: { 'oauth.sso_enabled': true } },
  };
  mocks.audit.mockClear();
});

const DEFAULT_VERSION = JSON.stringify({ session: 'session-1', oauth: 'oauth-1' });

describe('session profiles', () => {
  it('lists the live Default settings and keeps saved profiles tenant-scoped', async () => {
    const first = await call('GET', '/');
    expect(first.status).toBe(200);
    const initial = await first.json<{
      profiles: Array<{ id: string; values: Record<string, unknown>; version: unknown }>;
    }>();
    expect(initial.profiles).toHaveLength(1);
    expect(initial.profiles[0]).toMatchObject({
      id: 'default',
      version: DEFAULT_VERSION,
      values: { 'session.default_ttl': 86_400_000, 'oauth.sso_enabled': true },
    });

    const created = await call('POST', '/', {
      name: 'Short',
      values: { 'session.default_ttl': 3_600_000, 'oauth.sso_enabled': false },
    });
    expect(created.status).toBe(201);
    const { profile } = await created.json<{ profile: { id: string; version: number } }>();
    expect(profile.version).toBe(1);

    mocks.tenantId = 'tenant-b';
    mocks.auth = { ...ADMIN, tenantId: 'tenant-b', tenantScope: ['tenant-b'] };
    expect((await call('GET', `/${profile.id}`)).status).toBe(404);
    const other = await call('GET', '/');
    expect((await other.json<{ profiles: unknown[] }>()).profiles).toHaveLength(1);
  });

  it('requires the saved version when updating and keeps a profile a flow uses', async () => {
    const created = await call('POST', '/', { name: 'Short', values: {} });
    const { profile } = await created.json<{ profile: { id: string } }>();
    const updated = await call('PUT', `/${profile.id}`, {
      name: 'Shorter',
      version: 1,
      values: { 'session.max_ttl': 86_400_000 },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ profile: { version: number } }>()).profile.version).toBe(2);
    expect(
      (await call('PUT', `/${profile.id}`, { name: 'Old', version: 1, values: {} })).status
    ).toBe(409);
    mocks.flowUsing = profile.id;
    try {
      expect((await call('DELETE', `/${profile.id}`)).status).toBe(409);
    } finally {
      mocks.flowUsing = null;
    }
    expect((await call('DELETE', `/${profile.id}`)).status).toBe(204);
    expect((await call('GET', `/${profile.id}`)).status).toBe(404);
  });

  it('takes only session lengths and single sign-on, each checked', async () => {
    expect(
      (await call('POST', '/', { name: 'Bad', values: { 'session.backchannel_enabled': true } }))
        .status
    ).toBe(400);
    expect(
      (await call('POST', '/', { name: 'Bad', values: { 'oauth.sso_enabled': 'yes' } })).status
    ).toBe(400);
    expect((await call('POST', '/', { name: 'default', values: {} })).status).toBe(400);
  });

  it('writes the Default profile to both settings documents, all or nothing', async () => {
    expect((await call('DELETE', '/default')).status).toBe(400);
    const saved = await call('PUT', '/default', {
      name: 'Default',
      version: DEFAULT_VERSION,
      values: { 'session.default_ttl': 7_200_000, 'oauth.sso_enabled': false },
    });
    expect(saved.status).toBe(200);
    expect(mocks.settings.session.values['session.default_ttl']).toBe(7_200_000);
    expect(mocks.settings.oauth.values['oauth.sso_enabled']).toBe(false);
    // Read before that save: refused, and nothing written.
    const stale = await call('PUT', '/default', {
      name: 'Default',
      version: DEFAULT_VERSION,
      values: { 'session.default_ttl': 60_000 },
    });
    expect(stale.status).toBe(409);
    expect(mocks.settings.session.values['session.default_ttl']).toBe(7_200_000);
    // Only the changed document is written.
    const sessionOnly = await call('PUT', '/default', {
      name: 'Default',
      version: JSON.stringify({ session: 'session-2', oauth: 'oauth-2' }),
      values: { 'session.default_ttl': 3_600_000, 'oauth.sso_enabled': false },
    });
    expect(sessionOnly.status).toBe(200);
    expect(mocks.settings.session.version).toBe(3);
    expect(mocks.settings.oauth.version).toBe(2);
  });
});
