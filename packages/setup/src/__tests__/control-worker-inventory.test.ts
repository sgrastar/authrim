import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildControlWorkerInventoryRegistrationPlan,
  compileControlWorkerInventoryFromArtifacts,
} from '../core/control-worker-inventory.js';
import {
  compileDesiredWorkerInventory,
  loadWorkerCapabilityManifests,
} from '../core/worker-capabilities.js';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('control worker desired inventory registration', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(ROOT_DIR, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
  });

  afterEach(() => database.close());

  it('registers reconstructable desired bindings without secret bodies', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-control', 'ar-management'],
    });
    const records = compileDesiredWorkerInventory({
      environmentId: 'env-test',
      environmentName: 'test',
      manifests,
      generatedArtifactHashes: {
        'ar-control': HASH_A,
        'ar-management': HASH_B,
      },
    });
    const plan = buildControlWorkerInventoryRegistrationPlan({
      records,
      registeredBy: 'setup:test',
      now: 100,
    });
    database.exec(plan.bootstrapSql);
    for (const worker of plan.workerSql) database.exec(worker.sql);

    expect(
      database
        .prepare(
          `SELECT automatic_provisioning_enabled, provisioning_token_ownership,
                  provisioning_capability_state
             FROM control_environments WHERE environment_id = 'env-test'`
        )
        .get()
    ).toEqual({
      automatic_provisioning_enabled: 0,
      provisioning_token_ownership: 'none',
      provisioning_capability_state: 'disabled',
    });

    expect(
      database
        .prepare(
          `SELECT max_concurrent_provisioning, max_ready_spares, max_d1_resources,
                  daily_d1_create_budget, target_account_count
             FROM control_environment_resource_policies
            WHERE environment_id = 'env-test'`
        )
        .get()
    ).toEqual({
      max_concurrent_provisioning: 2,
      max_ready_spares: 2,
      max_d1_resources: 1000,
      daily_d1_create_budget: 20,
      target_account_count: 100000,
    });
    expect(
      database
        .prepare(
          `SELECT residency_policy_id, residency_partition, jurisdiction, location_hint, status,
                  lookup_capacity_domain_id
             FROM control_residency_partitions
            WHERE environment_id = 'env-test'`
        )
        .all()
    ).toEqual([
      {
        residency_policy_id: 'builtin:residency:default',
        residency_partition: 'default',
        jurisdiction: null,
        location_hint: null,
        status: 'active',
        lookup_capacity_domain_id: 'lookup:builtin:residency:default:default',
      },
    ]);

    database.exec(
      `UPDATE control_residency_partitions
          SET lookup_capacity_domain_id = NULL, updated_at = 50
        WHERE environment_id = 'env-test'
          AND residency_policy_id = 'builtin:residency:default'
          AND residency_partition = 'default';`
    );
    database.exec(plan.bootstrapSql);
    expect(
      database
        .prepare(
          `SELECT lookup_capacity_domain_id, updated_at
             FROM control_residency_partitions
            WHERE environment_id = 'env-test'
              AND residency_policy_id = 'builtin:residency:default'
              AND residency_partition = 'default'`
        )
        .get()
    ).toEqual({
      lookup_capacity_domain_id: 'lookup:builtin:residency:default:default',
      updated_at: 100,
    });

    database.exec(
      `UPDATE control_residency_partitions
          SET lookup_capacity_domain_id = 'lookup:operator:shared', updated_at = 200
        WHERE environment_id = 'env-test'
          AND residency_policy_id = 'builtin:residency:default'
          AND residency_partition = 'default';`
    );
    database.exec(plan.bootstrapSql);
    expect(
      database
        .prepare(
          `SELECT lookup_capacity_domain_id, updated_at
             FROM control_residency_partitions
            WHERE environment_id = 'env-test'
              AND residency_policy_id = 'builtin:residency:default'
              AND residency_partition = 'default'`
        )
        .get()
    ).toEqual({ lookup_capacity_domain_id: 'lookup:operator:shared', updated_at: 200 });

    const inventory = database
      .prepare(
        `SELECT worker_script_name, package_name, status, review_state
           FROM control_desired_worker_inventory ORDER BY worker_script_name`
      )
      .all() as Array<Record<string, unknown>>;
    expect(inventory).toEqual([
      {
        worker_script_name: 'test-ar-control',
        package_name: '@authrim/ar-control',
        status: 'active',
        review_state: 'auto_registered',
      },
      {
        worker_script_name: 'test-ar-management',
        package_name: '@authrim/ar-management',
        status: 'active',
        review_state: 'auto_registered',
      },
    ]);
    const controlTokens = database
      .prepare(
        `SELECT binding_name, secret_capability
           FROM control_worker_desired_bindings
          WHERE worker_script_name = 'test-ar-control' AND binding_kind = 'secret'
          ORDER BY binding_name`
      )
      .all() as Array<Record<string, unknown>>;
    expect(controlTokens.map((row) => row.binding_name)).toEqual([
      'CLOUDFLARE_D1_API_TOKEN',
      'CLOUDFLARE_KV_API_TOKEN',
      'CLOUDFLARE_R2_API_TOKEN',
      'CLOUDFLARE_WORKERS_API_TOKEN',
      'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A',
      'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B',
      'SMOKE_RPC_SIGNING_JWK_SLOT_A',
      'SMOKE_RPC_SIGNING_JWK_SLOT_B',
      'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID',
    ]);
    const managementLookupSecrets = database
      .prepare(
        `SELECT binding_name
           FROM control_worker_desired_bindings
          WHERE worker_script_name = 'test-ar-management'
            AND secret_capability = 'lookup_blind_index'
          ORDER BY binding_name`
      )
      .all() as Array<Record<string, unknown>>;
    expect(managementLookupSecrets).toEqual([
      { binding_name: 'LOOKUP_HMAC_KEY_SLOT_A' },
      { binding_name: 'LOOKUP_HMAC_KEY_SLOT_B' },
    ]);
    const dataRoles = database
      .prepare(
        `SELECT worker_script_name, data_role
           FROM control_worker_required_data_roles
          ORDER BY worker_script_name, data_role`
      )
      .all() as Array<Record<string, unknown>>;
    expect(dataRoles).toEqual([
      { worker_script_name: 'test-ar-control', data_role: 'control' },
      { worker_script_name: 'test-ar-management', data_role: 'lookup' },
      { worker_script_name: 'test-ar-management', data_role: 'tenant_core/default' },
      { worker_script_name: 'test-ar-management', data_role: 'tenant_core/users' },
      { worker_script_name: 'test-ar-management', data_role: 'tenant_pii' },
    ]);
    database.exec(
      `INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, location_hint,
         status, created_at, updated_at
       ) VALUES ('env-test', 'default', 'jp', 'apac', 'active', 100, 100);
       UPDATE control_environment_resource_policies
          SET max_d1_resources = 100
        WHERE environment_id = 'env-test';
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, provider_create_state, provider_resource_id,
         provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES (
         'resource-users-jp-1', 'env-test', 'd1', 'users:jp:1',
         'authrim-test-users-jp-1', 'fingerprint-users-jp-1', 'ready',
         '${plan.operationId}', 'identified', 'database-users-jp-1', 100, 100, 100
       );
       INSERT INTO control_tenant_shards (
         shard_id, environment_id, data_role, residency_policy_id, residency_partition,
         generation, logical_shard_id, binding_ref, d1_desired_resource_id,
         location_hint, status, created_at, updated_at
       ) VALUES (
         'shard-users-jp-1', 'env-test', 'tenant_core/users', 'default', 'jp',
         1, 'users:jp:1', 'TDB_USERS_0001_CORE', 'resource-users-jp-1',
         'apac', 'ready', 100, 100
       );`
    );
    expect(
      database
        .prepare(
          `SELECT worker_script_name, binding_name, data_role, logical_resource_id
             FROM control_desired_worker_binding_export
            WHERE binding_name = 'TDB_USERS_0001_CORE'`
        )
        .all()
    ).toEqual([
      {
        worker_script_name: 'test-ar-management',
        binding_name: 'TDB_USERS_0001_CORE',
        data_role: 'tenant_core/users',
        logical_resource_id: 'resource-users-jp-1',
      },
    ]);
    const serialized = JSON.stringify({ plan, inventory, controlTokens });
    expect(serialized).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/u);
    expect(serialized).not.toContain('@example.com');
  });

  it('records Automatic provisioning as pending without storing token material', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-control'],
    });
    const records = compileDesiredWorkerInventory({
      environmentId: 'env-test',
      environmentName: 'test',
      manifests,
      generatedArtifactHashes: { 'ar-control': HASH_A },
    });
    const plan = buildControlWorkerInventoryRegistrationPlan({
      records,
      environmentBootstrap: {
        defaultResidencyPolicyId: 'builtin:residency:default',
        automaticProvisioning: true,
      },
      registeredBy: 'setup:test',
      now: 100,
    });

    database.exec(plan.bootstrapSql);

    expect(
      database
        .prepare(
          `SELECT automatic_provisioning_enabled, provisioning_token_ownership,
                  provisioning_capability_state
             FROM control_environments WHERE environment_id = 'env-test'`
        )
        .get()
    ).toEqual({
      automatic_provisioning_enabled: 1,
      provisioning_token_ownership: 'none',
      provisioning_capability_state: 'pending',
    });
    expect(plan.bootstrapSql).not.toMatch(/Bearer|api[_-]?token|secret.{0,16}value/iu);
  });

  it('is idempotent and records the previous manifest hash on a changed registration', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-control'],
    });
    const firstRecords = compileDesiredWorkerInventory({
      environmentId: 'env-test',
      environmentName: 'test',
      manifests,
      generatedArtifactHashes: { 'ar-control': HASH_A },
    });
    const first = buildControlWorkerInventoryRegistrationPlan({
      records: firstRecords,
      now: 100,
    });
    database.exec(first.bootstrapSql);
    database.exec(first.workerSql[0].sql);
    database.exec(
      `UPDATE control_environment_resource_policies
          SET target_account_count = 43210, updated_at = 150
        WHERE environment_id = 'env-test';
       UPDATE control_residency_partitions
          SET status = 'disabled', updated_at = 150
        WHERE environment_id = 'env-test';`
    );
    database.exec(first.bootstrapSql);
    database.exec(first.workerSql[0].sql);

    expect(
      database
        .prepare(
          `SELECT target_account_count, updated_at
             FROM control_environment_resource_policies
            WHERE environment_id = 'env-test'`
        )
        .get()
    ).toEqual({ target_account_count: 43210, updated_at: 150 });
    expect(
      database
        .prepare(
          `SELECT residency_policy_id, residency_partition, status, updated_at
             FROM control_residency_partitions
            WHERE environment_id = 'env-test'`
        )
        .all()
    ).toEqual([
      {
        residency_policy_id: 'builtin:residency:default',
        residency_partition: 'default',
        status: 'disabled',
        updated_at: 150,
      },
    ]);

    const changedRecords = firstRecords.map((record) => ({
      ...record,
      sourceManifestHash: HASH_B,
      sourceReference: `authrim.worker-capabilities.json#sha256:${HASH_B}`,
      capabilityManifestDigest: HASH_B,
      generatedArtifactHash: HASH_B,
    }));
    const changed = buildControlWorkerInventoryRegistrationPlan({
      records: changedRecords,
      now: 200,
    });
    database.exec(changed.bootstrapSql);
    database.exec(changed.workerSql[0].sql);

    const events = database
      .prepare(
        `SELECT previous_manifest_hash, next_manifest_hash
           FROM control_worker_inventory_change_events
          WHERE worker_script_name = 'test-ar-control'
          ORDER BY created_at`
      )
      .all() as Array<Record<string, unknown>>;
    expect(events).toEqual([
      { previous_manifest_hash: null, next_manifest_hash: firstRecords[0].sourceManifestHash },
      { previous_manifest_hash: firstRecords[0].sourceManifestHash, next_manifest_hash: HASH_B },
    ]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_worker_desired_bindings
            WHERE worker_script_name = 'test-ar-control'`
        )
        .get()
    ).toEqual({ count: firstRecords[0].bindings.length });
  });

  it('rejects mixed environments and malformed digests before producing SQL', () => {
    expect(() =>
      buildControlWorkerInventoryRegistrationPlan({
        records: [
          {
            environmentId: 'env-test',
            environmentName: 'test',
            workerScriptName: 'test-ar-control',
            packageName: '@authrim/ar-control',
            deploymentTarget: 'default',
            capabilityManifestDigest: 'not-a-digest',
            sourceManifestPath: 'packages/ar-control/authrim.worker-capabilities.json',
            sourceManifestHash: HASH_A,
            generatedArtifactHash: HASH_A,
            sourceKind: 'core_manifest',
            sourceReference: 'manifest',
            registrationMode: 'auto',
            status: 'active',
            reviewState: 'auto_registered',
            requiredDataRoles: [],
            bindings: [],
          },
        ],
      })
    ).toThrow('invalid_capability_manifest_digest');

    const validRecord = {
      environmentId: 'env-test',
      environmentName: 'test',
      workerScriptName: 'test-ar-control',
      packageName: '@authrim/ar-control' as const,
      deploymentTarget: 'default',
      capabilityManifestDigest: HASH_A,
      sourceManifestPath: 'packages/ar-control/authrim.worker-capabilities.json',
      sourceManifestHash: HASH_A,
      generatedArtifactHash: HASH_A,
      sourceKind: 'core_manifest' as const,
      sourceReference: `authrim.worker-capabilities.json#sha256:${HASH_A}`,
      registrationMode: 'auto' as const,
      status: 'active' as const,
      reviewState: 'auto_registered' as const,
      requiredDataRoles: [],
      bindings: [],
    };
    expect(() =>
      buildControlWorkerInventoryRegistrationPlan({
        records: [validRecord],
        environmentBootstrap: {
          defaultResidencyPolicyId: 'builtin:residency:default',
          defaultResidencyPartition: 'EU West',
        },
      })
    ).toThrow('invalid_default_residency_partition');
  });

  it('records removal and later reactivation as reviewable status changes', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-control', 'ar-management'],
    });
    const allRecords = compileDesiredWorkerInventory({
      environmentId: 'env-test',
      environmentName: 'test',
      manifests,
      generatedArtifactHashes: {
        'ar-control': HASH_A,
        'ar-management': HASH_B,
      },
    });
    const initial = buildControlWorkerInventoryRegistrationPlan({ records: allRecords, now: 100 });
    database.exec(initial.bootstrapSql);
    for (const worker of initial.workerSql) database.exec(worker.sql);

    const withoutManagement = buildControlWorkerInventoryRegistrationPlan({
      records: allRecords.filter((record) => record.packageName !== '@authrim/ar-management'),
      now: 200,
    });
    database.exec(withoutManagement.bootstrapSql);
    for (const worker of withoutManagement.workerSql) database.exec(worker.sql);
    expect(
      database
        .prepare(
          `SELECT status FROM control_desired_worker_inventory
            WHERE worker_script_name = 'test-ar-management'`
        )
        .get()
    ).toEqual({ status: 'disabled' });

    const reactivated = buildControlWorkerInventoryRegistrationPlan({
      records: allRecords,
      now: 300,
    });
    database.exec(reactivated.bootstrapSql);
    for (const worker of reactivated.workerSql) database.exec(worker.sql);
    database.exec(reactivated.bootstrapSql);
    for (const worker of reactivated.workerSql) database.exec(worker.sql);
    const statusEvents = database
      .prepare(
        `SELECT json_extract(diff_json, '$.previous_status') AS previous_status,
                json_extract(diff_json, '$.next_status') AS next_status
           FROM control_worker_inventory_change_events
          WHERE worker_script_name = 'test-ar-management'
          ORDER BY created_at`
      )
      .all() as Array<Record<string, unknown>>;
    expect(statusEvents).toEqual([
      { previous_status: null, next_status: 'active' },
      { previous_status: 'active', next_status: 'disabled' },
      { previous_status: 'disabled', next_status: 'active' },
    ]);
  });

  it('scopes replacement by deployment target and keeps focused updates non-destructive', async () => {
    const apiManifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-control', 'ar-management'],
    });
    const apiRecords = compileDesiredWorkerInventory({
      environmentId: 'env-test',
      environmentName: 'test',
      manifests: apiManifests,
      generatedArtifactHashes: { 'ar-control': HASH_A, 'ar-management': HASH_B },
    });
    const uiManifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-admin-ui', 'ar-login-ui'],
    });
    const uiRecords = compileDesiredWorkerInventory({
      environmentId: 'env-test',
      environmentName: 'test',
      deploymentTarget: 'ui',
      manifests: uiManifests,
      generatedArtifactHashes: { 'ar-admin-ui': HASH_A, 'ar-login-ui': HASH_B },
    });

    for (const records of [apiRecords, uiRecords]) {
      const plan = buildControlWorkerInventoryRegistrationPlan({ records, now: 100 });
      database.exec(plan.bootstrapSql);
      for (const worker of plan.workerSql) database.exec(worker.sql);
    }

    const focused = buildControlWorkerInventoryRegistrationPlan({
      records: [apiRecords[0]],
      disableMissing: false,
      now: 200,
    });
    database.exec(focused.bootstrapSql);
    for (const worker of focused.workerSql) database.exec(worker.sql);
    expect(
      database
        .prepare(
          `SELECT worker_script_name, status FROM control_desired_worker_inventory
            ORDER BY worker_script_name`
        )
        .all()
    ).toEqual([
      { worker_script_name: 'test-ar-admin-ui', status: 'active' },
      { worker_script_name: 'test-ar-control', status: 'active' },
      { worker_script_name: 'test-ar-login-ui', status: 'active' },
      { worker_script_name: 'test-ar-management', status: 'active' },
    ]);

    const replaceApi = buildControlWorkerInventoryRegistrationPlan({
      records: [apiRecords[0]],
      now: 300,
    });
    database.exec(replaceApi.bootstrapSql);
    for (const worker of replaceApi.workerSql) database.exec(worker.sql);
    expect(
      database
        .prepare(
          `SELECT worker_script_name, deployment_target, status
             FROM control_desired_worker_inventory ORDER BY worker_script_name`
        )
        .all()
    ).toEqual([
      { worker_script_name: 'test-ar-admin-ui', deployment_target: 'ui', status: 'active' },
      { worker_script_name: 'test-ar-control', deployment_target: 'default', status: 'active' },
      { worker_script_name: 'test-ar-login-ui', deployment_target: 'ui', status: 'active' },
      {
        worker_script_name: 'test-ar-management',
        deployment_target: 'default',
        status: 'disabled',
      },
    ]);
  });

  it('maps a package-local wrangler.toml artifact to its UI component', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authrim-ui-inventory-'));
    const packageDir = join(root, 'packages', 'ar-admin-ui');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'package.json'), '{"name":"@authrim/ar-admin-ui"}');
    await writeFile(
      join(packageDir, 'authrim.worker-capabilities.json'),
      JSON.stringify({
        schemaVersion: 1,
        packageName: '@authrim/ar-admin-ui',
        worker: 'ar-admin-ui',
        requiredDataRoles: [],
        bindings: [],
        secrets: [],
      })
    );
    const artifactPath = join(packageDir, 'wrangler.toml');
    await writeFile(artifactPath, 'name = "test-ar-admin-ui"\n');

    try {
      await expect(
        compileControlWorkerInventoryFromArtifacts({
          baseDir: root,
          environmentId: 'env-test',
          environmentName: 'test',
          components: ['ar-admin-ui'],
          artifactPaths: [artifactPath],
          deploymentTarget: 'ui',
        })
      ).resolves.toMatchObject([
        {
          workerScriptName: 'test-ar-admin-ui',
          deploymentTarget: 'ui',
          generatedArtifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an inventory record whose script name is outside the declared environment', () => {
    expect(() =>
      buildControlWorkerInventoryRegistrationPlan({
        records: [
          {
            environmentId: 'env-test',
            environmentName: 'test',
            workerScriptName: 'other-ar-control',
            packageName: '@authrim/ar-control',
            deploymentTarget: 'default',
            capabilityManifestDigest: HASH_A,
            sourceManifestPath: 'packages/ar-control/authrim.worker-capabilities.json',
            sourceManifestHash: HASH_A,
            generatedArtifactHash: HASH_A,
            sourceKind: 'core_manifest',
            sourceReference: 'manifest',
            registrationMode: 'auto',
            status: 'active',
            reviewState: 'auto_registered',
            requiredDataRoles: [],
            bindings: [],
          },
        ],
      })
    ).toThrow('worker_inventory_script_name_mismatch:other-ar-control');
  });
});
