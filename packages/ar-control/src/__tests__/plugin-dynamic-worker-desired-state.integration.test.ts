import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginDynamicWorkerDesiredStateService } from '../plugin-dynamic-worker-desired-state';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MANIFEST_DIGEST = 'a'.repeat(64);
const VERSION_DIGEST = 'b'.repeat(64);

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

function aggregate(
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

describe('PluginDynamicWorkerDesiredStateService', () => {
  let database: DatabaseSync;
  let service: PluginDynamicWorkerDesiredStateService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
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
    const insertSource = database.prepare(
      `INSERT INTO control_external_capability_sources (
         environment_id, source_kind, source_id, source_manifest_path, source_manifest_hash,
         capability_manifest_digest, aggregate_json, status, review_state,
         registered_by_operation_id, registered_at
       ) VALUES ('test', 'plugin_manifest', 'plugin-a', ?, ?, ?, ?, 'active',
         'auto_registered', 'manifest-op', 1)`
    );
    insertSource.run(
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
    service = new PluginDynamicWorkerDesiredStateService(d1(database), () => 1_800_000_000);
  });

  afterEach(() => database.close());

  it('derives an approved tenant-scoped plan without provider resource inputs', async () => {
    const plan = await service.plan('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });

    expect(plan).toMatchObject({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
      capabilityManifestDigest: MANIFEST_DIGEST,
      bindings: [
        {
          name: 'TENANT_PROFILE',
          interface: 'authrim.account_metadata.v1',
          scope: 'tenant',
        },
      ],
    });
    expect(plan.installationId).toMatch(/^plugin-installation-v1-[a-f0-9]{64}$/u);
  });

  it('atomically reflects Runner state and remains idempotent', async () => {
    const plan = await service.plan('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
    const input = {
      installationId: plan.installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'enabled' as const,
      configVersion: 2,
      pinnedVersionDigest: VERSION_DIGEST,
      resourceSelections: [],
    };

    const first = await service.sync('test', input);
    const second = await service.sync('test', input);

    expect(second).toEqual(first);
    expect(
      database
        .prepare(
          `SELECT desired_spec_json, observed_spec_json, status
             FROM control_plugin_dynamic_worker_bindings`
        )
        .get()
    ).toMatchObject({ status: 'active' });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_operations
          WHERE operation_kind = 'sync_plugin_dynamic_worker_bindings'`
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
          WHERE event_type = 'plugin.dynamic_worker.bindings.synced'`
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it('marks all installation bindings deleted when Runner disables the plugin', async () => {
    const plan = await service.plan('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
    await service.sync('test', {
      installationId: plan.installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'enabled',
      configVersion: 1,
      pinnedVersionDigest: VERSION_DIGEST,
      resourceSelections: [],
    });
    database
      .prepare(
        `UPDATE control_external_capability_sources
            SET status = 'disabled', review_state = 'flagged', reviewed_by = 'reviewer',
                reviewed_at = 2
          WHERE source_id = 'plugin-a'`
      )
      .run();
    await expect(
      service.plan('test', { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true })
    ).rejects.toThrow('control_plugin_manifest_unavailable');

    const disabled = await service.sync('test', {
      installationId: plan.installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'disabled',
      configVersion: 1,
      pinnedVersionDigest: null,
      resourceSelections: [],
    });

    expect(disabled.bindingStatus).toBe('deleted');
    expect(
      database.prepare(`SELECT status FROM control_plugin_dynamic_worker_bindings`).get()
    ).toEqual({ status: 'deleted' });
  });

  it('defaults resources to managed and supports an explicit non-owned existing reference', async () => {
    const resources = [
      {
        schemaVersion: 1,
        logicalResourceId: 'plugin-state',
        binding: 'PLUGIN_STATE',
        kind: 'd1',
        scope: 'tenant',
        access: 'read_write',
        provisioning: { defaultMode: 'managed', allowExisting: true },
        migrationStream: 'plugin/plugin-a/state',
      },
    ];
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

    const managed = await service.plan('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
    expect(managed.resources).toEqual([
      expect.objectContaining({ logicalResourceId: 'plugin-state', lifecycleMode: 'managed' }),
    ]);

    const resourceSelections = [
      {
        logicalResourceId: 'plugin-state',
        mode: 'existing' as const,
        providerResourceId: 'existing-db-id',
        providerName: 'existing-plugin-state',
      },
    ];
    const existing = await service.plan('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
      resourceSelections,
    });
    expect(existing.resources).toEqual([
      expect.objectContaining({
        lifecycleMode: 'existing',
        providerResourceId: 'existing-db-id',
        providerName: 'existing-plugin-state',
      }),
    ]);

    const prepared = await service.prepare('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
      resourceSelections,
    });
    expect(prepared.readiness).toBe('pending');
    expect(prepared.operationId).toMatch(/^op_plugin_resources_[a-f0-9]{32}$/u);
    await expect(
      service.getPreparation('test', {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      })
    ).resolves.toMatchObject({
      operationId: prepared.operationId,
      readiness: 'pending',
      resources: [
        expect.objectContaining({
          lifecycleMode: 'existing',
          providerResourceId: 'existing-db-id',
        }),
      ],
    });
    await expect(
      service.sync('test', {
        installationId: existing.installationId,
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        state: 'enabled',
        configVersion: 1,
        pinnedVersionDigest: VERSION_DIGEST,
        resourceSelections,
      })
    ).rejects.toThrow('control_plugin_resources_not_ready');
    database
      .prepare(
        `UPDATE control_plugin_desired_resources
            SET status = 'active', updated_at = 2
          WHERE plugin_installation_id = ?`
      )
      .run(existing.installationId);
    database
      .prepare(
        `UPDATE control_plugin_resource_migration_state
            SET state = 'ready', provider_database_id = 'existing-db-id',
                expected_file_count = 0, applied_file_count = 0,
                completed_at = 2, updated_at = 2`
      )
      .run();

    await expect(
      service.getPreparation('test', {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      })
    ).resolves.toMatchObject({ operationId: prepared.operationId, readiness: 'ready' });

    await service.sync('test', {
      installationId: existing.installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'enabled',
      configVersion: 1,
      pinnedVersionDigest: VERSION_DIGEST,
      resourceSelections,
    });
    const reflected = database
      .prepare(
        `SELECT lifecycle_mode, provider_resource_id, provider_name, status, desired_spec_json
           FROM control_plugin_desired_resources`
      )
      .get() as Record<string, unknown>;
    expect(reflected).toMatchObject({
      lifecycle_mode: 'existing',
      provider_resource_id: 'existing-db-id',
      provider_name: 'existing-plugin-state',
      status: 'active',
    });
    expect(JSON.parse(String(reflected.desired_spec_json))).toMatchObject({
      ownership: 'external_reference',
      deleteProviderResource: false,
    });

    await service.sync('test', {
      installationId: existing.installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'disabled',
      configVersion: 1,
      pinnedVersionDigest: null,
      resourceSelections: [],
    });
    expect(
      database
        .prepare(
          `SELECT lifecycle_mode, provider_resource_id, status
             FROM control_plugin_desired_resources`
        )
        .get()
    ).toEqual({
      lifecycle_mode: 'existing',
      provider_resource_id: 'existing-db-id',
      status: 'active',
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_operations
            WHERE operation_kind = 'provision_plugin_resources'`
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT stream_id, release_id, manifest_digest, state
             FROM control_plugin_resource_migration_state`
        )
        .get()
    ).toEqual({
      stream_id: 'plugin/plugin-a/state',
      release_id: '0.4.0',
      manifest_digest: 'f'.repeat(64),
      state: 'ready',
    });
  });

  it('rejects existing-resource selection unless the manifest explicitly allows it', async () => {
    const resources = [
      {
        schemaVersion: 1,
        logicalResourceId: 'plugin-cache',
        binding: 'PLUGIN_CACHE',
        kind: 'kv_namespace',
        scope: 'tenant',
        access: 'read_write',
        provisioning: { defaultMode: 'managed', allowExisting: false },
        migrationStream: null,
      },
    ];
    database
      .prepare(
        `UPDATE control_external_capability_sources SET aggregate_json = ? WHERE source_id = 'plugin-a'`
      )
      .run(aggregate(undefined, resources));

    await expect(
      service.plan('test', {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
        resourceSelections: [
          {
            logicalResourceId: 'plugin-cache',
            mode: 'existing',
            providerResourceId: 'existing-kv-id',
            providerName: 'existing-plugin-cache',
          },
        ],
      })
    ).rejects.toThrow('control_plugin_existing_resource_forbidden');
  });

  it('fails closed on wrong-tenant installation identity and does not mutate desired state', async () => {
    const plan = await service.plan('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });

    await expect(
      service.sync('test', {
        installationId: plan.installationId,
        tenantId: 'tenant-b',
        pluginId: 'plugin-a',
        state: 'enabled',
        configVersion: 1,
        pinnedVersionDigest: VERSION_DIGEST,
        resourceSelections: [],
      })
    ).rejects.toThrow('control_plugin_installation_mismatch');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_plugin_dynamic_worker_bindings`).get()
    ).toEqual({ count: 0 });
  });

  it('fails closed when the registered binding projection differs from the manifest aggregate', async () => {
    database
      .prepare(
        `UPDATE control_external_capability_bindings
            SET binding_name = 'ACCOUNT_METADATA'
          WHERE source_id = 'plugin-a'`
      )
      .run();

    await expect(
      service.plan('test', { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true })
    ).rejects.toThrow('control_plugin_manifest_binding_mismatch');
  });

  it('rejects flagged manifests and raw tenant database bindings', async () => {
    database
      .prepare(
        `UPDATE control_external_capability_sources
            SET review_state = 'flagged', reviewed_by = 'reviewer', reviewed_at = 2
          WHERE source_id = 'plugin-a'`
      )
      .run();
    await expect(
      service.plan('test', { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true })
    ).rejects.toThrow('control_plugin_manifest_unavailable');

    database
      .prepare(
        `UPDATE control_external_capability_sources
            SET review_state = 'auto_registered', reviewed_by = NULL, reviewed_at = NULL,
                aggregate_json = ?
          WHERE source_id = 'plugin-a'`
      )
      .run(aggregate([{ name: 'DB', interface: 'authrim.account_metadata.v1' }]));
    database
      .prepare(
        `UPDATE control_external_capability_bindings SET binding_name = 'DB'
          WHERE source_id = 'plugin-a'`
      )
      .run();
    await expect(
      service.plan('test', { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true })
    ).rejects.toThrow('control_plugin_manifest_binding_invalid');
  });
});
