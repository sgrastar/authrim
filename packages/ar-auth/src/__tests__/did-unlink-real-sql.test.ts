/**
 * DID unlink and link again, on a real SQLite PII database built from the PII migrations (so the
 * unlink table, its link-required trigger and its CHECK constraints are the production ones) and
 * a real core database for the account's creation record. Only the session, the account lookup and
 * the linked-identity repository (a thin layer over the same `linked_identities` table) are fakes.
 *
 * Every unlink of a DID is its own operation: a completed one must never stand in for the unlink
 * of a DID that was linked again, and a retry of an unlink whose link row is already gone must
 * find the operation that removed it.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLookupBlindIndex } from '@authrim/ar-lib-core';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

const DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
const USER = 'user-123';
const ACCOUNT = `account:${USER}`;

const world = vi.hoisted(() => ({
  pii: undefined as unknown,
  core: undefined as unknown,
  linkSequence: 0,
}));

vi.mock('hono/cookie', () => ({ getCookie: vi.fn(() => 'session-1') }));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: { getSessionRpc: vi.fn(async () => ({ userId: 'user-123' })) },
    })),
    resolveAccountDataContextFromHono: vi.fn(async (_c: unknown, userId: string) => ({
      tenantId: 'default',
      accountId: `account:${userId}`,
      legacyUserId: userId,
      coreDb: world.core,
    })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: world.pii })),
    LinkedIdentityRepository: class {
      async findByProviderUser(tenantId: string, providerId: string, providerUserId: string) {
        return (
          ((world.pii as { raw: SqliteDatabase }).raw
            .prepare(
              `SELECT * FROM linked_identities
                WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?`
            )
            .get(tenantId, providerId, providerUserId) as Record<string, unknown> | undefined) ??
          null
        );
      }
    },
  };
});

import { didUnlinkHandler } from '../did-link';

function migrate(folder: string): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  const directory = path.resolve(__dirname, '../../../../migrations', folder, 'd1');
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(path.join(directory, file), 'utf8'), 'sqlite'));
  }
  return db;
}

function adapterOver(db: SqliteDatabase): DatabaseAdapter & { raw: SqliteDatabase } {
  const bind = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value));
  const adapter = {
    raw: db,
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      (db.prepare(sql).get(...bind(params)) as unknown) ?? null,
    execute: async (sql: string, params?: unknown[]) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...bind(params)).changes),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({
          success: true,
          rowsAffected: Number(db.prepare(statement.sql).run(...bind(statement.params)).changes),
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isHealthy: async () => true,
    getType: () => 'sqlite',
    close: async () => undefined,
  };
  return adapter as unknown as DatabaseAdapter & { raw: SqliteDatabase };
}

const ROUTE = {
  schemaVersion: 1,
  accountRouteGeneration: 1,
  residencyPolicyId: 'default-policy',
  targets: [
    {
      dataRole: 'tenant_core/users',
      residencyPartition: 'default',
      shardId: 'users-1',
      bindingRef: 'TDB_USERS_1',
      requiredBindingRouteGeneration: 3,
    },
  ],
};

function context(): Context<{ Bindings: Env }> {
  const store = new Map<string, unknown>([['tenantId', 'default']]);
  return {
    req: { param: vi.fn(() => encodeURIComponent(DID)), header: vi.fn() },
    env: {} as Env,
    json: vi.fn(
      (data: unknown, status?: number) =>
        new Response(JSON.stringify(data), {
          status: status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('DID unlink (real SQL)', () => {
  let pii: DatabaseAdapter & { raw: SqliteDatabase };

  beforeEach(async () => {
    pii = adapterOver(migrate('pii'));
    const coreDb = migrate('core');
    coreDb
      .prepare(
        `INSERT INTO identity_accounts (
           id, tenant_id, account_type, lifecycle_state, directory_publication_state,
           account_route_generation, created_at, updated_at
         ) VALUES (?, 'default', 'person', 'active', 'active', 1, 1, 1)`
      )
      .run(ACCOUNT);
    coreDb
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at
         ) VALUES ('account-routing:create', 'default', ?, 'account_created', 1, 1, 1, ?,
                   'succeeded', 0, 1, 1)`
      )
      .run(
        ACCOUNT,
        JSON.stringify({
          operationId: 'create',
          tenantId: 'default',
          accountId: ACCOUNT,
          idempotencyKey: 'create',
          routeProjection: ROUTE,
          indexes: [
            await createLookupBlindIndex('account_id', ACCOUNT, {
              generation: 1,
              secret: '0123456789abcdef0123456789abcdef',
            }),
          ],
        })
      );
    world.pii = pii;
    world.core = adapterOver(coreDb);
    world.linkSequence = 0;
  });

  function link(userId = USER): string {
    const id = `link-${++world.linkSequence}`;
    pii.raw
      .prepare(
        `INSERT INTO linked_identities (
           id, tenant_id, user_id, provider_id, provider_user_id, linked_at
         ) VALUES (?, 'default', ?, 'did', ?, 1)`
      )
      .run(id, userId, DID);
    return id;
  }

  const links = () =>
    pii.raw.prepare(`SELECT id, user_id FROM linked_identities WHERE provider_id = 'did'`).all();
  const operations = () =>
    pii.raw
      .prepare(
        `SELECT operation_id, state, issuer_json, raw_values_erased_at
           FROM external_identifier_unlink_operations ORDER BY created_at, operation_id`
      )
      .all() as Array<{ operation_id: string; state: string }>;

  /** What the scheduled cleanup does when it finishes an operation. */
  function complete(operationId: string) {
    pii.raw
      .prepare(
        `UPDATE external_identifier_unlink_operations
            SET state = 'completed', issuer_json = NULL, subject_json = NULL,
                raw_values_erased_at = 5, completed_at = 5
          WHERE operation_id = ?`
      )
      .run(operationId);
  }

  async function unlink() {
    const response = await didUnlinkHandler(context());
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('unlinks a linked DID with an operation of its own', async () => {
    link();
    const result = await unlink();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, cleanup_pending: true });
    expect(links()).toEqual([]);
    expect(operations()).toEqual([
      expect.objectContaining({ operation_id: result.body.operation_id, state: 'pending' }),
    ]);
    expect(String(result.body.operation_id)).toMatch(/^external-unlink:[a-f0-9]{32}$/);
  });

  it('unlinks the DID again after it was linked again, whatever became of the first operation', async () => {
    link();
    const first = await unlink();
    complete(String(first.body.operation_id));

    link();
    const second = await unlink();

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ success: true, cleanup_pending: true });
    expect(second.body.operation_id).not.toBe(first.body.operation_id);
    expect(links()).toEqual([]);
    expect(
      operations()
        .map((operation) => operation.state)
        .sort()
    ).toEqual(['completed', 'pending']);
  });

  it('repeats the unlink across several link cycles', async () => {
    const operationIds = new Set<string>();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      link();
      const result = await unlink();
      expect(result.body.cleanup_pending).toBe(true);
      expect(links()).toEqual([]);
      operationIds.add(String(result.body.operation_id));
      complete(String(result.body.operation_id));
    }
    expect(operationIds.size).toBe(3);
  });

  it('answers a retry of an unlink whose link row is gone with the operation that removed it', async () => {
    link();
    const first = await unlink();

    const retry = await unlink();
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      operation_id: first.body.operation_id,
      cleanup_pending: true,
    });
    expect(operations()).toHaveLength(1);

    pii.raw
      .prepare(`UPDATE external_identifier_unlink_operations SET state = 'directory_pending'`)
      .run();
    const again = await unlink();
    expect(again.body).toMatchObject({
      operation_id: first.body.operation_id,
      cleanup_pending: true,
    });
    expect(operations()).toHaveLength(1);
  });

  it('reports a completed unlink as done when the link is already gone', async () => {
    link();
    const first = await unlink();
    complete(String(first.body.operation_id));

    const retry = await unlink();
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      operation_id: first.body.operation_id,
      cleanup_pending: false,
    });
    expect(operations()).toHaveLength(1);
  });

  it('refuses an unlink of an unknown DID', async () => {
    const result = await unlink();
    expect(result.status).toBe(400);
    expect(operations()).toEqual([]);
  });

  it('does not unlink a DID linked to another user', async () => {
    link('user-999');
    const result = await unlink();
    expect(result.status).toBe(403);
    expect(links()).toHaveLength(1);
    expect(operations()).toEqual([]);
  });

  it('does not start a second operation while the first one of the DID is still running', async () => {
    link();
    const first = await unlink();
    link();

    const second = await unlink();
    expect(second.status).toBe(503);
    expect(links()).toHaveLength(1);
    expect(operations()).toHaveLength(1);

    complete(String(first.body.operation_id));
    const third = await unlink();
    expect(third.status).toBe(200);
    expect(links()).toEqual([]);
    expect(operations()).toHaveLength(2);
  });

  it('keeps a blocked unlink blocked for the retry, but a blocked one of an earlier link never stops a later unlink', async () => {
    link();
    const first = await unlink();
    pii.raw
      .prepare(
        `UPDATE external_identifier_unlink_operations SET state = 'blocked' WHERE operation_id = ?`
      )
      .run(first.body.operation_id);

    // The link row is gone and the operation is blocked: the retry reports the failure.
    expect((await unlink()).status).toBe(500);

    // The DID was linked again afterwards (the route was released by hand): the new link unlinks.
    link();
    const next = await unlink();
    expect(next.status).toBe(200);
    expect(next.body.operation_id).not.toBe(first.body.operation_id);
    expect(links()).toEqual([]);
  });

  it('creates no operation when the link was replaced between the read and the write', async () => {
    link();
    const core = world.core as { queryOne: (sql: string, params?: unknown[]) => Promise<unknown> };
    const queryOne = core.queryOne.bind(core);
    // Somebody else unlinks the DID and links it again while this request reads the route.
    core.queryOne = async (sql, params) => {
      pii.raw.prepare(`DELETE FROM linked_identities`).run();
      link();
      return queryOne(sql, params);
    };

    const result = await unlink();

    expect(result.status).toBe(503);
    expect(operations()).toEqual([]);
    expect(links()).toEqual([expect.objectContaining({ id: 'link-2' })]);
    // Repeating the request unlinks the link that exists now.
    core.queryOne = queryOne;
    const again = await unlink();
    expect(again.status).toBe(200);
    expect(links()).toEqual([]);
    expect(operations()).toHaveLength(1);
  });

  it('answers a retry with the newest operation of the DID, not with an older blocked one', async () => {
    link();
    const first = await unlink();
    pii.raw
      .prepare(
        `UPDATE external_identifier_unlink_operations
            SET state = 'blocked' WHERE operation_id = ?`
      )
      .run(String(first.body.operation_id));
    link();
    const second = await unlink();
    expect(second.status).toBe(200);
    complete(String(second.body.operation_id));
    // Both operations were created in the same second.
    pii.raw
      .prepare(`UPDATE external_identifier_unlink_operations SET created_at = 7, updated_at = 7`)
      .run();

    const retry = await unlink();
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      operation_id: second.body.operation_id,
      cleanup_pending: false,
    });
    expect(operations()).toHaveLength(2);
  });

  it('picks the operation created last when several share the same second, whatever their ids', async () => {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    link();
    const insert = (operationId: string) =>
      pii.raw
        .prepare(
          `INSERT INTO external_identifier_unlink_operations (
             operation_id, tenant_id, account_id, user_id, issuer_json, subject_json,
             issuer_sha256, subject_sha256, route_projection_json, state,
             attempt_count, created_at, updated_at
           ) VALUES (?, 'default', ?, ?, '"did"', ?, ?, ?, '{}', 'pending', 0, 7, 7)`
        )
        .run(operationId, ACCOUNT, USER, JSON.stringify(DID), sha('did'), sha(DID));
    // The first operation has the id that sorts last; it is completed. The second one is newer.
    insert('external-unlink:zzzz');
    complete('external-unlink:zzzz');
    insert('external-unlink:aaaa');
    pii.raw.prepare(`DELETE FROM linked_identities`).run();
    expect(
      pii.raw
        .prepare(`SELECT created_at, updated_at FROM external_identifier_unlink_operations`)
        .all()
    ).toEqual([
      { created_at: 7, updated_at: 7 },
      { created_at: 7, updated_at: 7 },
    ]);

    const retry = await unlink();
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      operation_id: 'external-unlink:aaaa',
      cleanup_pending: true,
    });
  });
});
