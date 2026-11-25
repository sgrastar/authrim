import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  D1_BINDING,
  KV_BINDING,
  cleanupWorld,
  newDeployment,
  oldDeployment,
  seedBindingReconciliation,
  type CleanupWorld,
} from './support/plugin-cleanup-fixtures';

let world: CleanupWorld;

const settings = (bindings: unknown[]) => ({
  compatibility_date: '2026-08-01',
  bindings: [{ name: 'SETTINGS', type: 'kv_namespace', namespace_id: 'settings-id' }, ...bindings],
});
const withPlugin = settings([
  { name: D1_BINDING, type: 'd1', database_id: 'managed-d1-id' },
  { name: KV_BINDING, type: 'kv_namespace', namespace_id: 'external-kv-id' },
]);
const withoutPlugin = settings([]);

beforeEach(async () => {
  world = await cleanupWorld();
  seedBindingReconciliation(world);
});
afterEach(() => world.database.close());

const row = (sql: string) => world.database.prepare(sql).get();
const operation = () =>
  row(
    `SELECT status, next_attempt_at, last_error_code, last_error_redacted, lock_owner
       FROM control_operations WHERE operation_kind = 'cleanup_plugin_resources'`
  );
const cleanupState = () =>
  row(
    'SELECT state, last_error_code, drain_not_before FROM control_plugin_resource_cleanup_operations'
  );

async function requested(enabled = true) {
  const service = world.service(enabled);
  await service.request('test', {
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    reason: 'uninstall',
    requestedById: 'admin-a',
    idempotencyKey: 'key-a',
  });
  return service;
}

/** Deployments seen by the removal: the source, the re-check, then after the patch. */
function removalFlow(options: { after?: unknown[]; reflected?: unknown; patchError?: Error } = {}) {
  const { workers } = world.clients;
  workers.listWorkerDeployments
    .mockResolvedValueOnce([oldDeployment])
    .mockResolvedValueOnce([oldDeployment])
    .mockResolvedValue((options.after ?? [newDeployment, oldDeployment]) as never);
  workers.getWorkerSettings
    .mockResolvedValueOnce(withPlugin as never)
    .mockResolvedValue((options.reflected ?? withoutPlugin) as never);
  if (options.patchError) workers.patchWorkerSettings.mockRejectedValue(options.patchError);
}

describe('binding removal', () => {
  it('removes only the plugin bindings, quarantines and releases the lease', async () => {
    removalFlow();
    const service = await requested();
    expect(await service.reconcile()).toBe(1);
    const [name, patch] = world.clients.workers.patchWorkerSettings.mock.calls[0] ?? [];
    expect(name).toBe('authrim-test-plugin-runner');
    expect((patch?.bindings ?? []).map((binding) => binding.name)).toEqual(['SETTINGS']);
    expect(cleanupState()).toEqual({
      state: 'quarantined',
      last_error_code: null,
      drain_not_before: 100 + 1800,
    });
    expect(operation()).toEqual({
      status: 'waiting_retry',
      next_attempt_at: 1900,
      last_error_code: null,
      last_error_redacted: null,
      lock_owner: null,
    });
    expect(
      row(
        `SELECT expected_source_version_id AS source, previous_deployment_id AS previous
           FROM control_plugin_resource_cleanup_operations`
      )
    ).toEqual({ source: 'version-old', previous: 'deployment-old' });
    expect(row('SELECT COUNT(*) AS n FROM control_worker_deployment_leases')).toEqual({ n: 0 });
    expect(
      world.database
        .prepare(
          `SELECT step_key, status FROM control_operation_steps
            WHERE step_key IN ('remove_plugin_resource_bindings', 'plugin_resource_quarantine_drain')
            ORDER BY step_key`
        )
        .all()
    ).toEqual([
      { step_key: 'plugin_resource_quarantine_drain', status: 'running' },
      { step_key: 'remove_plugin_resource_bindings', status: 'succeeded' },
    ]);
    expect(
      world.database.prepare('SELECT DISTINCT status FROM control_plugin_desired_resources').all()
    ).toEqual([{ status: 'deleting' }]);
    expect(
      world.database
        .prepare('SELECT DISTINCT state FROM control_plugin_resource_cleanup_items')
        .all()
    ).toEqual([{ state: 'quarantined' }]);
  });

  it('skips the patch when none of the plugin bindings remain on a non-required cleanup', async () => {
    world.database.exec(
      'UPDATE control_plugin_resource_cleanup_operations SET binding_presence_required = 0'
    );
    world.clients.workers.getWorkerSettings.mockResolvedValue(withoutPlugin as never);
    const service = await requested();
    world.database.exec(
      'UPDATE control_plugin_resource_cleanup_operations SET binding_presence_required = 0'
    );
    await service.reconcile();
    expect(world.clients.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(cleanupState()).toMatchObject({ state: 'quarantined' });
  });

  it('skips the worker entirely when the cleanup has no host bindings', async () => {
    world.database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
    const service = await requested();
    await service.reconcile();
    expect(world.clients.workers.listWorkerDeployments).not.toHaveBeenCalled();
    expect(cleanupState()).toMatchObject({ state: 'quarantined' });
  });

  it('blocks a cleanup that names bindings without a worker', async () => {
    const service = await requested();
    world.database.exec(
      'UPDATE control_plugin_resource_cleanup_operations SET worker_script_name = NULL, binding_presence_required = 0'
    );
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'blocked',
      last_error_code: 'control_plugin_cleanup_worker_invalid',
    });
    expect(cleanupState()).toMatchObject({
      state: 'blocked',
      last_error_code: 'control_plugin_cleanup_worker_invalid',
    });
  });

  it('blocks a cleanup whose worker name is unsafe', async () => {
    const service = await requested();
    world.database.exec(
      "UPDATE control_plugin_resource_cleanup_operations SET worker_script_name = 'a b'"
    );
    await service.reconcile();
    expect(operation()).toMatchObject({ last_error_code: 'control_plugin_cleanup_worker_invalid' });
  });

  it('retries later while another operation holds the worker lease', async () => {
    world.database.exec(`
      INSERT INTO control_operations (operation_id, environment_id, operation_kind, idempotency_key,
        status, requested_by_type, attempt_count, created_at, updated_at)
      VALUES ('rival', 'test', 'provision_plugin_resources', 'rival', 'running', 'admin', 1, 1, 1);
      INSERT INTO control_worker_deployment_leases (environment_id, worker_script_name,
        owner_operation_id, fencing_token, lease_expires_at, expected_source_version_id, updated_at)
      VALUES ('test', 'authrim-test-plugin-runner', 'rival', 3, 5000, 'v', 1);`);
    const service = await requested();
    await service.reconcile();
    expect(operation()).toEqual({
      status: 'waiting_retry',
      next_attempt_at: 130,
      last_error_code: 'control_worker_deployment_lease_busy',
      last_error_redacted: 'control_worker_deployment_lease_busy',
      lock_owner: null,
    });
    expect(world.clients.workers.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('retries when the active deployment changed between the two reads', async () => {
    world.clients.workers.listWorkerDeployments
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([newDeployment, oldDeployment]);
    const service = await requested();
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'waiting_retry',
      last_error_code: 'control_plugin_cleanup_worker_source_changed',
    });
    expect(row('SELECT COUNT(*) AS n FROM control_worker_deployment_leases')).toEqual({ n: 0 });
  });

  it('retries while the provider still reports the source version after the patch', async () => {
    removalFlow({ after: [oldDeployment] });
    const service = await requested();
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'waiting_retry',
      last_error_code: 'control_plugin_cleanup_binding_propagating',
    });
  });

  it('retries when another deployment landed between the source and the patch result', async () => {
    const interloper = {
      ...newDeployment,
      id: 'deployment-other',
      created_on: '2026-08-01T00:00:30.000Z',
    };
    removalFlow({ after: [newDeployment, interloper, oldDeployment] });
    const service = await requested();
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'waiting_retry',
      last_error_code: 'control_plugin_cleanup_concurrent_deployment',
    });
  });

  it('blocks when the reflected settings still carry a plugin binding', async () => {
    removalFlow({ reflected: withPlugin });
    const service = await requested();
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'blocked',
      last_error_code: 'control_plugin_cleanup_binding_reflection_mismatch',
    });
  });

  it('blocks when only one plugin binding is still reflected', async () => {
    removalFlow({
      reflected: settings([
        { name: KV_BINDING, type: 'kv_namespace', namespace_id: 'external-kv-id' },
      ]),
    });
    const service = await requested();
    await service.reconcile();
    expect(operation()).toMatchObject({
      last_error_code: 'control_plugin_cleanup_binding_reflection_mismatch',
    });
  });

  it('keeps going when the patch fails but the bindings are already gone', async () => {
    removalFlow({ patchError: new Error('response_lost') });
    const service = await requested();
    await service.reconcile();
    expect(cleanupState()).toMatchObject({ state: 'quarantined' });
  });

  it('retries with the provider error when the patch fails and the bindings remain', async () => {
    removalFlow({ patchError: new Error('provider_down'), reflected: withPlugin });
    const service = await requested();
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'waiting_retry',
      next_attempt_at: 130,
      last_error_code: 'control_plugin_cleanup_provider_failed',
    });
  });

  it('retries when the lease was lost before the patch', async () => {
    removalFlow();
    world.clients.workers.getWorkerSettings.mockReset();
    world.clients.workers.getWorkerSettings.mockImplementation(async () => {
      world.database.exec('DELETE FROM control_worker_deployment_leases');
      return withPlugin as never;
    });
    const service = await requested();
    await service.reconcile();
    expect(world.clients.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(operation()).toMatchObject({
      status: 'waiting_retry',
      last_error_code: 'control_worker_deployment_lease_lost',
    });
  });
});

describe('resource deletion edge cases', () => {
  async function dueForDeletion(enabled = true) {
    world.database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
    const service = await requested(enabled);
    await service.reconcile();
    world.now.value = 1900;
    return service;
  }

  it('does not commit a success when no desired resource row is left to remove', async () => {
    const service = await dueForDeletion();
    let present = true;
    world.clients.d1.getD1Database.mockImplementation(async () => {
      if (!present) throw Object.assign(new Error('not_found'), { status: 404 });
      return { uuid: 'managed-d1-id', name: 'managed-d1-name' };
    });
    world.clients.d1.deleteD1Database.mockImplementation(async () => {
      present = false;
    });
    world.database.exec("UPDATE control_plugin_desired_resources SET status = 'active'");
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'waiting_retry',
      last_error_code: 'control_plugin_cleanup_desired_state_not_removed',
    });
    expect(cleanupState()).toMatchObject({ state: 'verifying_absence' });
    expect(
      row(
        "SELECT COUNT(*) AS n FROM control_audit_events WHERE event_type = 'plugin.resources.cleanup.completed'"
      )
    ).toEqual({ n: 0 });
  });

  it('commits nothing when a same-generation desired row is still active', async () => {
    const service = await dueForDeletion();
    let present = true;
    world.clients.d1.getD1Database.mockImplementation(async () => {
      if (!present) throw Object.assign(new Error('not_found'), { status: 404 });
      return { uuid: 'managed-d1-id', name: 'managed-d1-name' };
    });
    world.clients.d1.deleteD1Database.mockImplementation(async () => {
      present = false;
    });
    world.database.exec(
      "UPDATE control_plugin_desired_resources SET status = 'active' WHERE plugin_resource_id = 'resource-existing'"
    );
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'waiting_retry',
      last_error_code: 'control_plugin_cleanup_desired_state_not_removed',
    });
    expect(cleanupState()).toMatchObject({ state: 'verifying_absence' });
    expect(
      world.database
        .prepare(
          'SELECT plugin_resource_id, status FROM control_plugin_desired_resources ORDER BY 1'
        )
        .all()
    ).toEqual([
      { plugin_resource_id: 'resource-existing', status: 'active' },
      { plugin_resource_id: 'resource-managed', status: 'deleting' },
    ]);
    expect(
      row(
        "SELECT COUNT(*) AS n FROM control_audit_events WHERE event_type = 'plugin.resources.cleanup.completed'"
      )
    ).toEqual({ n: 0 });
  });

  it('commits nothing when the claim was replaced before completion', async () => {
    const service = await dueForDeletion();
    let present = true;
    world.clients.d1.getD1Database.mockImplementation(async () => {
      if (!present) throw Object.assign(new Error('not_found'), { status: 404 });
      return { uuid: 'managed-d1-id', name: 'managed-d1-name' };
    });
    world.clients.d1.deleteD1Database.mockImplementation(async () => {
      present = false;
      world.database.exec(
        "UPDATE control_operations SET fencing_token = fencing_token + 1 WHERE operation_kind = 'cleanup_plugin_resources'"
      );
    });
    await service.reconcile();
    expect(cleanupState()).toMatchObject({ state: 'verifying_absence' });
    expect(operation()).not.toMatchObject({ status: 'succeeded' });
    expect(row('SELECT COUNT(*) AS n FROM control_plugin_desired_resources')).toEqual({ n: 2 });
  });

  it('keeps the cleanup blocked after the destructive kill switch turns it off and retries when asked', async () => {
    const service = await dueForDeletion(false);
    await service.reconcile();
    expect(operation()).toMatchObject({
      status: 'blocked',
      last_error_code: 'control_destructive_operations_disabled',
    });
    expect(cleanupState()).toMatchObject({ state: 'blocked' });
    expect(
      world.database
        .prepare(
          `SELECT step_key, status, last_error_code FROM control_operation_steps
            WHERE operation_id = (SELECT operation_id FROM control_operations
                                   WHERE operation_kind = 'cleanup_plugin_resources')
            ORDER BY display_order`
        )
        .all()
    ).toEqual([
      { step_key: 'remove_plugin_resource_bindings', status: 'succeeded', last_error_code: null },
      {
        step_key: 'plugin_resource_quarantine_drain',
        status: 'blocked',
        last_error_code: 'control_destructive_operations_disabled',
      },
      {
        step_key: 'delete_managed_plugin_resources',
        status: 'blocked',
        last_error_code: 'control_destructive_operations_disabled',
      },
    ]);
    world.now.value = 2000;
    const retried = await service.request('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      reason: 'uninstall',
      requestedById: 'admin-b',
      idempotencyKey: 'key-retry',
    });
    expect(retried).toMatchObject({ state: 'quarantined', lastErrorCode: null });
    expect(operation()).toMatchObject({ status: 'running', last_error_code: null });
    expect(
      row(
        `SELECT event_type, actor_id, outcome FROM control_audit_events
          WHERE event_type = 'plugin.resources.cleanup.retry_requested'`
      )
    ).toEqual({
      event_type: 'plugin.resources.cleanup.retry_requested',
      actor_id: 'admin-b',
      outcome: 'attempted',
    });
  });

  it('retries a blocked cleanup that never reached quarantine from the binding step', async () => {
    world.database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
    const service = await requested();
    world.database.exec(`
      UPDATE control_plugin_resource_cleanup_operations SET state = 'blocked', last_error_code = 'x';
      UPDATE control_operations SET status = 'blocked' WHERE operation_kind = 'cleanup_plugin_resources';
      UPDATE control_operation_steps SET status = 'running'
       WHERE step_key = 'remove_plugin_resource_bindings';
      UPDATE control_operation_steps SET status = 'blocked'
       WHERE step_key = 'remove_plugin_resource_bindings';`);
    const retried = await service.request('test', {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      reason: 'uninstall',
      requestedById: 'admin-a',
      idempotencyKey: 'key-retry',
    });
    expect(retried).toMatchObject({ state: 'requested', lastErrorCode: null });
    expect(
      row(
        "SELECT status FROM control_operation_steps WHERE step_key = 'remove_plugin_resource_bindings'"
      )
    ).toEqual({ status: 'running' });
  });
});
