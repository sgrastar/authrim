import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareD1Query, ReleaseArtifactStore } from '@authrim/ar-lib-core/control-plane';
import { executeSetupPluginControlOperator } from '../core/plugin-control-operator-executor.js';
import type {
  PendingPluginControlOperatorOperation,
  PendingPluginControlOperatorResource,
} from '../core/control-operator-operations.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OPERATION_ID = 'op-plugin-setup-a';
const INSTALLATION_ID = 'installation-a';
const FINGERPRINT = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function queryResult(
  sql: string,
  statement: ReturnType<DatabaseSync['prepare']>,
  params: unknown[] = []
) {
  if (/^\s*(SELECT|WITH|PRAGMA)/iu.test(sql) || /\bRETURNING\b/iu.test(sql)) {
    return { success: true, results: statement.all(...params), meta: { changes: 0 } };
  }
  const result = statement.run(...params);
  return { success: true, results: [], meta: { changes: Number(result.changes) } };
}

function client(database: DatabaseSync, tenantDatabase?: DatabaseSync) {
  let workerSettings: Record<string, unknown> = {
    bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }],
    compatibility_date: '2026-08-01',
  };
  let patched = false;
  const patchWorkerSettings = vi.fn(async (_name: string, settings: Record<string, unknown>) => {
    const beforeBindings = Array.isArray(workerSettings.bindings) ? workerSettings.bindings : [];
    const bindings = Array.isArray(settings.bindings)
      ? settings.bindings.map((binding) => {
          const candidate = binding as { name?: unknown; type?: unknown };
          return candidate.type === 'inherit'
            ? (beforeBindings.find(
                (existing) => (existing as { name?: unknown }).name === candidate.name
              ) ?? binding)
            : binding;
        })
      : [];
    workerSettings = { ...settings, bindings };
    patched = true;
    return settings;
  });
  const value = {
    async queryD1(databaseId: string, sql: string, params: unknown[] = []) {
      const selected = databaseId === 'control-id' ? database : tenantDatabase;
      if (!selected) throw new Error('unexpected_database');
      return [queryResult(sql, selected.prepare(sql), params)];
    },
    async queryD1Batch(databaseId: string, queries: readonly CloudflareD1Query[]) {
      const selected = databaseId === 'control-id' ? database : tenantDatabase;
      if (!selected) throw new Error('unexpected_database');
      selected.exec('BEGIN IMMEDIATE');
      try {
        const results = queries.map((query) =>
          queryResult(query.sql, selected.prepare(query.sql), [...(query.params ?? [])])
        );
        selected.exec('COMMIT');
        return results;
      } catch (error) {
        if (selected.isTransaction) selected.exec('ROLLBACK');
        throw error;
      }
    },
    listD1Databases: vi.fn(async () => []),
    createD1Database: vi.fn(async ({ name }: { name: string }) => ({
      uuid: 'database-a',
      name,
      read_replication: { mode: 'disabled' },
    })),
    getD1Database: vi.fn(async () => ({
      uuid: 'database-a',
      name: `authrim-test-${FINGERPRINT.slice(0, 32)}-d1`,
      read_replication: { mode: 'disabled' },
    })),
    updateD1Database: vi.fn(),
    listKvNamespaces: vi.fn(async () => []),
    createKvNamespace: vi.fn(async (title: string) => ({ id: 'namespace-a', title })),
    listR2Buckets: vi.fn(async () => []),
    createR2Bucket: vi.fn(async (name: string) => ({ name })),
    listWorkerDeployments: vi.fn(async () => [
      patched
        ? {
            id: 'deployment-b',
            created_on: '2026-08-01T00:00:01.000Z',
            source: 'api',
            strategy: 'percentage',
            versions: [{ percentage: 100, version_id: 'version-b' }],
          }
        : {
            id: 'deployment-a',
            created_on: '2026-08-01T00:00:00.000Z',
            source: 'api',
            strategy: 'percentage',
            versions: [{ percentage: 100, version_id: 'version-a' }],
          },
    ]),
    getWorkerSettings: vi.fn(async () => workerSettings),
    patchWorkerSettings,
  };
  return { value, patchWorkerSettings };
}

function resource(
  kind: PendingPluginControlOperatorResource['kind'],
  overrides: Partial<PendingPluginControlOperatorResource> = {}
): PendingPluginControlOperatorResource {
  const suffix = kind === 'd1' ? 'd1' : kind === 'kv_namespace' ? 'kv' : 'r2';
  const hostPrefix = kind === 'd1' ? 'D1' : kind === 'kv_namespace' ? 'KV' : 'R2';
  return {
    pluginResourceId: `resource-${suffix}`,
    kind,
    logicalResourceId: suffix,
    binding: `PLUGIN_${hostPrefix}`,
    access: 'read_write',
    lifecycleMode: 'managed',
    providerResourceId: null,
    providerName: null,
    ownershipFingerprint: FINGERPRINT,
    deterministicName: `authrim-test-${FINGERPRINT.slice(0, 32)}-${suffix}`,
    hostBindingRef: `PRES_${hostPrefix}_${FINGERPRINT.slice(0, 24).toUpperCase()}`,
    status: 'pending',
    migration:
      kind === 'd1'
        ? {
            streamId: 'plugin/plugin-a/state',
            releaseId: 'release-a',
            manifestDigest: DIGEST,
            manifestObjectKey: `releases/release-a/${DIGEST}/manifest.json`,
            state: 'requested',
            providerDatabaseId: null,
          }
        : null,
    ...overrides,
  };
}

function providerStep(item: PendingPluginControlOperatorResource): string {
  return `plugin_resource_${item.ownershipFingerprint.slice(0, 20)}_provider`;
}

function migrationStep(item: PendingPluginControlOperatorResource): string {
  return `plugin_resource_${item.ownershipFingerprint.slice(0, 20)}_migration`;
}

function bindingStep(item: PendingPluginControlOperatorResource): string {
  return `plugin_resource_${item.ownershipFingerprint.slice(0, 20)}_binding`;
}

function operation(
  currentStep: PendingPluginControlOperatorOperation['currentStep'],
  resources: PendingPluginControlOperatorResource[]
): PendingPluginControlOperatorOperation {
  return {
    operationId: OPERATION_ID,
    environmentId: 'test',
    operationKind: 'provision_plugin_resources',
    status: 'blocked',
    lastErrorCode: 'operator_action_required',
    attemptCount: 0,
    createdAt: 10,
    updatedAt: 10,
    pluginInstallationId: INSTALLATION_ID,
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    capabilityManifestDigest: DIGEST,
    currentStep,
    resources,
  };
}

describe('setup plugin Control operator executor', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_control_plane.sql'), 'utf8')
    );
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, last_error_code, last_error_redacted,
        created_at, updated_at
      ) VALUES (
        '${OPERATION_ID}', 'test', 'provision_plugin_resources', 'plugin:setup:a',
        'blocked', 'admin', 0, 'operator_action_required', 'operator_action_required', 10, 10
      );
    `);
  });

  it('creates managed D1, KV, and R2 resources and hands migration back as one operation', async () => {
    const resources = [
      resource('d1'),
      resource('kv_namespace', {
        pluginResourceId: 'resource-kv',
        logicalResourceId: 'kv',
        binding: 'PLUGIN_KV',
        ownershipFingerprint: 'c'.repeat(64),
        deterministicName: `authrim-test-${'c'.repeat(32)}-kv`,
        hostBindingRef: `PRES_KV_${'c'.repeat(24).toUpperCase()}`,
      }),
      resource('r2_bucket', {
        pluginResourceId: 'resource-r2',
        logicalResourceId: 'r2',
        binding: 'PLUGIN_R2',
        ownershipFingerprint: 'd'.repeat(64),
        deterministicName: `authrim-test-${'d'.repeat(32)}-r2`,
        hostBindingRef: `PRES_R2_${'d'.repeat(24).toUpperCase()}`,
      }),
    ];
    for (const [index, item] of resources.entries()) {
      database
        .prepare(
          `INSERT INTO control_plugin_desired_resources (
             plugin_resource_id, environment_id, operation_id, plugin_installation_id,
             tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
             injection_policy_json, desired_spec_json, status, updated_at
           ) VALUES (?, 'test', ?, ?, 'tenant-a', ?, ?, ?, 'managed', '{}', ?, 'pending', 10)`
        )
        .run(
          item.pluginResourceId,
          OPERATION_ID,
          INSTALLATION_ID,
          item.kind,
          item.logicalResourceId,
          item.binding,
          JSON.stringify({ ownershipFingerprint: item.ownershipFingerprint })
        );
      database
        .prepare(
          `INSERT INTO control_operation_steps (
             operation_id, step_key, display_order, status, last_error_code, updated_at
           ) VALUES (?, ?, ?, ?, ?, 10)`
        )
        .run(
          OPERATION_ID,
          `plugin_resource_${item.ownershipFingerprint.slice(0, 20)}_provider`,
          index * 30,
          index === 0 ? 'blocked' : 'queued',
          index === 0 ? 'operator_action_required' : null
        );
      database
        .prepare(
          `INSERT INTO control_operation_steps (
             operation_id, step_key, display_order, status, updated_at
           ) VALUES (?, ?, ?, ?, 10)`
        )
        .run(
          OPERATION_ID,
          `plugin_resource_${item.ownershipFingerprint.slice(0, 20)}_migration`,
          index * 30 + 10,
          item.kind === 'd1' ? 'queued' : 'skipped'
        );
      database
        .prepare(
          `INSERT INTO control_operation_steps (
             operation_id, step_key, display_order, status, updated_at
           ) VALUES (?, ?, ?, 'queued', 10)`
        )
        .run(
          OPERATION_ID,
          `plugin_resource_${item.ownershipFingerprint.slice(0, 20)}_binding`,
          index * 30 + 20
        );
    }
    const target = client(database);
    target.value.listKvNamespaces
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'namespace-a', title: resources[1]!.deterministicName }]);
    target.value.listR2Buckets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: resources[2]!.deterministicName }]);

    await expect(
      executeSetupPluginControlOperator({
        controlDatabaseId: 'control-id',
        migrationReleaseBucketName: 'migration-releases',
        operation: operation('provider', resources),
        client: target.value as never,
        now: () => 100,
      })
    ).resolves.toMatchObject({ state: 'awaiting_migration' });

    expect(target.value.createD1Database).toHaveBeenCalledTimes(1);
    expect(target.value.createKvNamespace).toHaveBeenCalledTimes(1);
    expect(target.value.createR2Bucket).toHaveBeenCalledTimes(1);
    expect(
      database
        .prepare(
          `SELECT resource_kind, status FROM control_plugin_desired_resources ORDER BY resource_kind`
        )
        .all()
    ).toEqual([
      { resource_kind: 'd1', status: 'ready' },
      { resource_kind: 'kv_namespace', status: 'ready' },
      { resource_kind: 'r2_bucket', status: 'ready' },
    ]);
    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({
      status: 'blocked',
      last_error_code: 'operator_action_required',
    });
  });

  it('adopts a deterministically named D1 after a create response is lost', async () => {
    const item = resource('d1');
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id,
           tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           injection_policy_json, desired_spec_json, status, updated_at
         ) VALUES (?, 'test', ?, ?, 'tenant-a', 'd1', ?, ?, 'managed', '{}', ?, 'pending', 10)`
      )
      .run(
        item.pluginResourceId,
        OPERATION_ID,
        INSTALLATION_ID,
        item.logicalResourceId,
        item.binding,
        JSON.stringify({ ownershipFingerprint: item.ownershipFingerprint })
      );
    database
      .prepare(
        `INSERT INTO control_operation_steps (
           operation_id, step_key, display_order, status, last_error_code, updated_at
         ) VALUES (?, ?, 0, 'blocked', 'operator_action_required', 10)`
      )
      .run(OPERATION_ID, providerStep(item));
    database
      .prepare(
        `INSERT INTO control_operation_steps (
           operation_id, step_key, display_order, status, updated_at
         ) VALUES (?, ?, 10, 'queued', 10), (?, ?, 20, 'queued', 10)`
      )
      .run(OPERATION_ID, migrationStep(item), OPERATION_ID, bindingStep(item));

    const target = client(database);
    target.value.listD1Databases.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        uuid: 'database-a',
        name: item.deterministicName,
        read_replication: { mode: 'disabled' },
      },
    ]);
    target.value.createD1Database.mockRejectedValueOnce(new Error('response_lost'));

    await expect(
      executeSetupPluginControlOperator({
        controlDatabaseId: 'control-id',
        migrationReleaseBucketName: 'migration-releases',
        operation: operation('provider', [item]),
        client: target.value as never,
        now: () => 100,
      })
    ).resolves.toMatchObject({ state: 'awaiting_migration' });

    expect(target.value.createD1Database).toHaveBeenCalledTimes(1);
    expect(target.value.listD1Databases).toHaveBeenCalledTimes(2);
    expect(
      database
        .prepare(
          `SELECT provider_resource_id, provider_name, status
             FROM control_plugin_desired_resources WHERE plugin_resource_id = ?`
        )
        .get(item.pluginResourceId)
    ).toEqual({
      provider_resource_id: 'database-a',
      provider_name: item.deterministicName,
      status: 'ready',
    });
  });

  it('applies the pinned plugin D1 migration before making bindings eligible', async () => {
    const sql = 'CREATE TABLE plugin_state (id TEXT PRIMARY KEY);';
    const checksum = createHash('sha256').update(sql).digest('hex');
    const manifest = `${JSON.stringify({
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [
        {
          id: 'plugin/plugin-a/state',
          dialect: 'sqlite',
          files: [{ path: '001_state.sql', checksum }],
        },
      ],
    })}\n`;
    const manifestDigest = createHash('sha256').update(manifest).digest('hex');
    const manifestObjectKey = `releases/0.4.0/${manifestDigest}/manifest.json`;
    const objects = new Map([
      [manifestObjectKey, manifest],
      [`releases/0.4.0/${manifestDigest}/streams/plugin/plugin-a/state/001_state.sql`, sql],
    ]);
    const artifactStore: ReleaseArtifactStore = {
      get: async (key) => {
        const value = objects.get(key);
        if (value === undefined) return null;
        const bytes = new TextEncoder().encode(value);
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
      },
    };
    const item = resource('d1', {
      providerResourceId: 'database-a',
      providerName: 'database-a-name',
      status: 'ready',
      migration: {
        streamId: 'plugin/plugin-a/state',
        releaseId: '0.4.0',
        manifestDigest,
        manifestObjectKey,
        state: 'requested',
        providerDatabaseId: 'database-a',
      },
    });
    database.exec(`
      INSERT INTO control_migration_release_catalog (
        environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
        state, active_stream_key, registered_by_operation_id, registered_at, activated_at
      ) VALUES (
        'test', 'plugin/plugin-a/state', '0.4.0', '${manifestDigest}',
        '${manifestObjectKey}', 'active', 'active', '${OPERATION_ID}', 10, 10
      );
      INSERT INTO control_operation_release_pins (
        operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
      ) VALUES (
        '${OPERATION_ID}', 'test', 'plugin/plugin-a/state', '0.4.0', '${manifestDigest}', 10
      );
    `);
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id,
           tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json, desired_spec_json,
           status, updated_at
         ) VALUES (?, 'test', ?, ?, 'tenant-a', 'd1', 'state', 'PLUGIN_STATE', 'managed',
           'database-a', 'database-a-name', '{}', '{}', 'ready', 10)`
      )
      .run(item.pluginResourceId, OPERATION_ID, INSTALLATION_ID);
    database
      .prepare(
        `INSERT INTO control_plugin_resource_migration_state (
           plugin_resource_id, environment_id, operation_id, stream_id, release_id,
           manifest_digest, provider_database_id, state, updated_at
         ) VALUES (?, 'test', ?, 'plugin/plugin-a/state', '0.4.0', ?,
           'database-a', 'requested', 10)`
      )
      .run(item.pluginResourceId, OPERATION_ID, manifestDigest);
    for (const [suffix, order, status] of [
      ['provider', 0, 'succeeded'],
      ['migration', 10, 'blocked'],
      ['binding', 20, 'queued'],
    ] as const) {
      database
        .prepare(
          `INSERT INTO control_operation_steps (
             operation_id, step_key, display_order, status, last_error_code, updated_at
           ) VALUES (?, ?, ?, ?, ?, 10)`
        )
        .run(
          OPERATION_ID,
          `plugin_resource_${FINGERPRINT.slice(0, 20)}_${suffix}`,
          order,
          status,
          status === 'blocked' ? 'operator_action_required' : null
        );
    }
    const tenantDatabase = new DatabaseSync(':memory:');
    const target = client(database, tenantDatabase);

    await expect(
      executeSetupPluginControlOperator({
        controlDatabaseId: 'control-id',
        migrationReleaseBucketName: 'migration-releases',
        operation: operation('migration', [item]),
        client: target.value as never,
        artifactStore,
        now: () => 200,
      })
    ).resolves.toMatchObject({ state: 'awaiting_worker_bindings' });

    expect(
      database
        .prepare(`SELECT state, provider_database_id FROM control_plugin_resource_migration_state`)
        .get()
    ).toEqual({ state: 'ready', provider_database_id: 'database-a' });
    expect(
      tenantDatabase
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_state'`)
        .get()
    ).toEqual({ name: 'plugin_state' });
  });

  it('patches all plugin bindings together and leaves smoke activation to Control', async () => {
    const item = resource('kv_namespace', {
      providerResourceId: 'namespace-a',
      providerName: 'namespace-a-name',
      status: 'ready',
      migration: null,
    });
    database.exec(`
      INSERT INTO control_desired_worker_inventory (
        environment_id, worker_script_name, package_name, deployment_target,
        capability_manifest_digest, source_manifest_path, source_manifest_hash,
        generated_artifact_hash, source_kind, source_reference,
        registered_by_operation_id, registered_by, registered_at
      ) VALUES (
        'test', 'test-ar-plugin-runner', '@authrim/ar-plugin-runner', 'test-ar-plugin-runner',
        '${'e'.repeat(64)}', 'packages/ar-plugin-runner/authrim.worker-capabilities.json',
        '${'f'.repeat(64)}', '${'1'.repeat(64)}', 'core_manifest', '@authrim/ar-plugin-runner',
        '${OPERATION_ID}', 'setup', 1
      );
    `);
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id,
           tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json, desired_spec_json,
           status, updated_at
         ) VALUES (?, 'test', ?, ?, 'tenant-a', ?, ?, ?, 'managed', ?, ?, '{}', '{}', 'ready', 10)`
      )
      .run(
        item.pluginResourceId,
        OPERATION_ID,
        INSTALLATION_ID,
        item.kind,
        item.logicalResourceId,
        item.binding,
        item.providerResourceId,
        item.providerName
      );
    database
      .prepare(
        `INSERT INTO control_operation_steps (
           operation_id, step_key, display_order, status, last_error_code, updated_at
         ) VALUES (?, ?, 20, 'blocked', 'operator_action_required', 10)`
      )
      .run(OPERATION_ID, `plugin_resource_${FINGERPRINT.slice(0, 20)}_binding`);
    const target = client(database);

    await expect(
      executeSetupPluginControlOperator({
        controlDatabaseId: 'control-id',
        migrationReleaseBucketName: 'migration-releases',
        operation: operation('binding', [item]),
        client: target.value as never,
        now: () => 100,
      })
    ).resolves.toMatchObject({ state: 'awaiting_smoke', errorCode: null });

    expect(target.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(target.patchWorkerSettings.mock.calls[0]?.[1]).toMatchObject({
      bindings: expect.arrayContaining([
        { name: item.hostBindingRef, type: 'kv_namespace', namespace_id: 'namespace-a' },
        { name: 'PLUGIN_LOADER', type: 'inherit', version_id: 'latest' },
      ]),
    });
    expect(
      database
        .prepare(
          `SELECT state, patch_result_version_id FROM control_plugin_resource_binding_reconciliations`
        )
        .get()
    ).toEqual({ state: 'settings_patched', patch_result_version_id: 'version-b' });
    expect(database.prepare(`SELECT status FROM control_operations`).get()).toEqual({
      status: 'running',
    });
  });
});
