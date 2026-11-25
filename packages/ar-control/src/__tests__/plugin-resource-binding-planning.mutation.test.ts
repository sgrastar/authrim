import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropTriggers } from './support/sqlite-d1';
import { BindingHarness } from './support/plugin-binding-harness';
import {
  DIGEST,
  FINGERPRINTS,
  INSTALLATION_ID,
  OPERATION_ID,
  hostRef,
  mapJson,
  planBindings,
} from './support/plugin-binding-fixtures';

const h = new BindingHarness();
const one = (sql: string) => h.database.prepare(sql).get();
const count = (table: string) =>
  (h.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function addKv(
  index: number,
  overrides: { fingerprint?: string; tenant?: string; spec?: Record<string, unknown> } = {}
): void {
  const fingerprint = overrides.fingerprint ?? index.toString(16).padStart(2, '0').repeat(32);
  h.database
    .prepare(
      `INSERT INTO control_plugin_desired_resources (
         plugin_resource_id, environment_id, operation_id, plugin_installation_id, tenant_id,
         resource_kind, logical_resource_id, binding_name, lifecycle_mode, provider_resource_id,
         provider_name, injection_policy_json, desired_spec_json, status, updated_at,
         provider_create_state, provider_identity_checkpointed_at
       ) VALUES (?, 'test', ?, ?, ?, 'kv_namespace', ?, ?, 'managed', ?, ?, '{}', ?, 'ready', 1,
                 'identified', 1)`
    )
    .run(
      `extra-${index}`,
      OPERATION_ID,
      INSTALLATION_ID,
      overrides.tenant ?? 'tenant-a',
      `extra-${index}`,
      `EXTRA_${index}`,
      `ns-${index}`,
      `ns-${index}-name`,
      JSON.stringify({
        pluginId: 'plugin-a',
        binding: `EXTRA_${index}`,
        kind: 'kv_namespace',
        access: 'read_only',
        ownershipFingerprint: fingerprint,
        capabilityManifestDigest: DIGEST,
        ...overrides.spec,
      })
    );
}

describe('plugin resource binding planning', () => {
  beforeEach(() => {
    h.reset();
    // Legacy rows predate the provider identity triggers, so the planner's own guards are exercised.
    dropTriggers(h.database);
  });
  afterEach(() => h.close());

  const planned = () => h.reconciler({ mutation: false }).reconcile();

  async function expectOperationBlocked(code: string) {
    await planned();
    expect(count('control_plugin_resource_binding_reconciliations')).toBe(0);
    expect(
      one('SELECT status, last_error_code, last_error_redacted, updated_at FROM control_operations')
    ).toEqual({
      status: 'blocked',
      last_error_code: code,
      last_error_redacted: code,
      updated_at: 100,
    });
  }

  async function expectSkipped() {
    expect(await planned()).toEqual({ attempted: 0, succeeded: 0, deferred: 0, blocked: 0 });
    expect(count('control_plugin_resource_binding_reconciliations')).toBe(0);
    expect(one('SELECT status, last_error_code FROM control_operations')).toEqual({
      status: 'running',
      last_error_code: null,
    });
  }

  it('creates one pending target with the sorted binding plan and starts the binding steps', async () => {
    expect(await planned()).toEqual({ attempted: 1, succeeded: 0, deferred: 1, blocked: 0 });
    expect(
      one(
        `SELECT operation_id, environment_id, plugin_installation_id, tenant_id, worker_script_name,
                desired_bindings_json, resource_map_json, state, created_at, updated_at
           FROM control_plugin_resource_binding_reconciliations`
      )
    ).toEqual({
      operation_id: OPERATION_ID,
      environment_id: 'test',
      plugin_installation_id: INSTALLATION_ID,
      tenant_id: 'tenant-a',
      worker_script_name: 'test-ar-plugin-runner',
      desired_bindings_json: JSON.stringify(planBindings()),
      resource_map_json: mapJson(),
      state: 'pending',
      created_at: 100,
      updated_at: 100,
    });
    expect(
      h.database
        .prepare(
          `SELECT status, attempt_count, started_at, updated_at FROM control_operation_steps
            WHERE step_key LIKE '%_binding'`
        )
        .all()
    ).toEqual(
      [0, 1, 2].map(() => ({
        status: 'running',
        attempt_count: 1,
        started_at: 100,
        updated_at: 100,
      }))
    );
    expect(
      h.database
        .prepare(
          `SELECT DISTINCT status, attempt_count FROM control_operation_steps
            WHERE step_key NOT LIKE '%_binding'`
        )
        .all()
    ).toEqual([{ status: 'succeeded', attempt_count: 0 }]);
  });

  it('does not recreate or restart an existing target', async () => {
    await planned();
    h.now = 200;
    await planned();
    expect(
      one('SELECT created_at, updated_at FROM control_plugin_resource_binding_reconciliations')
    ).toEqual({ created_at: 100, updated_at: 100 });
    expect(one(`SELECT MAX(attempt_count) AS attempts FROM control_operation_steps`)).toEqual({
      attempts: 1,
    });
  });

  it('plans exactly sixteen resources and ignores a seventeenth-resource group', async () => {
    for (let index = 1; index <= 13; index += 1) addKv(index);
    await planned();
    const stored = one(
      'SELECT resource_map_json AS json FROM control_plugin_resource_binding_reconciliations'
    ) as { json: string };
    const map = JSON.parse(stored.json) as { resources: unknown[] };
    expect(map.resources).toHaveLength(16);
  });

  it('skips a group of more than sixteen resources without blocking', async () => {
    for (let index = 1; index <= 14; index += 1) addKv(index);
    await expectSkipped();
  });

  describe('operations that are not plannable', () => {
    it('skips an operation of another kind', async () => {
      h.database.exec(
        "UPDATE control_operations SET operation_kind = 'register_external_capabilities'"
      );
      await expectSkipped();
    });

    it('skips an operation waiting for a later retry', async () => {
      h.database.exec(
        "UPDATE control_operations SET status = 'waiting_retry', next_attempt_at = 101"
      );
      expect(await planned()).toMatchObject({ attempted: 0 });
      expect(count('control_plugin_resource_binding_reconciliations')).toBe(0);
    });

    it('plans an operation whose retry time has arrived', async () => {
      h.database.exec(
        "UPDATE control_operations SET status = 'waiting_retry', next_attempt_at = 100"
      );
      expect(await planned()).toMatchObject({ attempted: 1 });
    });

    it('plans a queued operation', async () => {
      h.database.exec("UPDATE control_operations SET status = 'queued', started_at = NULL");
      expect(await planned()).toMatchObject({ attempted: 1 });
    });
  });

  describe('resources that are not ready', () => {
    it.each([
      ['a resource that is still provisioning', "status = 'provisioning'", 'resource-kv'],
      [
        'a provider id that is empty',
        "provider_resource_id = '', provider_name = 'name'",
        'resource-kv',
      ],
      [
        'a provider name that is empty',
        "provider_resource_id = 'id', provider_name = ''",
        'resource-kv',
      ],
    ])('waits on %s', async (_label, assignment, id) => {
      h.database.exec(
        `UPDATE control_plugin_desired_resources SET ${assignment} WHERE plugin_resource_id = '${id}'`
      );
      await expectSkipped();
    });

    it('waits while the D1 migration is not ready', async () => {
      h.database.exec("UPDATE control_plugin_resource_migration_state SET state = 'applying'");
      await expectSkipped();
    });

    it('waits while the D1 migration targets a different database', async () => {
      h.database.exec(
        "UPDATE control_plugin_resource_migration_state SET provider_database_id = 'other'"
      );
      await expectSkipped();
    });

    it('waits when a non-D1 resource carries migration state', async () => {
      h.database.exec(`
        INSERT INTO control_plugin_resource_migration_state (
          plugin_resource_id, environment_id, operation_id, stream_id, release_id,
          manifest_digest, provider_database_id, state, expected_file_count,
          applied_file_count, completed_at, updated_at
        ) VALUES ('resource-kv', 'test', '${OPERATION_ID}', 'plugin/plugin-a/state', 'release-a',
          '${'1'.repeat(64)}', 'namespace-a', 'ready', 1, 1, 1, 1)`);
      await expectSkipped();
    });
  });

  describe('provider checkpoints of managed resources', () => {
    it.each([
      ['an unidentified provider create', "provider_create_state = 'issued'", 'resource-kv'],
      ['a missing checkpoint time', 'provider_identity_checkpointed_at = NULL', 'resource-kv'],
      ['a missing R2 creation date', 'provider_creation_date = NULL', 'resource-r2'],
      ['an empty R2 creation date', "provider_creation_date = ''", 'resource-r2'],
      ['a missing R2 marker key', 'provider_ownership_marker_key = NULL', 'resource-r2'],
      ['a missing R2 ownership id', 'provider_ownership_id = NULL', 'resource-r2'],
    ])('blocks the operation on %s', async (_label, assignment, id) => {
      h.database.exec(
        `UPDATE control_plugin_desired_resources SET ${assignment} WHERE plugin_resource_id = '${id}'`
      );
      await expectOperationBlocked('plugin_resource_provider_checkpoint_invalid');
    });

    it('blocks on a bad checkpoint even when the resource is not yet ready', async () => {
      h.database.exec(
        "UPDATE control_plugin_desired_resources SET status = 'provisioning', provider_create_state = 'issued' WHERE plugin_resource_id = 'resource-kv'"
      );
      await expectOperationBlocked('plugin_resource_provider_checkpoint_invalid');
    });

    it('does not require a checkpoint for an existing resource', async () => {
      h.database.exec(
        "UPDATE control_plugin_desired_resources SET lifecycle_mode = 'existing', provider_create_state = 'not_started', provider_identity_checkpointed_at = NULL WHERE plugin_resource_id = 'resource-kv'"
      );
      expect(await planned()).toMatchObject({ attempted: 1 });
    });

    it('does not require R2 ownership evidence for a non-R2 managed resource', async () => {
      expect(await planned()).toMatchObject({ attempted: 1 });
      expect(
        one(
          "SELECT provider_creation_date FROM control_plugin_desired_resources WHERE plugin_resource_id = 'resource-kv'"
        )
      ).toEqual({ provider_creation_date: null });
    });
  });

  describe('runner inventory', () => {
    it.each([
      ['no active runner', "UPDATE control_desired_worker_inventory SET status = 'disabled'"],
      [
        'an unexpected script name',
        "UPDATE control_desired_worker_inventory SET worker_script_name = 'other-ar-plugin-runner', deployment_target = 'other-ar-plugin-runner'",
      ],
    ])('blocks the operation with %s', async (_label, statement) => {
      h.database.exec(statement);
      await expectOperationBlocked('plugin_resource_binding_runner_inventory_invalid');
    });

    it('blocks the operation with two active runners', async () => {
      h.database.exec(`
        INSERT INTO control_desired_worker_inventory (
          environment_id, worker_script_name, package_name, deployment_target,
          capability_manifest_digest, source_manifest_path, source_manifest_hash,
          generated_artifact_hash, source_kind, source_reference,
          registered_by_operation_id, registered_by, registered_at
        ) VALUES ('test', 'zz-ar-plugin-runner', '@authrim/ar-plugin-runner', 'zz-ar-plugin-runner',
          '${'d'.repeat(64)}', 'p', '${'e'.repeat(64)}', '${'f'.repeat(64)}', 'core_manifest',
          '@authrim/ar-plugin-runner', '${OPERATION_ID}', 'setup', 1)`);
      await expectOperationBlocked('plugin_resource_binding_runner_inventory_invalid');
    });

    it('ignores active workers of other packages', async () => {
      h.database.exec(`
        INSERT INTO control_desired_worker_inventory (
          environment_id, worker_script_name, package_name, deployment_target,
          capability_manifest_digest, source_manifest_path, source_manifest_hash,
          generated_artifact_hash, source_kind, source_reference,
          registered_by_operation_id, registered_by, registered_at
        ) VALUES ('test', 'aa-other', '@authrim/ar-other', 'aa-other',
          '${'d'.repeat(64)}', 'p', '${'e'.repeat(64)}', '${'f'.repeat(64)}', 'core_manifest',
          '@authrim/ar-other', '${OPERATION_ID}', 'setup', 1)`);
      expect(await planned()).toMatchObject({ attempted: 1 });
    });
  });

  describe('group validation', () => {
    it('blocks a group spanning two tenants', async () => {
      h.database.exec(
        "UPDATE control_plugin_desired_resources SET tenant_id = 'tenant-b' WHERE plugin_resource_id = 'resource-kv'"
      );
      await expectOperationBlocked('plugin_resource_binding_group_invalid');
    });

    it('blocks a group naming two plugins', async () => {
      addKv(1, { spec: { pluginId: 'plugin-b' } });
      await expectOperationBlocked('plugin_resource_binding_group_invalid');
    });

    it('blocks a group with two manifest digests', async () => {
      addKv(1, { spec: { capabilityManifestDigest: '8'.repeat(64) } });
      await expectOperationBlocked('plugin_resource_binding_group_invalid');
    });

    it('blocks a group reusing one ownership fingerprint for the same kind', async () => {
      addKv(1, { fingerprint: FINGERPRINTS.kv_namespace });
      await expectOperationBlocked('plugin_resource_binding_group_invalid');
    });

    it('accepts equal fingerprints across different kinds', async () => {
      h.database.exec(
        `UPDATE control_plugin_desired_resources SET desired_spec_json = json_set(desired_spec_json, '$.ownershipFingerprint', '${FINGERPRINTS.d1}') WHERE plugin_resource_id = 'resource-kv'`
      );
      expect(await planned()).toMatchObject({ attempted: 1 });
      expect(hostRef('kv_namespace')).not.toBe(hostRef('d1'));
    });
  });

  describe('desired spec validation', () => {
    const spec = (key: string, value: unknown) =>
      `UPDATE control_plugin_desired_resources SET desired_spec_json = json_set(desired_spec_json, '$.${key}', json('${JSON.stringify(value)}')) WHERE plugin_resource_id = 'resource-kv'`;
    it.each([
      ['an unsafe plugin id', spec('pluginId', 'Plugin A')],
      ['a numeric plugin id', spec('pluginId', 7)],
      ['a different binding', spec('binding', 'OTHER')],
      ['a different kind', spec('kind', 'd1')],
      ['an unknown access', spec('access', 'admin')],
      ['a short fingerprint', spec('ownershipFingerprint', 'abc')],
      ['a numeric fingerprint', spec('ownershipFingerprint', 5)],
      ['a short digest', spec('capabilityManifestDigest', 'abc')],
      ['a numeric digest', spec('capabilityManifestDigest', 5)],
      [
        'a non-object spec',
        "UPDATE control_plugin_desired_resources SET desired_spec_json = '[]' WHERE plugin_resource_id = 'resource-kv'",
      ],
    ])('blocks the operation on %s', async (_label, statement) => {
      h.database.exec(statement);
      await expectOperationBlocked('plugin_resource_binding_spec_invalid');
    });

    it('does not rewrite an operation that already left the running states', async () => {
      h.database.exec(
        "UPDATE control_operations SET status = 'waiting_retry', next_attempt_at = 50, last_error_code = 'earlier'"
      );
      h.database.exec(
        `UPDATE control_plugin_desired_resources SET desired_spec_json = '[]' WHERE plugin_resource_id = 'resource-kv'`
      );
      await planned();
      expect(one('SELECT status, last_error_code FROM control_operations')).toEqual({
        status: 'blocked',
        last_error_code: 'plugin_resource_binding_spec_invalid',
      });
    });
  });

  it('blocks the operation with a generic code when persisting the target fails', async () => {
    h.database.exec(`CREATE TRIGGER fail_binding_insert BEFORE INSERT
      ON control_plugin_resource_binding_reconciliations
      BEGIN SELECT RAISE(ABORT, 'storage_unavailable'); END`);
    await expectOperationBlocked('plugin_resource_binding_group_invalid');
  });

  it('orders the resource map by logical id with locale-aware comparison', async () => {
    addKv(1, { fingerprint: '0a'.repeat(32) });
    addKv(2, { fingerprint: '0b'.repeat(32) });
    h.database.exec(
      "UPDATE control_plugin_desired_resources SET logical_resource_id = 'x_a' WHERE plugin_resource_id = 'extra-1'"
    );
    h.database.exec(
      "UPDATE control_plugin_desired_resources SET logical_resource_id = 'x1' WHERE plugin_resource_id = 'extra-2'"
    );
    await planned();
    const map = JSON.parse(
      (
        one(
          'SELECT resource_map_json AS json FROM control_plugin_resource_binding_reconciliations'
        ) as { json: string }
      ).json
    ) as { resources: { logicalResourceId: string }[] };
    expect(map.resources.map((resource) => resource.logicalResourceId)).toEqual([
      'cache',
      'objects',
      'state',
      'x_a',
      'x1',
    ]);
  });
});
