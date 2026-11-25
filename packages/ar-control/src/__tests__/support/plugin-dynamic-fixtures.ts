import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const MANIFEST_DIGEST = 'a'.repeat(64);
export const VERSION_DIGEST = 'b'.repeat(64);

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

export function d1(database: DatabaseSync): D1Database {
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

export function aggregate(
  bindings = [{ name: 'TENANT_PROFILE', interface: 'authrim.account_metadata.v1' }],
  resources: unknown[] = []
) {
  return JSON.stringify({
    sourceKind: 'plugin_manifest',
    sourceId: 'plugin-a',
    sourceManifestPath: 'plugins/plugin-a/authrim.plugin-worker-capabilities.json',
    sourceManifestHash: 'c'.repeat(64),
    capabilityManifestDigest: MANIFEST_DIGEST,
    provenance: null,
    pluginPolicy: {
      backend: 'dynamic_worker',
      resourceScope: 'tenant',
      visibility: 'tenant',
      capabilities: [{ mutationScopes: ['account.metadata.write'] }],
      credentials: [],
      egressAllowedHosts: [],
      workerArtifact: {
        sourceBundlePath: 'plugins/plugin-a/worker.json',
        codeSha256: 'd'.repeat(64),
        codeObjectKey: `plugins/plugin-a/${'d'.repeat(64)}.json`,
        size: 100,
      },
      hostInterfaces: bindings.map((binding) => ({ ...binding, scope: 'tenant' })),
      resources,
    },
    workers: [
      {
        workerReference: 'plugin:plugin-a',
        scriptName: null,
        bindings: bindings.map((binding) => ({
          name: binding.name,
          kind: 'plugin_interface',
          capability: binding.interface,
          scope: 'tenant',
          reason: null,
        })),
      },
    ],
  });
}

export function seededDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'), 'utf8')
  );
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, completed_at, updated_at
    ) VALUES (
      'manifest-op', 'test', 'register_external_capabilities', 'manifest-a', 'succeeded',
      'setup', 1, 1, 1, 1
    );
  `);
  database
    .prepare(
      `INSERT INTO control_external_capability_sources (
         environment_id, source_kind, source_id, source_manifest_path, source_manifest_hash,
         capability_manifest_digest, aggregate_json, status, review_state,
         registered_by_operation_id, registered_at
       ) VALUES ('test', 'plugin_manifest', 'plugin-a', ?, ?, ?, ?, 'active',
         'auto_registered', 'manifest-op', 1)`
    )
    .run(
      'plugins/plugin-a/authrim.plugin-worker-capabilities.json',
      'c'.repeat(64),
      MANIFEST_DIGEST,
      aggregate()
    );
  database
    .prepare(
      `INSERT INTO control_external_capability_bindings (
         environment_id, source_kind, source_id, worker_reference, worker_script_name,
         binding_name, binding_kind, capability, capability_scope, reason, updated_at
       ) VALUES ('test', 'plugin_manifest', 'plugin-a', 'plugin:plugin-a', NULL,
         'TENANT_PROFILE', 'plugin_interface', 'authrim.account_metadata.v1', 'tenant', NULL, 1)`
    )
    .run();
  return database;
}

export const STATE_RESOURCE = {
  schemaVersion: 1,
  logicalResourceId: 'plugin-state',
  binding: 'PLUGIN_STATE',
  kind: 'd1',
  scope: 'tenant',
  access: 'read_write',
  provisioning: { defaultMode: 'managed', allowExisting: true },
  migrationStream: 'plugin/plugin-a/state',
};

/** Declares the d1 resource and activates its migration release. */
export function withStateResource(
  database: DatabaseSync,
  resources: unknown[] = [STATE_RESOURCE]
): void {
  database
    .prepare(
      `UPDATE control_external_capability_sources SET aggregate_json = ? WHERE source_id = 'plugin-a'`
    )
    .run(aggregate(undefined, resources));
  database.exec(`
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, completed_at, updated_at
    ) VALUES (
      'plugin-release-op', 'test', 'register_migration_release', 'plugin-release', 'succeeded',
      'setup', 1, 1, 1, 1
    );
    INSERT INTO control_migration_release_catalog (
      environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
      state, active_stream_key, registered_by_operation_id, registered_at, activated_at
    ) VALUES (
      'test', 'plugin/plugin-a/state', '0.4.0', '${'f'.repeat(64)}',
      'releases/0.4.0/${'f'.repeat(64)}/manifest.json',
      'active', 'active', 'plugin-release-op', 1, 1
    );
  `);
}
