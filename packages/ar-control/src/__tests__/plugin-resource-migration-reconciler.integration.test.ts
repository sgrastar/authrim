import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { MigrationD1Executor } from '../migration-engine';
import { PluginResourceMigrationReconciler } from '../plugin-resource-migration-reconciler';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const STREAM_ID = 'plugin/plugin-a/state';
const RELEASE_ID = '0.4.0';
const FINGERPRINT = 'a'.repeat(64);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function artifact(sqlOverride?: string) {
  const sql = 'CREATE TABLE plugin_state (id TEXT PRIMARY KEY);';
  const manifest = `${JSON.stringify({
    formatVersion: 1,
    productVersion: RELEASE_ID,
    streams: [
      {
        id: STREAM_ID,
        dialect: 'sqlite',
        logicalRoles: ['plugin_state'],
        files: [{ path: '001_state.sql', checksum: digest(sql) }],
      },
    ],
  })}\n`;
  const manifestDigest = digest(manifest);
  const root = `releases/${RELEASE_ID}/${manifestDigest}`;
  const objects = new Map<string, string>([
    [`${root}/manifest.json`, manifest],
    [`${root}/streams/${STREAM_ID}/001_state.sql`, sqlOverride ?? sql],
  ]);
  const bucket = {
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        size: bytes.byteLength,
        body: new ReadableStream<Uint8Array>(),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
  } as unknown as R2Bucket;
  return { bucket, manifestDigest, manifestObjectKey: `${root}/manifest.json` };
}

function api(manifestDigest: string): MigrationD1Executor {
  const history: Array<{ filename: string; checksum: string; applied_at: number }> = [];
  const success = (results: unknown[] = []): CloudflareD1QueryResult[] => [
    { success: true, results },
  ];
  return {
    async queryD1(_databaseId, sql) {
      if (sql.includes("name IN ('authrim_migrations', 'tenant_database_migration_state')")) {
        return success([
          { name: 'authrim_migrations' },
          { name: 'tenant_database_migration_state' },
        ]);
      }
      if (sql.startsWith('SELECT filename')) return success(history);
      if (sql.startsWith('SELECT stream_id')) {
        return success([
          {
            stream_id: STREAM_ID,
            release_id: RELEASE_ID,
            manifest_digest: manifestDigest,
            applied_file_count: 1,
            state: 'ready',
            last_filename: '001_state.sql',
          },
        ]);
      }
      throw new Error('unexpected_query');
    },
    async queryD1Batch(_databaseId, batch) {
      const record = batch.find((query) => query.sql.includes('INSERT INTO authrim_migrations'));
      if (record) {
        history.push({
          filename: String(record.params?.[0]),
          checksum: String(record.params?.[1]),
          applied_at: Number(record.params?.[2]),
        });
      }
      return batch.map(() => ({ success: true, results: [] }));
    },
  } satisfies MigrationD1Executor;
}

describe('PluginResourceMigrationReconciler', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
  });

  afterEach(() => database.close());

  function seed(manifestDigest: string, manifestObjectKey: string) {
    const operationId = 'op-plugin-resource-a';
    const resourceId = 'plugin-resource-v1-a';
    const prefix = `plugin_resource_${FINGERPRINT.slice(0, 20)}`;
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES (
        'release-op', 'test', 'register_migration_release', 'release', 'succeeded',
        'setup', 1, 1, 1, 1
      );
    `);
    database
      .prepare(
        `INSERT INTO control_migration_release_catalog (
           environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
           state, active_stream_key, registered_by_operation_id, registered_at, activated_at
         ) VALUES ('test', ?, ?, ?, ?, 'active', 'active', 'release-op', 1, 1)`
      )
      .run(STREAM_ID, RELEASE_ID, manifestDigest, manifestObjectKey);
    database
      .prepare(
        `INSERT INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key, status,
           requested_by_type, attempt_count, created_at, started_at, updated_at
         ) VALUES (?, 'test', 'provision_plugin_resources', ?, 'running', 'admin', 1, 2, 2, 2)`
      )
      .run(operationId, operationId);
    database
      .prepare(
        `INSERT INTO control_operation_release_pins (
           operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
         ) VALUES (?, 'test', ?, ?, ?, 2)`
      )
      .run(operationId, STREAM_ID, RELEASE_ID, manifestDigest);
    for (const [suffix, order, status] of [
      ['provider', 0, 'succeeded'],
      ['migration', 10, 'queued'],
      ['binding', 20, 'queued'],
    ] as const) {
      database
        .prepare(
          `INSERT INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, ?, ?, ?, 0, 2)`
        )
        .run(operationId, `${prefix}_${suffix}`, order, status);
    }
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id,
           tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json,
           desired_spec_json, status, updated_at
         ) VALUES (?, 'test', ?, 'installation-a', 'tenant-a', 'd1', 'state',
           'PLUGIN_STATE', 'managed', 'db-a', 'db-name', '{}', ?, 'ready', 2)`
      )
      .run(
        resourceId,
        operationId,
        JSON.stringify({
          ownershipFingerprint: FINGERPRINT,
          ownership: 'authrim_managed',
          deleteProviderResource: true,
        })
      );
    database
      .prepare(
        `INSERT INTO control_plugin_resource_migration_state (
           plugin_resource_id, environment_id, operation_id, stream_id, release_id,
           manifest_digest, state, updated_at
         ) VALUES (?, 'test', ?, ?, ?, ?, 'requested', 2)`
      )
      .run(resourceId, operationId, STREAM_ID, RELEASE_ID, manifestDigest);
    return { operationId, resourceId, prefix };
  }

  it('applies the pinned checksum release and leaves binding activation pending', async () => {
    const release = artifact();
    const seeded = seed(release.manifestDigest, release.manifestObjectKey);
    const reconciler = new PluginResourceMigrationReconciler(
      d1(database),
      release.bucket,
      api(release.manifestDigest),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);

    expect(
      database
        .prepare(
          `SELECT state, provider_database_id, expected_file_count, applied_file_count,
                  last_filename
             FROM control_plugin_resource_migration_state`
        )
        .get()
    ).toEqual({
      state: 'ready',
      provider_database_id: 'db-a',
      expected_file_count: 1,
      applied_file_count: 1,
      last_filename: '001_state.sql',
    });
    expect(database.prepare(`SELECT status FROM control_plugin_desired_resources`).get()).toEqual({
      status: 'ready',
    });
    expect(
      database
        .prepare(`SELECT status FROM control_operation_steps WHERE step_key = ?`)
        .get(`${seeded.prefix}_binding`)
    ).toEqual({ status: 'queued' });
  });

  it('blocks a replaced SQL object before activation and records only a stable error code', async () => {
    const release = artifact('SELECT 1;');
    seed(release.manifestDigest, release.manifestObjectKey);
    const reconciler = new PluginResourceMigrationReconciler(
      d1(database),
      release.bucket,
      api(release.manifestDigest),
      () => 100
    );

    await reconciler.reconcile();

    expect(
      database
        .prepare(`SELECT state, last_error_code FROM control_plugin_resource_migration_state`)
        .get()
    ).toEqual({ state: 'blocked', last_error_code: 'migration_release_sql_checksum_mismatch' });
    expect(
      database
        .prepare(
          `SELECT status, last_error_redacted
             FROM control_operations
            WHERE operation_id = ?`
        )
        .get('op-plugin-resource-a')
    ).toEqual({
      status: 'blocked',
      last_error_redacted: 'migration_release_sql_checksum_mismatch',
    });
    expect(database.prepare(`SELECT status FROM control_plugin_desired_resources`).get()).toEqual({
      status: 'ready',
    });
  });
});
