import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudflareControlApiError } from '@authrim/ar-lib-core/control-plane';
import { BoundedServiceBindingInvocationBudget } from '../service-binding-invocation-budget';
import { BindingHarness } from './support/plugin-binding-harness';
import {
  INSTALLATION_ID,
  OPERATION_ID,
  mapJson,
  seedTarget,
} from './support/plugin-binding-fixtures';

const h = new BindingHarness();

describe('plugin resource binding classification, leases and smoke series', () => {
  beforeEach(() => h.reset());
  afterEach(() => h.close());

  describe('error classification', () => {
    const cases: [string, unknown, 'blocked' | 'deferred', string][] = [
      [
        'a 401 provider response',
        new CloudflareControlApiError('workers.deployment.list', 401),
        'blocked',
        'control_workers_capability_rejected',
      ],
      [
        'a 403 provider response',
        new CloudflareControlApiError('workers.deployment.list', 403),
        'blocked',
        'control_workers_capability_rejected',
      ],
      [
        'a 400 provider response',
        new CloudflareControlApiError('workers.deployment.list', 400),
        'blocked',
        'plugin_resource_binding_provider_rejected',
      ],
      [
        'a 499 provider response',
        new CloudflareControlApiError('workers.deployment.list', 499),
        'blocked',
        'plugin_resource_binding_provider_rejected',
      ],
      [
        'a 408 provider response',
        new CloudflareControlApiError('workers.deployment.list', 408),
        'deferred',
        'plugin_resource_binding_provider_failed',
      ],
      [
        'a 429 provider response',
        new CloudflareControlApiError('workers.deployment.list', 429),
        'deferred',
        'plugin_resource_binding_provider_failed',
      ],
      [
        'a 500 provider response',
        new CloudflareControlApiError('workers.deployment.list', 500),
        'deferred',
        'plugin_resource_binding_provider_failed',
      ],
      [
        'a 399 provider response',
        new CloudflareControlApiError('workers.deployment.list', 399),
        'deferred',
        'plugin_resource_binding_provider_failed',
      ],
      [
        'a plugin binding error',
        new Error('plugin_resource_binding_plan_invalid'),
        'blocked',
        'plugin_resource_binding_plan_invalid',
      ],
      [
        'an unlisted plugin binding message',
        new Error('plugin_resource_binding_custom secret=abc'),
        'blocked',
        'plugin_resource_binding_reconciliation_failed',
      ],
      [
        'a smoke unavailable error',
        new Error('plugin_resource_binding_smoke_unavailable'),
        'deferred',
        'plugin_resource_binding_smoke_unavailable',
      ],
      [
        'a smoke failed error',
        new Error('plugin_resource_binding_smoke_failed'),
        'deferred',
        'plugin_resource_binding_smoke_failed',
      ],
      [
        'a settings binding error',
        new Error('worker_settings_binding_invalid:x'),
        'blocked',
        'worker_settings_binding_invalid',
      ],
      [
        'an oversized settings error',
        new Error('worker_settings_payload_too_large:9'),
        'blocked',
        'worker_settings_payload_too_large',
      ],
      [
        'an ambiguous deployment',
        new Error('control_worker_active_deployment_ambiguous'),
        'blocked',
        'control_worker_active_deployment_ambiguous',
      ],
      [
        'a concurrent deployment',
        new Error('control_worker_concurrent_deployment_detected'),
        'blocked',
        'control_worker_concurrent_deployment_detected',
      ],
      [
        'an unknown error',
        new Error('network_down'),
        'deferred',
        'plugin_resource_binding_reconciliation_failed',
      ],
      [
        'an error carrying storage text',
        new Error("CHECK constraint failed: state IN ('pending')"),
        'deferred',
        'plugin_resource_binding_reconciliation_failed',
      ],
      [
        'an internal control code',
        new Error('control_worker_patch_propagating'),
        'deferred',
        'control_worker_patch_propagating',
      ],
      [
        'an uppercase control-like message',
        new Error('control_Secret_sk_live_123'),
        'deferred',
        'plugin_resource_binding_reconciliation_failed',
      ],
      [
        'an empty error',
        new Error(''),
        'deferred',
        'plugin_resource_binding_reconciliation_failed',
      ],
      ['a thrown string', 'oops', 'deferred', 'plugin_resource_binding_reconciliation_failed'],
    ];

    it.each(cases)('classifies %s', async (_label, thrown, outcome, code) => {
      seedTarget(h.database);
      h.api.listWorkerDeployments.mockRejectedValue(thrown);
      const result = await h.reconciler().reconcile();
      expect(result).toEqual({
        attempted: 1,
        succeeded: 0,
        deferred: outcome === 'deferred' ? 1 : 0,
        blocked: outcome === 'blocked' ? 1 : 0,
      });
      expect(h.operation()).toEqual(
        outcome === 'blocked'
          ? {
              status: 'blocked',
              next_attempt_at: null,
              last_error_code: code,
              last_error_redacted: code,
            }
          : {
              status: 'waiting_retry',
              next_attempt_at: 115,
              last_error_code: code,
              last_error_redacted: code,
            }
      );
      expect(h.recon()).toMatchObject({ state: 'pending', last_error_code: code, updated_at: 100 });
      expect(h.leases()).toEqual([]);
    });
  });

  describe('deployment lease', () => {
    it('defers a pending target while another operation holds the lease', async () => {
      seedTarget(h.database);
      h.takeLease('op-other', 1000);
      expect(await h.reconciler().reconcile()).toEqual({
        attempted: 1,
        succeeded: 0,
        deferred: 1,
        blocked: 0,
      });
      expect(h.operation()).toEqual({
        status: 'waiting_retry',
        next_attempt_at: 115,
        last_error_code: 'control_worker_deployment_lease_busy',
        last_error_redacted: 'control_worker_deployment_lease_busy',
      });
      expect(h.api.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('defers a patched target while another operation holds the lease', async () => {
      seedTarget(h.database, { state: 'settings_patched' });
      h.takeLease('op-other', 1000);
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1 });
      expect(h.operation()).toMatchObject({
        status: 'waiting_retry',
        next_attempt_at: 115,
        last_error_code: 'control_worker_deployment_lease_busy',
      });
      expect(h.api.listWorkerDeployments).not.toHaveBeenCalled();
      expect(h.smoke).not.toHaveBeenCalled();
    });

    it('takes over an expired foreign lease with a bumped fencing token', async () => {
      seedTarget(h.database, { state: 'settings_patched', consecutive: 3, attempts: 3 });
      h.takeLease('op-other', 100);
      await h.reconciler().reconcile();
      expect(h.leases()).toEqual([
        expect.objectContaining({
          owner_operation_id: OPERATION_ID,
          fencing_token: 6,
          lease_expires_at: 1000,
          expected_source_version_id: 'version-old',
          mutation_started: 0,
          previous_deployment_id: null,
          patch_result_version_id: null,
        }),
      ]);
    });

    it('reuses the lease already owned by the same operation', async () => {
      seedTarget(h.database, { state: 'settings_patched', consecutive: 3, attempts: 3 });
      h.takeLease(OPERATION_ID, 5000);
      h.database
        .prepare(
          `UPDATE control_worker_deployment_leases SET mutation_started = 1, mutation_started_at = 7,
             previous_deployment_id = 'deployment-keep', patch_result_version_id = 'version-keep',
             expected_source_version_id = 'version-held'`
        )
        .run();
      await h.reconciler().reconcile();
      expect(h.leases()).toEqual([
        expect.objectContaining({
          fencing_token: 6,
          lease_expires_at: 1000,
          expected_source_version_id: 'version-held',
          mutation_started: 1,
          mutation_started_at: 7,
          previous_deployment_id: 'deployment-keep',
          patch_result_version_id: 'version-keep',
        }),
      ]);
    });
  });

  describe('smoke series', () => {
    it('runs the remaining smokes and schedules stabilization', async () => {
      seedTarget(h.database, { state: 'settings_patched', attempts: 1, consecutive: 1 });
      expect(await h.reconciler().reconcile()).toEqual({
        attempted: 1,
        succeeded: 0,
        deferred: 1,
        blocked: 0,
      });
      expect(h.smoke).toHaveBeenCalledTimes(2);
      expect(h.smoke.mock.calls[0]?.[0]).toEqual({
        operationId: OPERATION_ID,
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        installationId: INSTALLATION_ID,
        expectedVersionId: 'version-new',
        resources: (JSON.parse(mapJson()) as { resources: unknown[] }).resources,
      });
      expect(h.recon()).toEqual({
        state: 'stabilizing',
        last_error_code: null,
        attempts: 3,
        consecutive: 3,
        not_before: 130,
        updated_at: 100,
      });
      expect(h.leases()).toHaveLength(1);
    });

    it('records an intermediate success as smoke_verifying with no stabilization time', async () => {
      seedTarget(h.database, { state: 'settings_patched' });
      h.smoke.mockImplementationOnce(async (input) => {
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
      const budget = new BoundedServiceBindingInvocationBudget(1);
      expect(await h.reconciler({ budget }).reconcile()).toMatchObject({ deferred: 1 });
      expect(h.smoke).toHaveBeenCalledTimes(1);
      expect(h.recon()).toMatchObject({
        state: 'smoke_verifying',
        attempts: 1,
        consecutive: 1,
        not_before: null,
      });
      expect(h.operation()).toMatchObject({
        status: 'waiting_retry',
        last_error_code: 'control_service_binding_invocation_budget_exhausted',
        next_attempt_at: 115,
      });
      // The budget exhaustion releases the lease so another operation can proceed.
      expect(h.leases()).toEqual([]);
    });

    it('does not release the lease after an ordinary transient smoke failure', async () => {
      seedTarget(h.database, { state: 'settings_patched' });
      h.smoke.mockRejectedValue(new Error('runner_down'));
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1 });
      expect(h.operation()).toMatchObject({
        status: 'waiting_retry',
        last_error_code: 'plugin_resource_binding_smoke_failed',
      });
      expect(h.recon()).toMatchObject({ state: 'settings_patched', attempts: 0, consecutive: 0 });
      expect(h.leases()).toHaveLength(1);
    });

    it.each([
      ['operation id', { operationId: 'other' }],
      ['installation id', { installationId: 'other' }],
      ['observed version', { observedVersionId: 'version-other' }],
      ['resource count', { resourceCount: 2 }],
    ])('blocks when the smoke reports a different %s', async (_label, patch) => {
      seedTarget(h.database, { state: 'settings_patched' });
      h.smoke.mockImplementation(async (input) => {
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
          ...patch,
        };
      });
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1, deferred: 0 });
      expect(h.recon()).toMatchObject({
        state: 'blocked',
        last_error_code: 'plugin_resource_binding_smoke_mismatch',
      });
      expect(h.leases()).toEqual([]);
    });

    it('defers when the lease is lost between smokes', async () => {
      seedTarget(h.database, { state: 'settings_patched' });
      h.smoke.mockImplementation(async (input) => {
        h.database.exec('DELETE FROM control_worker_deployment_leases');
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
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1 });
      expect(h.smoke).toHaveBeenCalledTimes(1);
      expect(h.operation()).toMatchObject({
        last_error_code: 'control_worker_deployment_lease_lost',
      });
    });

    it('leaves state untouched when a concurrent writer advanced the smoke counters', async () => {
      seedTarget(h.database, { state: 'settings_patched' });
      h.smoke.mockImplementation(async (input) => {
        h.database.exec(
          'UPDATE control_plugin_resource_binding_reconciliations SET smoke_attempt_count = 2'
        );
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
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1, blocked: 0 });
      expect(h.recon()).toMatchObject({
        state: 'settings_patched',
        last_error_code: null,
        attempts: 2,
      });
      expect(h.operation()).toMatchObject({ status: 'running', last_error_code: null });
    });

    it('blocks a patched target that lost its patch result version', async () => {
      seedTarget(h.database, { state: 'settings_patched', patchVersion: null });
      expect(await h.reconciler().reconcile()).toMatchObject({ blocked: 1 });
      expect(h.recon()).toMatchObject({
        state: 'blocked',
        last_error_code: 'plugin_resource_binding_patch_result_missing',
      });
    });

    it('does nothing for a patched target when the three successes are already recorded', async () => {
      seedTarget(h.database, { state: 'smoke_verifying', consecutive: 3, attempts: 3 });
      expect(await h.reconciler().reconcile()).toMatchObject({ deferred: 1 });
      expect(h.smoke).not.toHaveBeenCalled();
    });
  });
});
