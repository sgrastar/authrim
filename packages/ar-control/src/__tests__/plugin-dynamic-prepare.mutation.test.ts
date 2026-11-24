import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginDynamicWorkerDesiredStateService } from '../plugin-dynamic-worker-desired-state';
import { d1, seededDatabase, withStateResource } from './support/plugin-dynamic-fixtures';

const INPUT = { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true };
let database: DatabaseSync;
let service: PluginDynamicWorkerDesiredStateService;

beforeEach(() => {
  database = seededDatabase();
  service = new PluginDynamicWorkerDesiredStateService(d1(database), () => 1_800_000_000);
});
afterEach(() => database.close());

const count = (table: string) =>
  (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('prepare without resources', () => {
  it('reports not_required without creating any operation', async () => {
    const result = await service.prepare('test', INPUT);
    expect(result).toMatchObject({ operationId: null, readiness: 'not_required', enabled: true });
    expect(count('control_operations')).toBe(1);
  });

  it('refuses to prepare a disabled installation', async () => {
    await expect(service.prepare('test', { ...INPUT, enabled: false })).rejects.toThrow(
      /^control_plugin_resource_prepare_disabled$/u
    );
  });
});

describe('prepare with a managed d1 resource', () => {
  beforeEach(() => withStateResource(database));

  it('creates one queued operation, steps, pins, resource and migration state', async () => {
    const prepared = await service.prepare('test', INPUT);
    expect(prepared.readiness).toBe('pending');
    expect(prepared.operationId).toMatch(/^op_plugin_resources_[a-f0-9]{32}$/u);
    const operation = database
      .prepare(
        `SELECT status, requested_by_type, requested_by_id, attempt_count, created_at, updated_at, idempotency_key
           FROM control_operations WHERE operation_id = ?`
      )
      .get(prepared.operationId) as Record<string, unknown>;
    expect(operation).toMatchObject({
      status: 'queued',
      requested_by_type: 'admin',
      requested_by_id: 'ar-management',
      attempt_count: 0,
      created_at: 1_800_000_000,
      updated_at: 1_800_000_000,
    });
    expect(String(operation.idempotency_key)).toMatch(/^plugin-resources:[a-f0-9]{64}$/u);
    const steps = database
      .prepare(
        `SELECT step_key, display_order, status FROM control_operation_steps
          WHERE operation_id = ? ORDER BY display_order`
      )
      .all(prepared.operationId) as { step_key: string; display_order: number; status: string }[];
    expect(steps.map((step) => [step.display_order, step.status])).toEqual([
      [0, 'queued'],
      [10, 'queued'],
      [20, 'queued'],
    ]);
    expect(
      steps.map((step) => step.step_key.replace(/plugin_resource_[a-f0-9]{20}/u, 'P'))
    ).toEqual(['P_provider', 'P_migration', 'P_binding']);
    expect(
      database
        .prepare(
          `SELECT stream_id, release_id, manifest_digest FROM control_operation_release_pins`
        )
        .all()
    ).toEqual([
      { stream_id: 'plugin/plugin-a/state', release_id: '0.4.0', manifest_digest: 'f'.repeat(64) },
    ]);
    expect(
      database
        .prepare(
          `SELECT status, lifecycle_mode, lifecycle_generation, resource_kind, binding_name, resource_scope
             FROM control_plugin_desired_resources`
        )
        .all()
    ).toEqual([
      {
        status: 'pending',
        lifecycle_mode: 'managed',
        lifecycle_generation: 1,
        resource_kind: 'd1',
        binding_name: 'PLUGIN_STATE',
        resource_scope: 'tenant',
      },
    ]);
    expect(
      database
        .prepare(`SELECT state, updated_at FROM control_plugin_resource_migration_state`)
        .all()
    ).toEqual([{ state: 'requested', updated_at: 1_800_000_000 }]);
  });

  it('is idempotent and reflects the readiness of the stored resources', async () => {
    const first = await service.prepare('test', INPUT);
    const again = await service.prepare('test', INPUT);
    expect(again).toEqual(first);
    expect(count('control_operations')).toBe(3);
    const setStatus = (status: string) =>
      database
        .prepare(
          `UPDATE control_plugin_desired_resources SET status = ?, provider_resource_id = 'db-1', provider_name = 'name-1'`
        )
        .run(status);
    for (const [status, readiness] of [
      ['active', 'ready'],
      ['failed', 'blocked'],
      ['provisioning', 'pending'],
      ['ready', 'pending'],
      ['deleting', 'pending'],
    ] as const) {
      setStatus(status);
      await expect(service.prepare('test', INPUT)).resolves.toMatchObject({
        operationId: first.operationId,
        readiness,
      });
    }
  });

  it('blocks while an earlier cleanup is unfinished', async () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES ('cleanup-op', 'test', 'cleanup_plugin_resources', 'cleanup-1', 'queued', 'admin', 0, 1, 1);
    `);
    const installation = (await service.plan('test', INPUT)).installationId;
    database
      .prepare(
        `INSERT INTO control_plugin_resource_cleanup_operations (
           operation_id, environment_id, plugin_installation_id, tenant_id, plugin_id,
           source_operation_id, lifecycle_generation, reason, state, created_at, updated_at
         ) VALUES ('cleanup-op', 'test', ?, 'tenant-a', 'plugin-a', 'manifest-op', 1, 'uninstall',
           'requested', 1, 1)`
      )
      .run(installation);
    await expect(service.prepare('test', INPUT)).resolves.toMatchObject({
      operationId: 'cleanup-op',
      readiness: 'blocked',
    });
    expect(count('control_plugin_desired_resources')).toBe(0);
    database
      .prepare(`UPDATE control_plugin_resource_cleanup_operations SET state = 'blocked'`)
      .run();
    await expect(service.prepare('test', INPUT)).resolves.toMatchObject({ readiness: 'blocked' });
  });

  it('numbers a new lifecycle after a finished cleanup', async () => {
    const installation = (await service.plan('test', INPUT)).installationId;
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES ('cleanup-op', 'test', 'cleanup_plugin_resources', 'cleanup-1', 'succeeded', 'admin', 0, 1, 1, 1);
    `);
    database
      .prepare(
        `INSERT INTO control_plugin_resource_cleanup_operations (
           operation_id, environment_id, plugin_installation_id, tenant_id, plugin_id,
           source_operation_id, lifecycle_generation, reason, state, drain_not_before,
           created_at, updated_at, completed_at
         ) VALUES ('cleanup-op', 'test', ?, 'tenant-a', 'plugin-a', 'manifest-op', 4, 'uninstall',
           'succeeded', 1, 1, 1, 1)`
      )
      .run(installation);
    await service.prepare('test', INPUT);
    expect(
      database.prepare(`SELECT lifecycle_generation FROM control_plugin_desired_resources`).all()
    ).toEqual([{ lifecycle_generation: 5 }]);
  });

  it('requires an active migration release for the declared stream', async () => {
    database.exec('DELETE FROM control_migration_release_catalog');
    await expect(service.prepare('test', INPUT)).rejects.toThrow(
      /^control_plugin_migration_release_unavailable$/u
    );
    expect(count('control_plugin_desired_resources')).toBe(0);
  });

  it.each([
    [
      'a changed desired spec',
      `UPDATE control_plugin_desired_resources SET desired_spec_json = '{}'`,
      'control_plugin_resource_immutable',
    ],
    [
      'a changed lifecycle mode',
      `UPDATE control_plugin_desired_resources SET lifecycle_mode = 'existing', provider_resource_id = 'x', provider_name = 'y'`,
      'control_plugin_resource_immutable',
    ],
  ])('refuses to re-prepare after %s', async (_name, sql, code) => {
    await service.prepare('test', INPUT);
    database.exec(sql);
    await expect(service.prepare('test', INPUT)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });

  it('refuses a stored resource the plan no longer declares', async () => {
    await service.prepare('test', INPUT);
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id, tenant_id,
           resource_scope, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json, desired_spec_json, status,
           updated_at, lifecycle_generation)
         SELECT 'extra-id', environment_id, operation_id, plugin_installation_id, tenant_id,
           resource_scope, resource_kind, 'other-resource', 'OTHER_BINDING', lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json, desired_spec_json, status,
           updated_at, lifecycle_generation FROM control_plugin_desired_resources LIMIT 1`
      )
      .run();
    await expect(service.prepare('test', INPUT)).rejects.toThrow(
      /^control_plugin_resource_set_immutable$/u
    );
  });

  it('refuses stored resources of different lifecycle generations', async () => {
    await service.prepare('test', INPUT);
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id, tenant_id,
           resource_scope, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json, desired_spec_json, status,
           updated_at, lifecycle_generation)
         SELECT 'extra-id', environment_id, operation_id, plugin_installation_id, tenant_id,
           resource_scope, resource_kind, 'other-resource', 'OTHER_BINDING', lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json, desired_spec_json, status,
           updated_at, 7 FROM control_plugin_desired_resources LIMIT 1`
      )
      .run();
    await expect(service.prepare('test', INPUT)).rejects.toThrow(
      /^control_plugin_resource_generation_mismatch$/u
    );
  });

  it('refuses stored resources that belong to different operations', async () => {
    await service.prepare('test', INPUT);
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES ('other-op', 'test', 'provision_plugin_resources', 'other-key', 'queued', 'admin', 0, 1, 1);
    `);
    database.prepare(`UPDATE control_plugin_desired_resources SET operation_id = 'other-op'`).run();
    await expect(service.prepare('test', INPUT)).resolves.toMatchObject({
      operationId: 'other-op',
    });
  });
});
