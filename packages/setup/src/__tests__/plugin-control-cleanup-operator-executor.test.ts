import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudflareControlApiClient,
  CloudflareD1Query,
} from '@authrim/ar-lib-core/control-plane';
import { executeSetupPluginCleanupOperator } from '../core/plugin-control-cleanup-operator-executor.js';
import type { PendingPluginControlCleanupOperation } from '../core/control-operator-operations.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FINGERPRINT = 'a'.repeat(64);
type SqlValue = string | number | null | Uint8Array;

function queryResult(sql: string, statement: StatementSync, params: readonly unknown[] = []) {
  const values = params as SqlValue[];
  if (/^\s*(SELECT|WITH|PRAGMA)/iu.test(sql) || /\bRETURNING\b/iu.test(sql)) {
    return { success: true, results: statement.all(...values), meta: { changes: 0 } };
  }
  const result = statement.run(...values);
  return { success: true, results: [], meta: { changes: Number(result.changes) } };
}

function notFound(): Error & { status: number } {
  return Object.assign(new Error('not_found'), { status: 404 });
}

describe('setup plugin cleanup operator executor', () => {
  let database: DatabaseSync;
  let managedD1: { uuid: string; name: string } | null;
  const deleteD1 = vi.fn();
  const deleteKv = vi.fn();

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    managedD1 = { uuid: 'managed-d1-id', name: 'managed-d1-name' };
    deleteD1.mockReset().mockImplementation(async () => {
      managedD1 = null;
    });
    deleteKv.mockReset();
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES (
        'source-op', 'test', 'provision_plugin_resources', 'source-op', 'canceled',
        'admin', 1, 1, 1, 1
      );
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, last_error_code, last_error_redacted,
        created_at, updated_at
      ) VALUES (
        'cleanup-op', 'test', 'cleanup_plugin_resources', 'cleanup-op', 'blocked',
        'admin', 0, 'operator_action_required', 'operator_action_required', 100, 100
      );
      INSERT INTO control_plugin_desired_resources (
        plugin_resource_id, environment_id, operation_id, plugin_installation_id,
        tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
        provider_resource_id, provider_name, injection_policy_json, desired_spec_json,
        status, updated_at, lifecycle_generation
      ) VALUES
        ('managed-resource', 'test', 'source-op', 'installation-a', 'tenant-a', 'd1',
         'state', 'PLUGIN_STATE', 'managed', 'managed-d1-id', 'managed-d1-name', '{}',
         '${JSON.stringify({
           ownershipFingerprint: FINGERPRINT,
           ownership: 'authrim_managed',
           deleteProviderResource: true,
         })}', 'active', 100, 1),
        ('existing-resource', 'test', 'source-op', 'installation-a', 'tenant-a',
         'kv_namespace', 'cache', 'PLUGIN_CACHE', 'existing', 'external-kv-id',
         'external-kv-name', '{}',
         '${JSON.stringify({
           ownershipFingerprint: 'b'.repeat(64),
           ownership: 'external_reference',
           deleteProviderResource: false,
         })}', 'active', 100, 1);
      INSERT INTO control_plugin_resource_cleanup_operations (
        operation_id, environment_id, plugin_installation_id, tenant_id, plugin_id,
        source_operation_id, lifecycle_generation, reason, state, worker_script_name,
        binding_names_json, binding_presence_required, created_at, updated_at
      ) VALUES (
        'cleanup-op', 'test', 'installation-a', 'tenant-a', 'plugin-a', 'source-op', 1,
        'canceled_pre_activation', 'requested', NULL, '[]', 0, 100, 100
      );
      INSERT INTO control_plugin_resource_cleanup_items (
        operation_id, plugin_resource_id, resource_kind, lifecycle_mode,
        provider_resource_id, provider_name, ownership_fingerprint,
        delete_provider_resource, state, updated_at
      ) VALUES
        ('cleanup-op', 'managed-resource', 'd1', 'managed', 'managed-d1-id',
         'managed-d1-name', '${FINGERPRINT}', 1, 'pending', 100),
        ('cleanup-op', 'existing-resource', 'kv_namespace', 'existing', 'external-kv-id',
         'external-kv-name', '${'b'.repeat(64)}', 0, 'pending', 100);
      INSERT INTO control_operation_steps (
        operation_id, step_key, display_order, status, last_error_code,
        last_error_redacted, updated_at
      ) VALUES
        ('cleanup-op', 'remove_plugin_resource_bindings', 10, 'blocked',
         'operator_action_required', 'operator_action_required', 100),
        ('cleanup-op', 'plugin_resource_quarantine_drain', 20, 'queued', NULL, NULL, 100),
        ('cleanup-op', 'delete_managed_plugin_resources', 30, 'queued', NULL, NULL, 100);
    `);
  });

  afterEach(() => database.close());

  function apiClient(): CloudflareControlApiClient {
    const value = {
      async queryD1(_databaseId: string, sql: string, params: unknown[] = []) {
        return [queryResult(sql, database.prepare(sql), params)];
      },
      async queryD1Batch(_databaseId: string, queries: readonly CloudflareD1Query[]) {
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = queries.map((query) =>
            queryResult(query.sql, database.prepare(query.sql), query.params ?? [])
          );
          database.exec('COMMIT');
          return result;
        } catch (error) {
          if (database.isTransaction) database.exec('ROLLBACK');
          throw error;
        }
      },
      async getD1Database() {
        if (!managedD1) throw notFound();
        return managedD1;
      },
      deleteD1Database: deleteD1,
      listKvNamespaces: vi.fn(async () => [{ id: 'external-kv-id', title: 'external-kv-name' }]),
      deleteKvNamespace: deleteKv,
      listR2Buckets: vi.fn(async () => []),
      deleteR2Bucket: vi.fn(),
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
    };
    return value as unknown as CloudflareControlApiClient;
  }

  function operation(overrides: Partial<PendingPluginControlCleanupOperation> = {}) {
    return {
      operationId: 'cleanup-op',
      environmentId: 'test',
      operationKind: 'cleanup_plugin_resources',
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
      attemptCount: 0,
      createdAt: 100,
      updatedAt: 100,
      pluginInstallationId: 'installation-a',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      sourceOperationId: 'source-op',
      lifecycleGeneration: 1,
      reason: 'canceled_pre_activation',
      state: 'requested',
      workerScriptName: null,
      bindingNames: [],
      bindingPresenceRequired: false,
      drainNotBefore: null,
      currentStep: 'binding',
      resources: [
        {
          pluginResourceId: 'managed-resource',
          kind: 'd1',
          lifecycleMode: 'managed',
          providerResourceId: 'managed-d1-id',
          providerName: 'managed-d1-name',
          ownershipFingerprint: FINGERPRINT,
          deleteProviderResource: true,
          state: 'pending',
        },
        {
          pluginResourceId: 'existing-resource',
          kind: 'kv_namespace',
          lifecycleMode: 'existing',
          providerResourceId: 'external-kv-id',
          providerName: 'external-kv-name',
          ownershipFingerprint: 'b'.repeat(64),
          deleteProviderResource: false,
          state: 'pending',
        },
      ],
      ...overrides,
    } satisfies PendingPluginControlCleanupOperation;
  }

  it('uses the canonical quarantine, deletes managed resources, and detaches existing ones', async () => {
    const client = apiClient();
    await expect(
      executeSetupPluginCleanupOperator({
        controlDatabaseId: 'control-id',
        operation: operation(),
        client,
        executionId: 'test-a',
        now: () => 100,
      })
    ).resolves.toEqual({
      operationId: 'cleanup-op',
      state: 'awaiting_quarantine',
      errorCode: null,
      nextAttemptAt: 1900,
    });
    expect(deleteD1).not.toHaveBeenCalled();

    await expect(
      executeSetupPluginCleanupOperator({
        controlDatabaseId: 'control-id',
        operation: operation({
          state: 'quarantined',
          currentStep: 'quarantine',
          drainNotBefore: 1900,
          resources: operation().resources.map((item) => ({ ...item, state: 'quarantined' })),
        }),
        client,
        executionId: 'test-waiting',
        now: () => 1000,
      })
    ).resolves.toEqual({
      operationId: 'cleanup-op',
      state: 'awaiting_quarantine',
      errorCode: null,
      nextAttemptAt: 1900,
    });
    expect(
      database
        .prepare(
          `SELECT status, next_attempt_at, last_error_code
             FROM control_operations WHERE operation_id = 'cleanup-op'`
        )
        .get()
    ).toEqual({
      status: 'blocked',
      next_attempt_at: 1900,
      last_error_code: 'operator_action_required',
    });
    expect(
      database
        .prepare(
          `SELECT status, next_attempt_at, last_error_code
             FROM control_operation_steps
            WHERE operation_id = 'cleanup-op'
              AND step_key = 'plugin_resource_quarantine_drain'`
        )
        .get()
    ).toEqual({
      status: 'blocked',
      next_attempt_at: 1900,
      last_error_code: 'operator_action_required',
    });
    expect(deleteD1).not.toHaveBeenCalled();

    await expect(
      executeSetupPluginCleanupOperator({
        controlDatabaseId: 'control-id',
        operation: operation({
          state: 'quarantined',
          currentStep: 'quarantine',
          drainNotBefore: 1900,
          resources: operation().resources.map((item) => ({ ...item, state: 'quarantined' })),
        }),
        client,
        executionId: 'test-b',
        now: () => 1900,
      })
    ).resolves.toMatchObject({ state: 'succeeded' });

    expect(deleteD1).toHaveBeenCalledWith('managed-d1-id');
    expect(deleteKv).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `SELECT lifecycle_mode, state FROM control_plugin_resource_cleanup_items
            ORDER BY lifecycle_mode`
        )
        .all()
    ).toEqual([
      { lifecycle_mode: 'existing', state: 'detached' },
      { lifecycle_mode: 'managed', state: 'deleted' },
    ]);
    expect(
      database
        .prepare(`SELECT status FROM control_operations WHERE operation_id = 'cleanup-op'`)
        .get()
    ).toEqual({ status: 'succeeded' });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM control_plugin_desired_resources').get()
    ).toEqual({ count: 0 });
  });

  it('returns and persists only stable codes when a provider error contains a secret', async () => {
    const client = apiClient();
    await executeSetupPluginCleanupOperator({
      controlDatabaseId: 'control-id',
      operation: operation(),
      client,
      executionId: 'test-a',
      now: () => 100,
    });
    deleteD1.mockRejectedValueOnce(new Error('provider sk_live_unexpected_secret'));

    await expect(
      executeSetupPluginCleanupOperator({
        controlDatabaseId: 'control-id',
        operation: operation({
          state: 'quarantined',
          currentStep: 'quarantine',
          drainNotBefore: 1900,
          resources: operation().resources.map((item) => ({ ...item, state: 'quarantined' })),
        }),
        client,
        executionId: 'test-b',
        now: () => 1900,
      })
    ).rejects.toThrow('control_plugin_cleanup_operator_provider_failed');

    expect(
      JSON.stringify(database.prepare('SELECT * FROM control_operations').all())
    ).not.toContain('sk_live_unexpected_secret');
    expect(
      database
        .prepare(
          `SELECT status, last_error_code FROM control_operations WHERE operation_id = 'cleanup-op'`
        )
        .get()
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required' });
  });
});
