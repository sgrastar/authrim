import type { DatabaseSync } from 'node:sqlite';
import { vi, type Mock } from 'vitest';
import type {
  CloudflareWorkerDeployment,
  CloudflareWorkerSettings,
} from '@authrim/ar-lib-core/control-plane';
import { PluginResourceBindingReconciler } from '../../plugin-resource-binding-reconciler';
import type { BoundedServiceBindingInvocationBudget } from '../../service-binding-invocation-budget';
import { d1 } from './plugin-dynamic-fixtures';
import {
  bindingDatabase,
  controlEnv,
  migrateD1,
  oldDeployment,
  smokeMock,
  OPERATION_ID,
} from './plugin-binding-fixtures';

/** Per-test world for driving the plugin resource binding reconciler against a real SQLite control database. */
type HarnessApi = {
  listWorkerDeployments: Mock<(scriptName: string) => Promise<CloudflareWorkerDeployment[]>>;
  getWorkerSettings: Mock<(scriptName: string) => Promise<CloudflareWorkerSettings>>;
  patchWorkerSettings: Mock<
    (scriptName: string, settings: CloudflareWorkerSettings) => Promise<CloudflareWorkerSettings>
  >;
};

function buildWorld(): {
  database: DatabaseSync;
  smoke: ReturnType<typeof smokeMock>;
  api: HarnessApi;
} {
  const database = bindingDatabase();
  migrateD1(database);
  return {
    database,
    smoke: smokeMock(),
    api: {
      listWorkerDeployments: vi.fn(async () => [oldDeployment]),
      getWorkerSettings: vi.fn(async () => ({})),
      patchWorkerSettings: vi.fn(async () => ({})),
    },
  };
}

/** Per-test world for driving the plugin resource binding reconciler against a real SQLite control database. */
export class BindingHarness {
  database: DatabaseSync;
  smoke: ReturnType<typeof smokeMock>;
  api: HarnessApi;
  now = 100;

  constructor() {
    const world = buildWorld();
    this.database = world.database;
    this.smoke = world.smoke;
    this.api = world.api;
  }

  reset(): void {
    const world = buildWorld();
    this.database = world.database;
    this.smoke = world.smoke;
    this.api = world.api;
    this.now = 100;
  }

  close(): void {
    this.database.close();
  }

  reconciler(
    options: { mutation?: boolean; budget?: BoundedServiceBindingInvocationBudget } = {}
  ): PluginResourceBindingReconciler {
    return new PluginResourceBindingReconciler(
      d1(this.database),
      this.api,
      controlEnv(d1(this.database), this.smoke),
      () => this.now,
      options.mutation ?? true,
      options.budget
    );
  }

  recon() {
    return this.database
      .prepare(
        `SELECT state, last_error_code, smoke_attempt_count AS attempts,
                consecutive_smoke_successes AS consecutive, stabilization_not_before AS not_before,
                updated_at FROM control_plugin_resource_binding_reconciliations`
      )
      .get();
  }

  operation() {
    return this.database
      .prepare(
        'SELECT status, next_attempt_at, last_error_code, last_error_redacted FROM control_operations'
      )
      .get();
  }

  leases() {
    return this.database.prepare('SELECT * FROM control_worker_deployment_leases').all();
  }

  runBindingSteps(): void {
    this.database.exec(
      "UPDATE control_operation_steps SET status = 'running' WHERE step_key LIKE '%_binding'"
    );
  }

  takeLease(owner: string, expires: number): void {
    if (owner !== OPERATION_ID) {
      this.database
        .prepare(
          `INSERT INTO control_operations (operation_id, environment_id, operation_kind,
             idempotency_key, status, requested_by_type, attempt_count, created_at, updated_at)
           VALUES (?, 'test', 'provision_plugin_resources', ?, 'running', 'admin', 1, 1, 1)`
        )
        .run(owner, `key-${owner}`);
    }
    this.database
      .prepare(
        `INSERT INTO control_worker_deployment_leases (environment_id, worker_script_name,
           owner_operation_id, fencing_token, lease_expires_at, expected_source_version_id, updated_at)
         VALUES ('test', 'test-ar-plugin-runner', ?, 5, ?, 'version-other', 1)`
      )
      .run(owner, expires);
  }
}
