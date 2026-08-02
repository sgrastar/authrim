import {
  assertControlPlaneRecordIsSecretFree,
  type ControlAccountDataRole,
  type ControlAccountRouteAllocationRequest,
  type ControlAccountRouteAllocationResult,
  type ControlAccountRouteAllocationTarget,
} from '@authrim/ar-lib-core/control-plane';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const ACCOUNT_DATA_ROLES = new Set<ControlAccountDataRole>(['tenant_core/users', 'tenant_pii']);

interface AccountAllocationRow {
  allocation_id: string;
  environment_id: string;
  tenant_id: string;
  account_id_blind_digest: string;
  data_role: ControlAccountDataRole;
  residency_partition: string;
  selected_shard_id: string;
  binding_ref: string;
  route_generation: number | string;
  idempotency_key: string;
}

interface AccountAllocationPlan {
  allocationId: string;
  environmentId: string;
  tenantId: string;
  accountIdBlindDigest: string;
  dataRole: ControlAccountDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
}

function requiredId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function requiredPartition(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_PARTITION.test(value)) {
    throw new Error('invalid_residency_partition');
  }
  return value;
}

function parseRequest(value: unknown): ControlAccountRouteAllocationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_account_route_allocation_request');
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.accountIdBlindDigest !== 'string' ||
    !HEX_DIGEST.test(input.accountIdBlindDigest)
  ) {
    throw new Error('invalid_account_id_blind_digest');
  }
  if (!Array.isArray(input.dataRoles) || input.dataRoles.length < 1 || input.dataRoles.length > 2) {
    throw new Error('invalid_account_route_data_roles');
  }
  const dataRoles = input.dataRoles.map((role) => {
    if (typeof role !== 'string' || !ACCOUNT_DATA_ROLES.has(role as ControlAccountDataRole)) {
      throw new Error('invalid_account_route_data_roles');
    }
    return role as ControlAccountDataRole;
  });
  if (new Set(dataRoles).size !== dataRoles.length) {
    throw new Error('invalid_account_route_data_roles');
  }
  return {
    tenantId: requiredId(input.tenantId, 'invalid_tenant_id'),
    accountIdBlindDigest: input.accountIdBlindDigest,
    residencyPolicyId: requiredId(input.residencyPolicyId, 'invalid_residency_policy_id'),
    residencyPartition: requiredPartition(input.residencyPartition),
    idempotencyKey: requiredId(input.idempotencyKey, 'invalid_idempotency_key'),
    dataRoles: [...dataRoles].sort(),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toTarget(row: AccountAllocationRow): ControlAccountRouteAllocationTarget {
  const routeGeneration =
    typeof row.route_generation === 'number' ? row.route_generation : Number(row.route_generation);
  if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 1) {
    throw new Error('control_account_allocation_invalid');
  }
  return {
    allocationId: row.allocation_id,
    dataRole: row.data_role,
    residencyPartition: row.residency_partition,
    shardId: row.selected_shard_id,
    bindingRef: row.binding_ref,
    routeGeneration,
  };
}

export class D1AccountAllocationRepository {
  constructor(private readonly db: D1Database) {}

  private getByAccount(plan: AccountAllocationPlan): Promise<AccountAllocationRow | null> {
    return this.db
      .prepare(
        `SELECT a.allocation_id, a.environment_id, a.tenant_id,
                a.account_id_blind_digest, a.data_role, a.residency_partition,
                a.selected_shard_id, s.binding_ref, a.route_generation, a.idempotency_key
           FROM control_tenant_shard_allocations a
           JOIN control_tenant_shards s
             ON s.shard_id = a.selected_shard_id AND s.environment_id = a.environment_id
           JOIN control_tenant_placement_policies policy
             ON policy.environment_id = a.environment_id AND policy.tenant_id = a.tenant_id
           JOIN control_tenant_shard_assignments assignment
             ON assignment.environment_id = a.environment_id
            AND assignment.tenant_id = a.tenant_id
            AND assignment.data_role = a.data_role
            AND assignment.residency_partition = a.residency_partition
            AND assignment.shard_id = a.selected_shard_id
            AND assignment.assignment_state = 'active'
          WHERE a.environment_id = ? AND a.tenant_id = ? AND a.data_role = ?
            AND a.residency_partition = ? AND a.account_id_blind_digest = ?
            AND a.reservation_state IN ('reserved', 'committed')
            AND policy.policy_state IN ('provisioning', 'active', 'migrating')
            AND s.data_role = a.data_role AND s.residency_partition = a.residency_partition
            AND s.generation = a.route_generation
            AND (
              (policy.isolation_policy = 'shared_pool'
               AND s.allocation_scope = 'shared_pool' AND s.owner_tenant_id IS NULL) OR
              (policy.isolation_policy = 'tenant_exclusive'
               AND s.allocation_scope = 'tenant_exclusive'
               AND s.owner_tenant_id = a.tenant_id)
            )`
      )
      .bind(
        plan.environmentId,
        plan.tenantId,
        plan.dataRole,
        plan.residencyPartition,
        plan.accountIdBlindDigest
      )
      .first<AccountAllocationRow>();
  }

  private getByIdempotency(plan: AccountAllocationPlan): Promise<AccountAllocationRow | null> {
    return this.db
      .prepare(
        `SELECT a.allocation_id, a.environment_id, a.tenant_id,
                a.account_id_blind_digest, a.data_role, a.residency_partition,
                a.selected_shard_id, s.binding_ref, a.route_generation, a.idempotency_key
           FROM control_tenant_shard_allocations a
           JOIN control_tenant_shards s
             ON s.shard_id = a.selected_shard_id AND s.environment_id = a.environment_id
           JOIN control_tenant_placement_policies policy
             ON policy.environment_id = a.environment_id AND policy.tenant_id = a.tenant_id
           JOIN control_tenant_shard_assignments assignment
             ON assignment.environment_id = a.environment_id
            AND assignment.tenant_id = a.tenant_id
            AND assignment.data_role = a.data_role
            AND assignment.residency_partition = a.residency_partition
            AND assignment.shard_id = a.selected_shard_id
            AND assignment.assignment_state = 'active'
          WHERE a.environment_id = ? AND a.tenant_id = ? AND a.data_role = ?
            AND a.residency_partition = ? AND a.idempotency_key = ?
            AND policy.policy_state IN ('provisioning', 'active', 'migrating')
            AND s.data_role = a.data_role AND s.residency_partition = a.residency_partition
            AND (
              (policy.isolation_policy = 'shared_pool'
               AND s.allocation_scope = 'shared_pool' AND s.owner_tenant_id IS NULL) OR
              (policy.isolation_policy = 'tenant_exclusive'
               AND s.allocation_scope = 'tenant_exclusive'
               AND s.owner_tenant_id = a.tenant_id)
            )`
      )
      .bind(
        plan.environmentId,
        plan.tenantId,
        plan.dataRole,
        plan.residencyPartition,
        plan.idempotencyKey
      )
      .first<AccountAllocationRow>();
  }

  private assertMatches(row: AccountAllocationRow, plan: AccountAllocationPlan): void {
    if (
      row.environment_id !== plan.environmentId ||
      row.tenant_id !== plan.tenantId ||
      row.account_id_blind_digest !== plan.accountIdBlindDigest ||
      row.data_role !== plan.dataRole ||
      row.residency_partition !== plan.residencyPartition
    ) {
      throw new Error('control_account_allocation_idempotency_conflict');
    }
  }

  async allocate(plan: AccountAllocationPlan, now: number): Promise<AccountAllocationRow> {
    const [byAccount, byIdempotency] = await Promise.all([
      this.getByAccount(plan),
      this.getByIdempotency(plan),
    ]);
    if (byIdempotency) this.assertMatches(byIdempotency, plan);
    if (byAccount) return byAccount;

    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_tenant_shard_allocations (
             allocation_id, environment_id, tenant_id, account_id_blind_digest,
             data_role, residency_partition, selected_shard_id, reservation_state,
             idempotency_key, route_generation, capacity_counted_at, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, candidate.shard_id, 'reserved', ?, candidate.generation,
                  NULL, ?, ?
             FROM (
               SELECT s.shard_id, s.generation
                 FROM control_tenant_shard_assignments assignment
                 JOIN control_tenant_shards s
                   ON s.environment_id = assignment.environment_id
                  AND s.shard_id = assignment.shard_id
                 JOIN control_shard_capacity c ON c.shard_id = s.shard_id
                 JOIN control_tenant_placement_policies policy
                   ON policy.environment_id = assignment.environment_id
                  AND policy.tenant_id = assignment.tenant_id
                WHERE assignment.environment_id = ? AND assignment.tenant_id = ?
                  AND assignment.data_role = ? AND assignment.residency_policy_id = ?
                  AND assignment.residency_partition = ?
                  AND assignment.assignment_state = 'active'
                  AND s.environment_id = ? AND s.data_role = ?
                  AND s.residency_policy_id = ? AND s.residency_partition = ?
                  AND policy.policy_state IN ('provisioning', 'active', 'migrating')
                  AND (
                    (policy.isolation_policy = 'shared_pool'
                     AND s.allocation_scope = 'shared_pool' AND s.owner_tenant_id IS NULL) OR
                    (policy.isolation_policy = 'tenant_exclusive'
                     AND s.allocation_scope = 'tenant_exclusive'
                     AND s.owner_tenant_id = assignment.tenant_id)
                  )
                  AND s.status = 'active' AND c.health_status = 'healthy'
                  AND c.allocation_status = 'eligible'
                  AND c.allocated_account_count < c.target_account_count
                ORDER BY (1.0 * c.allocated_account_count / c.target_account_count),
                         c.allocated_account_count, s.shard_id
                LIMIT 1
             ) candidate`
        )
        .bind(
          plan.allocationId,
          plan.environmentId,
          plan.tenantId,
          plan.accountIdBlindDigest,
          plan.dataRole,
          plan.residencyPartition,
          plan.idempotencyKey,
          now,
          now,
          plan.environmentId,
          plan.tenantId,
          plan.dataRole,
          plan.residencyPolicyId,
          plan.residencyPartition,
          plan.environmentId,
          plan.dataRole,
          plan.residencyPolicyId,
          plan.residencyPartition
        ),
      this.db
        .prepare(
          `UPDATE control_shard_capacity
              SET allocated_account_count = allocated_account_count + 1, updated_at = ?
            WHERE shard_id = (
              SELECT selected_shard_id FROM control_tenant_shard_allocations
               WHERE allocation_id = ? AND capacity_counted_at IS NULL
            )`
        )
        .bind(now, plan.allocationId),
      this.db
        .prepare(
          `UPDATE control_tenant_shard_allocations
              SET capacity_counted_at = ?, updated_at = ?
            WHERE allocation_id = ? AND capacity_counted_at IS NULL`
        )
        .bind(now, now, plan.allocationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, event_type, actor_type, resource_kind,
             resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, ?, 'control.account_route.allocated', 'ar-management',
                  'tenant_shard_allocation', ?, 'succeeded', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM control_tenant_shard_allocations WHERE allocation_id = ?
            )`
        )
        .bind(
          `audit:${plan.allocationId}:allocated`,
          plan.environmentId,
          plan.allocationId,
          JSON.stringify({
            data_role: plan.dataRole,
            residency_partition: plan.residencyPartition,
          }),
          now,
          plan.allocationId
        ),
    ]);

    const result = (await this.getByAccount(plan)) ?? (await this.getByIdempotency(plan));
    if (!result) throw new Error('control_account_allocation_capacity_unavailable');
    this.assertMatches(result, plan);
    return result;
  }
}

export class ControlAccountAllocationService {
  constructor(
    private readonly repository: D1AccountAllocationRepository,
    private readonly now: () => number
  ) {}

  async allocate(
    input: unknown,
    environmentId: string
  ): Promise<ControlAccountRouteAllocationResult> {
    const safeEnvironmentId = requiredId(environmentId, 'invalid_environment_id');
    const request = parseRequest(input);
    const targets: ControlAccountRouteAllocationTarget[] = [];
    for (const dataRole of request.dataRoles) {
      const digest = await sha256(
        [
          safeEnvironmentId,
          request.tenantId,
          request.accountIdBlindDigest,
          dataRole,
          request.residencyPartition,
        ].join('\0')
      );
      targets.push(
        toTarget(
          await this.repository.allocate(
            {
              allocationId: `allocation_${digest.slice(0, 32)}`,
              environmentId: safeEnvironmentId,
              tenantId: request.tenantId,
              accountIdBlindDigest: request.accountIdBlindDigest,
              dataRole,
              residencyPolicyId: request.residencyPolicyId,
              residencyPartition: request.residencyPartition,
              idempotencyKey: request.idempotencyKey,
            },
            this.now()
          )
        )
      );
    }
    const result: ControlAccountRouteAllocationResult = {
      tenantId: request.tenantId,
      residencyPolicyId: request.residencyPolicyId,
      targets: targets.sort((left, right) => left.dataRole.localeCompare(right.dataRole)),
    };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }
}
