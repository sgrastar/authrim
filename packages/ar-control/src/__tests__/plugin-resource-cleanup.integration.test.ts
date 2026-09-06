import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';
import { PluginResourceCleanupService } from '../plugin-resource-cleanup';
import { handoffPluginResourceOperationsToSetup } from '../plugin-resource-operator-handoff';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FINGERPRINT = 'a'.repeat(64);

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

function notFound(): Error & { status: number } {
  return Object.assign(new Error('not_found'), { status: 404 });
}

describe('PluginResourceCleanupService', () => {
  let database: DatabaseSync;
  let now: number;
  let managedD1: { uuid: string; name: string } | null;
  let service: PluginResourceCleanupService;
  let installationId: string;
  const deleteD1 = vi.fn();
  const deleteKv = vi.fn();

  function getManagedD1() {
    if (!managedD1) throw notFound();
    return managedD1;
  }

  beforeEach(async () => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    installationId = await derivePluginInstallationId({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      purpose: 'dynamic-plugin',
    });
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, started_at, completed_at, updated_at
      ) VALUES (
        'source-op', 'test', 'provision_plugin_resources', 'source-op', 'blocked',
        'admin', 1, 1, 1, NULL, 1
      );
    `);
    const insertResource = database.prepare(
      `INSERT INTO control_plugin_desired_resources (
         plugin_resource_id, environment_id, operation_id, plugin_installation_id,
         tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
         provider_resource_id, provider_name, injection_policy_json, desired_spec_json,
         status, updated_at, lifecycle_generation
       ) VALUES (?, 'test', 'source-op', ?, 'tenant-a', ?, ?, ?, ?, ?, ?, '{}', ?, 'active', 1, 1)`
    );
    insertResource.run(
      'resource-managed',
      installationId,
      'd1',
      'state',
      'PLUGIN_STATE',
      'managed',
      'managed-d1-id',
      'managed-d1-name',
      JSON.stringify({
        pluginId: 'plugin-a',
        ownershipFingerprint: FINGERPRINT,
        ownership: 'authrim_managed',
        deleteProviderResource: true,
      })
    );
    insertResource.run(
      'resource-existing',
      installationId,
      'kv_namespace',
      'cache',
      'PLUGIN_CACHE',
      'existing',
      'external-kv-id',
      'external-kv-name',
      JSON.stringify({
        pluginId: 'plugin-a',
        ownershipFingerprint: 'b'.repeat(64),
        ownership: 'external_reference',
        deleteProviderResource: false,
      })
    );
    now = 100;
    managedD1 = { uuid: 'managed-d1-id', name: 'managed-d1-name' };
    deleteD1.mockReset().mockImplementation(async () => {
      managedD1 = null;
    });
    deleteKv.mockReset();
    service = new PluginResourceCleanupService(
      d1(database),
      {
        d1: {
          getD1Database: vi.fn(async () => {
            if (!managedD1) throw notFound();
            return managedD1;
          }),
          deleteD1Database: deleteD1,
        },
        kv: {
          listKvNamespaces: vi.fn(async () => [
            { id: 'external-kv-id', title: 'external-kv-name' },
          ]),
          deleteKvNamespace: deleteKv,
        },
        r2: {
          listR2Buckets: vi.fn(async () => []),
          deleteR2Bucket: vi.fn(),
        },
        workers: {
          getWorkerSettings: vi.fn(),
          patchWorkerSettings: vi.fn(),
          listWorkerDeployments: vi.fn(),
        },
      },
      () => now,
      true
    );
  });

  afterEach(() => database.close());

  async function requestCleanup() {
    return service.request('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      reason: 'uninstall',
      requestedById: 'admin-a',
      idempotencyKey: 'uninstall-a',
    });
  }

  it('quarantines for 30 minutes, deletes only managed resources, and keeps a tombstone', async () => {
    const requested = await requestCleanup();
    expect(requested).toMatchObject({
      state: 'requested',
      managedResourceCount: 1,
      detachedResourceCount: 1,
    });

    await service.reconcile();
    expect(deleteD1).not.toHaveBeenCalled();
    expect(deleteKv).not.toHaveBeenCalled();
    expect(await service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })).toMatchObject(
      {
        state: 'quarantined',
        drainNotBefore: 1900,
      }
    );

    now = 1899;
    expect(await service.reconcile()).toBe(0);
    expect(deleteD1).not.toHaveBeenCalled();

    now = 1900;
    await service.reconcile();
    expect(deleteD1).toHaveBeenCalledWith('managed-d1-id');
    expect(deleteKv).not.toHaveBeenCalled();
    expect(await service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })).toMatchObject(
      {
        state: 'succeeded',
        completedAt: 1900,
      }
    );
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM control_plugin_desired_resources').get()
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT lifecycle_mode, state FROM control_plugin_resource_cleanup_items
            ORDER BY lifecycle_mode`
        )
        .all()
    ).toEqual([
      { lifecycle_mode: 'existing', state: 'detached' },
      { lifecycle_mode: 'managed', state: 'deleted' },
    ]);
  });

  it('converges after a provider deletion response loss', async () => {
    deleteD1.mockImplementationOnce(async () => {
      managedD1 = null;
      throw new Error('response_lost');
    });
    await requestCleanup();
    await service.reconcile();
    now = 1900;
    await service.reconcile();
    await expect(
      service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).resolves.toMatchObject({ state: 'succeeded' });
    expect(deleteD1).toHaveBeenCalledTimes(1);
  });

  it('does not persist a provider error message that may contain a secret', async () => {
    deleteD1.mockRejectedValueOnce(new Error('provider sk_live_unexpected_secret_value'));
    await requestCleanup();
    await service.reconcile();
    now = 1900;
    await service.reconcile();
    expect(
      database
        .prepare(
          `SELECT status, last_error_code, last_error_redacted
             FROM control_operations WHERE operation_kind = 'cleanup_plugin_resources'`
        )
        .get()
    ).toEqual({
      status: 'waiting_retry',
      last_error_code: 'control_plugin_cleanup_provider_failed',
      last_error_redacted: 'control_plugin_cleanup_provider_failed',
    });
    expect(
      JSON.stringify(database.prepare('SELECT * FROM control_operations').all())
    ).not.toContain('sk_live_unexpected_secret_value');
  });

  it('blocks without credential fallback when a resource-class token is unavailable', async () => {
    database.exec(`
      DELETE FROM control_plugin_desired_resources WHERE plugin_resource_id = 'resource-managed';
      INSERT INTO control_plugin_desired_resources (
        plugin_resource_id, environment_id, operation_id, plugin_installation_id,
        tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
        provider_resource_id, provider_name, provider_create_state, provider_creation_date,
        provider_ownership_marker_key, provider_ownership_id,
        provider_identity_checkpointed_at, injection_policy_json, desired_spec_json,
        status, updated_at, lifecycle_generation
      ) VALUES (
        'resource-managed', 'test', 'source-op', '${installationId}', 'tenant-a', 'r2_bucket',
        'state', 'PLUGIN_STATE', 'managed', 'managed-r2-name', 'managed-r2-name', 'identified',
        '2026-08-01T00:00:00.000Z', '.authrim/ownership.json', '${FINGERPRINT}', 1,
        '{}', '{"pluginId":"plugin-a","ownershipFingerprint":"${FINGERPRINT}",
        "ownership":"authrim_managed","deleteProviderResource":true}', 'active', 1, 1
      );
    `);
    service = new PluginResourceCleanupService(
      d1(database),
      {
        d1: { getD1Database: vi.fn(), deleteD1Database: deleteD1 },
        kv: { listKvNamespaces: vi.fn(async () => []), deleteKvNamespace: deleteKv },
        r2: {
          listR2Buckets: vi.fn(async () => {
            throw new Error('cloudflare_r2_token_required_for:r2.bucket.list');
          }),
          deleteR2Bucket: vi.fn(),
        },
        workers: {
          getWorkerSettings: vi.fn(),
          patchWorkerSettings: vi.fn(),
          listWorkerDeployments: vi.fn(),
        },
      },
      () => now,
      true
    );
    await requestCleanup();
    await service.reconcile();
    now = 1900;
    await service.reconcile();

    await expect(
      service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).resolves.toMatchObject({
      state: 'blocked',
      lastErrorCode: 'control_plugin_cleanup_capability_unavailable',
    });
    expect(deleteD1).not.toHaveBeenCalled();
  });

  it('blocks retryable provider failures after the two-hour cleanup retry budget', async () => {
    deleteD1.mockRejectedValue(new Error('provider_temporarily_unavailable'));
    await requestCleanup();
    await service.reconcile();
    now = 1900;
    await service.reconcile();
    await expect(
      service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).resolves.toMatchObject({ state: 'deleting_resources' });

    now = 9100;
    await service.reconcile();

    await expect(
      service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).resolves.toMatchObject({
      state: 'blocked',
      lastErrorCode: 'control_plugin_cleanup_provider_failed',
    });
  });

  it('turns an explicit pre-activation cancel into the same cleanup workflow', async () => {
    database.exec(`
      UPDATE control_operations
         SET status = 'canceled', completed_at = 101, updated_at = 101
       WHERE operation_id = 'source-op';
    `);
    await expect(
      service.requestCanceledProvisioning('test', {
        sourceOperationId: 'source-op',
        requestedById: 'admin-a',
        idempotencyKey: 'cancel-source-a',
      })
    ).resolves.toMatchObject({
      sourceOperationId: 'source-op',
      reason: 'canceled_pre_activation',
      state: 'requested',
    });
  });

  it('hands cleanup to the setup operator when Automatic provisioning is off', async () => {
    await requestCleanup();

    await expect(handoffPluginResourceOperationsToSetup(d1(database), now)).resolves.toBe(1);

    expect(
      database
        .prepare(
          `SELECT status, last_error_code FROM control_operations
            WHERE operation_kind = 'cleanup_plugin_resources'`
        )
        .get()
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required' });
    expect(
      database
        .prepare(
          `SELECT step_key, status FROM control_operation_steps
            WHERE operation_id = (
              SELECT operation_id FROM control_operations
               WHERE operation_kind = 'cleanup_plugin_resources'
            ) AND status = 'blocked'`
        )
        .get()
    ).toEqual({ step_key: 'remove_plugin_resource_bindings', status: 'blocked' });
  });

  it('adopts binding-patch response loss and removes only the installation host bindings', async () => {
    const resourceMap = JSON.stringify({
      schemaVersion: 1,
      pluginId: 'plugin-a',
      capabilityManifestDigest: 'c'.repeat(64),
      resources: [
        { hostBindingRef: 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA' },
        { hostBindingRef: 'PRES_KV_BBBBBBBBBBBBBBBBBBBBBBBB' },
      ],
    });
    database.exec(`
      INSERT INTO control_desired_worker_inventory (
        environment_id, worker_script_name, package_name, deployment_target,
        capability_manifest_digest, source_manifest_path, source_manifest_hash,
        generated_artifact_hash, source_kind, source_reference, registration_mode,
        status, review_state, registered_by_operation_id, registered_by, registered_at
      ) VALUES (
        'test', 'authrim-test-plugin-runner', '@authrim/ar-plugin-runner', 'test',
        '${'c'.repeat(64)}', 'manifest.json', '${'d'.repeat(64)}', '${'e'.repeat(64)}',
        'core_manifest', '@authrim/ar-plugin-runner', 'auto', 'active', 'auto_registered',
        'source-op', 'test', 1
      );
    `);
    database
      .prepare(
        `INSERT INTO control_plugin_resource_binding_reconciliations (
           operation_id, environment_id, plugin_installation_id, tenant_id,
           worker_script_name, desired_bindings_json, resource_map_json, state,
           expected_source_version_id, previous_deployment_id, patch_result_version_id,
           patch_result_deployment_id, previous_restore_settings_json,
           smoke_attempt_count, consecutive_smoke_successes, stabilization_not_before,
           created_at, updated_at, completed_at
         ) VALUES (
           'source-op', 'test', ?, 'tenant-a', 'authrim-test-plugin-runner', '[]', ?,
           'succeeded', 'version-old', 'deployment-old', 'version-bound', 'deployment-bound',
           '{}', 3, 3, 1, 1, 1, 1
         )`
      )
      .run(installationId, resourceMap);

    let settings = {
      compatibility_date: '2026-08-01',
      bindings: [
        { name: 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA', type: 'd1', database_id: 'managed-d1-id' },
        {
          name: 'PRES_KV_BBBBBBBBBBBBBBBBBBBBBBBB',
          type: 'kv_namespace',
          namespace_id: 'external-kv-id',
        },
        { name: 'SETTINGS', type: 'kv_namespace', namespace_id: 'settings-id' },
      ],
    };
    let settingsPatched = false;
    const patchSettings = vi.fn(async () => {
      settingsPatched = true;
      settings = {
        compatibility_date: '2026-08-01',
        bindings: [{ name: 'SETTINGS', type: 'kv_namespace', namespace_id: 'settings-id' }],
      };
      throw new Error('response_lost');
    });
    service = new PluginResourceCleanupService(
      d1(database),
      {
        d1: {
          getD1Database: vi.fn(async () => getManagedD1()),
          deleteD1Database: deleteD1,
        },
        kv: {
          listKvNamespaces: vi.fn(async () => [
            { id: 'external-kv-id', title: 'external-kv-name' },
          ]),
          deleteKvNamespace: deleteKv,
        },
        r2: { listR2Buckets: vi.fn(async () => []), deleteR2Bucket: vi.fn() },
        workers: {
          getWorkerSettings: vi.fn(async () => settings),
          patchWorkerSettings: patchSettings,
          listWorkerDeployments: vi.fn(async () => [
            ...(settingsPatched
              ? [
                  {
                    id: 'deployment-new',
                    created_on: '2026-08-01T00:01:00.000Z',
                    source: 'api',
                    strategy: 'percentage' as const,
                    versions: [{ percentage: 100, version_id: 'version-new' }],
                  },
                ]
              : []),
            {
              id: 'deployment-old',
              created_on: '2026-08-01T00:00:00.000Z',
              source: 'api',
              strategy: 'percentage' as const,
              versions: [{ percentage: 100, version_id: 'version-old' }],
            },
          ]),
        },
      },
      () => now,
      true
    );
    await requestCleanup();
    await service.reconcile();
    expect(patchSettings).toHaveBeenCalledTimes(1);
    expect(settings.bindings).toEqual([
      { name: 'SETTINGS', type: 'kv_namespace', namespace_id: 'settings-id' },
    ]);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM control_worker_deployment_leases').get()
    ).toEqual({ count: 0 });
  });

  it('fails closed when a binding from a succeeded activation is already missing', async () => {
    const resourceMap = JSON.stringify({
      schemaVersion: 1,
      pluginId: 'plugin-a',
      capabilityManifestDigest: 'c'.repeat(64),
      resources: [
        { hostBindingRef: 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA' },
        { hostBindingRef: 'PRES_KV_BBBBBBBBBBBBBBBBBBBBBBBB' },
      ],
    });
    database.exec(`
      INSERT INTO control_desired_worker_inventory (
        environment_id, worker_script_name, package_name, deployment_target,
        capability_manifest_digest, source_manifest_path, source_manifest_hash,
        generated_artifact_hash, source_kind, source_reference, registration_mode,
        status, review_state, registered_by_operation_id, registered_by, registered_at
      ) VALUES (
        'test', 'authrim-test-plugin-runner', '@authrim/ar-plugin-runner', 'test',
        '${'c'.repeat(64)}', 'manifest.json', '${'d'.repeat(64)}', '${'e'.repeat(64)}',
        'core_manifest', '@authrim/ar-plugin-runner', 'auto', 'active', 'auto_registered',
        'source-op', 'test', 1
      );
    `);
    database
      .prepare(
        `INSERT INTO control_plugin_resource_binding_reconciliations (
           operation_id, environment_id, plugin_installation_id, tenant_id,
           worker_script_name, desired_bindings_json, resource_map_json, state,
           expected_source_version_id, previous_deployment_id, patch_result_version_id,
           patch_result_deployment_id, previous_restore_settings_json,
           smoke_attempt_count, consecutive_smoke_successes, stabilization_not_before,
           created_at, updated_at, completed_at
         ) VALUES (
           'source-op', 'test', ?, 'tenant-a', 'authrim-test-plugin-runner', '[]', ?,
           'succeeded', 'version-old', 'deployment-old', 'version-bound', 'deployment-bound',
           '{}', 3, 3, 1, 1, 1, 1
         )`
      )
      .run(installationId, resourceMap);
    const patchSettings = vi.fn();
    service = new PluginResourceCleanupService(
      d1(database),
      {
        d1: { getD1Database: vi.fn(async () => getManagedD1()), deleteD1Database: deleteD1 },
        kv: { listKvNamespaces: vi.fn(async () => []), deleteKvNamespace: deleteKv },
        r2: { listR2Buckets: vi.fn(async () => []), deleteR2Bucket: vi.fn() },
        workers: {
          getWorkerSettings: vi.fn(async () => ({
            bindings: [{ name: 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA', type: 'd1' }],
          })),
          patchWorkerSettings: patchSettings,
          listWorkerDeployments: vi.fn(async () => [
            {
              id: 'deployment-old',
              created_on: '2026-08-01T00:00:00.000Z',
              source: 'api',
              strategy: 'percentage' as const,
              versions: [{ percentage: 100, version_id: 'version-old' }],
            },
          ]),
        },
      },
      () => now,
      true
    );

    await requestCleanup();
    await service.reconcile();

    await expect(
      service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).resolves.toMatchObject({
      state: 'blocked',
      lastErrorCode: 'control_plugin_cleanup_binding_presence_mismatch',
    });
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it('fails closed across tenants without scheduling provider deletion', async () => {
    await expect(
      service.request('test', {
        tenantId: 'tenant-b',
        pluginId: 'plugin-a',
        reason: 'uninstall',
        requestedById: 'admin-a',
        idempotencyKey: 'wrong-tenant',
      })
    ).resolves.toBeNull();
    expect(deleteD1).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_operations
            WHERE operation_kind = 'cleanup_plugin_resources'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('blocks provider deletion when the destructive-operation kill switch is off', async () => {
    service = new PluginResourceCleanupService(
      d1(database),
      {
        d1: {
          getD1Database: vi.fn(async () => getManagedD1()),
          deleteD1Database: deleteD1,
        },
        kv: { listKvNamespaces: vi.fn(async () => []), deleteKvNamespace: deleteKv },
        r2: { listR2Buckets: vi.fn(async () => []), deleteR2Bucket: vi.fn() },
        workers: {
          getWorkerSettings: vi.fn(),
          patchWorkerSettings: vi.fn(),
          listWorkerDeployments: vi.fn(),
        },
      },
      () => now,
      false
    );
    await requestCleanup();
    await service.reconcile();
    now = 1900;
    await service.reconcile();
    await expect(
      service.get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).resolves.toMatchObject({
      state: 'blocked',
      lastErrorCode: 'control_destructive_operations_disabled',
    });
    expect(deleteD1).not.toHaveBeenCalled();

    const retried = await requestCleanup();
    expect(retried).toMatchObject({
      state: 'quarantined',
      lastErrorCode: null,
    });
    expect(retried?.operationId).toMatch(/^op_plugin_cleanup_/u);
    expect(
      database
        .prepare(
          `SELECT status, last_error_code FROM control_operations
            WHERE operation_kind = 'cleanup_plugin_resources'`
        )
        .get()
    ).toEqual({ status: 'running', last_error_code: null });
  });
});
