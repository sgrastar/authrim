import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINGERPRINT,
  cleanupWorld,
  seedBindingReconciliation,
  type CleanupWorld,
} from './support/plugin-cleanup-fixtures';

let world: CleanupWorld;

beforeEach(async () => {
  world = await cleanupWorld();
});
afterEach(() => world.database.close());

const valid = {
  tenantId: 'tenant-a',
  pluginId: 'plugin-a',
  reason: 'uninstall',
  requestedById: 'admin-a',
  idempotencyKey: 'key-a',
};
const request = (input: unknown, environment = 'test') =>
  world.service().request(environment, input);
const row = (sql: string) => world.database.prepare(sql).get();

describe('cleanup request validation', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['a missing key', { ...valid, tenantId: undefined }],
    ['an extra key', { ...valid, extra: 1 }],
    ['an unsafe plugin id', { ...valid, pluginId: 'Plugin A' }],
    ['a numeric plugin id', { ...valid, pluginId: 7 }],
    ['an unknown reason', { ...valid, reason: 'other' }],
    [
      'a pre-activation cancel without a source operation',
      { ...valid, reason: 'canceled_pre_activation' },
    ],
    ['an uninstall naming a source operation', { ...valid, sourceOperationId: 'source-op' }],
    ['an unsafe tenant', { ...valid, tenantId: 'a b' }],
    ['an unsafe requester', { ...valid, requestedById: '' }],
    ['an unsafe idempotency key', { ...valid, idempotencyKey: 'a b' }],
    [
      'an unsafe source operation',
      { ...valid, reason: 'canceled_pre_activation', sourceOperationId: 'a b' },
    ],
  ])('rejects %s', async (_label, input) => {
    await expect(request(input)).rejects.toThrow('control_plugin_cleanup_request_invalid');
  });

  it('rejects an unsafe environment', async () => {
    await expect(request(valid, 'a b')).rejects.toThrow(
      'control_plugin_cleanup_environment_invalid'
    );
    await expect(
      world.service().get('', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).rejects.toThrow('control_plugin_cleanup_environment_invalid');
    await expect(
      world.service().requestCanceledProvisioning('a b', {
        sourceOperationId: 'source-op',
        requestedById: 'admin-a',
        idempotencyKey: 'key-a',
      })
    ).rejects.toThrow('control_plugin_cleanup_environment_invalid');
  });

  it('returns null when the installation owns no live resources', async () => {
    await expect(request({ ...valid, pluginId: 'plugin-z' })).resolves.toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['extra keys', { tenantId: 'tenant-a', pluginId: 'plugin-a', extra: 1 }],
    ['a missing key', { tenantId: 'tenant-a' }],
    ['an unsafe tenant', { tenantId: 'a b', pluginId: 'plugin-a' }],
    ['an unsafe plugin', { tenantId: 'tenant-a', pluginId: 'Plugin A' }],
    ['a numeric plugin', { tenantId: 'tenant-a', pluginId: 4 }],
  ])('rejects a lookup with %s', async (_label, input) => {
    await expect(world.service().get('test', input)).rejects.toThrow(
      'control_plugin_cleanup_lookup_invalid'
    );
  });

  it('returns null for a lookup without a cleanup', async () => {
    await expect(
      world.service().get('test', { tenantId: 'tenant-a', pluginId: 'plugin-a' })
    ).resolves.toBeNull();
  });
});

describe('cleanup source validation', () => {
  it('records the request with its idempotent operation, items and audit trail', async () => {
    const view = await request(valid);
    expect(view).toMatchObject({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      sourceOperationId: 'source-op',
      lifecycleGeneration: 1,
      reason: 'uninstall',
      state: 'requested',
      drainNotBefore: null,
      managedResourceCount: 1,
      detachedResourceCount: 1,
      lastErrorCode: null,
      createdAt: 100,
      updatedAt: 100,
      completedAt: null,
    });
    expect(
      world.database
        .prepare(
          `SELECT step_key, display_order, status FROM control_operation_steps
            WHERE operation_id = ? ORDER BY display_order`
        )
        .all(view?.operationId ?? '')
    ).toEqual([
      { step_key: 'remove_plugin_resource_bindings', display_order: 10, status: 'queued' },
      { step_key: 'plugin_resource_quarantine_drain', display_order: 20, status: 'queued' },
      { step_key: 'delete_managed_plugin_resources', display_order: 30, status: 'queued' },
    ]);
    expect(
      world.database
        .prepare(
          `SELECT resource_kind, lifecycle_mode, provider_resource_id, ownership_fingerprint,
                  delete_provider_resource, state FROM control_plugin_resource_cleanup_items
            ORDER BY plugin_resource_id`
        )
        .all()
    ).toEqual([
      {
        resource_kind: 'kv_namespace',
        lifecycle_mode: 'existing',
        provider_resource_id: 'external-kv-id',
        ownership_fingerprint: 'b'.repeat(64),
        delete_provider_resource: 0,
        state: 'pending',
      },
      {
        resource_kind: 'd1',
        lifecycle_mode: 'managed',
        provider_resource_id: 'managed-d1-id',
        ownership_fingerprint: FINGERPRINT,
        delete_provider_resource: 1,
        state: 'pending',
      },
    ]);
    expect(
      row(
        `SELECT event_type, actor_type, actor_id, resource_kind, resource_id, outcome,
                redacted_payload_json FROM control_audit_events
          WHERE event_type = 'plugin.resources.cleanup.requested'`
      )
    ).toEqual({
      event_type: 'plugin.resources.cleanup.requested',
      actor_type: 'admin',
      actor_id: 'admin-a',
      resource_kind: 'plugin_installation',
      resource_id: world.installationId,
      outcome: 'attempted',
      redacted_payload_json: JSON.stringify({
        reason: 'uninstall',
        lifecycleGeneration: 1,
        managedResourceCount: 1,
        existingResourceCount: 1,
      }),
    });
    expect(
      row(
        `SELECT idempotency_key, status, requested_by_type, requested_by_id, attempt_count
           FROM control_operations WHERE operation_kind = 'cleanup_plugin_resources'`
      )
    ).toEqual({
      idempotency_key: 'plugin-cleanup:key-a',
      status: 'queued',
      requested_by_type: 'admin',
      requested_by_id: 'admin-a',
      attempt_count: 0,
    });
    await expect(request({ ...valid, idempotencyKey: 'key-b' })).resolves.toEqual(view);
  });

  it('refuses a second cleanup for another reason while one is active', async () => {
    await request(valid);
    await expect(
      request({ ...valid, reason: 'canceled_pre_activation', sourceOperationId: 'source-op' })
    ).rejects.toThrow('control_plugin_cleanup_request_conflict');
  });

  it('rejects a resource set spanning two operations or two generations', async () => {
    world.database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES ('other-op', 'test', 'provision_plugin_resources', 'other', 'blocked',
        'admin', 1, 1, 1);
      UPDATE control_plugin_desired_resources SET operation_id = 'other-op'
       WHERE plugin_resource_id = 'resource-existing';`);
    await expect(request(valid)).rejects.toThrow('control_plugin_cleanup_resource_set_invalid');
    world.database.exec(`
      UPDATE control_plugin_desired_resources SET operation_id = 'source-op', lifecycle_generation = 2
       WHERE plugin_resource_id = 'resource-existing'`);
    await expect(request(valid)).rejects.toThrow('control_plugin_cleanup_resource_set_invalid');
  });

  it('rejects a pre-activation cancel naming another source operation', async () => {
    await expect(
      request({ ...valid, reason: 'canceled_pre_activation', sourceOperationId: 'elsewhere' })
    ).rejects.toThrow('control_plugin_cleanup_source_operation_mismatch');
  });

  it('rejects a missing source operation', async () => {
    world.database.exec('PRAGMA foreign_keys = OFF');
    world.database.exec("UPDATE control_operations SET operation_kind = 'tenant_create'");
    await expect(request(valid)).rejects.toThrow('control_plugin_cleanup_source_operation_invalid');
  });

  it('allows a pre-activation cancel only for a blocked or canceled source', async () => {
    const input = { ...valid, reason: 'canceled_pre_activation', sourceOperationId: 'source-op' };
    world.database.exec("UPDATE control_operations SET status = 'running'");
    await expect(request(input)).rejects.toThrow(
      'control_plugin_cleanup_source_operation_not_canceled'
    );
    world.database.exec("UPDATE control_operations SET status = 'blocked'");
    await expect(request(input)).resolves.toMatchObject({ reason: 'canceled_pre_activation' });
  });

  it('derives the canceled provisioning request from the source operation', async () => {
    await expect(
      world.service().requestCanceledProvisioning('test', {
        sourceOperationId: 'source-op',
        requestedById: 'admin-a',
        idempotencyKey: 'key-a',
      })
    ).resolves.toMatchObject({ reason: 'canceled_pre_activation', pluginId: 'plugin-a' });
  });

  it.each([
    [
      'an unsafe source id',
      { sourceOperationId: 'a b', requestedById: 'admin-a', idempotencyKey: 'k' },
      'control_plugin_cleanup_source_operation_invalid',
    ],
    [
      'an unsafe requester',
      { sourceOperationId: 'source-op', requestedById: '', idempotencyKey: 'k' },
      'control_plugin_cleanup_request_invalid',
    ],
    [
      'an unsafe key',
      { sourceOperationId: 'source-op', requestedById: 'admin-a', idempotencyKey: 'a b' },
      'control_plugin_cleanup_request_invalid',
    ],
    [
      'an unknown source',
      { sourceOperationId: 'missing', requestedById: 'admin-a', idempotencyKey: 'k' },
      'control_plugin_cleanup_source_operation_invalid',
    ],
  ])('rejects a canceled provisioning request with %s', async (_label, input, code) => {
    await expect(world.service().requestCanceledProvisioning('test', input)).rejects.toThrow(code);
  });

  it('rejects a canceled provisioning request when the source spans two tenants', async () => {
    world.database.exec(
      "UPDATE control_plugin_desired_resources SET tenant_id = 'tenant-b' WHERE plugin_resource_id = 'resource-existing'"
    );
    await expect(
      world.service().requestCanceledProvisioning('test', {
        sourceOperationId: 'source-op',
        requestedById: 'admin-a',
        idempotencyKey: 'k',
      })
    ).rejects.toThrow('control_plugin_cleanup_source_operation_invalid');
  });
});

describe('cleanup desired spec validation', () => {
  const patchSpec = (patch: string) =>
    world.database.exec(
      `UPDATE control_plugin_desired_resources
          SET desired_spec_json = json_set(desired_spec_json, ${patch})
        WHERE plugin_resource_id = 'resource-managed'`
    );

  it.each([
    ['a short fingerprint', "'$.ownershipFingerprint', 'abc'"],
    ['a numeric fingerprint', "'$.ownershipFingerprint', 5"],
    ['an unknown ownership', "'$.ownership', 'borrowed'"],
    ['an external ownership on a managed resource', "'$.ownership', 'external_reference'"],
    ['a text delete flag', "'$.deleteProviderResource', 'yes'"],
    ['a disabled delete flag on a managed resource', "'$.deleteProviderResource', json('false')"],
  ])('rejects %s', async (_label, patch) => {
    patchSpec(patch);
    await expect(request(valid)).rejects.toThrow('control_plugin_cleanup_desired_spec_invalid');
  });

  it('rejects a spec that is not an object', async () => {
    world.database.exec(
      "UPDATE control_plugin_desired_resources SET desired_spec_json = '[]' WHERE plugin_resource_id = 'resource-managed'"
    );
    await expect(request(valid)).rejects.toThrow('control_plugin_cleanup_desired_spec_invalid');
  });

  it('rejects a delete flag on an external reference', async () => {
    world.database.exec(
      `UPDATE control_plugin_desired_resources
          SET desired_spec_json = json_set(desired_spec_json, '$.deleteProviderResource', json('true'))
        WHERE plugin_resource_id = 'resource-existing'`
    );
    await expect(request(valid)).rejects.toThrow('control_plugin_cleanup_desired_spec_invalid');
  });
});

describe('cleanup binding plan validation', () => {
  it.each([
    ['a non-object map', '[]'],
    ['a missing resource list', '{}'],
    ['a non-array resource list', '{"resources":{}}'],
    ['seventeen resources', JSON.stringify({ resources: Array.from({ length: 17 }, () => ({})) })],
    ['a null entry', '{"resources":[null]}'],
    ['an array entry', '{"resources":[[]]}'],
    ['an unsafe host binding', '{"resources":[{"hostBindingRef":"PLUGIN_STATE"}]}'],
    [
      'a duplicate host binding',
      JSON.stringify({
        resources: [
          { hostBindingRef: 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA' },
          { hostBindingRef: 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA' },
        ],
      }),
    ],
  ])('rejects %s', async (_label, map) => {
    seedBindingReconciliation(world, { map });
    await expect(request(valid)).rejects.toThrow('control_plugin_cleanup_binding_plan_invalid');
  });

  it('accepts exactly sixteen host bindings and records them sorted', async () => {
    const names = Array.from(
      { length: 16 },
      (_, index) => `PRES_KV_${index.toString(16).toUpperCase().padStart(24, '0')}`
    ).reverse();
    seedBindingReconciliation(world, { hostBindings: names });
    await expect(request(valid)).resolves.toMatchObject({ state: 'requested' });
    expect(
      JSON.parse(
        (
          row(
            'SELECT binding_names_json AS json FROM control_plugin_resource_cleanup_operations'
          ) as {
            json: string;
          }
        ).json
      )
    ).toEqual([...names].sort());
  });

  it('requires bindings to still be present only for an uninstall of a succeeded activation', async () => {
    seedBindingReconciliation(world);
    await request(valid);
    expect(
      row(
        'SELECT binding_presence_required AS required, worker_script_name AS worker FROM control_plugin_resource_cleanup_operations'
      )
    ).toEqual({ required: 1, worker: 'authrim-test-plugin-runner' });
  });

  it('does not require bindings for an unfinished activation', async () => {
    seedBindingReconciliation(world, { state: 'settings_patched' });
    await request(valid);
    expect(
      row(
        'SELECT binding_presence_required AS required FROM control_plugin_resource_cleanup_operations'
      )
    ).toEqual({ required: 0 });
  });
});
