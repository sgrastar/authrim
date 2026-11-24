import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { pluginResourceHostBindingRef } from '../../plugin-resource-binding-reconciler';
import type { ControlEnv } from '../../types';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const OPERATION_ID = 'op-plugin-resources-a';
export const INSTALLATION_ID = 'installation-a';
export const FINGERPRINTS = {
  d1: 'a'.repeat(64),
  kv_namespace: 'b'.repeat(64),
  r2_bucket: 'c'.repeat(64),
};
export const DIGEST = '9'.repeat(64);

export const RESOURCES = [
  {
    id: 'resource-d1',
    logical: 'state',
    binding: 'PLUGIN_STATE',
    kind: 'd1',
    access: 'read_write',
    providerId: 'database-a',
    providerName: 'database-a-name',
  },
  {
    id: 'resource-kv',
    logical: 'cache',
    binding: 'PLUGIN_CACHE',
    kind: 'kv_namespace',
    access: 'read_only',
    providerId: 'namespace-a',
    providerName: 'namespace-a-name',
  },
  {
    id: 'resource-r2',
    logical: 'objects',
    binding: 'PLUGIN_OBJECTS',
    kind: 'r2_bucket',
    access: 'read_write',
    providerId: 'bucket-a-name',
    providerName: 'bucket-a-name',
  },
] as const;

export function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`missing_${label}`);
  return value;
}

/** Control database seeded with one provisioning operation and D1, KV and R2 resources ready for binding. */
export function bindingDatabase(): DatabaseSync {
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
      requested_by_type, attempt_count, created_at, started_at, updated_at
    ) VALUES (
      '${OPERATION_ID}', 'test', 'provision_plugin_resources', 'plugin-resources:a',
      'running', 'admin', 1, 1, 1, 1
    );
    INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES (
      'test', 'test-ar-plugin-runner', '@authrim/ar-plugin-runner',
      'test-ar-plugin-runner', '${'d'.repeat(64)}',
      'packages/ar-plugin-runner/authrim.worker-capabilities.json',
      '${'e'.repeat(64)}', '${'f'.repeat(64)}', 'core_manifest',
      '@authrim/ar-plugin-runner', '${OPERATION_ID}', 'setup', 1
    );
  `);
  for (const resource of RESOURCES) {
    const fingerprint = FINGERPRINTS[resource.kind];
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id,
           tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json,
           desired_spec_json, status, updated_at, provider_create_state,
           provider_creation_date, provider_ownership_marker_key, provider_ownership_id,
           provider_identity_checkpointed_at
         ) VALUES (?, 'test', ?, ?, 'tenant-a', ?, ?, ?, 'managed', ?, ?, '{}', ?, 'ready', 1,
                   'identified', ?, ?, ?, 1)`
      )
      .run(
        resource.id,
        OPERATION_ID,
        INSTALLATION_ID,
        resource.kind,
        resource.logical,
        resource.binding,
        resource.providerId,
        resource.providerName,
        JSON.stringify({
          pluginId: 'plugin-a',
          binding: resource.binding,
          kind: resource.kind,
          access: resource.access,
          ownershipFingerprint: fingerprint,
          capabilityManifestDigest: DIGEST,
        }),
        resource.kind === 'r2_bucket' ? '2026-08-31T00:00:00.000Z' : null,
        resource.kind === 'r2_bucket' ? '.authrim/ownership/test' : null,
        resource.kind === 'r2_bucket' ? 'ownership-test' : null
      );
    const prefix = `plugin_resource_${fingerprint.slice(0, 20)}`;
    for (const [suffix, order, status] of [
      ['provider', 0, 'succeeded'],
      ['migration', 10, 'succeeded'],
      ['binding', 20, 'queued'],
    ] as const) {
      database
        .prepare(
          `INSERT INTO control_operation_steps (operation_id, step_key, display_order, status, updated_at)
           VALUES (?, ?, ?, ?, 1)`
        )
        .run(OPERATION_ID, `${prefix}_${suffix}`, order, status);
    }
  }
  return database;
}

/** Marks the D1 resource as migrated, which the binding planner requires. */
export function migrateD1(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO control_migration_release_catalog (
      environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
      state, active_stream_key, registered_by_operation_id, registered_at, activated_at
    ) VALUES (
      'test', 'plugin/plugin-a/state', 'release-a', '${'1'.repeat(64)}',
      'releases/release-a/${'1'.repeat(64)}/manifest.json', 'active', 'active',
      '${OPERATION_ID}', 1, 1
    );
    INSERT INTO control_operation_release_pins (
      operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
    ) VALUES ('${OPERATION_ID}', 'test', 'plugin/plugin-a/state', 'release-a',
      '${'1'.repeat(64)}', 1);
    INSERT INTO control_plugin_resource_migration_state (
      plugin_resource_id, environment_id, operation_id, stream_id, release_id,
      manifest_digest, provider_database_id, state, expected_file_count,
      applied_file_count, completed_at, updated_at
    ) VALUES ('resource-d1', 'test', '${OPERATION_ID}', 'plugin/plugin-a/state', 'release-a',
      '${'1'.repeat(64)}', 'database-a', 'ready', 1, 1, 1, 1);
  `);
}

export function hostRef(kind: 'd1' | 'kv_namespace' | 'r2_bucket'): string {
  return pluginResourceHostBindingRef(kind, FINGERPRINTS[kind]);
}

export function mapJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    pluginId: 'plugin-a',
    capabilityManifestDigest: DIGEST,
    resources: RESOURCES.map((resource) => ({
      logicalResourceId: resource.logical,
      binding: resource.binding,
      hostBindingRef: hostRef(resource.kind),
      kind: resource.kind,
      access: resource.access,
      ownershipFingerprint: FINGERPRINTS[resource.kind],
    })).sort((a, b) => a.logicalResourceId.localeCompare(b.logicalResourceId)),
    ...overrides,
  });
}

export function planBindings() {
  return [
    { name: hostRef('d1'), type: 'd1', database_id: 'database-a' },
    { name: hostRef('kv_namespace'), type: 'kv_namespace', namespace_id: 'namespace-a' },
    { name: hostRef('r2_bucket'), type: 'r2_bucket', bucket_name: 'bucket-a-name' },
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export interface TargetSeed {
  state?: string;
  bindings?: string;
  map?: string;
  expectedSource?: string | null;
  previousDeployment?: string | null;
  patchVersion?: string | null;
  patchDeployment?: string | null;
  restore?: string | null;
  attempts?: number;
  consecutive?: number;
  notBefore?: number | null;
  installation?: string;
  updatedAt?: number;
}

/** Inserts a reconciliation row directly, bypassing the planner. */
export function seedTarget(database: DatabaseSync, seed: TargetSeed = {}): void {
  const state = seed.state ?? 'pending';
  const patched = state !== 'pending';
  database
    .prepare(
      `INSERT INTO control_plugin_resource_binding_reconciliations (
         operation_id, environment_id, plugin_installation_id, tenant_id, worker_script_name,
         desired_bindings_json, resource_map_json, state, expected_source_version_id,
         previous_deployment_id, patch_result_version_id, patch_result_deployment_id,
         previous_restore_settings_json, smoke_attempt_count, consecutive_smoke_successes,
         stabilization_not_before, created_at, updated_at, completed_at
       ) VALUES (?, 'test', ?, 'tenant-a', 'test-ar-plugin-runner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         10, ?, ?)`
    )
    .run(
      OPERATION_ID,
      seed.installation ?? INSTALLATION_ID,
      seed.bindings ?? JSON.stringify(planBindings()),
      seed.map ?? mapJson(),
      state,
      seed.expectedSource === undefined ? (patched ? 'version-old' : null) : seed.expectedSource,
      seed.previousDeployment === undefined
        ? patched
          ? 'deployment-old'
          : null
        : seed.previousDeployment,
      seed.patchVersion === undefined ? (patched ? 'version-new' : null) : seed.patchVersion,
      seed.patchDeployment === undefined
        ? patched
          ? 'deployment-new'
          : null
        : seed.patchDeployment,
      seed.restore === undefined
        ? patched
          ? JSON.stringify({ compatibility_date: '2026-08-01', bindings: [] })
          : null
        : seed.restore,
      seed.attempts ?? 0,
      seed.consecutive ?? 0,
      seed.notBefore ?? null,
      seed.updatedAt ?? 10,
      state === 'succeeded' ? 10 : null
    );
}

export const oldDeployment = {
  id: 'deployment-old',
  created_on: '2026-08-01T00:00:00.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-old' }],
};
export const newDeployment = {
  id: 'deployment-new',
  created_on: '2026-08-01T00:00:01.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-new' }],
};

export function smokeMock() {
  return vi.fn(async (input: unknown) => {
    const value = input as {
      operationId: string;
      installationId: string;
      expectedVersionId: string;
      resources: unknown[];
    };
    return {
      operationId: value.operationId,
      installationId: value.installationId,
      observedVersionId: value.expectedVersionId,
      resourceCount: value.resources.length,
    };
  });
}

export function controlEnv(db: D1Database, smoke: ReturnType<typeof smokeMock> | null): ControlEnv {
  return {
    CONTROL_DB: db,
    MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
    CLOUDFLARE_ACCOUNT_ID: 'account-a',
    ...(smoke
      ? {
          SMOKE_AR_PLUGIN_RUNNER: {
            smokeTenantBinding: vi.fn(),
            smokePluginResourceBindings: smoke,
          },
        }
      : {}),
  };
}
