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
    settings: { version: number; values: Record<string, unknown> };
    audit: ReturnType<typeof vi.fn>;
  } = {
    tenantId: 'tenant-a',
    auth: {},
    settings: {
      version: 1,
      values: {
        'authentication-methods.passkey.login_enabled': true,
        'authentication-methods.email_otp.login_enabled': true,
      },
    },
    audit: vi.fn(),
  };
  return state;
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.audit }));
vi.mock('../routes/settings-v2/settings-support', () => ({
  getSettingsManager: () => ({
    getAll: async () => ({
      version: `rev-${mocks.settings.version}`,
      values: { ...mocks.settings.values },
    }),
  }),
}));
vi.mock('../routes/settings-v2/tenant-settings-apply', () => ({
  applyTenantSettingsChange: async (input: {
    dryRun?: boolean;
    readBody: () => Promise<{ ifMatch: string; set: Record<string, unknown> }>;
  }) => {
    const body = await input.readBody();
    if (body.ifMatch !== `rev-${mocks.settings.version}`) {
      return Response.json(
        { error: 'conflict', currentVersion: `rev-${mocks.settings.version}` },
        { status: 409 }
      );
    }
    if (!input.dryRun) {
      Object.assign(mocks.settings.values, body.set);
      mocks.settings.version++;
    }
    return Response.json({ version: `rev-${mocks.settings.version}`, rejected: {} });
  },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
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

import { authenticationMethodProfilesRouter } from '../routes/admin-management/authentication-method-profiles';

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
  return authenticationMethodProfilesRouter.request(
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
  db.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, '013_authentication_method_profiles.sql'));
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
  mocks.settings.version = 1;
  mocks.settings.values = {
    'authentication-methods.passkey.login_enabled': true,
    'authentication-methods.email_otp.login_enabled': true,
  };
  mocks.audit.mockClear();
});

describe('authentication method profiles', () => {
  it('lists the live Default settings and keeps saved profiles tenant-scoped', async () => {
    const first = await call('GET', '/');
    expect(first.status).toBe(200);
    const initial = await first.json<{
      profiles: Array<{ id: string; values: Record<string, unknown> }>;
    }>();
    expect(initial.profiles).toHaveLength(1);
    expect(initial.profiles[0]).toMatchObject({
      id: 'default',
      values: {
        'authentication-methods.passkey.login_enabled': true,
      },
    });

    const created = await call('POST', '/', {
      name: 'Members',
      values: {
        'authentication-methods.passkey.login_enabled': true,
      },
    });
    expect(created.status).toBe(201);
    const { profile } = await created.json<{ profile: { id: string; version: number } }>();
    expect(profile.version).toBe(1);
    expect((await call('GET', '/')).status).toBe(200);

    mocks.tenantId = 'tenant-b';
    mocks.auth = { ...ADMIN, tenantId: 'tenant-b', tenantScope: ['tenant-b'] };
    expect((await call('GET', `/${profile.id}`)).status).toBe(404);
    const other = await call('GET', '/');
    expect((await other.json<{ profiles: unknown[] }>()).profiles).toHaveLength(1);
  });

  it('requires the saved version when updating and supports deletion', async () => {
    const created = await call('POST', '/', { name: 'Members', values: {} });
    const { profile } = await created.json<{ profile: { id: string } }>();
    const updated = await call('PUT', `/${profile.id}`, {
      name: 'Staff',
      version: 1,
      values: { 'authentication-methods.totp.login_enabled': true },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ profile: { version: number } }>()).profile.version).toBe(2);
    expect(
      (await call('PUT', `/${profile.id}`, { name: 'Old', version: 1, values: {} })).status
    ).toBe(409);
    expect((await call('DELETE', `/${profile.id}`)).status).toBe(204);
    expect((await call('GET', `/${profile.id}`)).status).toBe(404);
  });

  it('validates profile values and writes the Default profile through tenant settings', async () => {
    expect(
      (await call('POST', '/', { name: 'Bad', values: { 'security.enabled': true } })).status
    ).toBe(400);
    expect((await call('DELETE', '/default')).status).toBe(400);
    const saved = await call('PUT', '/default', {
      name: 'Default',
      version: 'rev-1',
      values: { 'authentication-methods.passkey.login_enabled': false },
    });
    expect(saved.status).toBe(200);
    expect(mocks.settings.values['authentication-methods.passkey.login_enabled']).toBe(false);
    expect(
      (await call('PUT', '/default', { name: 'Default', version: 'rev-1', values: {} })).status
    ).toBe(409);
  });
});
