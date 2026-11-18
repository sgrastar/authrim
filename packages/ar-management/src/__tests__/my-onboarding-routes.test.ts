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

const mocks = vi.hoisted(() => {
  const state: { adapter?: DatabaseAdapter; auth: Record<string, unknown>; tenantId: string } = {
    auth: {},
    tenantId: 'tenant-a',
  };
  return { state };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.state.adapter),
    getTenantIdFromContext: vi.fn(() => mocks.state.tenantId),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.state.auth);
        await next();
      },
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status: number) => Response }, code: string) =>
        c.json({ error: 'error', error_code: code }, status[code] ?? 500)
    ),
  };
});

import { ADMIN_ONBOARDING_ITEM_LIMIT } from '@authrim/ar-lib-core';
import { myOnboardingRouter } from '../routes/admin-management/my-onboarding';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);

function database(): { db: Database; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of ['001_0_5_0_admin_baseline.sql', '024_admin_onboarding_progress.sql']) {
    db.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, file));
  }
  db.exec('PRAGMA foreign_keys = ON');
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

function admin(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    sessionId: 'sess-1',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    globalRoles: [],
    permissions: [],
    globalPermissions: [],
    tenantScope: ['tenant-a'],
    tenantId: 'tenant-a',
    ...overrides,
  };
}

const call = (method: string, path: string) => myOnboardingRouter.request(path, { method }, {});
const items = async (response: Response) =>
  (await response.json<{ completed: Array<{ item_id: string }> }>()).completed.map(
    (entry) => entry.item_id
  );

describe('first-steps checklist progress routes', () => {
  let db: Database;

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = database());
    mocks.state.adapter = adapter;
    mocks.state.tenantId = 'tenant-a';
    mocks.state.auth = admin();
    db.exec(`INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES
      ('admin-1', 'tenant-a', 'a@example.com', 1, 1), ('admin-2', 'tenant-a', 'b@example.com', 1, 1)`);
  });

  it('starts empty, marks items finished and reopens them', async () => {
    expect(await items(await call('GET', '/'))).toEqual([]);
    expect(await items(await call('PUT', '/sign-in'))).toEqual(['sign-in']);
    expect(await items(await call('PUT', '/theme'))).toEqual(['sign-in', 'theme']);
    expect(await items(await call('DELETE', '/sign-in'))).toEqual(['theme']);
    // Reopening what was never finished changes nothing.
    expect(await items(await call('DELETE', '/schema'))).toEqual(['theme']);
  });

  it('keeps the first time when an item is finished again', async () => {
    await call('PUT', '/theme');
    db.exec('UPDATE admin_onboarding_progress SET completed_at = 5');
    const again = await call('PUT', '/theme');
    expect(await again.json()).toEqual({ completed: [{ item_id: 'theme', completed_at: 5 }] });
  });

  it('keeps progress apart per admin and per tenant', async () => {
    await call('PUT', '/theme');
    mocks.state.tenantId = 'tenant-b';
    expect(await items(await call('GET', '/'))).toEqual([]);
    mocks.state.tenantId = 'tenant-a';
    mocks.state.auth = admin({ userId: 'admin-2' });
    expect(await items(await call('GET', '/'))).toEqual([]);
    mocks.state.auth = admin();
    expect(await items(await call('GET', '/'))).toEqual(['theme']);
  });

  it('refuses identifiers that are not item identifiers', async () => {
    for (const path of ['/Theme', '/a_b', '/-a', '/a--b', `/${'a'.repeat(41)}`, '/a%20b']) {
      expect((await call('PUT', path)).status, path).toBe(400);
      expect((await call('DELETE', path)).status, path).toBe(400);
    }
    expect(await items(await call('GET', '/'))).toEqual([]);
  });

  it('keeps a bounded number of finished items', async () => {
    for (let n = 0; n < ADMIN_ONBOARDING_ITEM_LIMIT; n++) {
      expect((await call('PUT', `/item-${n}`)).status).toBe(200);
    }
    const over = await call('PUT', '/one-more');
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: 'limit_reached' });
    // One already kept is still fine at the limit.
    expect((await call('PUT', '/item-0')).status).toBe(200);
  });

  it('is for human sessions only', async () => {
    mocks.state.auth = admin({ authMethod: 'bearer', sessionId: undefined });
    expect((await call('GET', '/')).status).toBe(403);
    expect((await call('PUT', '/theme')).status).toBe(403);
    expect((await call('DELETE', '/theme')).status).toBe(403);
  });

  it('forgets an admin’s progress with the admin', async () => {
    await call('PUT', '/theme');
    db.exec("DELETE FROM admin_users WHERE id = 'admin-1'");
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_onboarding_progress').get()).toEqual({
      n: 0,
    });
  });
});
