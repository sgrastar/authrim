import {
  assertControlPlaneRecordIsSecretFree,
  type ControlTenantDefaultRouteAllocation,
  type ControlTenantDefaultRouteReservationRequest,
} from '@authrim/ar-lib-core/control-plane';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;

interface AllocationRow {
  allocation_id: string;
  environment_id: string;
  tenant_id: string;
  residency_policy_id: string;
  residency_partition: string;
  selected_shard_id: string;
  reservation_state: 'reserved' | 'committed' | 'released';
  idempotency_key: string;
  route_generation: number | string;
  binding_ref: string;
  provider_resource_id: string;
  deterministic_name: string;
  allocation_scope: 'shared_pool' | 'tenant_exclusive';
  owner_tenant_id: string | null;
  assignment_generation: number | string;
}

function requiredId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function parseReservation(input: unknown): ControlTenantDefaultRouteReservationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_tenant_default_route_reservation');
  }
  const value = input as Record<string, unknown>;
  const keys = ['tenantId', 'residencyPolicyId', 'residencyPartition', 'idempotencyKey'];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error('invalid_tenant_default_route_reservation');
  }
  if (
    typeof value.residencyPartition !== 'string' ||
    !SAFE_PARTITION.test(value.residencyPartition)
  ) {
    throw new Error('invalid_residency_partition');
  }
  return {
    tenantId: requiredId(value.tenantId, 'invalid_tenant_id'),
    residencyPolicyId: requiredId(value.residencyPolicyId, 'invalid_residency_policy_id'),
    residencyPartition: value.residencyPartition,
    idempotencyKey: requiredId(value.idempotencyKey, 'invalid_idempotency_key'),
  };
}

function routeGeneration(row: AllocationRow): number {
  const value =
    typeof row.route_generation === 'number' ? row.route_generation : Number(row.route_generation);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('control_tenant_default_allocation_invalid');
  }
  return value;
}

function assignmentGeneration(row: AllocationRow): number {
  const value =
    typeof row.assignment_generation === 'number'
      ? row.assignment_generation
      : Number(row.assignment_generation);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('control_tenant_default_allocation_invalid');
  }
  return value;
}

function allocation(row: AllocationRow): ControlTenantDefaultRouteAllocation {
  const result: ControlTenantDefaultRouteAllocation = {
    allocationId: row.allocation_id,
    tenantId: row.tenant_id,
    state: row.reservation_state,
    target: {
      shardId: row.selected_shard_id,
      dataRole: 'tenant_core/default',
      residencyPolicyId: row.residency_policy_id,
      residencyPartition: row.residency_partition,
      routeGeneration: routeGeneration(row),
      bindingRef: row.binding_ref,
      databaseId: row.provider_resource_id,
      databaseName: row.deterministic_name,
      allocationScope: row.allocation_scope,
      ownerTenantId: row.owner_tenant_id,
      assignmentGeneration: assignmentGeneration(row),
    },
  };
  assertControlPlaneRecordIsSecretFree(result);
  return result;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class TenantDefaultAllocationService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number
  ) {}

  private get(environmentId: string, column: 'allocation_id' | 'idempotency_key', value: string) {
    return this.db
      .prepare(
        `SELECT allocation.allocation_id, allocation.environment_id, allocation.tenant_id,
                allocation.residency_policy_id, allocation.residency_partition,
                allocation.selected_shard_id, allocation.reservation_state,
                allocation.idempotency_key, allocation.route_generation, shard.binding_ref,
                observed.provider_resource_id, desired.deterministic_name,
                shard.allocation_scope, shard.owner_tenant_id, assignment.assignment_generation
           FROM control_tenant_default_allocations allocation
           JOIN control_tenant_shards shard
             ON shard.shard_id = allocation.selected_shard_id
            AND shard.environment_id = allocation.environment_id
           JOIN control_tenant_placement_policies policy
             ON policy.environment_id = allocation.environment_id
            AND policy.tenant_id = allocation.tenant_id
           JOIN control_tenant_shard_assignments assignment
             ON assignment.environment_id = allocation.environment_id
            AND assignment.tenant_id = allocation.tenant_id
            AND assignment.data_role = 'tenant_core/default'
            AND assignment.residency_policy_id = allocation.residency_policy_id
            AND assignment.residency_partition = allocation.residency_partition
            AND assignment.shard_id = allocation.selected_shard_id
            AND assignment.assignment_state = 'active'
           JOIN control_desired_resources desired
             ON desired.desired_resource_id = shard.d1_desired_resource_id
            AND desired.environment_id = shard.environment_id
           JOIN control_observed_resources observed
             ON observed.observed_resource_id = desired.observed_resource_id
            AND observed.environment_id = shard.environment_id
          WHERE allocation.environment_id = ? AND allocation.${column} = ?
            AND policy.policy_state IN ('provisioning', 'active', 'migrating')
            AND shard.data_role = 'tenant_core/default'
            AND shard.residency_policy_id = allocation.residency_policy_id
            AND shard.residency_partition = allocation.residency_partition
            AND shard.generation = allocation.route_generation
            AND (
              (policy.isolation_policy = 'shared_pool'
               AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
              (policy.isolation_policy = 'tenant_exclusive'
               AND shard.allocation_scope = 'tenant_exclusive'
               AND shard.owner_tenant_id = allocation.tenant_id)
            )`
      )
      .bind(environmentId, value)
      .first<AllocationRow>();
  }

  async reserve(
    input: unknown,
    environmentId: string
  ): Promise<ControlTenantDefaultRouteAllocation> {
    const safeEnvironmentId = requiredId(environmentId, 'invalid_environment_id');
    const request = parseReservation(input);
    const id = await digest(
      [
        safeEnvironmentId,
        request.tenantId,
        request.residencyPolicyId,
        request.residencyPartition,
      ].join('\0')
    );
    const allocationId = `tenant_default_${id.slice(0, 32)}`;
    const now = this.now();
    const existing = await this.get(safeEnvironmentId, 'idempotency_key', request.idempotencyKey);
    if (existing) {
      if (
        existing.tenant_id !== request.tenantId ||
        existing.residency_policy_id !== request.residencyPolicyId ||
        existing.residency_partition !== request.residencyPartition
      ) {
        throw new Error('control_tenant_default_allocation_idempotency_conflict');
      }
      return allocation(existing);
    }
    const prior = await this.get(safeEnvironmentId, 'allocation_id', allocationId);
    if (prior && prior.reservation_state !== 'released') return allocation(prior);

    if (prior) {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE control_tenant_default_allocations
                SET selected_shard_id = (
                      SELECT shard.shard_id
                        FROM control_tenant_shards shard
                        JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
                        JOIN control_tenant_shard_assignments assignment
                          ON assignment.environment_id = shard.environment_id
                         AND assignment.tenant_id = ?
                         AND assignment.data_role = 'tenant_core/default'
                         AND assignment.residency_policy_id = shard.residency_policy_id
                         AND assignment.residency_partition = shard.residency_partition
                         AND assignment.shard_id = shard.shard_id
                         AND assignment.assignment_state = 'active'
                        JOIN control_tenant_placement_policies policy
                          ON policy.environment_id = assignment.environment_id
                         AND policy.tenant_id = assignment.tenant_id
                       WHERE shard.environment_id = ? AND shard.data_role = 'tenant_core/default'
                         AND shard.residency_policy_id = ? AND shard.residency_partition = ?
                         AND shard.status = 'active' AND capacity.health_status = 'healthy'
                         AND capacity.allocation_status = 'eligible'
                         AND capacity.allocated_account_count < capacity.target_account_count
                         AND policy.policy_state IN ('provisioning', 'active', 'migrating')
                         AND (
                           (policy.isolation_policy = 'shared_pool'
                            AND shard.allocation_scope = 'shared_pool'
                            AND shard.owner_tenant_id IS NULL) OR
                           (policy.isolation_policy = 'tenant_exclusive'
                            AND shard.allocation_scope = 'tenant_exclusive'
                            AND shard.owner_tenant_id = policy.tenant_id)
                         )
                       ORDER BY (1.0 * capacity.allocated_account_count / capacity.target_account_count),
                                capacity.allocated_account_count, shard.shard_id
                       LIMIT 1
                    ),
                    route_generation = (
                      SELECT shard.generation
                        FROM control_tenant_shards shard
                        JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
                        JOIN control_tenant_shard_assignments assignment
                          ON assignment.environment_id = shard.environment_id
                         AND assignment.tenant_id = ?
                         AND assignment.data_role = 'tenant_core/default'
                         AND assignment.residency_policy_id = shard.residency_policy_id
                         AND assignment.residency_partition = shard.residency_partition
                         AND assignment.shard_id = shard.shard_id
                         AND assignment.assignment_state = 'active'
                        JOIN control_tenant_placement_policies policy
                          ON policy.environment_id = assignment.environment_id
                         AND policy.tenant_id = assignment.tenant_id
                       WHERE shard.environment_id = ? AND shard.data_role = 'tenant_core/default'
                         AND shard.residency_policy_id = ? AND shard.residency_partition = ?
                         AND shard.status = 'active' AND capacity.health_status = 'healthy'
                         AND capacity.allocation_status = 'eligible'
                         AND capacity.allocated_account_count < capacity.target_account_count
                         AND policy.policy_state IN ('provisioning', 'active', 'migrating')
                         AND (
                           (policy.isolation_policy = 'shared_pool'
                            AND shard.allocation_scope = 'shared_pool'
                            AND shard.owner_tenant_id IS NULL) OR
                           (policy.isolation_policy = 'tenant_exclusive'
                            AND shard.allocation_scope = 'tenant_exclusive'
                            AND shard.owner_tenant_id = policy.tenant_id)
                         )
                       ORDER BY (1.0 * capacity.allocated_account_count / capacity.target_account_count),
                                capacity.allocated_account_count, shard.shard_id
                       LIMIT 1
                    ),
                    reservation_state = 'reserved', idempotency_key = ?,
                    capacity_counted_at = NULL, committed_at = NULL, released_at = NULL,
                    updated_at = ?
              WHERE environment_id = ? AND allocation_id = ? AND reservation_state = 'released'
                AND EXISTS (
                  SELECT 1
                    FROM control_tenant_shards shard
                    JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
                    JOIN control_tenant_shard_assignments assignment
                      ON assignment.environment_id = shard.environment_id
                     AND assignment.tenant_id = ?
                     AND assignment.data_role = 'tenant_core/default'
                     AND assignment.residency_policy_id = shard.residency_policy_id
                     AND assignment.residency_partition = shard.residency_partition
                     AND assignment.shard_id = shard.shard_id
                     AND assignment.assignment_state = 'active'
                    JOIN control_tenant_placement_policies policy
                      ON policy.environment_id = assignment.environment_id
                     AND policy.tenant_id = assignment.tenant_id
                   WHERE shard.environment_id = ? AND shard.data_role = 'tenant_core/default'
                     AND shard.residency_policy_id = ? AND shard.residency_partition = ?
                     AND shard.status = 'active' AND capacity.health_status = 'healthy'
                     AND capacity.allocation_status = 'eligible'
                     AND capacity.allocated_account_count < capacity.target_account_count
                     AND policy.policy_state IN ('provisioning', 'active', 'migrating')
                     AND (
                       (policy.isolation_policy = 'shared_pool'
                        AND shard.allocation_scope = 'shared_pool'
                        AND shard.owner_tenant_id IS NULL) OR
                       (policy.isolation_policy = 'tenant_exclusive'
                        AND shard.allocation_scope = 'tenant_exclusive'
                        AND shard.owner_tenant_id = policy.tenant_id)
                     )
                )`
          )
          .bind(
            request.tenantId,
            safeEnvironmentId,
            request.residencyPolicyId,
            request.residencyPartition,
            request.tenantId,
            safeEnvironmentId,
            request.residencyPolicyId,
            request.residencyPartition,
            request.idempotencyKey,
            now,
            safeEnvironmentId,
            allocationId,
            request.tenantId,
            safeEnvironmentId,
            request.residencyPolicyId,
            request.residencyPartition
          ),
        this.db
          .prepare(
            `UPDATE control_shard_capacity
                SET allocated_account_count = allocated_account_count + 1, updated_at = ?
              WHERE shard_id = (
                SELECT selected_shard_id FROM control_tenant_default_allocations
                 WHERE allocation_id = ? AND reservation_state = 'reserved'
                   AND capacity_counted_at IS NULL
              )`
          )
          .bind(now, allocationId),
        this.db
          .prepare(
            `UPDATE control_tenant_default_allocations
                SET capacity_counted_at = ?, updated_at = ?
              WHERE allocation_id = ? AND reservation_state = 'reserved'
                AND capacity_counted_at IS NULL`
          )
          .bind(now, now, allocationId),
      ]);
      if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
        throw new Error('control_tenant_default_allocation_capacity_unavailable');
      }
      const reflected = await this.get(safeEnvironmentId, 'allocation_id', allocationId);
      if (!reflected) throw new Error('control_tenant_default_allocation_capacity_unavailable');
      return allocation(reflected);
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_tenant_default_allocations (
             allocation_id, environment_id, tenant_id, residency_policy_id,
             residency_partition, selected_shard_id, reservation_state,
             idempotency_key, route_generation, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, candidate.shard_id, 'reserved', ?, candidate.generation, ?, ?
             FROM (
               SELECT shard.shard_id, shard.generation
                 FROM control_tenant_shards shard
                 JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
                 JOIN control_tenant_shard_assignments assignment
                   ON assignment.environment_id = shard.environment_id
                  AND assignment.tenant_id = ?
                  AND assignment.data_role = 'tenant_core/default'
                  AND assignment.residency_policy_id = shard.residency_policy_id
                  AND assignment.residency_partition = shard.residency_partition
                  AND assignment.shard_id = shard.shard_id
                  AND assignment.assignment_state = 'active'
                 JOIN control_tenant_placement_policies policy
                   ON policy.environment_id = assignment.environment_id
                  AND policy.tenant_id = assignment.tenant_id
                WHERE shard.environment_id = ? AND shard.data_role = 'tenant_core/default'
                  AND shard.residency_policy_id = ? AND shard.residency_partition = ?
                  AND shard.status = 'active' AND capacity.health_status = 'healthy'
                  AND capacity.allocation_status = 'eligible'
                  AND capacity.allocated_account_count < capacity.target_account_count
                  AND policy.policy_state IN ('provisioning', 'active', 'migrating')
                  AND (
                    (policy.isolation_policy = 'shared_pool'
                     AND shard.allocation_scope = 'shared_pool'
                     AND shard.owner_tenant_id IS NULL) OR
                    (policy.isolation_policy = 'tenant_exclusive'
                     AND shard.allocation_scope = 'tenant_exclusive'
                     AND shard.owner_tenant_id = policy.tenant_id)
                  )
                ORDER BY (1.0 * capacity.allocated_account_count / capacity.target_account_count),
                         capacity.allocated_account_count, shard.shard_id
                LIMIT 1
             ) candidate`
        )
        .bind(
          allocationId,
          safeEnvironmentId,
          request.tenantId,
          request.residencyPolicyId,
          request.residencyPartition,
          request.idempotencyKey,
          now,
          now,
          request.tenantId,
          safeEnvironmentId,
          request.residencyPolicyId,
          request.residencyPartition
        ),
      this.db
        .prepare(
          `UPDATE control_shard_capacity
              SET allocated_account_count = allocated_account_count + 1, updated_at = ?
            WHERE shard_id = (
              SELECT selected_shard_id FROM control_tenant_default_allocations
               WHERE allocation_id = ? AND capacity_counted_at IS NULL
            )`
        )
        .bind(now, allocationId),
      this.db
        .prepare(
          `UPDATE control_tenant_default_allocations
              SET capacity_counted_at = ?, updated_at = ?
            WHERE allocation_id = ? AND capacity_counted_at IS NULL`
        )
        .bind(now, now, allocationId),
    ]);
    const reflected = await this.get(safeEnvironmentId, 'allocation_id', allocationId);
    if (!reflected) throw new Error('control_tenant_default_allocation_capacity_unavailable');
    return allocation(reflected);
  }

  async mutate(
    input: unknown,
    environmentId: string,
    action: 'commit' | 'release'
  ): Promise<ControlTenantDefaultRouteAllocation> {
    const safeEnvironmentId = requiredId(environmentId, 'invalid_environment_id');
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid_tenant_default_route_mutation');
    }
    const value = input as Record<string, unknown>;
    if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'allocationId')) {
      throw new Error('invalid_tenant_default_route_mutation');
    }
    const allocationId = requiredId(value.allocationId, 'invalid_allocation_id');
    const before = await this.get(safeEnvironmentId, 'allocation_id', allocationId);
    if (!before) throw new Error('control_tenant_default_allocation_not_found');
    if (before.reservation_state === 'released' && action === 'commit') {
      throw new Error('control_tenant_default_allocation_released');
    }
    const now = this.now();
    if (action === 'commit' && before.reservation_state === 'reserved') {
      await this.db
        .prepare(
          `UPDATE control_tenant_default_allocations
              SET reservation_state = 'committed', committed_at = ?, updated_at = ?
            WHERE environment_id = ? AND allocation_id = ? AND reservation_state = 'reserved'`
        )
        .bind(now, now, safeEnvironmentId, allocationId)
        .run();
    }
    if (action === 'release' && before.reservation_state === 'reserved') {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE control_shard_capacity
                SET allocated_account_count = MAX(allocated_account_count - 1, 0), updated_at = ?
              WHERE shard_id = ? AND EXISTS (
                SELECT 1 FROM control_tenant_default_allocations
                 WHERE environment_id = ? AND allocation_id = ?
                   AND reservation_state = 'reserved' AND capacity_counted_at IS NOT NULL
              )`
          )
          .bind(now, before.selected_shard_id, safeEnvironmentId, allocationId),
        this.db
          .prepare(
            `UPDATE control_tenant_default_allocations
                SET reservation_state = 'released', released_at = ?, updated_at = ?
              WHERE environment_id = ? AND allocation_id = ? AND reservation_state = 'reserved'`
          )
          .bind(now, now, safeEnvironmentId, allocationId),
      ]);
    }
    const reflected = await this.get(safeEnvironmentId, 'allocation_id', allocationId);
    if (!reflected) throw new Error('control_tenant_default_allocation_not_found');
    return allocation(reflected);
  }
}
