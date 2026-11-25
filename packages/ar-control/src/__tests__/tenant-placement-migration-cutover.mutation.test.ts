import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPlacementMigrationService } from '../tenant-placement-migration';
import { dropTriggers } from './support/sqlite-d1';
import { placementDatabase, sessionD1 } from './support/placement-migration-fixtures';

const E = 'env-test';
const ROLES = ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const;
let database: DatabaseSync;
let now: number;

beforeEach(() => {
  database = placementDatabase();
  now = 100;
});
afterEach(() => database.close());

const row = (sql: string) => database.prepare(sql).get();
const all = (sql: string) => database.prepare(sql).all();
const mutation = (operationId: string, key = 'action-a') => ({
  operationId,
  requestedById: 'admin-a',
  idempotencyKey: key,
});

function provisionTargets(operationId: string): void {
  for (const [index, role] of ROLES.entries()) {
    const id = `target-${index}`;
    database.exec(`
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id, deterministic_name,
        ownership_fingerprint, provisioning_state, origin_operation_id, provider_create_state,
        provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
      ) VALUES ('desired-${id}', '${E}', 'd1', 'logical-${id}', 'db-${id}', 'fp-${id}', 'active',
        'fixture-shards', 'identified', 'provider-${id}', 1, 1, 1);
      INSERT INTO control_observed_resources (
        observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
        provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
      ) VALUES ('observed-${id}', '${E}', 'desired-${id}', 'provider-${id}', 'db-${id}', 'd1',
        'fp-${id}', 'present', 1);
      INSERT INTO control_tenant_shards (
        shard_id, environment_id, data_role, residency_policy_id, residency_partition, generation,
        logical_shard_id, binding_ref, d1_desired_resource_id, status, created_at, updated_at,
        allocation_scope, owner_tenant_id
      ) VALUES ('${id}', '${E}', '${role}', 'default', 'jp', ${5 + index}, 'logical-${id}',
        'TDB_TARGET_${index}', 'desired-${id}', 'active', 1, 1, 'tenant_exclusive', 'tenant-a');
      INSERT INTO control_tenant_shard_assignments (
        environment_id, tenant_id, data_role, residency_policy_id, residency_partition, shard_id,
        assignment_generation, assignment_state, source_operation_id, created_at, updated_at
      ) VALUES ('${E}', 'tenant-a', '${role}', 'default', 'jp', '${id}', 2, 'pending',
        '${operationId}', 1, 1);
      UPDATE control_tenant_placement_migration_shards
         SET target_shard_id = '${id}', target_assignment_generation = 2,
             shard_state = 'write_fenced', verified_at = 30, write_fenced_at = 40,
             source_row_count = 4, target_row_count = 4,
             source_checksum = '${'a'.repeat(64)}', target_checksum = '${'a'.repeat(64)}'
       WHERE data_role = '${role}'`);
  }
}

async function fenced(sourceD1?: { queryD1: ReturnType<typeof vi.fn> }) {
  const service = new TenantPlacementMigrationService(
    sessionD1(database),
    () => now,
    sourceD1 ? { sourceD1: sourceD1 as never } : {}
  );
  const started = await service.start(E, {
    tenantId: 'tenant-a',
    targetIsolationPolicy: 'tenant_exclusive',
    idempotencyKey: 'placement-a',
    requestedById: 'admin-a',
  });
  dropTriggers(database);
  database.exec('PRAGMA foreign_keys = OFF');
  provisionTargets(started.operationId);
  database.exec(`
    UPDATE control_tenant_placement_migrations
       SET migration_state = 'cutover_ready', write_fence_state = 'active',
           write_fence_started_at = 40;
    INSERT INTO control_directory_rewrite_leases (
      environment_id, operation_id, operation_kind, owner_id, fencing_token, checkpoint_json,
      lease_expires_at, mutation_started, updated_at
    ) VALUES ('${E}', '${started.operationId}', 'tenant_placement_migration', 'owner', 1, '{}',
      9999, 1, 1);
    INSERT INTO control_tenant_default_allocations (
      allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
      selected_shard_id, reservation_state, idempotency_key, route_generation, created_at,
      committed_at, updated_at
    ) VALUES ('alloc-default', '${E}', 'tenant-a', 'default', 'jp', 'shared-1', 'committed',
      'alloc-default', 1, 1, 1, 1)`);
  return { service, operationId: started.operationId };
}

describe('commitCutover', () => {
  it('moves the policy, assignments, allocations and shards to the target atomically', async () => {
    const { service, operationId } = await fenced();
    now = 200;
    const committed = await service.commitCutover(E, mutation(operationId));
    expect(committed).toMatchObject({ state: 'cutover_committed', canCancel: false });
    expect(
      row(
        `SELECT isolation_policy, policy_generation, policy_state, pending_isolation_policy,
                pending_policy_generation, migration_operation_id, updated_at
           FROM control_tenant_placement_policies WHERE tenant_id = 'tenant-a'`
      )
    ).toEqual({
      isolation_policy: 'tenant_exclusive',
      policy_generation: 2,
      policy_state: 'active',
      pending_isolation_policy: null,
      pending_policy_generation: null,
      migration_operation_id: null,
      updated_at: 200,
    });
    expect(
      all(
        `SELECT shard_id, assignment_state, retired_at IS NOT NULL AS retired
           FROM control_tenant_shard_assignments ORDER BY shard_id`
      )
    ).toEqual([
      { shard_id: 'shared-1', assignment_state: 'quarantined', retired: 1 },
      { shard_id: 'shared-2', assignment_state: 'quarantined', retired: 1 },
      { shard_id: 'shared-3', assignment_state: 'quarantined', retired: 1 },
      { shard_id: 'target-0', assignment_state: 'active', retired: 0 },
      { shard_id: 'target-1', assignment_state: 'active', retired: 0 },
      { shard_id: 'target-2', assignment_state: 'active', retired: 0 },
    ]);
    expect(
      row(
        'SELECT selected_shard_id, route_generation, updated_at FROM control_tenant_default_allocations'
      )
    ).toEqual({ selected_shard_id: 'target-0', route_generation: 5, updated_at: 200 });
    expect(
      all(
        'SELECT DISTINCT shard_state, cutover_committed_at FROM control_tenant_placement_migration_shards'
      )
    ).toEqual([{ shard_state: 'cutover_committed', cutover_committed_at: 200 }]);
    expect(
      row(
        `SELECT event_type, actor_id, outcome FROM control_audit_events
          WHERE event_type = 'tenant_placement_migration.cutover_commit'`
      )
    ).toEqual({
      event_type: 'tenant_placement_migration.cutover_commit',
      actor_id: 'admin-a',
      outcome: 'succeeded',
    });
    await expect(service.commitCutover(E, mutation(operationId, 'again'))).resolves.toMatchObject({
      state: 'cutover_committed',
    });
  });

  it('requires an unexpired route lease', async () => {
    const { service, operationId } = await fenced();
    database.exec('UPDATE control_directory_rewrite_leases SET lease_expires_at = 100');
    await expect(service.commitCutover(E, mutation(operationId))).rejects.toThrow(
      'control_tenant_placement_migration_route_lease_required'
    );
    database.exec('DELETE FROM control_directory_rewrite_leases');
    await expect(service.commitCutover(E, mutation(operationId))).rejects.toThrow(
      'control_tenant_placement_migration_route_lease_required'
    );
  });

  it('refuses to commit while an allocation still points at an unmapped shard', async () => {
    const { service, operationId } = await fenced();
    database.exec(`
      INSERT INTO control_tenant_default_allocations (
        allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
        selected_shard_id, reservation_state, idempotency_key, route_generation, created_at,
        updated_at
      ) VALUES ('alloc-other', '${E}', 'tenant-a', 'default', 'eu', 'shared-1', 'reserved',
        'alloc-other', 1, 1, 1)`);
    await expect(service.commitCutover(E, mutation(operationId))).rejects.toThrow(
      'control_tenant_placement_migration_allocation_unmapped'
    );
    expect(
      row("SELECT policy_state FROM control_tenant_placement_policies WHERE tenant_id = 'tenant-a'")
    ).toEqual({
      policy_state: 'migrating',
    });
  });
});

describe('finalizeCutover', () => {
  const capture = (cutover: unknown = 150) =>
    vi.fn(async (_id: string, sql: string, _params?: unknown[]) =>
      /^\s*UPDATE/u.test(sql)
        ? [{ success: true, results: [] }]
        : [
            {
              success: true,
              results: [{ capture_state: 'cutover_committed', cutover_committed_at: cutover }],
            },
          ]
    );

  async function committed(queryD1 = capture()) {
    const { service, operationId } = await fenced({ queryD1 });
    for (const index of [1, 2, 3]) {
      database.exec(`
        INSERT INTO control_observed_resources (
          observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
          provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
        ) VALUES ('observed-source-${index}', '${E}', 'desired-${index}',
          'provider-database-${index}', 'database-${index}', 'd1', 'fingerprint-${index}',
          'present', 1)`);
    }
    await service.commitCutover(E, mutation(operationId));
    return { service, operationId, queryD1 };
  }

  it('quarantines the sources, releases the fence and the lease', async () => {
    const { service, operationId, queryD1 } = await committed();
    now = 300;
    const view = await service.finalizeCutover(E, mutation(operationId, 'finalize'));
    expect(view).toMatchObject({
      state: 'source_quarantined',
      writeFenceState: 'released',
      routeCutoverStarted: false,
      sourceRetentionExpiresAt: 300 + 30 * 24 * 3600,
    });
    expect(queryD1).toHaveBeenCalled();
    const updates = queryD1.mock.calls.filter((call) => /^\s*UPDATE/u.test(String(call[1])));
    expect(updates.map((call) => call[0]).sort()).toEqual([
      'provider-database-1',
      'provider-database-2',
      'provider-database-3',
    ]);
    expect(updates[0]?.[2]).toEqual([300, 300, operationId, 'tenant-a']);
    expect(
      all('SELECT DISTINCT shard_state FROM control_tenant_placement_migration_shards')
    ).toEqual([{ shard_state: 'quarantined' }]);
    expect(row('SELECT COUNT(*) AS n FROM control_directory_rewrite_leases')).toEqual({ n: 0 });
    expect(
      row(
        "SELECT actor_id FROM control_audit_events WHERE event_type = 'tenant_placement_migration.source_quarantine'"
      )
    ).toEqual({ actor_id: 'admin-a' });
  });

  it('fails when the source capture does not reflect the committed cutover', async () => {
    const queryD1 = vi.fn(async (_id: string, sql: string, _params?: unknown[]) =>
      /^\s*UPDATE/u.test(sql)
        ? [{ success: true, results: [] }]
        : [
            {
              success: true,
              results: [{ capture_state: 'write_fenced', cutover_committed_at: null }],
            },
          ]
    );
    const { service, operationId } = await committed(queryD1);
    await expect(service.finalizeCutover(E, mutation(operationId, 'f'))).rejects.toThrow(
      'control_tenant_placement_migration_finalize_cleanup_failed'
    );
    expect(row('SELECT migration_state FROM control_tenant_placement_migrations')).toEqual({
      migration_state: 'cutover_committed',
    });
  });

  it('fails when a source database is not observed', async () => {
    const { service, operationId } = await committed();
    database.exec(
      "UPDATE control_observed_resources SET observed_state = 'missing' WHERE observed_resource_id LIKE 'observed-source%'"
    );
    await expect(service.finalizeCutover(E, mutation(operationId, 'f'))).rejects.toThrow(
      'control_tenant_placement_migration_source_incomplete'
    );
  });
});
