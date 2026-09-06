import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createLookupBlindIndexes,
  type AccountDirectoryPublication,
  type Env,
} from '@authrim/ar-lib-core';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = { generation: 2, secret: '0123456789abcdef0123456789abcdef' };
const PREVIOUS_KEY = { generation: 1, secret: 'abcdef0123456789abcdef0123456789' };
const lookupForBucket = vi.hoisted(() => vi.fn());

vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: vi.fn(async () => ({
    writeKeys: [KEY],
    readKeys: [KEY, PREVIOUS_KEY],
    state: { current: { generation: 2 } },
  })),
}));

vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: vi.fn(async () => lookupForBucket),
}));

import { processOneScheduledExternalIdentifierUnlink } from '../external-identifier-unlink-scheduled';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function sqlValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_sqlite_test_value');
  });
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    return this.executeRun();
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class UnboundStatement {
  constructor(
    private readonly sql: string,
    private readonly database: DatabaseSync
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.database.prepare(this.sql), sqlValues(values));
  }

  first<T>(): Promise<T | null> {
    return this.bind().first<T>();
  }

  all<T>() {
    return this.bind().all<T>();
  }

  run() {
    return this.bind().run();
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  private prepare(sql: string): UnboundStatement {
    return new UnboundStatement(sql, this.database);
  }

  private session(): D1DatabaseSession {
    return {
      prepare: (sql: string) => this.prepare(sql),
      batch: async (statements: unknown[]) => this.batch(statements),
      getBookmark: () => null,
    } as unknown as D1DatabaseSession;
  }

  readonly binding = {
    prepare: (sql: string) => this.prepare(sql),
    batch: async (statements: unknown[]) => this.batch(statements),
    exec: async (sql: string) => {
      this.database.exec(sql);
      return { count: 0, duration: 0 };
    },
    withSession: () => this.session(),
  } as unknown as D1Database;

  private async batch(statements: unknown[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
        return statement.executeRun();
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('external identifier unlink scheduled recovery', () => {
  let core: DatabaseSync;
  let pii: DatabaseSync;
  let lookup: DatabaseSync;
  let coreD1: SqliteD1;
  let piiD1: SqliteD1;
  let lookupD1: SqliteD1;
  let publication: AccountDirectoryPublication;
  let externalIndexes: Awaited<ReturnType<typeof createLookupBlindIndexes>>;

  beforeEach(async () => {
    core = new DatabaseSync(':memory:');
    pii = new DatabaseSync(':memory:');
    lookup = new DatabaseSync(':memory:');
    core.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    core.exec(
      `INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, created_at, updated_at
       ) VALUES ('account:user-a', 'tenant-a', 'person', 'active', 1, 1);`
    );
    pii.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/pii/d1/001_0_4_0_pii_baseline.sql'), 'utf8')
    );
    lookup.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    coreD1 = new SqliteD1(core);
    piiD1 = new SqliteD1(pii);
    lookupD1 = new SqliteD1(lookup);
    lookupForBucket.mockReset().mockResolvedValue(lookupD1.binding);

    const accountIndexes = await createLookupBlindIndexes('account_id', 'account:user-a', [KEY]);
    externalIndexes = await createLookupBlindIndexes(
      'external_subject',
      { issuer: 'did', subject: 'did:key:subject-a' },
      [KEY, PREVIOUS_KEY]
    );
    publication = {
      operationId: 'create-a',
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      idempotencyKey: 'create-account-a',
      routeProjection: {
        schemaVersion: 1,
        accountRouteGeneration: 1,
        residencyPolicyId: 'default-policy',
        targets: [
          {
            dataRole: 'tenant_core/users',
            residencyPartition: 'global',
            shardId: 'core-a',
            bindingRef: 'CORE_A',
            requiredBindingRouteGeneration: 1,
          },
          {
            dataRole: 'tenant_pii',
            residencyPartition: 'global',
            shardId: 'pii-a',
            bindingRef: 'PII_A',
            requiredBindingRouteGeneration: 1,
          },
        ],
      },
      indexes: [...accountIndexes, ...externalIndexes],
    };
    core
      .prepare(
        `UPDATE identity_accounts SET directory_publication_state = 'active'
          WHERE tenant_id = 'tenant-a' AND id = 'account:user-a'`
      )
      .run();
    core
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, succeeded_at, updated_at
         ) VALUES ('account-routing:create-a', 'tenant-a', 'account:user-a',
                   'account_created', 1, 1, 1, ?, 'succeeded', 1, 1, 1, 1)`
      )
      .run(JSON.stringify(publication));
    for (const index of externalIndexes) {
      lookup
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'tenant-a', 'account:user-a', 1, 1, 1,
                     'default-policy', ?, 'active', 'active', 'active', 1, 1)`
        )
        .run(
          index.virtualBucket,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest,
          JSON.stringify(publication.routeProjection)
        );
      lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, committed_at, created_at, updated_at
           ) VALUES (?, 'tenant-a', ?, ?, ?, ?, 'account:user-a', 'committed',
                     'create-a', 1, 1, 1)`
        )
        .run(
          index.virtualBucket,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest
        );
    }
    pii
      .prepare(
        `INSERT INTO linked_identities (
           id, tenant_id, user_id, provider_id, provider_user_id, linked_at
         ) VALUES ('link-a', 'tenant-a', 'user-a', 'did', 'did:key:subject-a', 1)`
      )
      .run();
    pii
      .prepare(
        `INSERT INTO external_identifier_unlink_operations (
           operation_id, tenant_id, account_id, user_id, issuer_json, subject_json,
           issuer_sha256, subject_sha256, route_projection_json, state,
           attempt_count, created_at, updated_at
         ) VALUES ('unlink-a', 'tenant-a', 'account:user-a', 'user-a', ?, ?, ?, ?, ?,
                   'pending', 0, 1, 1)`
      )
      .run(
        JSON.stringify('did'),
        JSON.stringify('did:key:subject-a'),
        await sha256Hex('did'),
        await sha256Hex('did:key:subject-a'),
        JSON.stringify(publication.routeProjection)
      );
    pii.prepare(`DELETE FROM linked_identities WHERE id = 'link-a'`).run();
  });

  afterEach(() => {
    core.close();
    pii.close();
    lookup.close();
  });

  function env(): Env {
    return { CORE_A: coreD1.binding, PII_A: piiD1.binding } as unknown as Env;
  }

  it('removes Lookup state before completing and erasing the durable PII operation', async () => {
    await expect(
      processOneScheduledExternalIdentifierUnlink(
        env(),
        // The scheduler receives this adapter from its bounded PII shard scan.
        (await import('@authrim/ar-lib-core')).ensureDatabaseAdapter(piiD1.binding, 'test-pii'),
        'owner-a',
        100
      )
    ).resolves.toBe(true);

    expect(
      lookup
        .prepare(
          `SELECT hmac_key_generation, lifecycle_state
             FROM lookup_identifiers ORDER BY hmac_key_generation`
        )
        .all()
    ).toEqual([
      { hmac_key_generation: 1, lifecycle_state: 'disabled' },
      { hmac_key_generation: 2, lifecycle_state: 'disabled' },
    ]);
    expect(
      lookup
        .prepare(
          `SELECT hmac_key_generation, reservation_state
             FROM lookup_identifier_reservations ORDER BY hmac_key_generation`
        )
        .all()
    ).toEqual([
      { hmac_key_generation: 1, reservation_state: 'released' },
      { hmac_key_generation: 2, reservation_state: 'released' },
    ]);
    expect(
      core
        .prepare(
          `SELECT status FROM account_routing_outbox WHERE event_kind = 'identifier_removed'`
        )
        .get()
    ).toEqual({ status: 'succeeded' });
    expect(
      pii
        .prepare(
          `SELECT state, issuer_json, subject_json, raw_values_erased_at
             FROM external_identifier_unlink_operations WHERE operation_id = 'unlink-a'`
        )
        .get()
    ).toEqual({
      state: 'completed',
      issuer_json: null,
      subject_json: null,
      raw_values_erased_at: 100,
    });
  });

  it('fails closed and retains raw recovery data when the stored digest is corrupted', async () => {
    pii
      .prepare(
        `UPDATE external_identifier_unlink_operations SET subject_sha256 = ?
          WHERE operation_id = 'unlink-a'`
      )
      .run('0'.repeat(64));

    await processOneScheduledExternalIdentifierUnlink(
      env(),
      (await import('@authrim/ar-lib-core')).ensureDatabaseAdapter(piiD1.binding, 'test-pii'),
      'owner-a',
      100
    );

    expect(
      pii
        .prepare(
          `SELECT state, subject_json, raw_values_erased_at, error_code
             FROM external_identifier_unlink_operations WHERE operation_id = 'unlink-a'`
        )
        .get()
    ).toEqual({
      state: 'blocked',
      subject_json: JSON.stringify('did:key:subject-a'),
      raw_values_erased_at: null,
      error_code: 'external_identifier_unlink_blocked',
    });
    expect(lookup.prepare(`SELECT lifecycle_state FROM lookup_identifiers`).get()).toEqual({
      lifecycle_state: 'active',
    });
  });

  it('adopts a succeeded Core outbox after response loss and completes PII cleanup', async () => {
    await processOneScheduledExternalIdentifierUnlink(
      env(),
      (await import('@authrim/ar-lib-core')).ensureDatabaseAdapter(piiD1.binding, 'test-pii'),
      'owner-a',
      100
    );
    pii
      .prepare(
        `UPDATE external_identifier_unlink_operations
            SET state = 'directory_pending', issuer_json = ?, subject_json = ?,
                raw_values_erased_at = NULL, completed_at = NULL, lease_owner = NULL,
                lease_expires_at = NULL, next_attempt_at = 101, updated_at = 101
          WHERE operation_id = 'unlink-a'`
      )
      .run(JSON.stringify('did'), JSON.stringify('did:key:subject-a'));

    await processOneScheduledExternalIdentifierUnlink(
      env(),
      (await import('@authrim/ar-lib-core')).ensureDatabaseAdapter(piiD1.binding, 'test-pii'),
      'owner-b',
      101
    );

    expect(
      core
        .prepare(
          `SELECT COUNT(*) AS count FROM account_routing_outbox WHERE event_kind = 'identifier_removed'`
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      pii.prepare(`SELECT state, issuer_json FROM external_identifier_unlink_operations`).get()
    ).toEqual({ state: 'completed', issuer_json: null });
  });
});
