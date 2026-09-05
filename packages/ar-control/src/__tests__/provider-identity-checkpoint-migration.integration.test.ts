import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('provider identity checkpoint migration', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
      INSERT INTO control_environment_resource_policies (
        environment_id, max_concurrent_provisioning, max_ready_spares,
        max_d1_resources, daily_d1_create_budget, target_account_count,
        created_at, updated_at
      ) VALUES ('env-test', 2, 2, 100, 20, 100000, 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES
        ('op-generic', 'env-test', 'provision_shard', 'generic', 'succeeded',
         'scheduler', 1, 10, 20, 20),
        ('op-plugin-d1', 'env-test', 'plugin_resource_provision', 'plugin-d1', 'succeeded',
         'scheduler', 1, 10, 20, 20),
        ('op-plugin-r2', 'env-test', 'plugin_resource_provision', 'plugin-r2', 'succeeded',
         'scheduler', 1, 10, 20, 20);
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, observed_resource_id, provider_create_state,
        provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
      ) VALUES (
        'desired-generic', 'env-test', 'd1', 'users:jp:1', 'authrim-test-users-1',
        '${'a'.repeat(64)}', 'active', 'op-generic', NULL, 'identified',
        'database-uuid', 20, 10, 20
      );
      INSERT INTO control_observed_resources (
        observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
        provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
      ) VALUES (
        'observed-generic', 'env-test', 'desired-generic', 'database-uuid',
        'authrim-test-users-1', 'd1', '${'a'.repeat(64)}', 'present', 20
      );
      UPDATE control_desired_resources
         SET observed_resource_id = 'observed-generic'
       WHERE desired_resource_id = 'desired-generic';
      INSERT INTO control_plugin_desired_resources (
        plugin_resource_id, environment_id, operation_id, plugin_installation_id,
        tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
        provider_resource_id, provider_name, provider_create_state, provider_creation_date,
        provider_ownership_marker_key, provider_ownership_id,
        provider_identity_checkpointed_at, status, updated_at
      ) VALUES
        ('plugin-d1', 'env-test', 'op-plugin-d1', 'plugin-a', 'tenant-a', 'd1',
         'database', 'PLUGIN_DB', 'managed', 'plugin-database-uuid',
         'authrim-plugin-database', 'identified', NULL, NULL, NULL, 20, 'active', 20),
        ('plugin-r2', 'env-test', 'op-plugin-r2', 'plugin-a', 'tenant-a', 'r2_bucket',
         'objects', 'PLUGIN_BUCKET', 'managed', 'authrim-plugin-bucket',
         'authrim-plugin-bucket', 'identified', '2026-08-01T00:00:00.000Z',
         '.authrim/ownership.json', '${'b'.repeat(64)}', 20, 'ready', 20);
    `);
  });

  afterEach(() => database.close());

  it('loads exact provider evidence from the current fresh-install baseline', () => {
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_resource_id,
                  provider_identity_checkpointed_at, provisioning_state
             FROM control_desired_resources WHERE desired_resource_id = 'desired-generic'`
        )
        .get()
    ).toEqual({
      provider_create_state: 'identified',
      provider_resource_id: 'database-uuid',
      provider_identity_checkpointed_at: 20,
      provisioning_state: 'active',
    });
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_identity_checkpointed_at, status
             FROM control_plugin_desired_resources WHERE plugin_resource_id = 'plugin-d1'`
        )
        .get()
    ).toEqual({
      provider_create_state: 'identified',
      provider_identity_checkpointed_at: 20,
      status: 'active',
    });
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_creation_date,
                  provider_ownership_marker_key, provider_ownership_id, status
             FROM control_plugin_desired_resources WHERE plugin_resource_id = 'plugin-r2'`
        )
        .get()
    ).toEqual({
      provider_create_state: 'identified',
      provider_creation_date: '2026-08-01T00:00:00.000Z',
      provider_ownership_marker_key: '.authrim/ownership.json',
      provider_ownership_id: 'b'.repeat(64),
      status: 'ready',
    });
  });

  it('remains expand-compatible with the previous Control writer until coordinator cutover', () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES
        ('op-old-generic', 'env-test', 'provision_shard', 'old-generic', 'running',
         'scheduler', 1, 30, 30),
        ('op-old-plugin', 'env-test', 'plugin_resource_provision', 'old-plugin', 'running',
         'scheduler', 1, 30, 30);
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, created_at, updated_at
      ) VALUES (
        'desired-old', 'env-test', 'd1', 'users:jp:old', 'authrim-test-users-old',
        '${'b'.repeat(64)}', 'creating', 'op-old-generic', 30, 30
      );
      INSERT INTO control_plugin_desired_resources (
        plugin_resource_id, environment_id, operation_id, plugin_installation_id,
        tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
        provider_resource_id, provider_name, status, updated_at
      ) VALUES
        ('plugin-old', 'env-test', 'op-old-plugin', 'plugin-old', 'tenant-old', 'd1',
         'database', 'PLUGIN_DB', 'managed', 'old-database-uuid',
         'authrim-plugin-old', 'ready', 30),
        ('plugin-old-r2', 'env-test', 'op-old-plugin', 'plugin-old', 'tenant-old', 'r2_bucket',
         'objects', 'PLUGIN_BUCKET', 'managed', 'authrim-plugin-old-bucket',
         'authrim-plugin-old-bucket', 'provisioning', 30);
    `);

    expect(
      database
        .prepare(
          `SELECT provider_create_state FROM control_desired_resources
            WHERE desired_resource_id = 'desired-old'`
        )
        .get()
    ).toEqual({ provider_create_state: 'not_started' });
    database.exec(`
      INSERT INTO control_observed_resources (
        observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
        provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
      ) VALUES (
        'observed-old', 'env-test', 'desired-old', 'old-database-uuid',
        'authrim-test-users-old', 'd1', '${'b'.repeat(64)}', 'present', 31
      );
      UPDATE control_desired_resources
         SET observed_resource_id = 'observed-old', provisioning_state = 'ready', updated_at = 31
       WHERE desired_resource_id = 'desired-old';
    `);
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_resource_id,
                  provider_identity_checkpointed_at
             FROM control_desired_resources WHERE desired_resource_id = 'desired-old'`
        )
        .get()
    ).toEqual({
      provider_create_state: 'identified',
      provider_resource_id: 'old-database-uuid',
      provider_identity_checkpointed_at: 31,
    });
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_resource_id,
                  provider_identity_checkpointed_at
             FROM control_plugin_desired_resources
            WHERE plugin_resource_id = 'plugin-old'`
        )
        .get()
    ).toEqual({
      provider_create_state: 'identified',
      provider_resource_id: 'old-database-uuid',
      provider_identity_checkpointed_at: 30,
    });
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_identity_checkpointed_at
             FROM control_plugin_desired_resources
            WHERE plugin_resource_id = 'plugin-old-r2'`
        )
        .get()
    ).toEqual({
      provider_create_state: 'not_started',
      provider_identity_checkpointed_at: null,
    });
    expect(() =>
      database
        .prepare(
          `UPDATE control_plugin_desired_resources SET status = 'ready'
            WHERE plugin_resource_id = 'plugin-old-r2'`
        )
        .run()
    ).toThrow('control_plugin_resource_provider_identity_invalid');
  });

  it('rejects incomplete identified checkpoints', () => {
    expect(() =>
      database.exec(`
        UPDATE control_desired_resources
           SET provider_create_state = 'identified', provider_resource_id = 'replacement-uuid'
         WHERE desired_resource_id = 'desired-generic';
      `)
    ).toThrow('control_desired_resource_provider_identity_invalid');
  });

  it('rejects ready managed resources that have no immutable provider checkpoint', () => {
    expect(() =>
      database.exec(`
        INSERT INTO control_desired_resources (
          desired_resource_id, environment_id, resource_kind, logical_shard_id,
          deterministic_name, ownership_fingerprint, provisioning_state,
          origin_operation_id, created_at, updated_at
        ) VALUES (
          'desired-unverified', 'env-test', 'd1', 'users:jp:unverified',
          'authrim-test-users-unverified', '${'c'.repeat(64)}', 'ready',
          'op-generic', 40, 40
        );
      `)
    ).toThrow('control_desired_resource_provider_identity_invalid');
    expect(() =>
      database.exec(`
        INSERT INTO control_plugin_desired_resources (
          plugin_resource_id, environment_id, operation_id, plugin_installation_id,
          tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
          provider_resource_id, provider_name, status, updated_at
        ) VALUES (
          'plugin-unverified-r2', 'env-test', 'op-plugin-r2', 'plugin-b', 'tenant-b',
          'r2_bucket', 'objects', 'PLUGIN_BUCKET', 'managed', 'bucket-unverified',
          'bucket-unverified', 'ready', 40
        );
      `)
    ).toThrow('control_plugin_resource_provider_identity_invalid');
    expect(() =>
      database.exec(`
        INSERT INTO control_plugin_desired_resources (
          plugin_resource_id, environment_id, operation_id, plugin_installation_id,
          tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
          provider_resource_id, provider_name, status, updated_at
        ) VALUES (
          'plugin-existing-r2', 'env-test', 'op-plugin-r2', 'plugin-c', 'tenant-c',
          'r2_bucket', 'objects', 'PLUGIN_BUCKET_EXISTING', 'existing', 'bucket-existing',
          'bucket-existing', 'ready', 40
        );
      `)
    ).not.toThrow();
  });
});
