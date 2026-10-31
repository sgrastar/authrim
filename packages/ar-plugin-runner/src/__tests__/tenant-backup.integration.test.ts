import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { D1PluginConfigStore } from '../config-store';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import { DynamicPluginTenantBackupService } from '../tenant-backup';
import type { PluginRunnerEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const VERSION = '1'.repeat(64);
const SOURCE_KEY = 'source-plugin-runner-encryption-key-value';
const TARGET_KEY = 'target-plugin-runner-encryption-key-value';
const MUTATION_KEY = 'plugin-runner-mutation-hmac-key-value';

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.values) as T[] };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class Session {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      bind: (...values: unknown[]) =>
        new BoundStatement(
          statement,
          values.map((value) => {
            if (
              typeof value === 'string' ||
              typeof value === 'number' ||
              value === null ||
              value instanceof Uint8Array
            )
              return value;
            throw new Error('unsupported_test_sqlite_value');
          })
        ),
    };
  }

  async batch(statements: BoundStatement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

function database(): DatabaseSync {
  const value = new DatabaseSync(':memory:');
  value.exec(
    readFileSync(
      resolve(REPO_ROOT, 'migrations/plugin-runner/d1/001_0_4_0_plugin_runner_baseline.sql'),
      'utf8'
    )
  );
  value.exec('PRAGMA foreign_keys = ON');
  return value;
}

function publish(value: DatabaseSync, version = VERSION): void {
  value
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES ('plugin-a', ?, ?, ?, ?, ?, ?, 'published', 1, 1)`
    )
    .run(
      version,
      'a'.repeat(64),
      `plugins/plugin-a/${'a'.repeat(64)}.json`,
      'b'.repeat(64),
      'c'.repeat(64),
      JSON.stringify({
        backend: 'dynamic_worker',
        resourceScope: 'tenant',
        visibility: 'tenant',
        capabilities: [{ name: 'flow.evaluate' }],
        credentials: [{ configKey: 'apiKey', required: true }],
        egressAllowedHosts: [{ kind: 'exact', host: 'api.example.com' }],
        hostInterfaces: [],
        resources: [],
      })
    );
  value
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES ('plugin-a', ?, 'active', 1)`
    )
    .run(version);
  value
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_credential_slots (
         plugin_id, version_digest, config_key, required, destination_host,
         injection_kind, injection_name, updated_at
       ) VALUES ('plugin-a', ?, 'apiKey', 1, 'api.example.com', 'bearer', 'Authorization', 1)`
    )
    .run(version);
  value
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_egress_allowed_hosts (
         plugin_id, version_digest, rule_id, match_kind, host_pattern, created_at
       ) VALUES ('plugin-a', ?, 'api', 'exact', 'api.example.com', 1)`
    )
    .run(version);
  value.exec(
    `INSERT INTO plugin_runner_approved_mutation_scopes (
       plugin_id, mutation_scope, approved_at
     ) VALUES ('plugin-a', 'account.metadata.write', 1)`
  );
}

function environment(value: DatabaseSync, environmentId: string, encryptionKey: string) {
  return {
    PLUGIN_RUNNER_DB: d1(value),
    AUTHRIM_ENVIRONMENT_NAME: environmentId,
    PLUGIN_ENCRYPTION_KEY: encryptionKey,
    PLUGIN_MUTATION_HMAC_KEY: MUTATION_KEY,
  } as PluginRunnerEnv;
}

describe('dynamic plugin tenant backup service', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    while (databases.length) databases.pop()?.close();
  });

  it('roundtrips credentials and scopes with a target-derived installation id and key', async () => {
    const sourceDb = database();
    const targetDb = database();
    databases.push(sourceDb, targetDb);
    publish(sourceDb);
    publish(targetDb);
    const sourceEnv = environment(sourceDb, 'source', SOURCE_KEY);
    const targetEnv = environment(targetDb, 'target', TARGET_KEY);
    const sourceInstallations = new D1DynamicPluginInstallationStore(
      sourceEnv.PLUGIN_RUNNER_DB,
      'source',
      () => 10
    );
    const source = await sourceInstallations.configure({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: false,
    });
    await new D1PluginConfigStore(
      sourceEnv.PLUGIN_RUNNER_DB,
      SOURCE_KEY,
      MUTATION_KEY,
      () => 11
    ).replaceCredentials({
      operationId: 'source-credential',
      tenantId: 'tenant-a',
      installationId: source.installationId,
      expectedConfigVersion: 1,
      credentials: [
        {
          configKey: 'apiKey',
          destinationHost: 'api.example.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: 'source-secret',
        },
      ],
    });
    sourceDb
      .prepare(
        `INSERT INTO plugin_runner_installation_mutation_scopes (
           installation_id, mutation_scope, state, updated_at
         ) VALUES (?, 'account.metadata.write', 'enabled', 12)`
      )
      .run(source.installationId);
    await sourceInstallations.configure({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });

    const exported = await new DynamicPluginTenantBackupService(sourceEnv, () => 20).export({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
    });
    expect(exported).toMatchObject({
      enabled: true,
      credentials: { apiKey: 'source-secret' },
      mutationScopes: ['account.metadata.write'],
      resources: [],
      sourceInstallationId: source.installationId,
    });
    if (!exported) throw new Error('test_export_missing');
    const restored = await new DynamicPluginTenantBackupService(targetEnv, () => 30).restore({
      operationId: 'restore-a',
      configuration: exported,
    });
    expect(restored).toMatchObject({ state: 'enabled', configVersion: 2 });
    expect(restored.installationId).not.toBe(source.installationId);
    await expect(
      new DynamicPluginTenantBackupService(targetEnv, () => 31).verify({
        configuration: exported,
      })
    ).resolves.toBe(true);
    const sourceEnvelope = sourceDb
      .prepare(`SELECT encrypted_value FROM plugin_runner_encrypted_configs`)
      .get() as { encrypted_value: string };
    const targetEnvelope = targetDb
      .prepare(`SELECT encrypted_value FROM plugin_runner_encrypted_configs`)
      .get() as { encrypted_value: string };
    expect(targetEnvelope.encrypted_value).not.toBe(sourceEnvelope.encrypted_value);
    expect(targetEnvelope.encrypted_value).not.toContain('source-secret');
  });

  it('refuses a target with a different active plugin version before creating an installation', async () => {
    const targetDb = database();
    databases.push(targetDb);
    publish(targetDb, '2'.repeat(64));
    const service = new DynamicPluginTenantBackupService(
      environment(targetDb, 'target', TARGET_KEY),
      () => 30
    );
    await expect(
      service.restore({
        operationId: 'restore-version-mismatch',
        configuration: {
          tenantId: 'tenant-a',
          sourceInstallationId: 'source-installation',
          pluginId: 'plugin-a',
          versionDigest: VERSION,
          contractVersion: 1,
          enabled: false,
          credentials: {},
          resources: [],
          mutationScopes: [],
        },
      })
    ).rejects.toThrow('plugin_dynamic_backup_version_mismatch');
    expect(
      targetDb.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_installations`).get()
    ).toEqual({
      count: 0,
    });
  });

  it('requires logical resources to be provisioned in the target before mutation', async () => {
    const targetDb = database();
    databases.push(targetDb);
    publish(targetDb);
    const service = new DynamicPluginTenantBackupService(
      environment(targetDb, 'target', TARGET_KEY),
      () => 30
    );
    await expect(
      service.restore({
        operationId: 'restore-resource-prerequisite',
        configuration: {
          tenantId: 'tenant-a',
          sourceInstallationId: 'source-installation',
          pluginId: 'plugin-a',
          versionDigest: VERSION,
          contractVersion: 1,
          enabled: false,
          credentials: {},
          resources: [
            {
              logicalResourceId: 'data',
              binding: 'PLUGIN_DATA',
              kind: 'd1',
              access: 'read_write',
            },
          ],
          mutationScopes: [],
        },
      })
    ).rejects.toThrow('plugin_dynamic_backup_resources_required');
    expect(
      targetDb.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_installations`).get()
    ).toEqual({
      count: 0,
    });
  });
});
