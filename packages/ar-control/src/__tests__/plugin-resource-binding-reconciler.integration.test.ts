import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareWorkerSettings } from '@authrim/ar-lib-core/control-plane';
import {
  PluginResourceBindingReconciler,
  pluginResourceHostBindingRef,
} from '../plugin-resource-binding-reconciler';
import { handoffPluginResourceOperationsToSetup } from '../plugin-resource-operator-handoff';
import type { ControlEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OPERATION_ID = 'op-plugin-resources-a';
const INSTALLATION_ID = 'installation-a';
const FINGERPRINTS = {
  d1: 'a'.repeat(64),
  kv_namespace: 'b'.repeat(64),
  r2_bucket: 'c'.repeat(64),
};

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]) {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

const oldDeployment = {
  id: 'deployment-old',
  created_on: '2026-08-01T00:00:00.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-old' }],
};

const newDeployment = {
  id: 'deployment-new',
  created_on: '2026-08-01T00:00:01.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-new' }],
};

describe('PluginResourceBindingReconciler', () => {
  let database: DatabaseSync;
  let now: number;
  let smoke: ReturnType<
    typeof vi.fn<
      (input: unknown) => Promise<{
        operationId: string;
        installationId: string;
        observedVersionId: string;
        resourceCount: number;
      }>
    >
  >;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/001_pre_1_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/009_provider_identity_checkpoint.sql'),
        'utf8'
      )
    );
    now = 100;
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
      ) VALUES (
        '${OPERATION_ID}', 'test', 'plugin/plugin-a/state', 'release-a',
        '${'1'.repeat(64)}', 1
      );
    `);
    for (const resource of [
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
    ] as const) {
      const fingerprint = FINGERPRINTS[resource.kind];
      const stepPrefix = `plugin_resource_${fingerprint.slice(0, 20)}`;
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
            capabilityManifestDigest: '9'.repeat(64),
          }),
          resource.kind === 'r2_bucket' ? '2026-08-31T00:00:00.000Z' : null,
          resource.kind === 'r2_bucket' ? '.authrim/ownership/test' : null,
          resource.kind === 'r2_bucket' ? 'ownership-test' : null
        );
      for (const [suffix, order, status] of [
        ['provider', 0, 'succeeded'],
        ['migration', 10, resource.kind === 'd1' ? 'succeeded' : 'skipped'],
        ['binding', 20, 'queued'],
      ] as const) {
        database
          .prepare(
            `INSERT INTO control_operation_steps (
               operation_id, step_key, display_order, status, updated_at
             ) VALUES (?, ?, ?, ?, 1)`
          )
          .run(OPERATION_ID, `${stepPrefix}_${suffix}`, order, status);
      }
      if (resource.kind === 'd1') {
        database
          .prepare(
            `INSERT INTO control_plugin_resource_migration_state (
               plugin_resource_id, environment_id, operation_id, stream_id, release_id,
               manifest_digest, provider_database_id, state, expected_file_count,
               applied_file_count, completed_at, updated_at
             ) VALUES (?, 'test', ?, 'plugin/plugin-a/state', 'release-a', ?, ?,
                       'ready', 1, 1, 1, 1)`
          )
          .run(resource.id, OPERATION_ID, '1'.repeat(64), resource.providerId);
      }
    }
    smoke = vi.fn(async (input: unknown) => {
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
  });

  afterEach(() => database.close());

  function env(): ControlEnv {
    return {
      CONTROL_DB: d1(database),
      MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
      CLOUDFLARE_ACCOUNT_ID: 'account-a',
      SMOKE_AR_PLUGIN_RUNNER: {
        smokeTenantBinding: vi.fn(),
        smokePluginResourceBindings: smoke,
      },
    };
  }

  function reflectedBindings() {
    return [
      {
        name: pluginResourceHostBindingRef('d1', FINGERPRINTS.d1),
        type: 'd1',
        database_id: 'database-a',
      },
      {
        name: pluginResourceHostBindingRef('kv_namespace', FINGERPRINTS.kv_namespace),
        type: 'kv_namespace',
        namespace_id: 'namespace-a',
      },
      {
        name: pluginResourceHostBindingRef('r2_bucket', FINGERPRINTS.r2_bucket),
        type: 'r2_bucket',
        bucket_name: 'bucket-a-name',
      },
    ].sort((left, right) => left.name.localeCompare(right.name));
  }

  it('activates all resources only after three smokes and a delayed final smoke', async () => {
    const bindings = reflectedBindings();
    const api = {
      listWorkerDeployments: vi.fn(async () => [oldDeployment]),
      getWorkerSettings: vi.fn(async () => ({ bindings, compatibility_date: '2026-08-01' })),
      patchWorkerSettings: vi.fn(),
    };
    const reconciler = new PluginResourceBindingReconciler(d1(database), api, env(), () => now);

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(smoke).toHaveBeenCalledTimes(3);
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `SELECT state, consecutive_smoke_successes, stabilization_not_before
             FROM control_plugin_resource_binding_reconciliations`
        )
        .get()
    ).toEqual({
      state: 'stabilizing',
      consecutive_smoke_successes: 3,
      stabilization_not_before: 130,
    });
    expect(
      database.prepare(`SELECT DISTINCT status FROM control_plugin_desired_resources`).all()
    ).toEqual([{ status: 'ready' }]);

    now = 131;
    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 1,
      succeeded: 1,
      deferred: 0,
      blocked: 0,
    });
    expect(smoke).toHaveBeenCalledTimes(4);
    expect(
      database.prepare(`SELECT DISTINCT status FROM control_plugin_desired_resources`).all()
    ).toEqual([{ status: 'active' }]);
    expect(database.prepare(`SELECT status FROM control_operations`).get()).toEqual({
      status: 'succeeded',
    });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_worker_deployment_leases`).get()
    ).toEqual({ count: 0 });
    const serializedSmoke = JSON.stringify(smoke.mock.calls);
    expect(serializedSmoke).not.toContain('database-a');
    expect(serializedSmoke).not.toContain('namespace-a');
    expect(serializedSmoke).not.toContain('bucket-a-name');
  });

  it('blocks an old-writer R2 row that lacks immutable ownership evidence', async () => {
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id,
           tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json,
           desired_spec_json, status, updated_at
         ) VALUES (
           'resource-r2-unverified', 'test', ?, ?, 'tenant-a', 'r2_bucket',
           'legacy-objects', 'PLUGIN_LEGACY_OBJECTS', 'managed',
           'legacy-bucket-name', 'legacy-bucket-name', '{}', ?, 'provisioning', 1
         )`
      )
      .run(
        OPERATION_ID,
        INSTALLATION_ID,
        JSON.stringify({
          pluginId: 'plugin-a',
          binding: 'PLUGIN_LEGACY_OBJECTS',
          kind: 'r2_bucket',
          access: 'read_write',
          ownershipFingerprint: '4'.repeat(64),
          capabilityManifestDigest: '9'.repeat(64),
        })
      );
    const api = {
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
    };
    const reconciler = new PluginResourceBindingReconciler(d1(database), api, env(), () => now);

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      deferred: 0,
      blocked: 0,
    });
    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({
      status: 'blocked',
      last_error_code: 'plugin_resource_provider_checkpoint_invalid',
    });
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('patches D1, KV, and R2 bindings together while preserving existing settings', async () => {
    const bindings = reflectedBindings();
    let listCount = 0;
    const api = {
      listWorkerDeployments: vi.fn(async () => {
        listCount += 1;
        return listCount < 3 ? [oldDeployment] : [newDeployment, oldDeployment];
      }),
      getWorkerSettings: vi
        .fn()
        .mockResolvedValueOnce({
          bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }],
          compatibility_date: '2026-08-01',
          observability: { enabled: true },
        })
        .mockResolvedValueOnce({
          bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }, ...bindings],
          compatibility_date: '2026-08-01',
          observability: { enabled: true },
        }),
      patchWorkerSettings: vi.fn(
        async (_scriptName: string, _settings: CloudflareWorkerSettings) => ({ bindings })
      ),
    };
    const reconciler = new PluginResourceBindingReconciler(d1(database), api, env(), () => now);

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    const patchedSettings = api.patchWorkerSettings.mock.calls[0]?.[1];
    expect(patchedSettings).toMatchObject({
      compatibility_date: '2026-08-01',
      observability: { enabled: true },
    });
    expect(
      patchedSettings?.bindings?.some(
        (binding) => binding.name === 'PLUGIN_LOADER' && binding.type === 'inherit'
      )
    ).toBe(true);
    for (const expectedBinding of bindings) {
      expect(
        patchedSettings?.bindings?.some(
          (binding) => JSON.stringify(binding) === JSON.stringify(expectedBinding)
        )
      ).toBe(true);
    }
    expect(
      database
        .prepare(
          `SELECT state, patch_result_version_id
             FROM control_plugin_resource_binding_reconciliations`
        )
        .get()
    ).toEqual({ state: 'stabilizing', patch_result_version_id: 'version-new' });
  });

  it('does not call Cloudflare while Automatic provisioning is off and a patch is pending', async () => {
    const api = {
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
    };
    const reconciler = new PluginResourceBindingReconciler(
      d1(database),
      api,
      env(),
      () => now,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
    expect(api.getWorkerSettings).not.toHaveBeenCalled();
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(smoke).not.toHaveBeenCalled();
  });

  it('adopts a response-lost settings patch without issuing a second mutation', async () => {
    const bindings = reflectedBindings();
    let mutated = false;
    const api = {
      listWorkerDeployments: vi.fn(async () =>
        mutated ? [newDeployment, oldDeployment] : [oldDeployment]
      ),
      getWorkerSettings: vi.fn(async () =>
        mutated
          ? {
              bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }, ...bindings],
              compatibility_date: '2026-08-01',
            }
          : {
              bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }],
              compatibility_date: '2026-08-01',
            }
      ),
      patchWorkerSettings: vi.fn(async () => {
        mutated = true;
        throw new Error('response_lost');
      }),
    };
    const reconciler = new PluginResourceBindingReconciler(d1(database), api, env(), () => now);

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(
      database
        .prepare(
          `SELECT mutation_started, expected_source_version_id, previous_deployment_id
             FROM control_worker_deployment_leases`
        )
        .get()
    ).toEqual({
      mutation_started: 1,
      expected_source_version_id: 'version-old',
      previous_deployment_id: 'deployment-old',
    });

    now = 130;
    await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 1, blocked: 0 });
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(smoke).toHaveBeenCalledTimes(4);
    expect(
      database
        .prepare(
          `SELECT state, patch_result_version_id
             FROM control_plugin_resource_binding_reconciliations`
        )
        .get()
    ).toEqual({ state: 'succeeded', patch_result_version_id: 'version-new' });
  });

  it('blocks activation when Runner reflects a different resource contract', async () => {
    smoke.mockImplementation(async (input: unknown) => {
      const value = input as {
        operationId: string;
        installationId: string;
        expectedVersionId: string;
      };
      return {
        operationId: value.operationId,
        installationId: value.installationId,
        observedVersionId: value.expectedVersionId,
        resourceCount: 2,
      };
    });
    const bindings = reflectedBindings();
    const reconciler = new PluginResourceBindingReconciler(
      d1(database),
      {
        listWorkerDeployments: vi.fn(async () => [oldDeployment]),
        getWorkerSettings: vi.fn(async () => ({ bindings })),
        patchWorkerSettings: vi.fn(),
      },
      env(),
      () => now
    );

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 0,
      blocked: 1,
    });
    expect(database.prepare(`SELECT status FROM control_operations`).get()).toEqual({
      status: 'blocked',
    });
    expect(
      database.prepare(`SELECT DISTINCT status FROM control_plugin_desired_resources`).all()
    ).toEqual([{ status: 'ready' }]);
  });

  it('hands the first incomplete plugin resource step to setup when automation is off', async () => {
    database
      .prepare(
        `UPDATE control_operations
            SET status = 'waiting_retry', lock_owner = NULL, lock_expires_at = NULL,
                last_error_code = 'plugin_resource_provider_request_failed', next_attempt_at = ?
          WHERE operation_id = ?`
      )
      .run(now, OPERATION_ID);

    await expect(handoffPluginResourceOperationsToSetup(d1(database), now)).resolves.toBe(1);

    expect(
      database
        .prepare(`SELECT status, last_error_code FROM control_operations WHERE operation_id = ?`)
        .get(OPERATION_ID)
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required' });
    const blocked = database
      .prepare(
        `SELECT step_key, status, last_error_code FROM control_operation_steps
          WHERE operation_id = ? AND status = 'blocked'`
      )
      .all(OPERATION_ID);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      status: 'blocked',
      last_error_code: 'operator_action_required',
    });
    expect(
      database
        .prepare(
          `SELECT event_type, redacted_payload_json FROM control_audit_events
            WHERE operation_id = ? AND event_type = 'plugin.resources.operator_handoff'`
        )
        .get(OPERATION_ID)
    ).toEqual({
      event_type: 'plugin.resources.operator_handoff',
      redacted_payload_json:
        '{"reason":"operator_action_required","operationKind":"provision_plugin_resources"}',
    });
  });

  it('hands off only operations that require an unavailable optional resource class', async () => {
    database
      .prepare(
        `UPDATE control_plugin_desired_resources
            SET status = 'pending'
          WHERE plugin_resource_id = 'resource-kv'`
      )
      .run();
    const providerStep = `plugin_resource_${FINGERPRINTS.kv_namespace.slice(0, 20)}_provider`;
    database
      .prepare(`DELETE FROM control_operation_steps WHERE operation_id = ? AND step_key = ?`)
      .run(OPERATION_ID, providerStep);
    database
      .prepare(
        `INSERT INTO control_operation_steps (
           operation_id, step_key, display_order, status, attempt_count, next_attempt_at,
           last_error_code, last_error_redacted, updated_at
         ) VALUES (?, ?, 0, 'waiting_retry', 1, ?,
                   'plugin_resource_provider_request_failed',
                   'plugin_resource_provider_request_failed', ?)`
      )
      .run(OPERATION_ID, providerStep, now + 900, now);
    database
      .prepare(
        `UPDATE control_operations
            SET status = 'waiting_retry', lock_owner = NULL, lock_expires_at = NULL,
                last_error_code = 'plugin_resource_provider_request_failed', next_attempt_at = ?
          WHERE operation_id = ?`
      )
      .run(now + 900, OPERATION_ID);

    await expect(
      handoffPluginResourceOperationsToSetup(d1(database), now, {
        resourceKinds: ['r2_bucket'],
      })
    ).resolves.toBe(0);
    expect(database.prepare(`SELECT status FROM control_operations`).get()).toEqual({
      status: 'waiting_retry',
    });

    await expect(
      handoffPluginResourceOperationsToSetup(d1(database), now, {
        resourceKinds: ['kv_namespace'],
      })
    ).resolves.toBe(1);
    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required' });
  });
});
