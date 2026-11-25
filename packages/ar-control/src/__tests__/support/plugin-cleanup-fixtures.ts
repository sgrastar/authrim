import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { vi, type Mock } from 'vitest';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';
import type {
  CloudflareWorkerDeployment,
  CloudflareWorkerSettings,
} from '@authrim/ar-lib-core/control-plane';
import { PluginResourceCleanupService } from '../../plugin-resource-cleanup';
import { d1 } from './plugin-dynamic-fixtures';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const FINGERPRINT = 'a'.repeat(64);
export const D1_BINDING = 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA';
export const KV_BINDING = 'PRES_KV_BBBBBBBBBBBBBBBBBBBBBBBB';

export const oldDeployment: CloudflareWorkerDeployment = {
  id: 'deployment-old',
  created_on: '2026-08-01T00:00:00.000Z',
  source: 'api',
  strategy: 'percentage',
  versions: [{ percentage: 100, version_id: 'version-old' }],
};
export const newDeployment: CloudflareWorkerDeployment = {
  id: 'deployment-new',
  created_on: '2026-08-01T00:01:00.000Z',
  source: 'api',
  strategy: 'percentage',
  versions: [{ percentage: 100, version_id: 'version-new' }],
};

export interface CleanupWorld {
  database: DatabaseSync;
  installationId: string;
  now: { value: number };
  clients: {
    d1: { getD1Database: Mock; deleteD1Database: Mock };
    kv: { listKvNamespaces: Mock; deleteKvNamespace: Mock };
    r2: { listR2Buckets: Mock; deleteR2Bucket: Mock };
    workers: {
      getWorkerSettings: Mock<(name: string) => Promise<CloudflareWorkerSettings>>;
      patchWorkerSettings: Mock<
        (name: string, settings: CloudflareWorkerSettings) => Promise<CloudflareWorkerSettings>
      >;
      listWorkerDeployments: Mock<(name: string) => Promise<CloudflareWorkerDeployment[]>>;
    };
  };
  service: (providerDeletionEnabled?: boolean) => PluginResourceCleanupService;
}

/** A blocked provisioning operation owning one managed D1 and one external KV resource. */
export async function cleanupWorld(): Promise<CleanupWorld> {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'), 'utf8')
  );
  const installationId = await derivePluginInstallationId({
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
    ) VALUES ('source-op', 'test', 'provision_plugin_resources', 'source-op', 'blocked',
      'admin', 1, 1, 1, NULL, 1);`);
  const insert = database.prepare(
    `INSERT INTO control_plugin_desired_resources (
       plugin_resource_id, environment_id, operation_id, plugin_installation_id,
       tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
       provider_resource_id, provider_name, injection_policy_json, desired_spec_json,
       status, updated_at, lifecycle_generation
     ) VALUES (?, 'test', 'source-op', ?, 'tenant-a', ?, ?, ?, ?, ?, ?, '{}', ?, 'active', 1, 1)`
  );
  insert.run(
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
  insert.run(
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
  const now = { value: 100 };
  const clients = {
    d1: {
      getD1Database: vi.fn(async () => {
        throw Object.assign(new Error('not_found'), { status: 404 });
      }),
      deleteD1Database: vi.fn(),
    },
    kv: { listKvNamespaces: vi.fn(async () => []), deleteKvNamespace: vi.fn() },
    r2: { listR2Buckets: vi.fn(async () => []), deleteR2Bucket: vi.fn() },
    workers: {
      getWorkerSettings: vi.fn(async () => ({})),
      patchWorkerSettings: vi.fn(async () => ({})),
      listWorkerDeployments: vi.fn(async () => [oldDeployment]),
    },
  };
  return {
    database,
    installationId,
    now,
    clients,
    service: (enabled = true) =>
      new PluginResourceCleanupService(d1(database), clients, () => now.value, enabled),
  };
}

/** Registers the runner worker and a succeeded binding reconciliation naming the given host bindings. */
export function seedBindingReconciliation(
  world: CleanupWorld,
  options: { hostBindings?: unknown[]; state?: string; map?: string } = {}
): void {
  const hostBindings = options.hostBindings ?? [D1_BINDING, KV_BINDING];
  world.database.exec(`
    INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference, registration_mode,
      status, review_state, registered_by_operation_id, registered_by, registered_at
    ) VALUES ('test', 'authrim-test-plugin-runner', '@authrim/ar-plugin-runner', 'test',
      '${'c'.repeat(64)}', 'manifest.json', '${'d'.repeat(64)}', '${'e'.repeat(64)}',
      'core_manifest', '@authrim/ar-plugin-runner', 'auto', 'active', 'auto_registered',
      'source-op', 'test', 1);`);
  world.database
    .prepare(
      `INSERT INTO control_plugin_resource_binding_reconciliations (
         operation_id, environment_id, plugin_installation_id, tenant_id, worker_script_name,
         desired_bindings_json, resource_map_json, state, expected_source_version_id,
         previous_deployment_id, patch_result_version_id, patch_result_deployment_id,
         previous_restore_settings_json, smoke_attempt_count, consecutive_smoke_successes,
         stabilization_not_before, created_at, updated_at, completed_at
       ) VALUES ('source-op', 'test', ?, 'tenant-a', 'authrim-test-plugin-runner', '[]', ?, ?,
         'version-old', 'deployment-old', 'version-bound', 'deployment-bound', '{}', 3, 3, 1, 1, 1, 1)`
    )
    .run(
      world.installationId,
      options.map ??
        JSON.stringify({
          schemaVersion: 1,
          resources: hostBindings.map((hostBindingRef) => ({ hostBindingRef })),
        }),
      options.state ?? 'succeeded'
    );
}
