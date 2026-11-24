import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';
import { controlDatabase, d1Over, dropTriggers } from './support/sqlite-d1';

const ENV = 'env-test';
const SOURCE = 'tenant-create-route';
let database: DatabaseSync;
let repository: D1ControlRepository;

beforeEach(() => {
  database = controlDatabase();
  dropTriggers(database);
  repository = new D1ControlRepository(d1Over(database));
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('${ENV}', 'test', 'urn:authrim:control:${ENV}', 'active', 1, 1);
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, updated_at
    ) VALUES ('${SOURCE}', '${ENV}', 'tenant_create', '${SOURCE}', 'running', 'admin', 1, 10, 10);
    INSERT INTO control_tenant_placement_policies (
      environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
      source_operation_id, idempotency_key, created_at, updated_at
    ) VALUES ('${ENV}', 'tenant-route', 'tenant_exclusive', 1, 'provisioning',
              '${SOURCE}', 'tenant-route-policy', 10, 10);
    INSERT INTO control_tenant_shard_assignments (
      environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
      shard_id, assignment_generation, assignment_state, source_operation_id,
      created_at, activated_at, updated_at
    ) VALUES
      ('${ENV}', 'tenant-route', 'tenant_core/default', 'default', 'jp', 'shard-default', 1,
       'active', '${SOURCE}', 10, 10, 10),
      ('${ENV}', 'tenant-route', 'tenant_core/users', 'default', 'jp', 'shard-users', 1,
       'active', '${SOURCE}', 10, 10, 10),
      ('${ENV}', 'tenant-route', 'tenant_pii', 'default', 'jp', 'shard-pii', 1,
       'active', '${SOURCE}', 10, 10, 10);
    INSERT INTO control_tenant_default_allocations (
      allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
      selected_shard_id, reservation_state, idempotency_key, route_generation,
      capacity_counted_at, created_at, committed_at, updated_at
    ) VALUES ('allocation', '${ENV}', 'tenant-route', 'default', 'jp', 'shard-default',
              'committed', 'allocation', 4, 10, 10, 10, 10);`);
  for (const [id, role, binding] of [
    ['shard-default', 'tenant_core/default', 'TDB_DEFAULT'],
    ['shard-users', 'tenant_core/users', 'TDB_USERS'],
    ['shard-pii', 'tenant_pii', 'TDB_PII'],
  ] as const) {
    database
      .prepare(
        `INSERT INTO control_tenant_shards (
           shard_id, environment_id, data_role, residency_policy_id, residency_partition,
           generation, logical_shard_id, binding_ref, d1_desired_resource_id, location_hint,
           status, created_at, updated_at, allocation_scope, owner_tenant_id
         ) VALUES (?, ?, ?, 'default', 'jp', 4, ?, ?, ?, 'apac', 'active', 10, 10,
                   'tenant_exclusive', 'tenant-route')`
      )
      .run(id, ENV, role, `logical-${id}`, binding, `desired-${id}`);
  }
});

const targets = () => [
  {
    dataRole: 'tenant_core/default' as const,
    shardId: 'shard-default',
    bindingRef: 'TDB_DEFAULT',
    generation: 4,
  },
  {
    dataRole: 'tenant_core/users' as const,
    shardId: 'shard-users',
    bindingRef: 'TDB_USERS',
    generation: 4,
  },
  { dataRole: 'tenant_pii' as const, shardId: 'shard-pii', bindingRef: 'TDB_PII', generation: 4 },
];

function request(patch: { targets?: ReturnType<typeof targets>; runtimeGeneration?: number } = {}) {
  return {
    environmentId: ENV,
    tenantId: 'tenant-route',
    sourceOperationId: SOURCE,
    idempotencyKey: 'activation-1',
    runtimeRoute: {
      runtimeGeneration: patch.runtimeGeneration ?? 4,
      registryPublicationGeneration: 6,
      tenantLifecycleState: 'active' as const,
      routeStatus: 'active' as const,
      targets: patch.targets ?? targets(),
    },
  };
}

const row = (sql: string) => database.prepare(sql).get();

describe('tenant placement policy registration', () => {
  const input = {
    environmentId: ENV,
    tenantId: 'tenant-new',
    isolationPolicy: 'shared_pool' as const,
    sourceOperationId: 'op-new',
    idempotencyKey: 'key-new',
  };

  it('registers a provisioning policy and audits it', async () => {
    await expect(repository.registerTenantPlacementPolicy(input, 50)).resolves.toEqual({
      tenantId: 'tenant-new',
      isolationPolicy: 'shared_pool',
      policyGeneration: 1,
      state: 'provisioning',
      pendingIsolationPolicy: null,
      pendingPolicyGeneration: null,
      migrationOperationId: null,
      sourceOperationId: 'op-new',
      createdAt: 50,
      updatedAt: 50,
    });
    expect(
      row(
        `SELECT event_id, event_type, actor_type, resource_kind, resource_id, outcome,
                redacted_payload_json, created_at FROM control_audit_events
          WHERE event_type = 'control.tenant_placement.registered'`
      )
    ).toEqual({
      event_id: 'audit:tenant-placement:env-test:tenant-new',
      event_type: 'control.tenant_placement.registered',
      actor_type: 'ar-management',
      resource_kind: 'tenant_placement_policy',
      resource_id: 'tenant-new',
      outcome: 'succeeded',
      redacted_payload_json: JSON.stringify({ isolation_policy: 'shared_pool' }),
      created_at: 50,
    });
  });

  it('replays an identical registration without changing timestamps', async () => {
    await repository.registerTenantPlacementPolicy(input, 50);
    await expect(repository.registerTenantPlacementPolicy(input, 90)).resolves.toMatchObject({
      createdAt: 50,
      updatedAt: 50,
    });
    expect(row('SELECT COUNT(*) AS n FROM control_audit_events')).toEqual({ n: 1 });
  });

  it.each([
    ['isolation policy', { isolationPolicy: 'tenant_exclusive' as const }],
    ['source operation', { sourceOperationId: 'op-other' }],
    ['idempotency key', { idempotencyKey: 'key-other' }],
  ])('conflicts when a replay changes the %s', async (_label, patch) => {
    await repository.registerTenantPlacementPolicy(input, 50);
    await expect(
      repository.registerTenantPlacementPolicy({ ...input, ...patch }, 60)
    ).rejects.toThrow('control_tenant_placement_policy_conflict');
  });

  it('conflicts when another tenant already owns the idempotency key', async () => {
    await repository.registerTenantPlacementPolicy(input, 50);
    await expect(
      repository.registerTenantPlacementPolicy({ ...input, tenantId: 'tenant-two' }, 60)
    ).rejects.toThrow('control_tenant_placement_policy_conflict');
  });
});

describe('tenant placement activation', () => {
  it('creates the route, observation operation and audit evidence once', async () => {
    await expect(repository.activateTenantPlacementPolicy(request(), 20)).resolves.toMatchObject({
      state: 'active',
      tenantId: 'tenant-route',
      updatedAt: 20,
    });
    expect(
      row(
        `SELECT route_generation, tenant_lifecycle_generation, quarantine_deny_generation,
                registry_publication_generation, tenant_lifecycle_state, route_status,
                residency_policy_id, route_projection_json, created_at, updated_at
           FROM control_runtime_registry_routes`
      )
    ).toEqual({
      route_generation: 4,
      tenant_lifecycle_generation: 1,
      quarantine_deny_generation: 0,
      registry_publication_generation: 6,
      tenant_lifecycle_state: 'active',
      route_status: 'active',
      residency_policy_id: 'default',
      route_projection_json: JSON.stringify({
        targets: [
          {
            dataRole: 'tenant_core/default',
            residencyPartition: 'jp',
            shardId: 'shard-default',
            bindingRef: 'TDB_DEFAULT',
            generation: 4,
          },
          {
            dataRole: 'tenant_core/users',
            residencyPartition: 'jp',
            shardId: 'shard-users',
            bindingRef: 'TDB_USERS',
            generation: 4,
          },
          {
            dataRole: 'tenant_pii',
            residencyPartition: 'jp',
            shardId: 'shard-pii',
            bindingRef: 'TDB_PII',
            generation: 4,
          },
        ],
      }),
      created_at: 20,
      updated_at: 20,
    });
    expect(
      row(
        `SELECT operation_kind, status, requested_by_type, requested_by_id, attempt_count,
                created_at, started_at, completed_at, updated_at, idempotency_key
           FROM control_operations WHERE operation_kind = 'tenant_runtime_route_observation'`
      )
    ).toMatchObject({
      status: 'succeeded',
      requested_by_type: 'admin',
      requested_by_id: 'ar-management',
      attempt_count: 1,
      created_at: 20,
      started_at: 20,
      completed_at: 20,
      updated_at: 20,
    });
    expect(
      row(
        `SELECT event_id, event_type, actor_type, resource_kind, resource_id, outcome,
                redacted_payload_json, created_at FROM control_audit_events
          WHERE event_type = 'control.tenant_placement.activated'`
      )
    ).toEqual({
      event_id: 'audit:tenant-placement-activation:env-test:activation-1',
      event_type: 'control.tenant_placement.activated',
      actor_type: 'ar-management',
      resource_kind: 'tenant_placement_policy',
      resource_id: 'tenant-route',
      outcome: 'succeeded',
      redacted_payload_json: JSON.stringify({
        tenant_id: 'tenant-route',
        source_operation_id: SOURCE,
        runtime_generation: 4,
        target_count: 3,
      }),
      created_at: 20,
    });
    expect(row('SELECT activated_at FROM control_tenant_placement_policies')).toEqual({
      activated_at: 20,
    });
  });

  it('accepts the observed targets in any order', async () => {
    await expect(
      repository.activateTenantPlacementPolicy(request({ targets: targets().reverse() }), 20)
    ).resolves.toMatchObject({ state: 'active' });
  });

  it.each([
    ['too few targets', (list: ReturnType<typeof targets>) => list.slice(0, 2)],
    ['too many targets', (list: ReturnType<typeof targets>) => [...list, ...list.slice(0, 1)]],
    [
      'a data role mismatch',
      (list: ReturnType<typeof targets>) =>
        list.map((entry, index) =>
          index === 1 ? { ...entry, dataRole: 'tenant_core/default' as const } : entry
        ),
    ],
    [
      'a shard mismatch',
      (list: ReturnType<typeof targets>) =>
        list.map((entry, index) => (index === 0 ? { ...entry, shardId: 'x' } : entry)),
    ],
    [
      'a binding mismatch',
      (list: ReturnType<typeof targets>) =>
        list.map((entry, index) => (index === 2 ? { ...entry, bindingRef: 'X' } : entry)),
    ],
    [
      'a generation mismatch',
      (list: ReturnType<typeof targets>) =>
        list.map((entry, index) => (index === 2 ? { ...entry, generation: 5 } : entry)),
    ],
  ])('rejects %s', async (_label, mutate) => {
    await expect(
      repository.activateTenantPlacementPolicy(request({ targets: mutate(targets()) }), 20)
    ).rejects.toThrow('control_tenant_runtime_route_observation_mismatch');
    expect(row('SELECT policy_state FROM control_tenant_placement_policies')).toEqual({
      policy_state: 'provisioning',
    });
  });

  it('rejects assignments spanning more than one residency policy', async () => {
    database.exec(
      "UPDATE control_tenant_shard_assignments SET residency_policy_id = 'other' WHERE data_role = 'tenant_pii'"
    );
    await expect(repository.activateTenantPlacementPolicy(request(), 20)).rejects.toThrow(
      'control_tenant_runtime_route_observation_mismatch'
    );
  });

  it('ignores inactive assignments and unavailable shards', async () => {
    database.exec(`
      INSERT INTO control_tenant_shard_assignments (
        environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
        shard_id, assignment_generation, assignment_state, source_operation_id,
        created_at, retired_at, updated_at
      ) VALUES ('${ENV}', 'tenant-route', 'tenant_pii', 'default', 'jp', 'shard-old', 2,
                'retired', '${SOURCE}', 1, 1, 1)`);
    await expect(repository.activateTenantPlacementPolicy(request(), 20)).resolves.toMatchObject({
      state: 'active',
    });
    database.exec(
      "UPDATE control_tenant_shards SET status = 'failed' WHERE shard_id = 'shard-pii'"
    );
    await expect(repository.activateTenantPlacementPolicy(request(), 21)).rejects.toThrow(
      'control_tenant_runtime_route_observation_mismatch'
    );
  });

  it.each([['a different runtime generation', request({ runtimeGeneration: 5 })]])(
    'rejects %s',
    async (_label, input) => {
      await expect(repository.activateTenantPlacementPolicy(input, 20)).rejects.toThrow(
        'control_tenant_runtime_route_generation_mismatch'
      );
    }
  );

  it('rejects activation without a committed default allocation', async () => {
    database.exec('DELETE FROM control_tenant_default_allocations');
    await expect(repository.activateTenantPlacementPolicy(request(), 20)).rejects.toThrow(
      'control_tenant_runtime_route_generation_mismatch'
    );
  });

  it('rejects activation for a policy owned by another source operation', async () => {
    await expect(
      repository.activateTenantPlacementPolicy({ ...request(), sourceOperationId: 'other' }, 20)
    ).rejects.toThrow('control_tenant_placement_policy_activation_conflict');
  });

  it.each([
    ['registry publication generation', 'registry_publication_generation = 9'],
    ['residency policy', "residency_policy_id = 'other'"],
    ['projection', 'route_projection_json = \'{"targets":[]}\''],
    ['route generation', 'route_generation = 3'],
  ])('rejects a recorded route with a different %s', async (_label, assignment) => {
    await repository.activateTenantPlacementPolicy(request(), 20);
    database.exec(`UPDATE control_runtime_registry_routes SET ${assignment}`);
    await expect(repository.activateTenantPlacementPolicy(request(), 21)).rejects.toThrow(
      'control_tenant_runtime_route_observation_conflict'
    );
  });

  it.each([
    ['lifecycle state', { tenantLifecycleState: 'quarantined' }],
    ['route status', { routeStatus: 'disabled' }],
  ])(
    'rejects an observation with a different %s than the recorded route',
    async (_label, patch) => {
      await repository.activateTenantPlacementPolicy(request(), 20);
      const base = request();
      await expect(
        repository.activateTenantPlacementPolicy(
          { ...base, runtimeRoute: { ...base.runtimeRoute, ...patch } } as typeof base,
          21
        )
      ).rejects.toThrow('control_tenant_runtime_route_observation_conflict');
    }
  );

  it('rejects a recorded route whose source is not a succeeded observation', async () => {
    await repository.activateTenantPlacementPolicy(request(), 20);
    database.exec(
      "UPDATE control_operations SET status = 'running', completed_at = NULL WHERE operation_kind = 'tenant_runtime_route_observation'"
    );
    await expect(repository.activateTenantPlacementPolicy(request(), 21)).rejects.toThrow(
      'control_tenant_runtime_route_observation_conflict'
    );
  });
});
