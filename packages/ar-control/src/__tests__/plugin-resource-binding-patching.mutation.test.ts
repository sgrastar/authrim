import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudflareControlApiError } from '@authrim/ar-lib-core/control-plane';
import { BindingHarness } from './support/plugin-binding-harness';
import {
  OPERATION_ID,
  newDeployment,
  oldDeployment,
  planBindings,
  seedTarget,
} from './support/plugin-binding-fixtures';

const h = new BindingHarness();
const loader = { name: 'PLUGIN_LOADER', type: 'worker_loader' };
const bare = { compatibility_date: '2026-08-01', bindings: [loader] };
const bound = { compatibility_date: '2026-08-01', bindings: [loader, ...planBindings()] };
const recon = () =>
  h.database
    .prepare(
      `SELECT state, last_error_code, expected_source_version_id AS expected,
              previous_deployment_id AS previous, patch_result_version_id AS patch_version,
              patch_result_deployment_id AS patch_deployment, previous_restore_settings_json AS restore
         FROM control_plugin_resource_binding_reconciliations`
    )
    .get() as Record<string, string | null>;
const lease = () =>
  h.database
    .prepare(
      `SELECT fencing_token, mutation_started, mutation_started_at, previous_deployment_id AS previous,
              patch_result_version_id AS patch_version, patch_result_deployment_id AS patch_deployment,
              expected_source_version_id AS expected FROM control_worker_deployment_leases`
    )
    .get();

describe('plugin resource binding settings patch', () => {
  beforeEach(() => {
    h.reset();
    seedTarget(h.database);
  });
  afterEach(() => h.close());

  it('patches, records the provider result and proceeds to the smoke series', async () => {
    h.api.listWorkerDeployments
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([newDeployment, oldDeployment]);
    h.api.getWorkerSettings.mockResolvedValueOnce(bare).mockResolvedValueOnce(bound);
    expect(await h.reconciler().reconcile()).toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(h.api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(h.api.patchWorkerSettings.mock.calls[0]?.[0]).toBe('test-ar-plugin-runner');
    expect(h.smoke).toHaveBeenCalledTimes(3);
    const row = recon();
    expect(row).toMatchObject({
      state: 'stabilizing',
      last_error_code: null,
      expected: 'version-old',
      previous: 'deployment-old',
      patch_version: 'version-new',
      patch_deployment: 'deployment-new',
    });
    expect(JSON.parse(row.restore ?? 'null')).toMatchObject({
      compatibility_date: '2026-08-01',
      bindings: [{ name: 'PLUGIN_LOADER', type: 'inherit' }],
    });
    expect(lease()).toMatchObject({
      mutation_started: 1,
      mutation_started_at: 100,
      previous: 'deployment-old',
      patch_version: 'version-new',
      patch_deployment: 'deployment-new',
      expected: 'version-old',
    });
  });

  it('adopts settings that already contain the planned bindings without patching', async () => {
    h.api.getWorkerSettings.mockResolvedValue(bound);
    expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1, blocked: 0 });
    expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(recon()).toMatchObject({
      state: 'stabilizing',
      expected: 'version-old',
      previous: 'deployment-old',
      patch_version: 'version-old',
      patch_deployment: 'deployment-old',
      restore: JSON.stringify(bound),
    });
    expect(lease()).toMatchObject({ mutation_started: 0, mutation_started_at: null });
  });

  it('leaves all state untouched when the lease vanishes before an already-satisfied result is recorded', async () => {
    h.api.getWorkerSettings.mockImplementation(async () => {
      h.database.exec('DELETE FROM control_worker_deployment_leases');
      return bound;
    });
    expect(await h.reconciler().reconcile()).toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(h.operation()).toMatchObject({ status: 'running', last_error_code: null });
    expect(recon()).toMatchObject({ state: 'pending', last_error_code: null });
  });

  it('leaves all state untouched when the lease vanishes before the patch intent is recorded', async () => {
    h.api.getWorkerSettings.mockImplementation(async () => {
      h.database.exec('DELETE FROM control_worker_deployment_leases');
      return bare;
    });
    expect(await h.reconciler().reconcile()).toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(h.operation()).toMatchObject({ status: 'running', last_error_code: null });
    expect(recon()).toMatchObject({ state: 'pending', last_error_code: null });
    expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('leaves all state untouched when the lease vanishes during the patch call', async () => {
    h.api.getWorkerSettings.mockResolvedValue(bare);
    h.api.listWorkerDeployments.mockResolvedValue([newDeployment, oldDeployment]);
    h.api.listWorkerDeployments
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([oldDeployment]);
    h.api.patchWorkerSettings.mockImplementation(async () => {
      h.database.exec('DELETE FROM control_worker_deployment_leases');
      return {};
    });
    expect(await h.reconciler().reconcile()).toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(h.operation()).toMatchObject({ status: 'running', last_error_code: null });
    expect(recon()).toMatchObject({ state: 'pending', last_error_code: null });
  });

  it('defers while the provider still reports the source version after the patch', async () => {
    h.api.getWorkerSettings.mockResolvedValue(bare);
    expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1, blocked: 0 });
    expect(h.api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(h.operation()).toEqual({
      status: 'waiting_retry',
      next_attempt_at: 115,
      last_error_code: 'control_worker_patch_propagating',
      last_error_redacted: 'control_worker_patch_propagating',
    });
    expect(lease()).toMatchObject({ mutation_started: 1, mutation_started_at: 100 });
  });

  it('keeps the persisted patch intent when the provider rejects with a server error', async () => {
    h.api.getWorkerSettings.mockResolvedValue(bare);
    h.api.patchWorkerSettings.mockRejectedValue(
      new CloudflareControlApiError('workers.deployment.list', 503)
    );
    expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1, blocked: 0 });
    expect(h.operation()).toMatchObject({
      status: 'waiting_retry',
      last_error_code: 'plugin_resource_binding_provider_failed',
    });
    expect(lease()).toMatchObject({ mutation_started: 1 });
  });

  it('defers when the runner has no active deployment', async () => {
    h.api.listWorkerDeployments.mockResolvedValue([]);
    expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1 });
    expect(h.operation()).toMatchObject({
      last_error_code: 'control_worker_active_deployment_missing',
    });
  });

  it('requests a rollback when the patched settings drop a planned binding', async () => {
    h.api.listWorkerDeployments
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([newDeployment, oldDeployment]);
    h.api.getWorkerSettings.mockResolvedValueOnce(bare).mockResolvedValueOnce(bare);
    expect(await h.reconciler().reconcile()).toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(recon()).toMatchObject({
      state: 'rollback_required',
      last_error_code: 'control_worker_settings_preservation_failed',
      patch_version: 'version-new',
      patch_deployment: 'deployment-new',
    });
    expect(h.smoke).not.toHaveBeenCalled();

    // The next pass restores the saved settings and records the rollback.
    h.api.listWorkerDeployments.mockResolvedValue([newDeployment, oldDeployment]);
    h.api.getWorkerSettings.mockResolvedValue(bare);
    expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
    const restored = h.api.patchWorkerSettings.mock.calls.at(-1)?.[1];
    expect(restored).toMatchObject({ bindings: [{ name: 'PLUGIN_LOADER', type: 'inherit' }] });
    expect(recon()).toMatchObject({
      state: 'rolled_back',
      last_error_code: 'plugin_resource_binding_rolled_back',
    });
  });

  describe('a patch whose response was lost', () => {
    const restore = JSON.stringify({
      compatibility_date: '2026-08-01',
      bindings: [{ name: 'PLUGIN_LOADER', type: 'inherit', version_id: 'version-old' }],
    });

    function startedLease(startedAt: number, extra = '') {
      h.takeLease(OPERATION_ID, 5000);
      h.database.exec(
        `UPDATE control_worker_deployment_leases SET mutation_started = 1,
           mutation_started_at = ${startedAt}, previous_deployment_id = 'deployment-old',
           expected_source_version_id = 'version-old'${extra}`
      );
      h.database.exec(
        `UPDATE control_plugin_resource_binding_reconciliations SET previous_restore_settings_json = '${restore}',
           expected_source_version_id = 'version-old', previous_deployment_id = 'deployment-old'`
      );
    }

    it('re-arms the intent once the propagation grace has passed', async () => {
      startedLease(40);
      h.api.getWorkerSettings.mockResolvedValue(bare);
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1, blocked: 0 });
      expect(lease()).toMatchObject({
        mutation_started: 0,
        mutation_started_at: null,
        previous: null,
      });
      expect(h.operation()).toMatchObject({ status: 'running', last_error_code: null });
      expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('keeps waiting inside the propagation grace', async () => {
      startedLease(41);
      h.api.getWorkerSettings.mockResolvedValue(bare);
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1 });
      expect(lease()).toMatchObject({ mutation_started: 1, mutation_started_at: 41 });
      expect(h.operation()).toEqual({
        status: 'waiting_retry',
        next_attempt_at: 115,
        last_error_code: 'control_worker_patch_propagating',
        last_error_redacted: 'control_worker_patch_propagating',
      });
    });

    it('waits until the grace deadline when it is later than the retry delay', async () => {
      startedLease(90);
      h.api.getWorkerSettings.mockResolvedValue(bare);
      await h.reconciler().reconcile();
      expect(h.operation()).toMatchObject({ next_attempt_at: 150 });
    });

    it('defers with a lost lease when the intent can no longer be re-armed', async () => {
      startedLease(40, ", patch_result_version_id = 'version-new'");
      h.api.getWorkerSettings.mockResolvedValue(bare);
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1 });
      expect(h.operation()).toMatchObject({
        last_error_code: 'control_worker_deployment_lease_lost',
      });
    });

    it('blocks when the previous deployment is not directly behind the active one', async () => {
      startedLease(40);
      h.database.exec(
        "UPDATE control_worker_deployment_leases SET previous_deployment_id = 'deployment-unknown'"
      );
      h.api.listWorkerDeployments.mockResolvedValue([newDeployment, oldDeployment]);
      h.api.getWorkerSettings.mockResolvedValue(bound);
      expect(await h.reconciler().reconcile()).toMatchObject({ attempted: 1 });
      expect(recon()).toMatchObject({
        last_error_code: 'control_worker_concurrent_deployment_detected',
      });
    });

    it('requests a rollback when the adopted deployment lost the saved settings', async () => {
      startedLease(40);
      h.api.listWorkerDeployments.mockResolvedValue([newDeployment, oldDeployment]);
      h.api.getWorkerSettings.mockResolvedValue({ compatibility_date: '2026-08-01', bindings: [] });
      expect(await h.reconciler().reconcile()).toMatchObject({ attempted: 1 });
      expect(recon()).toMatchObject({
        state: 'rollback_required',
        patch_version: 'version-new',
        last_error_code: 'control_worker_settings_preservation_failed',
      });
    });
  });

  it('does not overwrite a newer run that advanced the reconciliation to rollback', async () => {
    h.api.getWorkerSettings.mockImplementation(async () => {
      h.database.exec(
        `UPDATE control_plugin_resource_binding_reconciliations
            SET state = 'rollback_required', expected_source_version_id = 'x',
                previous_restore_settings_json = '{}'`
      );
      return bare;
    });
    expect(await h.reconciler().reconcile()).toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(recon()).toMatchObject({ state: 'rollback_required', last_error_code: null });
    expect(h.operation()).toMatchObject({ status: 'running', last_error_code: null });
    expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer run when the fence is lost after the patch', async () => {
    h.api.getWorkerSettings.mockResolvedValue(bare);
    h.api.listWorkerDeployments
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([oldDeployment])
      .mockResolvedValueOnce([newDeployment, oldDeployment]);
    h.api.patchWorkerSettings.mockImplementation(async () => {
      h.database.exec(
        `UPDATE control_plugin_resource_binding_reconciliations SET state = 'rollback_required'`
      );
      return {};
    });
    expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1, blocked: 0 });
    expect(recon()).toMatchObject({ state: 'rollback_required', last_error_code: null });
    expect(h.operation()).toMatchObject({ status: 'running', last_error_code: null });
  });

  it('refuses to block with a lease token that a newer run has already replaced', async () => {
    h.api.getWorkerSettings.mockResolvedValue(bare);
    h.api.listWorkerDeployments.mockResolvedValue([oldDeployment]);
    h.api.patchWorkerSettings.mockImplementation(async () => {
      // A newer run takes over the lease while this one is still inside the patch call.
      h.database.exec(
        `UPDATE control_worker_deployment_leases SET fencing_token = fencing_token + 1`
      );
      throw new Error('worker_settings_binding_0_type_required');
    });
    await h.reconciler().reconcile();
    expect(h.operation()).toMatchObject({ status: 'running' });
    expect(recon()).toMatchObject({ state: 'pending' });
  });
});
