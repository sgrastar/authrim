import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPlacementMigrationService } from '../tenant-placement-migration';
import { dropTriggers } from './support/sqlite-d1';
import { placementDatabase, sessionD1 } from './support/placement-migration-fixtures';

const E = 'env-test';
let database: DatabaseSync;
let now: number;
let service: TenantPlacementMigrationService;

beforeEach(() => {
  database = placementDatabase();
  now = 100;
  service = new TenantPlacementMigrationService(sessionD1(database), () => now);
});
afterEach(() => database.close());

const START = {
  tenantId: 'tenant-a',
  targetIsolationPolicy: 'tenant_exclusive' as const,
  idempotencyKey: 'placement-a',
  requestedById: 'admin-a',
};
const mutation = (operationId: string, patch: Record<string, unknown> = {}) => ({
  operationId,
  requestedById: 'admin-a',
  idempotencyKey: 'action-a',
  ...patch,
});
const setState = (state: string, extra = '') => {
  dropTriggers(database);
  const committed = ['cutover_committed', 'source_quarantined', 'purge_pending', 'complete'];
  const columns = [
    `migration_state = '${state}'`,
    ...(committed.includes(state) ? ['cutover_committed_at = 50'] : []),
    ...(state === 'complete' ? ['completed_at = 50', 'active_operation_key = NULL'] : []),
    ...(extra ? [extra.replace(/^, /u, '')] : []),
  ];
  database.exec(`UPDATE control_tenant_placement_migrations SET ${columns.join(', ')}`);
};
const activeFence = "write_fence_state = 'active', write_fence_started_at = 40";
const row = (sql: string) => database.prepare(sql).get();

const ROLES = ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const;

function provisionTarget(index: number): string {
  const id = `target-${index}`;
  database.exec(`
    INSERT INTO control_desired_resources (
      desired_resource_id, environment_id, resource_kind, logical_shard_id, deterministic_name,
      ownership_fingerprint, provisioning_state, origin_operation_id, provider_create_state,
      provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
    ) VALUES ('desired-${id}', 'env-test', 'd1', 'logical-${id}', 'db-${id}', 'fp-${id}', 'active',
      'fixture-shards', 'identified', 'provider-${id}', 1, 1, 1);
    INSERT INTO control_observed_resources (
      observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
      provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
    ) VALUES ('observed-${id}', 'env-test', 'desired-${id}', 'provider-${id}', 'db-${id}', 'd1',
      'fp-${id}', 'present', 1);
    INSERT INTO control_tenant_shards (
      shard_id, environment_id, data_role, residency_policy_id, residency_partition, generation,
      logical_shard_id, binding_ref, d1_desired_resource_id, status, created_at, updated_at,
      allocation_scope, owner_tenant_id
    ) VALUES ('${id}', 'env-test', '${ROLES[index]}', 'default', 'jp', ${5 + index},
      'logical-${id}', 'TDB_TARGET_${index}', 'desired-${id}', 'active', 1, 1,
      'tenant_exclusive', 'tenant-a');
    UPDATE control_tenant_placement_migration_shards
       SET target_shard_id = '${id}', target_assignment_generation = 2
     WHERE data_role = '${ROLES[index]}'`);
  return id;
}

describe('start validation', () => {
  it.each([
    ['environment', { env: 'a b' }, 'invalid_tenant_placement_migration_environment'],
    ['tenant', { tenantId: '' }, 'invalid_tenant_placement_migration_tenant'],
    [
      'idempotency key',
      { idempotencyKey: 'a b' },
      'invalid_tenant_placement_migration_idempotency_key',
    ],
    ['requester', { requestedById: 7 }, 'invalid_tenant_placement_migration_actor'],
    [
      'target policy',
      { targetIsolationPolicy: 'shared_pool' },
      'invalid_tenant_placement_migration_target',
    ],
  ])('rejects an invalid %s', async (_label, patch, code) => {
    const { env, ...input } = { env: E, ...START, ...patch } as typeof START & { env: string };
    await expect(service.start(env, input)).rejects.toThrow(code);
  });

  it('requires the D1 sessions API', async () => {
    const plain = new TenantPlacementMigrationService(
      { prepare: () => undefined } as unknown as D1Database,
      () => now
    );
    await expect(plain.start(E, START)).rejects.toThrow('d1_sessions_api_required');
  });

  it.each([
    ['an unknown tenant', { tenantId: 'tenant-z' }],
    ['a non-active policy', null],
  ])('refuses %s as a migration source', async (_label, patch) => {
    if (patch === null) {
      dropTriggers(database);
      database.exec("UPDATE control_tenant_placement_policies SET policy_state = 'provisioning'");
    }
    await expect(service.start(E, { ...START, ...(patch ?? {}) })).rejects.toThrow(
      'control_tenant_placement_migration_source_invalid'
    );
  });

  it('refuses a policy that is already tenant exclusive or already migrating', async () => {
    dropTriggers(database);
    database.exec(
      "UPDATE control_tenant_placement_policies SET isolation_policy = 'tenant_exclusive'"
    );
    await expect(service.start(E, START)).rejects.toThrow(
      'control_tenant_placement_migration_source_invalid'
    );
  });

  it('reports an idempotency conflict when the key belongs to another tenant', async () => {
    await service.start(E, START);
    database.exec(`
      INSERT INTO control_tenant_placement_policies (
        environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
        source_operation_id, idempotency_key, activated_at, created_at, updated_at
      ) VALUES ('env-test', 'tenant-b', 'shared_pool', 1, 'active', 'op-b', 'op-b', 1, 1, 1)`);
    await expect(service.start(E, { ...START, tenantId: 'tenant-b' })).rejects.toThrow(
      'control_tenant_placement_migration_idempotency_conflict'
    );
  });

  it.each([
    [
      'too few assigned shards',
      () =>
        database.exec(
          "DELETE FROM control_tenant_shard_assignments WHERE data_role = 'tenant_pii'"
        ),
    ],
    [
      'no default role',
      () =>
        database.exec(
          "UPDATE control_tenant_shard_assignments SET data_role = 'tenant_core/users', assignment_generation = 2 WHERE data_role = 'tenant_core/default'"
        ),
    ],
    [
      'no users role',
      () =>
        database.exec(
          "UPDATE control_tenant_shard_assignments SET data_role = 'tenant_pii', assignment_generation = 2 WHERE data_role = 'tenant_core/users'"
        ),
    ],
  ])('blocks a source set with %s', async (_label, mutate) => {
    dropTriggers(database);
    mutate();
    await expect(service.start(E, START)).rejects.toThrow(
      'control_tenant_placement_migration_source_incomplete'
    );
  });

  it('records the operation, its shards and an audit event atomically', async () => {
    const view = await service.start(E, START);
    expect(view.operationId).toMatch(/^tenant-placement:[a-f0-9]{64}$/u);
    expect(
      row(
        `SELECT status, operation_kind, requested_by_type, requested_by_id, idempotency_key
           FROM control_operations WHERE operation_id = '${view.operationId}'`
      )
    ).toMatchObject({
      status: 'running',
      operation_kind: 'tenant_placement_migration',
      requested_by_id: 'admin-a',
    });
    expect(view).toMatchObject({
      createdAt: 100,
      updatedAt: 100,
      routeCutoverStarted: false,
      canApprovePurge: false,
      sourceRetentionExpiresAt: null,
      lastErrorCode: null,
    });
    expect(view.shards.map((shard) => shard.dataRole)).toEqual([
      'tenant_core/default',
      'tenant_core/users',
      'tenant_pii',
    ]);
    expect(view.shards[0]).toMatchObject({
      residencyPolicyId: 'default',
      residencyPartition: 'jp',
      sourceShardId: 'shared-1',
      sourceAssignmentGeneration: 1,
      targetShardId: null,
      target: null,
      state: 'target_pending',
    });
  });

  it('returns null for an unknown migration', async () => {
    await expect(service.get(E, 'missing')).resolves.toBeNull();
  });
});

describe('operation state guards', () => {
  const methods = [
    ['cancel', (id: string) => service.cancel(E, mutation(id))],
    ['beginRouteCutover', (id: string) => service.beginRouteCutover(E, mutation(id))],
    ['commitCutover', (id: string) => service.commitCutover(E, mutation(id))],
    ['approvePurge', (id: string) => service.approvePurge(E, mutation(id))],
    ['finalizeCutover', (id: string) => service.finalizeCutover(E, mutation(id))],
  ] as const;

  it.each(methods)('%s rejects an unknown migration', async (_name, call) => {
    await expect(call('missing')).rejects.toThrow('control_tenant_placement_migration_not_found');
  });

  it.each(methods)('%s validates the request identifiers', async (name) => {
    const target = service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const invoke = (patch: Record<string, unknown>, env = E) =>
      target[name]?.call(service, env, mutation('op', patch));
    await expect(invoke({}, 'a b')).rejects.toThrow(
      'invalid_tenant_placement_migration_environment'
    );
    await expect(invoke({ operationId: '' })).rejects.toThrow(
      'invalid_tenant_placement_migration_operation'
    );
    await expect(invoke({ requestedById: '' })).rejects.toThrow(
      'invalid_tenant_placement_migration_actor'
    );
    await expect(invoke({ idempotencyKey: 'a b' })).rejects.toThrow(
      'invalid_tenant_placement_migration_idempotency_key'
    );
  });

  it('cancels an operation only before the route cutover begins', async () => {
    const started = await service.start(E, START);
    for (const state of ['cutover_committed', 'source_quarantined', 'purge_pending', 'complete']) {
      setState(state);
      await expect(service.cancel(E, mutation(started.operationId))).rejects.toThrow(
        'control_tenant_placement_migration_cancel_not_allowed'
      );
    }
    setState('cutover_ready');
    database.exec(`
      INSERT INTO control_directory_rewrite_leases (
        environment_id, operation_id, operation_kind, owner_id, fencing_token,
        checkpoint_json, lease_expires_at, mutation_started, updated_at
      ) VALUES ('${E}', '${started.operationId}', 'tenant_placement_migration', 'owner', 1,
        '{}', 9999, 1, 1)`);
    expect((await service.get(E, started.operationId))?.canCancel).toBe(false);
    await expect(service.cancel(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_cancel_not_allowed'
    );
    database.exec('DELETE FROM control_directory_rewrite_leases');
    expect((await service.get(E, started.operationId))?.canCancel).toBe(true);
  });

  it('replays a cancelled migration without further mutation', async () => {
    const started = await service.start(E, START);
    const canceled = await service.cancel(E, mutation(started.operationId));
    now = 500;
    await expect(
      service.cancel(E, mutation(started.operationId, { idempotencyKey: 'other' }))
    ).resolves.toEqual(canceled);
  });

  it('refuses the route cutover until the write fence is active and the copy is ready', async () => {
    const started = await service.start(E, START);
    await expect(service.beginRouteCutover(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_cutover_not_ready'
    );
    setState('cutover_ready');
    await expect(service.beginRouteCutover(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_cutover_not_ready'
    );
    await expect(service.commitCutover(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_cutover_not_ready'
    );
  });

  it.each(['cutover_committed', 'source_quarantined', 'purge_pending', 'complete'])(
    'treats a %s migration as already committed',
    async (state) => {
      const started = await service.start(E, START);
      setState(state);
      await expect(service.commitCutover(E, mutation(started.operationId))).resolves.toMatchObject({
        state,
      });
    }
  );

  it('refuses to approve a purge before the source retention elapsed', async () => {
    const started = await service.start(E, START);
    await expect(service.approvePurge(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_purge_not_allowed'
    );
    setState('source_quarantined', ', source_retention_expires_at = 101');
    expect((await service.get(E, started.operationId))?.canApprovePurge).toBe(false);
    await expect(service.approvePurge(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_purge_not_allowed'
    );
    now = 101;
    expect((await service.get(E, started.operationId))?.canApprovePurge).toBe(true);
    for (const state of ['purge_pending', 'complete']) {
      setState(state);
      await expect(service.approvePurge(E, mutation(started.operationId))).resolves.toMatchObject({
        state,
      });
    }
  });

  it('refuses to finalize before the cutover committed', async () => {
    const started = await service.start(E, START);
    await expect(service.finalizeCutover(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_finalize_not_ready'
    );
    for (const state of ['source_quarantined', 'purge_pending', 'complete']) {
      setState(state);
      await expect(
        service.finalizeCutover(E, mutation(started.operationId))
      ).resolves.toMatchObject({
        state,
      });
    }
  });

  it('requires the route lease and a source cleanup client to finalize', async () => {
    const started = await service.start(E, START);
    setState('cutover_committed');
    setState('cutover_committed', `, ${activeFence}`);
    await expect(service.finalizeCutover(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_route_lease_required'
    );
    database.exec(`
      INSERT INTO control_directory_rewrite_leases (
        environment_id, operation_id, operation_kind, owner_id, fencing_token,
        checkpoint_json, lease_expires_at, mutation_started, updated_at
      ) VALUES ('${E}', '${started.operationId}', 'tenant_placement_migration', 'owner', 1,
        '{}', 9999, 1, 1)`);
    await expect(service.finalizeCutover(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_finalize_cleanup_unavailable'
    );
  });
});

describe('source purge approval', () => {
  async function quarantined() {
    const started = await service.start(E, START);
    dropTriggers(database);
    database.exec('PRAGMA foreign_keys = OFF');
    for (const index of [0, 1, 2]) provisionTarget(index);
    database.exec(`
      UPDATE control_tenant_placement_migration_shards
         SET shard_state = 'quarantined', verified_at = 30, source_row_count = 4,
             target_row_count = 4, source_checksum = '${'a'.repeat(64)}',
             target_checksum = '${'a'.repeat(64)}'`);
    setState('source_quarantined', ', source_retention_expires_at = 150');
    return started;
  }

  it('records the approval, resets the purge cursors and audits it', async () => {
    const started = await quarantined();
    now = 150;
    const approved = await service.approvePurge(E, mutation(started.operationId));
    expect(approved).toMatchObject({ state: 'purge_pending', updatedAt: 150 });
    expect(
      row(
        `SELECT purge_approved_by, purge_approved_at, updated_at
           FROM control_tenant_placement_migrations`
      )
    ).toEqual({ purge_approved_by: 'admin-a', purge_approved_at: 150, updated_at: 150 });
    expect(
      database
        .prepare(
          `SELECT table_cursor_json AS cursor, updated_at FROM control_tenant_placement_migration_shards`
        )
        .all()
    ).toEqual([0, 1, 2].map(() => ({ cursor: '{"purgeTableIndex":0}', updated_at: 150 })));
    expect(
      row(
        `SELECT event_type, actor_type, actor_id, resource_kind, resource_id, outcome,
                redacted_payload_json, created_at FROM control_audit_events
          WHERE event_type = 'tenant_placement_migration.source_purge_approved'`
      )
    ).toEqual({
      event_type: 'tenant_placement_migration.source_purge_approved',
      actor_type: 'admin',
      actor_id: 'admin-a',
      resource_kind: 'tenant_placement_migration',
      resource_id: started.operationId,
      outcome: 'succeeded',
      redacted_payload_json: '{}',
      created_at: 150,
    });
    await expect(
      service.approvePurge(E, mutation(started.operationId, { idempotencyKey: 'other' }))
    ).resolves.toMatchObject({ state: 'purge_pending' });
  });

  it('leaves nothing committed when a shard is not quarantined', async () => {
    const started = await quarantined();
    database.exec(
      "UPDATE control_tenant_placement_migration_shards SET shard_state = 'verified' WHERE data_role = 'tenant_pii'"
    );
    now = 150;
    await expect(service.approvePurge(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_purge_not_allowed'
    );
    expect(
      row(
        'SELECT migration_state, purge_approved_by, purge_approved_at FROM control_tenant_placement_migrations'
      )
    ).toEqual({
      migration_state: 'source_quarantined',
      purge_approved_by: null,
      purge_approved_at: null,
    });
    expect(
      database
        .prepare(
          'SELECT DISTINCT table_cursor_json AS cursor FROM control_tenant_placement_migration_shards'
        )
        .all()
    ).toEqual([{ cursor: '{}' }]);
    expect(
      row(
        "SELECT COUNT(*) AS n FROM control_audit_events WHERE event_type = 'tenant_placement_migration.source_purge_approved'"
      )
    ).toEqual({ n: 0 });
  });

  it('does not rewind the purge cursors when a concurrent request approved first', async () => {
    const started = await quarantined();
    now = 150;
    const stale = await service.get(E, started.operationId);
    await service.approvePurge(E, mutation(started.operationId, { idempotencyKey: 'first' }));
    database.exec(
      `UPDATE control_tenant_placement_migration_shards SET table_cursor_json = '{"purgeTableIndex":1}'`
    );
    vi.spyOn(service, 'get').mockResolvedValueOnce(stale);
    await expect(
      service.approvePurge(E, mutation(started.operationId, { idempotencyKey: 'second' }))
    ).resolves.toMatchObject({ state: 'purge_pending' });
    expect(
      database
        .prepare(
          'SELECT DISTINCT table_cursor_json AS cursor FROM control_tenant_placement_migration_shards'
        )
        .all()
    ).toEqual([{ cursor: '{"purgeTableIndex":1}' }]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM control_audit_events WHERE event_type = 'tenant_placement_migration.source_purge_approved'"
        )
        .get()
    ).toEqual({ n: 1 });
  });

  it('records the approval even when another action already used the same key and audit id', async () => {
    const started = await quarantined();
    now = 150;
    const digest = createHash('sha256')
      .update(`${E}\0${started.operationId}\0shared-key`)
      .digest('hex');
    database.exec(`
      INSERT INTO control_audit_events (
        event_id, environment_id, operation_id, event_type, actor_type, actor_id, resource_kind,
        resource_id, outcome, redacted_payload_json, created_at
      ) VALUES ('tenant-placement:${digest}', '${E}', '${started.operationId}',
        'tenant_placement_migration.source_quarantine', 'admin', 'admin-a',
        'tenant_placement_migration', '${started.operationId}', 'succeeded', '{}', 100)`);
    await service.approvePurge(E, mutation(started.operationId, { idempotencyKey: 'shared-key' }));
    expect(
      database
        .prepare(
          "SELECT event_id FROM control_audit_events WHERE event_type = 'tenant_placement_migration.source_purge_approved'"
        )
        .get()
    ).toEqual({ event_id: `tenant-placement:${digest}:source_purge_approved` });
  });

  it('exposes the approval only from the retention expiry onwards', async () => {
    const started = await quarantined();
    now = 149;
    expect((await service.get(E, started.operationId))?.canApprovePurge).toBe(false);
    now = 150;
    expect((await service.get(E, started.operationId))?.canApprovePurge).toBe(true);
    expect((await service.get(E, started.operationId))?.sourceRetentionExpiresAt).toBe(150);
  });

  it('refuses a purge for a migration whose retention is not recorded', async () => {
    const started = await quarantined();
    database.exec(
      'UPDATE control_tenant_placement_migrations SET source_retention_expires_at = NULL'
    );
    await expect(service.approvePurge(E, mutation(started.operationId))).rejects.toThrow(
      'control_tenant_placement_migration_purge_not_allowed'
    );
  });
});

describe('migration view metadata', () => {
  it('maps a provisioned target shard into the view', async () => {
    const started = await service.start(E, START);
    dropTriggers(database);
    database.exec('PRAGMA foreign_keys = OFF');
    provisionTarget(0);
    const view = await service.get(E, started.operationId);
    expect(view?.shards[0]?.target).toEqual({
      shardId: 'target-0',
      assignmentGeneration: 2,
      routeGeneration: 5,
      bindingRef: 'TDB_TARGET_0',
      databaseId: 'provider-target-0',
      databaseName: 'db-target-0',
    });
    database.exec(
      "UPDATE control_tenant_shards SET binding_ref = 'lower' WHERE shard_id = 'target-0'"
    );
    await expect(service.get(E, started.operationId)).rejects.toThrow(
      'control_tenant_placement_migration_target_metadata_invalid'
    );
  });
});
