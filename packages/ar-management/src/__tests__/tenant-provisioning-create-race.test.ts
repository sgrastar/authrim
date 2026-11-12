import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * Two identical create requests, the real `beginTenantProvisioning` on real SQLite tables (the
 * admin schema for the operation, a tenants table for the platform row): the create path only
 * inserts a missing draft row and never rewrites the lifecycle of an existing one, so a tenant
 * that became active in between stays active.
 */
interface Hooks {
  admin: unknown;
  platform: unknown;
  beforeTenantInsert: null | (() => Promise<void>);
}
const hooks = vi.hoisted((): Hooks => ({ admin: null, platform: null, beforeTenantInsert: null }));

function sqliteAdapter(getDb: () => SQLiteDatabase, beforeInsert = false): DatabaseAdapter {
  const adapter = {
    query: async (sql: string, params: SQLInputValue[] = []) =>
      getDb()
        .prepare(sql)
        .all(...params),
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      getDb()
        .prepare(sql)
        .get(...params) ?? null,
    execute: async (sql: string, params: SQLInputValue[] = []) => {
      if (beforeInsert && hooks.beforeTenantInsert && /INSERT INTO tenants/.test(sql)) {
        const hook = hooks.beforeTenantInsert;
        hooks.beforeTenantInsert = null;
        await hook();
      }
      const result = getDb()
        .prepare(sql)
        .run(...params);
      return { success: true, rowsAffected: Number(result.changes) };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      getDb().exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(adapter);
        getDb().exec('COMMIT');
        return result;
      } catch (error) {
        getDb().exec('ROLLBACK');
        throw error;
      }
    },
    batch: async (statements: Array<{ sql: string; params?: SQLInputValue[] }>) => {
      getDb().exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => ({
          success: true,
          rowsAffected: Number(
            getDb()
              .prepare(statement.sql)
              .run(...(statement.params ?? [])).changes
          ),
        }));
        getDb().exec('COMMIT');
        return results;
      } catch (error) {
        getDb().exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return adapter;
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const platform = sqliteAdapter(() => hooks.platform as SQLiteDatabase, true);
  const admin = sqliteAdapter(() => hooks.admin as SQLiteDatabase);
  return {
    ...actual,
    createD1Adapter: () => platform,
    requireAdminDatabaseAdapter: () => admin,
    runTenantBackupCoveredEffect: async () => undefined,
    createAuditLogFromContext: async () => undefined,
  };
});

import { adminTenantCreateHandler } from '../admin-tenants';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function openDatabases() {
  const admin = new DatabaseSync(':memory:');
  admin.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/admin/d1/001_0_4_0_admin_baseline.sql'), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  const platform = new DatabaseSync(':memory:');
  platform.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, tenant_code TEXT UNIQUE, tenant_key TEXT, name TEXT, description TEXT,
      isolation_policy TEXT, lifecycle_state TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
      default_tenant_guard TEXT, created_at INTEGER, updated_at INTEGER
    );
  `);
  hooks.admin = admin;
  hooks.platform = platform;
  return { admin, platform };
}

const AUTH: AdminAuthContext = {
  userId: 'human-1',
  authMethod: 'bearer',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  tenantScope: ['*'],
};

async function create(name = 'Second Tenant') {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', AUTH);
    c.set('tenantId' as never, 'default' as never);
    await next();
  });
  app.post('/api/admin/tenants', (c) => adminTenantCreateHandler(c as never));
  const response = await app.request(
    '/api/admin/tenants',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'second', name, isolation_policy: 'shared_pool' }),
    },
    { BASE_DOMAIN: 'op.example.com', AUTHRIM_ENVIRONMENT_NAME: 'test' },
    { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} }
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const tenant = (db: SQLiteDatabase) =>
  db.prepare("SELECT lifecycle_state, is_default FROM tenants WHERE id = 'second'").get();
const operations = (db: SQLiteDatabase) =>
  Number(
    (db.prepare('SELECT COUNT(*) AS n FROM tenant_provisioning_operations').get() as { n: number })
      .n
  );

describe('tenant create path and the tenant row', () => {
  beforeEach(() => {
    hooks.beforeTenantInsert = null;
  });

  it('a first create writes the draft row and the operation', async () => {
    const { admin, platform } = openDatabases();
    const result = await create();
    expect(result.status).toBe(202);
    expect(tenant(platform)).toEqual({ lifecycle_state: 'provisioning', is_default: 0 });
    expect(operations(admin)).toBe(1);
  });

  it('a plain idempotent retry returns the existing operation and creates nothing new', async () => {
    const { admin, platform } = openDatabases();
    const first = await create();
    const again = await create();
    expect(again.status).toBe(202);
    expect(operations(admin)).toBe(1);
    expect((again.body.provisioning as { operation_id: string }).operation_id).toBe(
      (first.body.provisioning as { operation_id: string }).operation_id
    );
    expect(tenant(platform)).toEqual({ lifecycle_state: 'provisioning', is_default: 0 });
  });

  it('a tenant that became active between the operation write and the row write stays active', async () => {
    const { platform } = openDatabases();
    // Request A has created the operation and is about to write the row; meanwhile request B
    // finds the operation, creates the missing row, and the saga activates the tenant.
    hooks.beforeTenantInsert = async () => {
      expect((await create()).status).toBe(202);
      platform
        .prepare(
          "UPDATE tenants SET lifecycle_state = 'active', is_default = 1, default_tenant_guard = 'default' WHERE id = 'second'"
        )
        .run();
    };
    const a = await create();
    expect(a.status).toBe(202);
    expect(tenant(platform)).toEqual({ lifecycle_state: 'active', is_default: 1 });
  });

  it('replays a completed create after an administrator changed the tenant code, leaving the tenant alone', async () => {
    const { platform } = openDatabases();
    const first = await create();
    expect(first.status).toBe(202);
    platform
      .prepare(
        "UPDATE tenants SET tenant_code = 'renamed', lifecycle_state = 'active' WHERE id = 'second'"
      )
      .run();
    const again = await create();
    expect(again.status).toBe(202);
    expect(again.body.tenant_code).toBe('renamed');
    expect(tenant(platform)).toEqual({ lifecycle_state: 'active', is_default: 0 });
  });

  it('refuses a new create whose row of that id was written by someone else with another code', async () => {
    const { platform } = openDatabases();
    hooks.beforeTenantInsert = async () => {
      platform
        .prepare(
          "INSERT INTO tenants (id, tenant_code, name, lifecycle_state) VALUES ('second', 'someone-elses', 'X', 'active')"
        )
        .run();
    };
    const result = await create();
    expect(result.status).toBe(400);
    expect(tenant(platform)).toEqual({ lifecycle_state: 'active', is_default: 0 });
  });
});
