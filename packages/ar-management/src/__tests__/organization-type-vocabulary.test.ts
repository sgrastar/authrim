import {
  readMigrationSource,
  listMigrationSourceFiles,
} from '../../../../test/helpers/migration-source.mjs';
/**
 * Organisation types are the core vocabulary (distributor, enterprise, department): the Admin API
 * accepts only those, and the core migration renames what the API wrote before.
 */

import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

const mocked = vi.hoisted(() => ({ coreAdapter: null as unknown }));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocked.coreAdapter })),
  };
});

import { adminOrganizationCreateHandler, adminOrganizationUpdateHandler } from '../admin-rbac';

const MIGRATIONS = fileURLToPath(new URL('../../../../migrations/core/d1/', import.meta.url));
const VOCABULARY_MIGRATION = '024_organization_type_core_vocabulary.sql';

function render(sql: string): string {
  return sql
    .replaceAll(
      '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
      "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))"
    )
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

/** The core schema with every migration before `until` (or all of them) applied. */
function coreDatabase(until?: string): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  const files = until
    ? listMigrationSourceFiles(MIGRATIONS).filter((name) => name < until)
    : ['001_0_5_0_core_baseline.sql'];
  for (const file of files) {
    db.exec(render(readMigrationSource(MIGRATIONS, file)));
  }
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

const values = (params: unknown[] = []) =>
  params.map((value): SQLInputValue => (value === undefined ? null : (value as SQLInputValue)));

function sqliteAdapter(db: SQLiteDatabase): DatabaseAdapter {
  const run = (sql: string, params?: unknown[]) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
  });
  return {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run(sql, params),
  } as unknown as DatabaseAdapter;
}

function context(input: { params?: Record<string, string>; body?: unknown }) {
  return {
    req: {
      param: vi.fn((name: string) => input.params?.[name]),
      query: vi.fn(() => undefined),
      json: vi.fn(async () => input.body ?? {}),
    },
    env: { DB: {} },
    json: vi.fn((body: unknown, status?: number) => Response.json(body, { status: status ?? 200 })),
    get: vi.fn(() => undefined),
    set: vi.fn(),
  } as never;
}

function insertOrganization(
  db: SQLiteDatabase,
  id: string,
  orgType: string,
  tenantId = 'tenant-a'
) {
  db.prepare(
    `INSERT INTO organizations (id, tenant_id, name, org_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 100, 100)`
  ).run(id, tenantId, id, orgType);
}

const orgTypes = (db: SQLiteDatabase) =>
  db.prepare('SELECT id, org_type FROM organizations ORDER BY id').all();

describe('organisation type migration', () => {
  it('renames the Admin API types to the core type of the same meaning', () => {
    const db = coreDatabase(VOCABULARY_MIGRATION);
    insertOrganization(db, 'org-department', 'department');
    insertOrganization(db, 'org-distributor', 'distributor');
    insertOrganization(db, 'org-enterprise', 'enterprise');
    insertOrganization(db, 'org-partner', 'partner', 'tenant-b');
    insertOrganization(db, 'org-personal', 'personal');
    insertOrganization(db, 'org-team', 'team');

    db.exec(render(readMigrationSource(MIGRATIONS, VOCABULARY_MIGRATION)));

    expect(orgTypes(db)).toEqual([
      { id: 'org-department', org_type: 'department' },
      { id: 'org-distributor', org_type: 'distributor' },
      { id: 'org-enterprise', org_type: 'enterprise' },
      { id: 'org-partner', org_type: 'distributor' },
      { id: 'org-personal', org_type: 'enterprise' },
      { id: 'org-team', org_type: 'department' },
    ]);
  });
});

describe('organisation type in the Admin API', () => {
  let db: SQLiteDatabase;

  beforeEach(() => {
    db = coreDatabase();
    mocked.coreAdapter = sqliteAdapter(db);
  });

  it.each(['distributor', 'enterprise', 'department'])(
    'creates an organisation of type %s',
    async (org_type) => {
      const response = await adminOrganizationCreateHandler(
        context({ body: { name: 'acme', org_type } })
      );
      expect(response.status).toBe(201);
      expect(orgTypes(db)).toEqual([expect.objectContaining({ org_type })]);
    }
  );

  it('creates an enterprise when no type is given, as the column default', async () => {
    const response = await adminOrganizationCreateHandler(context({ body: { name: 'acme' } }));
    expect(response.status).toBe(201);
    expect(orgTypes(db)).toEqual([expect.objectContaining({ org_type: 'enterprise' })]);
  });

  it.each(['personal', 'team', 'partner', 'invalid', '', 7])(
    'refuses to create an organisation of type %j',
    async (org_type) => {
      const response = await adminOrganizationCreateHandler(
        context({ body: { name: 'acme', org_type } })
      );
      expect(response.status).toBe(400);
      expect(orgTypes(db)).toEqual([]);
    }
  );

  it('changes the type to another core type', async () => {
    insertOrganization(db, 'org-1', 'enterprise');
    const response = await adminOrganizationUpdateHandler(
      context({ params: { id: 'org-1' }, body: { org_type: 'department' } })
    );
    expect(response.status).toBe(200);
    expect(orgTypes(db)).toEqual([{ id: 'org-1', org_type: 'department' }]);
  });

  it.each(['personal', 'team', 'partner', 'invalid'])(
    'refuses to change the type to %s',
    async (org_type) => {
      insertOrganization(db, 'org-1', 'enterprise');
      const response = await adminOrganizationUpdateHandler(
        context({ params: { id: 'org-1' }, body: { org_type } })
      );
      expect(response.status).toBe(400);
      expect(orgTypes(db)).toEqual([{ id: 'org-1', org_type: 'enterprise' }]);
    }
  );
});
