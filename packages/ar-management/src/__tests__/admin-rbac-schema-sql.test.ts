/**
 * The user-relationship handlers against the real core schema
 * (every core migration, in order), so a column the schema does not have fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveRelationshipsSummary,
  validateActingAsRelationship,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

const USERS = new Set(['parent-1', 'child-1', 'other-1']);

const mocked = vi.hoisted(() => ({
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  coreAdapter: null as unknown,
  defaultAdapter: null as unknown,
}));

// The account-store lookup is the only part replaced on the account path: the context it sets
// is read by the library's own adapter factories, so a handler that skips it finds no user.

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: mocked.getTenantIdFromContext,
    // As the real resolver: a user the tenant has no account route for is not found.
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { set(key: string, value: unknown): void }, accountId: string) => {
        if (accountId === 'broken-1') throw new Error('lookup_unavailable');
        if (!USERS.has(accountId)) throw new Error('account_data_route_not_found');
        c.set('accountDataContext', {
          tenantId: 'tenant-a',
          accountId,
          coreDb: mocked.coreAdapter,
          piiDb: mocked.coreAdapter,
        });
      }
    ),
    // Organisation handlers use the tenant's default store.
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocked.defaultAdapter })),
    // The user store reads the PII side; these tests only need "does the user exist".
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        return USERS.has(userId)
          ? { id: userId, email: `${userId}@example.com`, name: userId }
          : null;
      }
    },
  };
});

import {
  adminUserRelationshipCreateHandler,
  adminUserRelationshipDeleteHandler,
  adminUserRelationshipsListHandler,
} from '../admin-rbac';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function renderSqliteMigration(sql: string): string {
  return sql
    .replaceAll(
      '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
      "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))"
    )
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

function coreDatabase(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  const directory = `${REPO_ROOT}migrations/core/d1`;
  for (const file of [
    '001_0_5_0_core_baseline.sql',
    '015_end_user_groups.sql',
    '016_invitation_group.sql',
    '017_service_group_scim_membership_inputs.sql',
    '018_remove_organizations.sql',
    '019_dynamic_publication_unknown_groups.sql',
    '020_relationship_userset_relation.sql',
    '021_check_resource_registry.sql',
  ]) {
    db.exec(renderSqliteMigration(readFileSync(`${directory}/${file}`, 'utf8')));
  }
  // Users live in users_core / PII; the rows here stand alone.
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
    transaction: async (fn: (tx: DatabaseAdapter) => Promise<unknown>) => fn(sqliteAdapter(db)),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) =>
      statements.map((statement) => run(statement.sql, statement.params)),
    // The rest of the adapter shape, so the core readers take it as an adapter.
    isHealthy: async () => true,
    getType: () => 'sqlite',
    close: async () => undefined,
  } as unknown as DatabaseAdapter;
}

/** REBAC_CACHE: where the tenant's ReBAC version is kept. */
const versions = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };

function context(input: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const store = new Map<string, unknown>([['tenantId', 'tenant-a']]);
  return {
    req: {
      param: vi.fn((name: string) => input.params?.[name]),
      query: vi.fn((name: string) => input.query?.[name]),
      json: vi.fn(async () => input.body ?? {}),
    },
    env: { DB: {}, REBAC_CACHE: versions },
    json: vi.fn((body: unknown, status?: number) => Response.json(body, { status: status ?? 200 })),
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
  } as never;
}

type Body = Record<string, unknown>;
type Relationship = { id: string; expires_at: number | null };

const json = async <T = Body>(response: Response) => (await response.json()) as T;

function insertRelationship(
  db: SQLiteDatabase,
  row: {
    id: string;
    tenantId?: string;
    type: string;
    fromId: string;
    toId: string;
    fromType?: string;
    toType?: string;
    expiresAt?: number | null;
  }
) {
  db.prepare(
    `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id, to_type, to_id,
       expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 100)`
  ).run(
    row.id,
    row.tenantId ?? 'tenant-a',
    row.type,
    row.fromType ?? 'subject',
    row.fromId,
    row.toType ?? 'subject',
    row.toId,
    row.expiresAt ?? null
  );
}

describe('admin user relationships on the core schema', () => {
  let db: SQLiteDatabase;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    db = coreDatabase();
    adapter = sqliteAdapter(db);
    mocked.coreAdapter = adapter;
    // The user's rows are in their account store, never in the tenant's default one.
    mocked.defaultAdapter = sqliteAdapter(coreDatabase());
  });

  it('stores a relationship as from (the user) to (the related subject)', async () => {
    const response = await adminUserRelationshipCreateHandler(
      context({
        params: { id: 'parent-1' },
        body: { related_subject_id: 'child-1', relationship_type: 'guardian' },
      })
    );

    expect(response.status).toBe(201);
    const body = await json<{ relationship: Relationship }>(response);
    expect(body.relationship).toMatchObject({
      subject_id: 'parent-1',
      related_subject_id: 'child-1',
      relationship_type: 'guardian',
      expires_at: null,
    });
    expect(
      db
        .prepare(
          `SELECT tenant_id, relationship_type, from_type, from_id, to_type, to_id, permission_level
             FROM relationships WHERE id = ?`
        )
        .get(body.relationship.id)
    ).toEqual({
      tenant_id: 'tenant-a',
      relationship_type: 'guardian',
      from_type: 'subject',
      from_id: 'parent-1',
      to_type: 'subject',
      to_id: 'child-1',
      permission_level: 'full',
    });
  });

  it('writes rows the acting-as check and the relationships claim read', async () => {
    for (const relationship_type of ['parent_child', 'delegate']) {
      const response = await adminUserRelationshipCreateHandler(
        context({
          params: { id: 'parent-1' },
          body: { related_subject_id: 'child-1', relationship_type },
        })
      );
      expect(response.status).toBe(201);
    }

    await expect(
      validateActingAsRelationship(adapter, 'parent-1', 'child-1', 'tenant-a')
    ).resolves.toMatchObject({ valid: true });
    // The other way round grants nothing.
    await expect(
      validateActingAsRelationship(adapter, 'child-1', 'parent-1', 'tenant-a')
    ).resolves.toMatchObject({ valid: false });
    await expect(resolveRelationshipsSummary(adapter, 'parent-1', 'tenant-a')).resolves.toEqual(
      expect.objectContaining({ children_ids: ['child-1'] })
    );
    await expect(resolveRelationshipsSummary(adapter, 'child-1', 'tenant-a')).resolves.toEqual(
      expect.objectContaining({ parent_ids: ['parent-1'] })
    );
  });

  it('accepts only the relationship types the core readers know', async () => {
    for (const relationship_type of ['parent_of', 'guardian_of', 'assistant_of', 'reseller_of']) {
      const response = await adminUserRelationshipCreateHandler(
        context({
          params: { id: 'parent-1' },
          body: { related_subject_id: 'child-1', relationship_type },
        })
      );
      expect(response.status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationships').get()).toEqual({ n: 0 });
  });

  it('keeps the expiry in seconds and answers it in milliseconds', async () => {
    const expiresAtMs = 4_102_444_800_000; // 2100-01-01
    const response = await adminUserRelationshipCreateHandler(
      context({
        params: { id: 'parent-1' },
        body: {
          related_subject_id: 'child-1',
          relationship_type: 'manager',
          expires_at: expiresAtMs,
        },
      })
    );
    expect(response.status).toBe(201);
    expect((await json<{ relationship: Relationship }>(response)).relationship.expires_at).toBe(
      expiresAtMs
    );
    expect(db.prepare('SELECT expires_at FROM relationships').get()).toEqual({
      expires_at: expiresAtMs / 1000,
    });
  });

  it('refuses an expiry that is zero, past, fractional or not a number', async () => {
    for (const expires_at of [0, Date.now() - 1000, Date.now() + 1000.5, '4102444800000']) {
      const response = await adminUserRelationshipCreateHandler(
        context({
          params: { id: 'parent-1' },
          body: { related_subject_id: 'child-1', relationship_type: 'guardian', expires_at },
        })
      );
      expect(response.status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationships').get()).toEqual({ n: 0 });
  });

  it('answers 404 for a user it does not know, on either end', async () => {
    for (const [id, related_subject_id] of [
      ['ghost-1', 'child-1'],
      ['parent-1', 'ghost-1'],
    ]) {
      const response = await adminUserRelationshipCreateHandler(
        context({
          params: { id },
          body: { related_subject_id, relationship_type: 'guardian' },
        })
      );
      expect(response.status).toBe(404);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationships').get()).toEqual({ n: 0 });
  });

  it('answers 404 when the path user has no account route, and 500 when the lookup fails', async () => {
    for (const [id, status] of [
      ['ghost-1', 404],
      ['broken-1', 500],
    ] as const) {
      const list = await adminUserRelationshipsListHandler(context({ params: { id } }));
      const create = await adminUserRelationshipCreateHandler(
        context({
          params: { id },
          body: { related_subject_id: 'child-1', relationship_type: 'guardian' },
        })
      );
      const remove = await adminUserRelationshipDeleteHandler(
        context({ params: { id, relationshipId: 'rel-1' } })
      );
      expect([list.status, create.status, remove.status]).toEqual([status, status, status]);
    }
  });

  it('bumps the tenant ReBAC version on create and delete', async () => {
    versions.put.mockClear();
    const created = await adminUserRelationshipCreateHandler(
      context({
        params: { id: 'parent-1' },
        body: { related_subject_id: 'child-1', relationship_type: 'guardian' },
      })
    );
    expect(created.status).toBe(201);
    const { relationship } = await json<{ relationship: Relationship }>(created);
    const removed = await adminUserRelationshipDeleteHandler(
      context({ params: { id: 'parent-1', relationshipId: relationship.id } })
    );
    expect(removed.status).toBe(200);
    expect(versions.put.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      'rebac:v2:tenant-version:tenant-a',
      'rebac:v2:tenant-version:tenant-a',
    ]);
  });

  it('refuses the same relationship twice', async () => {
    insertRelationship(db, { id: 'rel-1', type: 'guardian', fromId: 'parent-1', toId: 'child-1' });
    const response = await adminUserRelationshipCreateHandler(
      context({
        params: { id: 'parent-1' },
        body: { related_subject_id: 'child-1', relationship_type: 'guardian' },
      })
    );
    expect(response.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationships').get()).toEqual({ n: 1 });
  });

  it('answers 409 when a concurrent create wins the unique index', async () => {
    insertRelationship(db, { id: 'rel-1', type: 'guardian', fromId: 'parent-1', toId: 'child-1' });
    // The duplicate check ran before the other create committed.
    mocked.coreAdapter = {
      ...adapter,
      queryOne: async (sql: string, params?: unknown[]) =>
        sql.includes('FROM relationships') ? null : adapter.queryOne(sql, params),
    };
    const response = await adminUserRelationshipCreateHandler(
      context({
        params: { id: 'parent-1' },
        body: { related_subject_id: 'child-1', relationship_type: 'guardian' },
      })
    );
    expect(response.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationships').get()).toEqual({ n: 1 });
  });

  it('lists outgoing and incoming relationships of the tenant that have not expired', async () => {
    insertRelationship(db, {
      id: 'rel-out',
      type: 'guardian',
      fromId: 'parent-1',
      toId: 'child-1',
    });
    insertRelationship(db, { id: 'rel-in', type: 'delegate', fromId: 'other-1', toId: 'parent-1' });
    insertRelationship(db, {
      id: 'rel-expired',
      type: 'parent_child',
      fromId: 'parent-1',
      toId: 'other-1',
      expiresAt: 1,
    });
    // Tuples between a user and an organisation are not user relationships.
    insertRelationship(db, {
      id: 'rel-to-org',
      type: 'member',
      fromId: 'parent-1',
      toType: 'org',
      toId: 'org-1',
    });
    insertRelationship(db, {
      id: 'rel-from-org',
      type: 'member',
      fromType: 'org',
      fromId: 'org-1',
      toId: 'parent-1',
    });
    insertRelationship(db, {
      id: 'rel-other-tenant',
      tenantId: 'tenant-b',
      type: 'guardian',
      fromId: 'parent-1',
      toId: 'other-1',
    });

    const response = await adminUserRelationshipsListHandler(
      context({ params: { id: 'parent-1' } })
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.outgoing_relationships).toEqual([
      {
        id: 'rel-out',
        relationship_type: 'guardian',
        related_subject_id: 'child-1',
        related_email: 'child-1@example.com',
        related_name: 'child-1',
        expires_at: null,
        created_at: 100_000,
      },
    ]);
    expect(body.incoming_relationships).toEqual([
      {
        id: 'rel-in',
        relationship_type: 'delegate',
        subject_id: 'other-1',
        subject_email: 'other-1@example.com',
        subject_name: 'other-1',
        expires_at: null,
        created_at: 100_000,
      },
    ]);

    const incomingOnly = await json(
      await adminUserRelationshipsListHandler(
        context({ params: { id: 'parent-1' }, query: { direction: 'incoming' } })
      )
    );
    expect(incomingOnly.outgoing_relationships).toBeUndefined();
    expect(incomingOnly.incoming_relationships).toHaveLength(1);
  });

  it('deletes a relationship from either end, and only one the user is part of', async () => {
    insertRelationship(db, { id: 'rel-1', type: 'guardian', fromId: 'parent-1', toId: 'child-1' });
    insertRelationship(db, { id: 'rel-2', type: 'guardian', fromId: 'other-1', toId: 'child-1' });
    insertRelationship(db, {
      id: 'rel-org',
      type: 'member',
      fromId: 'parent-1',
      toType: 'org',
      toId: 'org-1',
    });

    const orgTuple = await adminUserRelationshipDeleteHandler(
      context({ params: { id: 'parent-1', relationshipId: 'rel-org' } })
    );
    expect(orgTuple.status).toBe(404);

    const unrelated = await adminUserRelationshipDeleteHandler(
      context({ params: { id: 'parent-1', relationshipId: 'rel-2' } })
    );
    expect(unrelated.status).toBe(404);

    const fromChild = await adminUserRelationshipDeleteHandler(
      context({ params: { id: 'child-1', relationshipId: 'rel-1' } })
    );
    expect(fromChild.status).toBe(200);
    expect(db.prepare('SELECT id FROM relationships ORDER BY id').all()).toEqual([
      { id: 'rel-2' },
      { id: 'rel-org' },
    ]);
  });
});
