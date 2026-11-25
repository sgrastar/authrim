import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginResourceBindingReconciler } from '../plugin-resource-binding-reconciler';
import { BoundedServiceBindingInvocationBudget } from '../service-binding-invocation-budget';
import { d1 } from './support/plugin-dynamic-fixtures';
import { BindingHarness } from './support/plugin-binding-harness';
import {
  INSTALLATION_ID,
  OPERATION_ID,
  controlEnv,
  newDeployment,
  oldDeployment,
  planBindings,
  seedTarget,
} from './support/plugin-binding-fixtures';

const h = new BindingHarness();
const row = (sql: string) => h.database.prepare(sql).get();

describe('plugin resource binding stabilization, ordering and rollback', () => {
  beforeEach(() => h.reset());
  afterEach(() => h.close());

  describe('stabilization', () => {
    const stabilizing = () => {
      seedTarget(h.database, { state: 'stabilizing', consecutive: 3, attempts: 3, notBefore: 130 });
      h.runBindingSteps();
    };

    it('is not due before the stabilization time', async () => {
      stabilizing();
      h.now = 129;
      expect(await h.reconciler().reconcile()).toMatchObject({ attempted: 0 });
      h.now = 130;
      expect(await h.reconciler().reconcile()).toMatchObject({ attempted: 1, succeeded: 1 });
    });

    it('activates the resources and records the audit trail', async () => {
      stabilizing();
      h.now = 140;
      expect(await h.reconciler().reconcile()).toEqual({
        attempted: 1,
        succeeded: 1,
        deferred: 0,
        blocked: 0,
      });
      expect(h.smoke).toHaveBeenCalledTimes(1);
      expect(h.recon()).toMatchObject({
        state: 'succeeded',
        attempts: 4,
        last_error_code: null,
        updated_at: 140,
      });
      expect(
        row('SELECT completed_at FROM control_plugin_resource_binding_reconciliations')
      ).toEqual({ completed_at: 140 });
      expect(
        h.database
          .prepare('SELECT DISTINCT status, updated_at FROM control_plugin_desired_resources')
          .all()
      ).toEqual([{ status: 'active', updated_at: 140 }]);
      expect(
        h.database
          .prepare(
            `SELECT status, completed_at FROM control_operation_steps WHERE step_key LIKE '%_binding'`
          )
          .all()
      ).toEqual([
        { status: 'succeeded', completed_at: 140 },
        { status: 'succeeded', completed_at: 140 },
        { status: 'succeeded', completed_at: 140 },
      ]);
      expect(row('SELECT status, completed_at, next_attempt_at FROM control_operations')).toEqual({
        status: 'succeeded',
        completed_at: 140,
        next_attempt_at: null,
      });
      expect(h.leases()).toEqual([]);
      expect(row('SELECT * FROM control_audit_events')).toMatchObject({
        event_id: `audit_plugin_resource_bindings_${OPERATION_ID.slice(-32)}`,
        environment_id: 'test',
        operation_id: OPERATION_ID,
        event_type: 'plugin.resource_bindings.activated',
        actor_type: 'worker',
        actor_id: 'ar-control',
        resource_kind: 'plugin_installation',
        resource_id: INSTALLATION_ID,
        outcome: 'succeeded',
        redacted_payload_json: JSON.stringify({
          resourceCount: 3,
          workerScriptName: 'test-ar-plugin-runner',
        }),
        created_at: 140,
      });
    });

    it('blocks when an installation resource is not ready', async () => {
      stabilizing();
      h.now = 140;
      h.database.exec(
        "UPDATE control_plugin_desired_resources SET status = 'provisioning' WHERE plugin_resource_id = 'resource-kv'"
      );
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        state: 'blocked',
        last_error_code: 'plugin_resource_binding_activation_prerequisite_invalid',
      });
      expect(h.smoke).not.toHaveBeenCalled();
    });

    it('blocks when an earlier provisioning step is unfinished', async () => {
      stabilizing();
      h.now = 140;
      h.database.exec(
        `INSERT INTO control_operation_steps (operation_id, step_key, display_order, status, updated_at)
         VALUES ('${OPERATION_ID}', 'plugin_resource_zzz_provider', 5, 'queued', 1)`
      );
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        last_error_code: 'plugin_resource_binding_activation_prerequisite_invalid',
      });
    });

    it('blocks when a binding step is not running', async () => {
      seedTarget(h.database, { state: 'stabilizing', consecutive: 3, attempts: 3, notBefore: 130 });
      h.now = 140;
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
    });

    it('blocks when the resource count differs from the map', async () => {
      stabilizing();
      h.now = 140;
      h.database.exec(
        "INSERT INTO control_plugin_desired_resources (plugin_resource_id, environment_id, operation_id, plugin_installation_id, tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode, provider_resource_id, provider_name, injection_policy_json, desired_spec_json, status, updated_at) VALUES ('extra', 'test', '" +
          OPERATION_ID +
          "', '" +
          INSTALLATION_ID +
          "', 'tenant-a', 'kv_namespace', 'extra', 'EXTRA', 'existing', 'x', 'x', '{}', '{}', 'ready', 1)"
      );
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        last_error_code: 'plugin_resource_binding_activation_prerequisite_invalid',
      });
    });

    it('blocks when a patched stabilizing target lost its deployment id', async () => {
      seedTarget(h.database, {
        state: 'stabilizing',
        consecutive: 3,
        attempts: 3,
        notBefore: 130,
        patchDeployment: null,
      });
      h.runBindingSteps();
      h.now = 140;
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        last_error_code: 'plugin_resource_binding_patch_result_missing',
      });
    });

    it('blocks when a stabilizing target lost its version id', async () => {
      seedTarget(h.database, {
        state: 'stabilizing',
        consecutive: 3,
        attempts: 3,
        notBefore: 130,
        patchVersion: null,
      });
      h.runBindingSteps();
      h.now = 140;
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
    });

    it('blocks with a stabilization-specific code when the final smoke fails', async () => {
      stabilizing();
      h.now = 140;
      h.smoke.mockRejectedValue(new Error('runner_down'));
      expect(await h.reconciler().reconcile()).toEqual({
        attempted: 1,
        succeeded: 0,
        deferred: 0,
        blocked: 1,
      });
      expect(h.operation()).toMatchObject({
        status: 'blocked',
        last_error_code: 'plugin_resource_binding_stabilization_smoke_failed',
      });
      expect(h.recon()).toMatchObject({ state: 'blocked' });
    });

    it('blocks on a final smoke mismatch and defers on budget exhaustion', async () => {
      stabilizing();
      h.now = 140;
      h.smoke.mockResolvedValue({
        operationId: OPERATION_ID,
        installationId: INSTALLATION_ID,
        observedVersionId: 'wrong',
        resourceCount: 3,
      });
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        last_error_code: 'plugin_resource_binding_smoke_mismatch',
      });
    });

    it('defers and releases the lease when the invocation budget is spent', async () => {
      stabilizing();
      h.now = 140;
      const budget = new BoundedServiceBindingInvocationBudget(1);
      budget.tryConsume();
      expect(await h.reconciler({ budget }).reconcile()).toMatchObject({ deferred: 1 });
      expect(h.operation()).toMatchObject({
        last_error_code: 'control_service_binding_invocation_budget_exhausted',
      });
      expect(h.smoke).not.toHaveBeenCalled();
      expect(h.leases()).toEqual([]);
    });

    it('blocks when the activation cannot be reflected in the operation', async () => {
      stabilizing();
      h.now = 140;
      h.database.exec(
        "INSERT INTO control_plugin_desired_resources (plugin_resource_id, environment_id, operation_id, plugin_installation_id, tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode, provider_resource_id, provider_name, injection_policy_json, desired_spec_json, status, updated_at) VALUES ('other-install', 'test', '" +
          OPERATION_ID +
          "', 'installation-b', 'tenant-a', 'kv_namespace', 'other', 'OTHER', 'existing', 'x', 'x', '{}', '{}', 'pending', 1)"
      );
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1, succeeded: 0 });
      expect(h.recon()).toMatchObject({ state: 'succeeded', last_error_code: null });
      expect(h.operation()).toMatchObject({
        status: 'blocked',
        last_error_code: 'plugin_resource_binding_activation_reflection_failed',
      });
    });
  });

  describe('target ordering', () => {
    it('processes stabilizing, smoke_verifying and settings_patched targets in that order, then by age', async () => {
      seedTarget(h.database, {
        state: 'settings_patched',
        installation: 'inst-c',
        consecutive: 2,
        attempts: 2,
        updatedAt: 1,
      });
      seedTarget(h.database, {
        state: 'settings_patched',
        installation: 'inst-b',
        consecutive: 2,
        attempts: 2,
        updatedAt: 5,
      });
      seedTarget(h.database, {
        state: 'smoke_verifying',
        installation: 'inst-a',
        consecutive: 2,
        attempts: 2,
        updatedAt: 9,
      });
      seedTarget(h.database, {
        state: 'stabilizing',
        consecutive: 3,
        attempts: 3,
        notBefore: 50,
        updatedAt: 20,
      });
      h.runBindingSteps();
      seedTarget(h.database, {
        state: 'stabilizing',
        installation: 'inst-late',
        consecutive: 3,
        attempts: 3,
        notBefore: 500,
        updatedAt: 0,
      });
      seedTarget(h.database, {
        state: 'succeeded',
        installation: 'inst-done',
        consecutive: 3,
        attempts: 4,
      });
      const order: string[] = [];
      h.smoke.mockImplementation(async (input) => {
        const value = input as {
          operationId: string;
          installationId: string;
          expectedVersionId: string;
          resources: unknown[];
        };
        order.push(value.installationId);
        return {
          operationId: value.operationId,
          installationId: value.installationId,
          observedVersionId: value.expectedVersionId,
          resourceCount: value.resources.length,
        };
      });
      const result = await h.reconciler().reconcile(10);
      expect(result.attempted).toBe(4);
      expect(order).toEqual([INSTALLATION_ID, 'inst-a', 'inst-c', 'inst-b']);
      expect(result).toMatchObject({ succeeded: 1, deferred: 3 });
    });

    it.each([
      [0, 1],
      [-5, 1],
      [2.9, 2],
      [100, 3],
    ])('clamps the limit %s to %s targets', async (limit, expected) => {
      for (const installation of [INSTALLATION_ID, 'inst-b', 'inst-c']) {
        seedTarget(h.database, {
          state: 'settings_patched',
          installation,
          consecutive: 3,
          attempts: 3,
        });
      }
      expect((await h.reconciler().reconcile(limit)).attempted).toBe(expected);
    });

    it('lists a rollback-required target and leaves operations that are not runnable', async () => {
      seedTarget(h.database, { state: 'rollback_required' });
      expect(await h.reconciler({ mutation: false }).reconcile()).toEqual({
        attempted: 1,
        succeeded: 0,
        deferred: 1,
        blocked: 0,
      });
      expect(h.api.listWorkerDeployments).not.toHaveBeenCalled();
      h.database.exec(
        "UPDATE control_operations SET status = 'waiting_retry', next_attempt_at = 101"
      );
      expect(await h.reconciler().reconcile()).toMatchObject({ attempted: 0 });
      h.database.exec('UPDATE control_operations SET next_attempt_at = 100');
      expect(await h.reconciler({ mutation: false }).reconcile()).toMatchObject({ attempted: 1 });
      h.database.exec("UPDATE control_operations SET status = 'blocked', next_attempt_at = NULL");
      expect(await h.reconciler().reconcile()).toMatchObject({ attempted: 0 });
    });
  });

  describe('rollback', () => {
    const restore = {
      compatibility_date: '2026-08-01',
      bindings: [{ name: 'PLUGIN_LOADER', type: 'inherit', version_id: 'version-old' }],
    };

    function rollbackTarget(overrides: Parameters<typeof seedTarget>[1] = {}) {
      seedTarget(h.database, {
        state: 'rollback_required',
        restore: JSON.stringify(restore),
        ...overrides,
      });
      h.api.listWorkerDeployments.mockResolvedValue([newDeployment, oldDeployment]);
    }

    it('restores the previous settings and marks the target rolled back', async () => {
      rollbackTarget();
      h.api.patchWorkerSettings.mockResolvedValue({});
      h.api.getWorkerSettings.mockResolvedValue({
        compatibility_date: '2026-08-01',
        bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }],
      });
      expect(await h.reconciler().reconcile()).toEqual({
        attempted: 1,
        succeeded: 0,
        deferred: 0,
        blocked: 1,
      });
      expect(h.api.patchWorkerSettings).toHaveBeenCalledWith('test-ar-plugin-runner', restore);
      expect(h.recon()).toMatchObject({
        state: 'rolled_back',
        last_error_code: 'plugin_resource_binding_rolled_back',
      });
      expect(h.operation()).toEqual({
        status: 'blocked',
        next_attempt_at: null,
        last_error_code: 'plugin_resource_binding_rolled_back',
        last_error_redacted: 'plugin_resource_binding_rolled_back',
      });
      expect(h.leases()).toEqual([]);
    });

    it('blocks when the planned bindings are still reflected after the restore', async () => {
      rollbackTarget();
      h.api.getWorkerSettings.mockResolvedValue({
        compatibility_date: '2026-08-01',
        bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }, ...planBindings()],
      });
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        state: 'blocked',
        last_error_code: 'plugin_resource_binding_rollback_failed',
      });
    });

    it('blocks when the reflected settings do not match the restore intent', async () => {
      rollbackTarget();
      h.api.patchWorkerSettings.mockResolvedValue({});
      h.api.getWorkerSettings.mockResolvedValue({ compatibility_date: '2026-08-01', bindings: [] });
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        state: 'blocked',
        last_error_code: 'plugin_resource_binding_rollback_failed',
      });
    });

    it.each([
      ['a missing patch version', { patchVersion: null }],
      ['a missing patch deployment', { patchDeployment: null }],
      ['a different patch version', { patchVersion: 'version-x' }],
      ['a different patch deployment', { patchDeployment: 'deployment-x' }],
    ])('blocks rollback on %s', async (_label, overrides) => {
      rollbackTarget(overrides);
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        state: 'blocked',
        last_error_code: 'plugin_resource_binding_newer_deployment_detected',
      });
      expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('defers rollback when the lease expired before the restore', async () => {
      rollbackTarget();
      const times = [100, 100, 100_000];
      let index = 0;
      const clocked = new PluginResourceBindingReconciler(
        d1(h.database),
        h.api,
        controlEnv(d1(h.database), h.smoke),
        () => times[Math.min(index++, times.length - 1)] ?? 0
      );
      expect(await clocked.reconcile()).toMatchObject({ deferred: 1, blocked: 0 });
      expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('blocks a restore whose stored settings are not an object', async () => {
      rollbackTarget({ restore: '[]' });
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        last_error_code: 'plugin_resource_binding_restore_invalid',
      });
    });
  });

  it('blocks with the prerequisite code when only the binding steps are not running', async () => {
    seedTarget(h.database, { state: 'stabilizing', consecutive: 3, attempts: 3, notBefore: 130 });
    h.now = 140;
    expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
    expect(h.recon()).toMatchObject({
      last_error_code: 'plugin_resource_binding_activation_prerequisite_invalid',
    });
  });

  it('blocks with the prerequisite code when only the installation has an unready extra resource', async () => {
    seedTarget(h.database, { state: 'stabilizing', consecutive: 3, attempts: 3, notBefore: 130 });
    h.runBindingSteps();
    h.now = 140;
    h.database.exec(
      `INSERT INTO control_plugin_desired_resources (plugin_resource_id, environment_id, operation_id,
         plugin_installation_id, tenant_id, resource_kind, logical_resource_id, binding_name,
         lifecycle_mode, provider_resource_id, provider_name, injection_policy_json,
         desired_spec_json, status, updated_at)
       VALUES ('extra', 'test', '${OPERATION_ID}', '${INSTALLATION_ID}', 'tenant-a', 'kv_namespace',
         'extra', 'EXTRA', 'existing', 'x', 'x', '{}', '{}', 'pending', 1)`
    );
    expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
    expect(h.recon()).toMatchObject({
      last_error_code: 'plugin_resource_binding_activation_prerequisite_invalid',
    });
  });

  it('defers the stabilization when the lease expires before the final smoke', async () => {
    seedTarget(h.database, { state: 'stabilizing', consecutive: 3, attempts: 3, notBefore: 130 });
    h.runBindingSteps();
    const times = [140, 140, 100_000];
    let index = 0;
    const clocked = new PluginResourceBindingReconciler(
      d1(h.database),
      h.api,
      controlEnv(d1(h.database), h.smoke),
      () => times[Math.min(index++, times.length - 1)] ?? 0
    );
    expect(await clocked.reconcile()).toMatchObject({ deferred: 1, succeeded: 0 });
    expect(h.operation()).toMatchObject({
      last_error_code: 'control_worker_deployment_lease_lost',
    });
    expect(h.smoke).not.toHaveBeenCalled();
  });

  it.each(['settings_patched', 'smoke_verifying', 'stabilizing'])(
    'never asks the provider for deployments while a %s target is verified',
    async (state) => {
      seedTarget(h.database, { state, consecutive: 3, attempts: 3, notBefore: 100 });
      h.runBindingSteps();
      await h.reconciler().reconcile();
      expect(h.api.listWorkerDeployments).not.toHaveBeenCalled();
      expect(h.api.getWorkerSettings).not.toHaveBeenCalled();
      expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
    }
  );

  it('runs the smoke series even when provider mutation is disabled', async () => {
    seedTarget(h.database, { state: 'settings_patched', consecutive: 2, attempts: 2 });
    expect(await h.reconciler({ mutation: false }).reconcile()).toMatchObject({ deferred: 1 });
    expect(h.smoke).toHaveBeenCalledTimes(1);
  });

  it('stamps the default clock as whole seconds', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_900_000_000_999));
      seedTarget(h.database);
      const reconciler = new PluginResourceBindingReconciler(
        d1(h.database),
        h.api,
        controlEnv(d1(h.database), null)
      );
      expect(await reconciler.reconcile()).toMatchObject({ deferred: 1 });
      expect(h.operation()).toMatchObject({ next_attempt_at: 1_900_000_015 });
    } finally {
      vi.useRealTimers();
    }
  });
});
