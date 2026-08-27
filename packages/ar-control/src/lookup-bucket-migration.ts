import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  nextDirectoryRewriteFencingToken,
  type ControlLookupBucketMigrationBlockRequest,
  type ControlLookupBucketMigrationClaimRequest,
  type ControlLookupBucketMigrationCheckpointRequest,
  type ControlLookupBucketMigrationCompleteRequest,
  type ControlLookupBucketMigrationCutoverRequest,
  type ControlLookupBucketLoadSnapshotRequest,
  type ControlLookupBucketMigrationStartRequest,
  type ControlLookupBucketMigrationState,
  type ControlLookupBucketMigrationView,
  type ControlLookupBucketRouteTarget,
  type ControlLookupBucketWriteRoute,
} from '@authrim/ar-lib-core/control-plane';

const LEASE_SECONDS = 2 * 60;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;

interface AssignmentRow {
  virtual_bucket: number;
  lookup_shard_id: string;
  assignment_generation: number;
  state: 'active' | 'copying' | 'verifying' | 'cutover_pending' | 'blocked';
  target_lookup_shard_id: string | null;
  source_binding_ref: string;
  source_residency_partition: string;
  source_lookup_capacity_domain_id?: string;
}

interface TargetShardRow {
  lookup_shard_id: string;
  binding_ref: string;
  residency_partition: string;
  lookup_capacity_domain_id: string;
  status: string;
}

interface LeaseRow {
  operation_id: string;
  owner_id: string;
  fencing_token: number;
  lease_expires_at: number;
  mutation_started: number;
}

interface MigrationRow {
  operation_id: string;
  environment_id: string;
  virtual_bucket: number;
  source_lookup_shard_id: string;
  target_lookup_shard_id: string;
  source_assignment_generation: number;
  target_assignment_generation: number;
  state: ControlLookupBucketMigrationState;
  backfill_cursor_json: string;
  source_row_count: number | null;
  target_row_count: number | null;
  verification_digest: string | null;
  verification_attempt_count: number;
  cutover_started_at: number | null;
  cutover_registry_generation: number | null;
  grace_expires_at: number | null;
  source_binding_ref: string;
  target_binding_ref: string;
  fencing_token: number;
  lease_expires_at: number;
}

interface OperationIdentityRow {
  operation_id: string;
  operation_kind: string;
}

interface PlanAssignmentRow {
  virtual_bucket: number;
  lookup_shard_id: string;
  assignment_generation: number;
  state: string;
  target_lookup_shard_id: string | null;
}

interface PlanShardRow {
  lookup_shard_id: string;
  residency_partition: string;
  lookup_capacity_domain_id: string;
  capacity_weight: number | string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return db.withSession('first-primary');
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function bucket(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4095) {
    throw new Error('invalid_lookup_bucket_migration_bucket');
  }
  return value as number;
}

async function operationId(input: {
  environmentId: string;
  virtualBucket: number;
  idempotencyKey: string;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${input.environmentId}\0${input.virtualBucket}\0${input.idempotencyKey}`
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
  return `lookup-bucket:${hex}`;
}

function routeTarget(
  lookupShardId: string,
  bindingRef: string,
  assignmentGeneration: number
): ControlLookupBucketRouteTarget {
  if (
    !SAFE_ID.test(lookupShardId) ||
    !SAFE_BINDING.test(bindingRef) ||
    !Number.isSafeInteger(assignmentGeneration) ||
    assignmentGeneration < 1
  ) {
    throw new Error('control_lookup_bucket_route_invalid');
  }
  return { lookupShardId, bindingRef, assignmentGeneration };
}

function validatedCursor(value: string): string {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new Error('invalid_lookup_bucket_migration_cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('invalid_lookup_bucket_migration_cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_lookup_bucket_migration_cursor');
  }
  return JSON.stringify(parsed);
}

function count(value: number | null, code: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

export class LookupBucketMigrationService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number
  ) {}

  async planNextAutomaticMigration(
    environmentId: string,
    input: ControlLookupBucketLoadSnapshotRequest
  ): Promise<ControlLookupBucketMigrationView | null> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    const ownerId = safeId(input.ownerId, 'invalid_lookup_bucket_migration_owner');
    const now = this.now();
    if (
      !Number.isSafeInteger(input.observedAt) ||
      input.observedAt < now - 5 * 60 ||
      input.observedAt > now + 5 ||
      !Array.isArray(input.buckets) ||
      input.buckets.length < 1 ||
      input.buckets.length > 4096
    ) {
      throw new Error('control_lookup_bucket_load_snapshot_invalid');
    }
    const session = primary(this.db);
    const activeRewrite = await session
      .prepare(
        `SELECT operation_id FROM control_lookup_bucket_migrations
          WHERE environment_id = ? AND state <> 'complete' LIMIT 1`
      )
      .bind(environmentId)
      .first<{ operation_id: string }>();
    if (activeRewrite) return null;
    const [assignmentResult, shardResult] = await Promise.all([
      session
        .prepare(
          `SELECT virtual_bucket, lookup_shard_id, assignment_generation, state,
                  target_lookup_shard_id
             FROM control_lookup_bucket_assignments
            WHERE environment_id = ? ORDER BY virtual_bucket`
        )
        .bind(environmentId)
        .all<PlanAssignmentRow>(),
      session
        .prepare(
          `SELECT shard.lookup_shard_id, shard.residency_partition,
                  COALESCE(
                    json_extract(desired.desired_spec_json, '$.lookup_capacity_domain_id'),
                    residency.lookup_capacity_domain_id,
                    'lookup:' || residency.residency_policy_id || ':' ||
                      residency.residency_partition
                  ) AS lookup_capacity_domain_id,
                  shard.capacity_weight
             FROM control_lookup_physical_shards shard
             JOIN control_environments environment
               ON environment.environment_id = shard.environment_id
              AND environment.lifecycle_state = 'active'
             JOIN control_desired_resources desired
               ON desired.environment_id = shard.environment_id
              AND desired.desired_resource_id = shard.d1_desired_resource_id
             JOIN control_residency_partitions residency
               ON residency.environment_id = shard.environment_id
              AND residency.residency_policy_id =
                  json_extract(desired.desired_spec_json, '$.residency_policy_id')
              AND residency.residency_partition = shard.residency_partition
              AND residency.status = 'active'
            WHERE shard.environment_id = ? AND shard.status = 'active'
            ORDER BY shard.lookup_shard_id
            LIMIT 4096`
        )
        .bind(environmentId)
        .all<PlanShardRow>(),
    ]);
    if (assignmentResult.results.length !== input.buckets.length) {
      throw new Error('control_lookup_bucket_load_snapshot_incomplete');
    }
    const observations = new Map<number, (typeof input.buckets)[number]>();
    for (const observation of input.buckets) {
      const virtualBucket = bucket(observation.virtualBucket);
      if (
        observations.has(virtualBucket) ||
        !SAFE_ID.test(observation.lookupShardId) ||
        !Number.isSafeInteger(observation.assignmentGeneration) ||
        observation.assignmentGeneration < 1 ||
        !Number.isSafeInteger(observation.activeIdentifierCount) ||
        observation.activeIdentifierCount < 0 ||
        !Number.isSafeInteger(observation.activeAliasCount) ||
        observation.activeAliasCount < 0 ||
        !Number.isSafeInteger(observation.successfulRoutePublicationCount) ||
        observation.successfulRoutePublicationCount < 0 ||
        !Number.isSafeInteger(observation.publicationCounterUpdatedAt) ||
        observation.publicationCounterUpdatedAt < 0 ||
        observation.publicationCounterUpdatedAt > input.observedAt + 5 ||
        !Number.isSafeInteger(observation.counterUpdatedAt) ||
        observation.counterUpdatedAt > input.observedAt + 5
      ) {
        throw new Error('control_lookup_bucket_load_observation_invalid');
      }
      observations.set(virtualBucket, observation);
    }
    const shards = new Map<
      string,
      {
        lookupShardId: string;
        residencyPartition: string;
        lookupCapacityDomainId: string;
        capacityWeight: number;
        total: number;
        buckets: { virtualBucket: number; assignmentGeneration: number; count: number }[];
      }
    >();
    for (const row of shardResult.results) {
      const capacityWeight = Number(row.capacity_weight);
      if (
        !SAFE_ID.test(row.lookup_shard_id) ||
        !SAFE_ID.test(row.residency_partition) ||
        !SAFE_ID.test(row.lookup_capacity_domain_id) ||
        !Number.isFinite(capacityWeight) ||
        capacityWeight <= 0
      ) {
        throw new Error('control_lookup_bucket_migration_load_invalid');
      }
      shards.set(row.lookup_shard_id, {
        lookupShardId: row.lookup_shard_id,
        residencyPartition: row.residency_partition,
        lookupCapacityDomainId: row.lookup_capacity_domain_id,
        capacityWeight,
        total: 0,
        buckets: [],
      });
    }
    for (const assignment of assignmentResult.results) {
      const virtualBucket = bucket(assignment.virtual_bucket);
      const observation = observations.get(virtualBucket);
      const shard = shards.get(assignment.lookup_shard_id);
      if (
        assignment.state !== 'active' ||
        assignment.target_lookup_shard_id !== null ||
        !observation ||
        observation.lookupShardId !== assignment.lookup_shard_id ||
        observation.assignmentGeneration !== Number(assignment.assignment_generation) ||
        !shard
      ) {
        throw new Error('control_lookup_bucket_load_assignment_mismatch');
      }
      const routeCount = observation.activeIdentifierCount + observation.activeAliasCount;
      const total = shard.total + routeCount;
      if (!Number.isSafeInteger(total))
        throw new Error('control_lookup_bucket_migration_load_invalid');
      shard.total = total;
      shard.buckets.push({
        virtualBucket,
        assignmentGeneration: Number(assignment.assignment_generation),
        count: routeCount,
      });
    }
    let selected:
      | {
          improvement: number;
          source: string;
          target: string;
          virtualBucket: number;
          assignmentGeneration: number;
          count: number;
        }
      | undefined;
    const values = [...shards.values()];
    for (const source of values) {
      for (const target of values) {
        if (
          source.lookupShardId === target.lookupShardId ||
          source.lookupCapacityDomainId !== target.lookupCapacityDomainId ||
          source.total / source.capacityWeight <= target.total / target.capacityWeight
        ) {
          continue;
        }
        const before = source.total / source.capacityWeight - target.total / target.capacityWeight;
        for (const candidate of source.buckets) {
          const after = Math.abs(
            (source.total - candidate.count) / source.capacityWeight -
              (target.total + candidate.count) / target.capacityWeight
          );
          const improvement = before - after;
          if (improvement <= 0) continue;
          const next = {
            improvement,
            source: source.lookupShardId,
            target: target.lookupShardId,
            virtualBucket: candidate.virtualBucket,
            assignmentGeneration: candidate.assignmentGeneration,
            count: candidate.count,
          };
          if (
            !selected ||
            next.improvement > selected.improvement ||
            (next.improvement === selected.improvement && next.count > selected.count) ||
            (next.improvement === selected.improvement &&
              next.count === selected.count &&
              `${next.source}\0${next.target}\0${next.virtualBucket}` <
                `${selected.source}\0${selected.target}\0${selected.virtualBucket}`)
          ) {
            selected = next;
          }
        }
      }
    }
    if (!selected) return null;
    return this.start(environmentId, {
      virtualBucket: selected.virtualBucket,
      targetLookupShardId: selected.target,
      idempotencyKey: `auto-rebalance:${selected.virtualBucket}:${selected.assignmentGeneration}:${selected.target}`,
      ownerId,
    });
  }

  async start(
    environmentId: string,
    input: ControlLookupBucketMigrationStartRequest
  ): Promise<ControlLookupBucketMigrationView> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    const virtualBucket = bucket(input.virtualBucket);
    const targetLookupShardId = safeId(
      input.targetLookupShardId,
      'invalid_lookup_bucket_migration_target'
    );
    const idempotencyKey = safeId(
      input.idempotencyKey,
      'invalid_lookup_bucket_migration_idempotency_key'
    );
    const ownerId = safeId(input.ownerId, 'invalid_lookup_bucket_migration_owner');
    const expectedOperationId = await operationId({
      environmentId,
      virtualBucket,
      idempotencyKey,
    });
    const session = primary(this.db);
    const existingOperation = await session
      .prepare(
        `SELECT operation_id, operation_kind FROM control_operations
          WHERE environment_id = ? AND idempotency_key = ?`
      )
      .bind(environmentId, idempotencyKey)
      .first<OperationIdentityRow>();
    if (existingOperation) {
      if (
        existingOperation.operation_id !== expectedOperationId ||
        existingOperation.operation_kind !== 'lookup_bucket_migration'
      ) {
        throw new Error('control_lookup_bucket_migration_idempotency_conflict');
      }
      const existing = await this.view(environmentId, expectedOperationId);
      if (
        existing.virtualBucket !== virtualBucket ||
        existing.target.lookupShardId !== targetLookupShardId
      ) {
        throw new Error('control_lookup_bucket_migration_idempotency_conflict');
      }
      return existing;
    }

    const assignment = await session
      .prepare(
        `SELECT assignment.virtual_bucket, assignment.lookup_shard_id,
                assignment.assignment_generation, assignment.state,
                assignment.target_lookup_shard_id,
                source.binding_ref AS source_binding_ref,
                source.residency_partition AS source_residency_partition,
                COALESCE(
                  json_extract(source_desired.desired_spec_json, '$.lookup_capacity_domain_id'),
                  source_residency.lookup_capacity_domain_id,
                  'lookup:' || source_residency.residency_policy_id || ':' ||
                    source_residency.residency_partition
                ) AS source_lookup_capacity_domain_id
           FROM control_lookup_bucket_assignments assignment
           JOIN control_lookup_physical_shards source
             ON source.environment_id = assignment.environment_id
            AND source.lookup_shard_id = assignment.lookup_shard_id
           JOIN control_desired_resources source_desired
             ON source_desired.environment_id = source.environment_id
            AND source_desired.desired_resource_id = source.d1_desired_resource_id
           JOIN control_residency_partitions source_residency
             ON source_residency.environment_id = source.environment_id
            AND source_residency.residency_policy_id =
                json_extract(source_desired.desired_spec_json, '$.residency_policy_id')
            AND source_residency.residency_partition = source.residency_partition
            AND source_residency.status = 'active'
          WHERE assignment.environment_id = ? AND assignment.virtual_bucket = ?`
      )
      .bind(environmentId, virtualBucket)
      .first<AssignmentRow>();
    if (
      !assignment ||
      assignment.state !== 'active' ||
      assignment.target_lookup_shard_id !== null ||
      assignment.lookup_shard_id === targetLookupShardId
    ) {
      throw new Error('control_lookup_bucket_migration_source_unavailable');
    }
    const target = await session
      .prepare(
        `SELECT shard.lookup_shard_id, shard.binding_ref, shard.residency_partition,
                COALESCE(
                  json_extract(desired.desired_spec_json, '$.lookup_capacity_domain_id'),
                  residency.lookup_capacity_domain_id,
                  'lookup:' || residency.residency_policy_id || ':' ||
                    residency.residency_partition
                ) AS lookup_capacity_domain_id,
                shard.status
           FROM control_lookup_physical_shards shard
           JOIN control_desired_resources desired
             ON desired.environment_id = shard.environment_id
            AND desired.desired_resource_id = shard.d1_desired_resource_id
           JOIN control_residency_partitions residency
             ON residency.environment_id = shard.environment_id
            AND residency.residency_policy_id =
                json_extract(desired.desired_spec_json, '$.residency_policy_id')
            AND residency.residency_partition = shard.residency_partition
            AND residency.status = 'active'
          WHERE shard.environment_id = ? AND shard.lookup_shard_id = ?`
      )
      .bind(environmentId, targetLookupShardId)
      .first<TargetShardRow>();
    if (
      !target ||
      target.status !== 'active' ||
      !SAFE_ID.test(target.lookup_capacity_domain_id) ||
      !SAFE_ID.test(assignment.source_lookup_capacity_domain_id ?? '') ||
      target.residency_partition !== assignment.source_residency_partition ||
      target.lookup_capacity_domain_id !== assignment.source_lookup_capacity_domain_id ||
      !SAFE_BINDING.test(target.binding_ref) ||
      !SAFE_BINDING.test(assignment.source_binding_ref)
    ) {
      throw new Error('control_lookup_bucket_migration_target_unavailable');
    }

    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('control_lookup_bucket_migration_time_invalid');
    }
    const currentLease = await session
      .prepare(
        `SELECT operation_id, owner_id, fencing_token, lease_expires_at, mutation_started
           FROM control_directory_rewrite_leases WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<LeaseRow>();
    const fencingToken = nextDirectoryRewriteFencingToken({
      current: currentLease
        ? {
            operationId: currentLease.operation_id,
            fencingToken: Number(currentLease.fencing_token),
            leaseExpiresAt: Number(currentLease.lease_expires_at),
            mutationStarted: currentLease.mutation_started === 1,
          }
        : null,
      nextOperationId: expectedOperationId,
      now,
    });
    const leaseExpiresAt = now + LEASE_SECONDS;
    const targetGeneration = Number(assignment.assignment_generation) + 1;
    const statements = [
      session
        .prepare(
          `INSERT INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, created_at, updated_at
           ) VALUES (?, ?, 'lookup_bucket_migration', ?, 'queued', 'scheduler', ?, ?, ?)`
        )
        .bind(expectedOperationId, environmentId, idempotencyKey, ownerId, now, now),
      ...(currentLease
        ? [
            session
              .prepare(
                `UPDATE control_directory_rewrite_leases
                    SET operation_id = ?, operation_kind = 'lookup_bucket_migration', owner_id = ?,
                        fencing_token = ?, checkpoint_json = '{}', lease_expires_at = ?,
                        mutation_started = 0, rollback_verified_at = NULL, updated_at = ?
                  WHERE environment_id = ? AND operation_id = ? AND fencing_token = ?
                    AND lease_expires_at <= ? AND mutation_started = 0`
              )
              .bind(
                expectedOperationId,
                ownerId,
                fencingToken,
                leaseExpiresAt,
                now,
                environmentId,
                currentLease.operation_id,
                currentLease.fencing_token,
                now
              ),
          ]
        : [
            session
              .prepare(
                `INSERT INTO control_directory_rewrite_leases (
                   environment_id, operation_id, operation_kind, owner_id, fencing_token,
                   checkpoint_json, lease_expires_at, mutation_started, updated_at
                 ) VALUES (?, ?, 'lookup_bucket_migration', ?, ?, '{}', ?, 0, ?)`
              )
              .bind(environmentId, expectedOperationId, ownerId, fencingToken, leaseExpiresAt, now),
          ]),
      session
        .prepare(
          `INSERT INTO control_lookup_bucket_migrations (
             operation_id, environment_id, virtual_bucket, source_lookup_shard_id,
             target_lookup_shard_id, source_assignment_generation,
             target_assignment_generation, state, active_operation_key,
             dual_write_started_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, 'dual_write', 'active', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM control_directory_rewrite_leases
               WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
                 AND fencing_token = ? AND mutation_started = 0
            )`
        )
        .bind(
          expectedOperationId,
          environmentId,
          virtualBucket,
          assignment.lookup_shard_id,
          targetLookupShardId,
          assignment.assignment_generation,
          targetGeneration,
          now,
          now,
          environmentId,
          expectedOperationId,
          ownerId,
          fencingToken
        ),
      session
        .prepare(
          `UPDATE control_lookup_bucket_assignments
              SET state = 'copying', target_lookup_shard_id = ?, backfill_cursor = '{}',
                  source_row_count = NULL, target_row_count = NULL,
                  verification_result_json = NULL, updated_at = ?
            WHERE environment_id = ? AND virtual_bucket = ? AND state = 'active'
              AND lookup_shard_id = ? AND assignment_generation = ?
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases
                 WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
                   AND fencing_token = ? AND mutation_started = 0
              )
              AND EXISTS (
                SELECT 1 FROM control_lookup_bucket_migrations migration
                 WHERE migration.operation_id = ? AND migration.environment_id = ?
                   AND migration.virtual_bucket = control_lookup_bucket_assignments.virtual_bucket
                   AND migration.state = 'dual_write'
              )`
        )
        .bind(
          targetLookupShardId,
          now,
          environmentId,
          virtualBucket,
          assignment.lookup_shard_id,
          assignment.assignment_generation,
          environmentId,
          expectedOperationId,
          ownerId,
          fencingToken,
          expectedOperationId,
          environmentId
        ),
      session
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET mutation_started = 1, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND mutation_started = 0
              AND EXISTS (
                SELECT 1 FROM control_lookup_bucket_migrations migration
                 WHERE migration.operation_id = ? AND migration.environment_id = ?
                   AND migration.state = 'dual_write'
              )`
        )
        .bind(
          leaseExpiresAt,
          now,
          environmentId,
          expectedOperationId,
          ownerId,
          fencingToken,
          expectedOperationId,
          environmentId
        ),
      session
        .prepare(
          `UPDATE control_operations
              SET status = 'running', requested_by_id = ?, lock_owner = ?,
                  lock_expires_at = ?, fencing_token = ?, started_at = COALESCE(started_at, ?),
                  attempt_count = attempt_count + 1, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'queued'
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases
                 WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
                   AND fencing_token = ? AND mutation_started = 1
              )
              AND EXISTS (
                SELECT 1 FROM control_lookup_bucket_migrations migration
                 WHERE migration.operation_id = ? AND migration.environment_id = ?
                   AND migration.state = 'dual_write'
              )`
        )
        .bind(
          ownerId,
          ownerId,
          leaseExpiresAt,
          fencingToken,
          now,
          now,
          expectedOperationId,
          environmentId,
          environmentId,
          expectedOperationId,
          ownerId,
          fencingToken,
          expectedOperationId,
          environmentId
        ),
      session
        .prepare(
          `DELETE FROM control_operations
            WHERE operation_id = ? AND environment_id = ? AND status = 'queued'
              AND NOT EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = control_operations.environment_id
                   AND lease.operation_id = control_operations.operation_id
                   AND lease.owner_id = ? AND lease.fencing_token = ?
              )`
        )
        .bind(expectedOperationId, environmentId, ownerId, fencingToken),
    ];
    const started = await this.db.batch(statements);
    if (
      started.slice(0, -1).some((result) => (result.meta.changes ?? 0) !== 1) ||
      (started[started.length - 1]?.meta.changes ?? 0) !== 0
    ) {
      throw new Error('control_lookup_bucket_migration_start_stale');
    }
    return this.view(environmentId, expectedOperationId);
  }

  async claim(
    environmentId: string,
    input: ControlLookupBucketMigrationClaimRequest
  ): Promise<ControlLookupBucketMigrationView> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    const operationIdValue = safeId(input.operationId, 'invalid_lookup_bucket_migration_operation');
    const ownerId = safeId(input.ownerId, 'invalid_lookup_bucket_migration_owner');
    const session = primary(this.db);
    await this.view(environmentId, operationIdValue);
    const lease = await session
      .prepare(
        `SELECT operation_id, owner_id, fencing_token, lease_expires_at, mutation_started
           FROM control_directory_rewrite_leases WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<LeaseRow>();
    if (!lease || lease.operation_id !== operationIdValue || lease.mutation_started !== 1) {
      throw new Error('control_lookup_bucket_migration_lease_unavailable');
    }
    const now = this.now();
    if (lease.lease_expires_at > now) {
      if (lease.owner_id !== ownerId) throw new Error('directory_rewrite_lease_active');
      const renewed = await session
        .prepare(
          `UPDATE control_directory_rewrite_leases SET lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND mutation_started = 1 AND lease_expires_at > ?`
        )
        .bind(
          now + LEASE_SECONDS,
          now,
          environmentId,
          operationIdValue,
          ownerId,
          lease.fencing_token,
          now
        )
        .run();
      if ((renewed.meta.changes ?? 0) !== 1) {
        throw new Error('control_lookup_bucket_migration_lease_raced');
      }
    } else {
      const nextToken = nextDirectoryRewriteFencingToken({
        current: {
          operationId: lease.operation_id,
          fencingToken: Number(lease.fencing_token),
          leaseExpiresAt: Number(lease.lease_expires_at),
          mutationStarted: true,
        },
        nextOperationId: operationIdValue,
        now,
      });
      const claimed = await session
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET owner_id = ?, fencing_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND fencing_token = ?
              AND lease_expires_at <= ? AND mutation_started = 1`
        )
        .bind(
          ownerId,
          nextToken,
          now + LEASE_SECONDS,
          now,
          environmentId,
          operationIdValue,
          lease.fencing_token,
          now
        )
        .run();
      if ((claimed.meta.changes ?? 0) !== 1) {
        throw new Error('control_lookup_bucket_migration_lease_raced');
      }
    }
    const refreshed = await this.view(environmentId, operationIdValue);
    const operation = await session
      .prepare(
        `UPDATE control_operations
            SET lock_owner = ?, lock_expires_at = ?, fencing_token = ?,
                attempt_count = attempt_count + 1, updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND status IN ('running', 'waiting_retry', 'blocked')
            AND EXISTS (
              SELECT 1 FROM control_directory_rewrite_leases lease
               WHERE lease.environment_id = control_operations.environment_id
                 AND lease.operation_id = control_operations.operation_id
                 AND lease.owner_id = ? AND lease.fencing_token = ?
                 AND lease.mutation_started = 1 AND lease.lease_expires_at > ?
            )`
      )
      .bind(
        ownerId,
        refreshed.leaseExpiresAt,
        refreshed.fencingToken,
        now,
        operationIdValue,
        environmentId,
        ownerId,
        refreshed.fencingToken,
        now
      )
      .run();
    if ((operation.meta.changes ?? 0) !== 1) {
      throw new Error('control_lookup_bucket_migration_operation_stale');
    }
    return refreshed;
  }

  async claimNext(
    environmentId: string,
    ownerIdInput: string
  ): Promise<ControlLookupBucketMigrationView | null> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    const ownerId = safeId(ownerIdInput, 'invalid_lookup_bucket_migration_owner');
    const now = this.now();
    const candidate = await primary(this.db)
      .prepare(
        `SELECT migration.operation_id, lease.owner_id, lease.lease_expires_at
           FROM control_lookup_bucket_migrations migration
           JOIN control_directory_rewrite_leases lease
             ON lease.environment_id = migration.environment_id
            AND lease.operation_id = migration.operation_id
          WHERE migration.environment_id = ?
            AND migration.state NOT IN ('complete', 'blocked')
          ORDER BY migration.updated_at, migration.virtual_bucket LIMIT 1`
      )
      .bind(environmentId)
      .first<{ operation_id: string; owner_id: string; lease_expires_at: number }>();
    if (!candidate || Number(candidate.lease_expires_at) > now) return null;
    return this.claim(environmentId, { operationId: candidate.operation_id, ownerId });
  }

  async checkpoint(
    environmentId: string,
    input: ControlLookupBucketMigrationCheckpointRequest
  ): Promise<ControlLookupBucketMigrationView> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    const operationIdValue = safeId(input.operationId, 'invalid_lookup_bucket_migration_operation');
    const ownerId = safeId(input.ownerId, 'invalid_lookup_bucket_migration_owner');
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error('invalid_lookup_bucket_migration_fencing_token');
    }
    const allowed =
      (input.expectedState === 'dual_write' && input.nextState === 'backfilling') ||
      (input.expectedState === 'backfilling' &&
        (input.nextState === 'backfilling' || input.nextState === 'verifying')) ||
      (input.expectedState === 'verifying' &&
        (input.nextState === 'backfilling' ||
          input.nextState === 'verifying' ||
          input.nextState === 'cutover_pending'));
    if (!allowed) throw new Error('invalid_lookup_bucket_migration_checkpoint_transition');
    const cursor = validatedCursor(input.backfillCursor);
    const sourceRowCount = count(
      input.sourceRowCount,
      'invalid_lookup_bucket_migration_source_count'
    );
    const targetRowCount = count(
      input.targetRowCount,
      'invalid_lookup_bucket_migration_target_count'
    );
    const digest = input.verificationDigest;
    if (
      input.nextState === 'cutover_pending' &&
      (sourceRowCount === null ||
        targetRowCount === null ||
        sourceRowCount !== targetRowCount ||
        typeof digest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(digest))
    ) {
      throw new Error('control_lookup_bucket_migration_verification_required');
    }
    if (digest !== null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) {
      throw new Error('invalid_lookup_bucket_migration_verification_digest');
    }
    const now = this.now();
    const assignmentState =
      input.nextState === 'verifying'
        ? 'verifying'
        : input.nextState === 'cutover_pending'
          ? 'cutover_pending'
          : 'copying';
    const session = primary(this.db);
    const migrationStatement = session
      .prepare(
        `UPDATE control_lookup_bucket_migrations AS migration
            SET state = ?, backfill_cursor_json = ?, source_row_count = ?,
                target_row_count = ?, verification_digest = ?,
                verification_attempt_count = verification_attempt_count +
                  CASE WHEN state = 'verifying' AND ? = 'backfilling' THEN 1 ELSE 0 END,
                updated_at = ?
          WHERE operation_id = ? AND environment_id = ? AND state = ?
            AND (state <> 'verifying' OR ? <> 'backfilling' OR verification_attempt_count < 3)
            AND EXISTS (
              SELECT 1 FROM control_directory_rewrite_leases lease
               WHERE lease.environment_id = migration.environment_id
                 AND lease.operation_id = migration.operation_id AND lease.owner_id = ?
                 AND lease.fencing_token = ? AND lease.mutation_started = 1
                 AND lease.lease_expires_at > ?
            )`
      )
      .bind(
        input.nextState,
        cursor,
        sourceRowCount,
        targetRowCount,
        digest,
        input.nextState,
        now,
        operationIdValue,
        environmentId,
        input.expectedState,
        input.nextState,
        ownerId,
        input.fencingToken,
        now
      );
    const assignmentStatement = session
      .prepare(
        `UPDATE control_lookup_bucket_assignments
            SET state = ?, backfill_cursor = ?, source_row_count = ?, target_row_count = ?,
                verification_result_json = ?, updated_at = ?
          WHERE environment_id = ? AND virtual_bucket = (
              SELECT virtual_bucket FROM control_lookup_bucket_migrations
               WHERE operation_id = ? AND environment_id = ?
            )
            AND target_lookup_shard_id = (
              SELECT target_lookup_shard_id FROM control_lookup_bucket_migrations
               WHERE operation_id = ? AND environment_id = ?
            )
            AND EXISTS (
              SELECT 1
                FROM control_lookup_bucket_migrations migration
                JOIN control_directory_rewrite_leases lease
                  ON lease.environment_id = migration.environment_id
                 AND lease.operation_id = migration.operation_id
               WHERE migration.operation_id = ? AND migration.environment_id = ?
                 AND migration.virtual_bucket = control_lookup_bucket_assignments.virtual_bucket
                 AND migration.state = ? AND lease.owner_id = ? AND lease.fencing_token = ?
                 AND lease.mutation_started = 1 AND lease.lease_expires_at > ?
            )`
      )
      .bind(
        assignmentState,
        cursor,
        sourceRowCount,
        targetRowCount,
        digest === null ? null : JSON.stringify({ digest }),
        now,
        environmentId,
        operationIdValue,
        environmentId,
        operationIdValue,
        environmentId,
        operationIdValue,
        environmentId,
        input.nextState,
        ownerId,
        input.fencingToken,
        now
      );
    const checkpointed = await this.db.batch([migrationStatement, assignmentStatement]);
    if (checkpointed.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error('control_lookup_bucket_migration_assignment_stale');
    }
    await this.renewOperationLease(
      session,
      environmentId,
      operationIdValue,
      ownerId,
      input.fencingToken,
      now
    );
    return this.view(environmentId, operationIdValue);
  }

  async release(
    environmentId: string,
    input: ControlLookupBucketMigrationCutoverRequest
  ): Promise<ControlLookupBucketMigrationView> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    safeId(input.operationId, 'invalid_lookup_bucket_migration_operation');
    safeId(input.ownerId, 'invalid_lookup_bucket_migration_owner');
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error('invalid_lookup_bucket_migration_fencing_token');
    }
    const current = await this.view(environmentId, input.operationId);
    if (current.state === 'complete' || current.state === 'blocked') {
      throw new Error('control_lookup_bucket_migration_state_conflict');
    }
    await this.assertClaim(environmentId, input, current.state);
    const now = this.now();
    const session = primary(this.db);
    const released = await this.db.batch([
      session
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND mutation_started = 1 AND lease_expires_at > ?`
        )
        .bind(now, now, environmentId, input.operationId, input.ownerId, input.fencingToken, now),
      session
        .prepare(
          `UPDATE control_operations
              SET lock_expires_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'running'
              AND lock_owner = ? AND fencing_token = ?`
        )
        .bind(now, now, input.operationId, environmentId, input.ownerId, input.fencingToken),
    ]);
    if (released.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error('control_lookup_bucket_migration_release_stale');
    }
    return this.view(environmentId, input.operationId);
  }

  async prepareCutover(
    environmentId: string,
    input: ControlLookupBucketMigrationCutoverRequest
  ): Promise<ControlLookupBucketMigrationView> {
    const current = await this.assertClaim(environmentId, input, 'cutover_pending');
    if (
      current.sourceRowCount === null ||
      current.targetRowCount === null ||
      current.sourceRowCount !== current.targetRowCount ||
      !current.verificationDigest
    ) {
      throw new Error('control_lookup_bucket_migration_verification_required');
    }
    const now = this.now();
    const session = primary(this.db);
    const switched = await session
      .prepare(
        `UPDATE control_lookup_bucket_assignments
            SET lookup_shard_id = ?, assignment_generation = ?, state = 'active',
                target_lookup_shard_id = NULL, updated_at = ?
          WHERE environment_id = ? AND virtual_bucket = ?
            AND lookup_shard_id = ? AND assignment_generation = ?
            AND state = 'cutover_pending' AND target_lookup_shard_id = ?
            AND EXISTS (
              SELECT 1
                FROM control_lookup_bucket_migrations migration
                JOIN control_directory_rewrite_leases lease
                  ON lease.environment_id = migration.environment_id
                 AND lease.operation_id = migration.operation_id
               WHERE migration.operation_id = ? AND migration.environment_id = ?
                 AND migration.virtual_bucket = control_lookup_bucket_assignments.virtual_bucket
                 AND migration.state = 'cutover_pending' AND lease.owner_id = ?
                 AND lease.fencing_token = ? AND lease.mutation_started = 1
                 AND lease.lease_expires_at > ?
            )`
      )
      .bind(
        current.target.lookupShardId,
        current.target.assignmentGeneration,
        now,
        environmentId,
        current.virtualBucket,
        current.source.lookupShardId,
        current.source.assignmentGeneration,
        current.target.lookupShardId,
        input.operationId,
        environmentId,
        input.ownerId,
        input.fencingToken,
        now
      )
      .run();
    if ((switched.meta.changes ?? 0) !== 1) {
      const reflected = await this.writeRoute(environmentId, current.virtualBucket);
      if (
        reflected.primary.lookupShardId !== current.target.lookupShardId ||
        reflected.primary.assignmentGeneration !== current.target.assignmentGeneration
      ) {
        throw new Error('control_lookup_bucket_migration_cutover_stale');
      }
    }
    await this.renewOperationLease(
      session,
      environmentId,
      input.operationId,
      input.ownerId,
      input.fencingToken,
      now
    );
    return this.view(environmentId, input.operationId);
  }

  async confirmCutover(
    environmentId: string,
    input: ControlLookupBucketMigrationCutoverRequest,
    registryGeneration: number
  ): Promise<ControlLookupBucketMigrationView> {
    if (!Number.isSafeInteger(registryGeneration) || registryGeneration < 1) {
      throw new Error('control_lookup_bucket_migration_registry_generation_invalid');
    }
    const current = await this.assertClaim(environmentId, input, 'cutover_pending');
    const route = await this.writeRoute(environmentId, current.virtualBucket);
    if (
      route.primary.lookupShardId !== current.target.lookupShardId ||
      route.primary.assignmentGeneration !== current.target.assignmentGeneration
    ) {
      throw new Error('control_lookup_bucket_migration_cutover_not_prepared');
    }
    const now = this.now();
    const graceExpiresAt = now + 15 * 60;
    const session = primary(this.db);
    const advanced = await session
      .prepare(
        `UPDATE control_lookup_bucket_migrations AS migration
            SET state = 'grace', cutover_started_at = COALESCE(cutover_started_at, ?),
                cutover_registry_generation = ?, grace_expires_at = COALESCE(grace_expires_at, ?),
                updated_at = ?
          WHERE operation_id = ? AND environment_id = ? AND state = 'cutover_pending'
            AND EXISTS (
              SELECT 1 FROM control_directory_rewrite_leases lease
               WHERE lease.environment_id = migration.environment_id
                 AND lease.operation_id = migration.operation_id AND lease.owner_id = ?
                 AND lease.fencing_token = ? AND lease.mutation_started = 1
                 AND lease.lease_expires_at > ?
            )`
      )
      .bind(
        now,
        registryGeneration,
        graceExpiresAt,
        now,
        input.operationId,
        environmentId,
        input.ownerId,
        input.fencingToken,
        now
      )
      .run();
    if ((advanced.meta.changes ?? 0) !== 1) {
      throw new Error('control_lookup_bucket_migration_cutover_stale');
    }
    await this.renewOperationLease(
      session,
      environmentId,
      input.operationId,
      input.ownerId,
      input.fencingToken,
      now
    );
    return this.view(environmentId, input.operationId);
  }

  async complete(
    environmentId: string,
    input: ControlLookupBucketMigrationCompleteRequest
  ): Promise<ControlLookupBucketMigrationView> {
    if (input.oldRowsQuarantined !== true) {
      throw new Error('control_lookup_bucket_migration_quarantine_required');
    }
    const current = await this.assertClaim(environmentId, input, 'grace');
    const now = this.now();
    if (current.graceExpiresAt === null || now < current.graceExpiresAt) {
      throw new Error('control_lookup_bucket_migration_grace_active');
    }
    const session = primary(this.db);
    const completed = await this.db.batch([
      session
        .prepare(
          `UPDATE control_operations AS operation
              SET status = 'succeeded', completed_at = ?, lock_owner = NULL,
                  lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'running'
              AND fencing_token = ? AND lock_owner = ?
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = operation.environment_id
                   AND lease.operation_id = operation.operation_id AND lease.owner_id = ?
                   AND lease.fencing_token = ? AND lease.mutation_started = 1
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          now,
          now,
          input.operationId,
          environmentId,
          input.fencingToken,
          input.ownerId,
          input.ownerId,
          input.fencingToken,
          now
        ),
      session
        .prepare(
          `UPDATE control_lookup_bucket_migrations AS migration
              SET state = 'complete', active_operation_key = 'operation:' || operation_id,
                  completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND state = 'grace'
              AND EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = migration.operation_id
                   AND operation.status = 'succeeded'
              )
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = migration.environment_id
                   AND lease.operation_id = migration.operation_id AND lease.owner_id = ?
                   AND lease.fencing_token = ? AND lease.mutation_started = 1
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(now, now, input.operationId, environmentId, input.ownerId, input.fencingToken, now),
      session
        .prepare(
          `DELETE FROM control_directory_rewrite_leases
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND mutation_started = 1
              AND EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = control_directory_rewrite_leases.operation_id
                   AND operation.status = 'succeeded'
              )`
        )
        .bind(environmentId, input.operationId, input.ownerId, input.fencingToken),
    ]);
    if (completed.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error('control_lookup_bucket_migration_complete_stale');
    }
    return {
      ...current,
      state: 'complete',
      fencingToken: 0,
      leaseExpiresAt: 0,
    };
  }

  async block(
    environmentId: string,
    input: ControlLookupBucketMigrationBlockRequest
  ): Promise<ControlLookupBucketMigrationView> {
    if (!/^lookup_bucket_migration_[a-z0-9_]{1,96}$/u.test(input.errorCode)) {
      throw new Error('invalid_lookup_bucket_migration_error_code');
    }
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    safeId(input.operationId, 'invalid_lookup_bucket_migration_operation');
    safeId(input.ownerId, 'invalid_lookup_bucket_migration_owner');
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error('invalid_lookup_bucket_migration_fencing_token');
    }
    const current = await this.view(environmentId, input.operationId);
    if (current.state === 'complete' || current.state === 'blocked') {
      throw new Error('control_lookup_bucket_migration_state_conflict');
    }
    await this.assertClaim(environmentId, input, current.state);
    const now = this.now();
    const session = primary(this.db);
    const blocked = await this.db.batch([
      session
        .prepare(
          `UPDATE control_lookup_bucket_migrations AS migration
              SET state = 'blocked', active_operation_key = 'operation:' || operation_id,
                  last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND state = ?
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = migration.environment_id
                   AND lease.operation_id = migration.operation_id AND lease.owner_id = ?
                   AND lease.fencing_token = ? AND lease.mutation_started = 1
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          input.errorCode,
          now,
          input.operationId,
          environmentId,
          current.state,
          input.ownerId,
          input.fencingToken,
          now
        ),
      session
        .prepare(
          `UPDATE control_lookup_bucket_assignments SET state = 'blocked', updated_at = ?
            WHERE environment_id = ? AND virtual_bucket = ?
              AND EXISTS (
                SELECT 1
                  FROM control_lookup_bucket_migrations migration
                  JOIN control_directory_rewrite_leases lease
                    ON lease.environment_id = migration.environment_id
                   AND lease.operation_id = migration.operation_id
                 WHERE migration.operation_id = ? AND migration.environment_id = ?
                   AND migration.virtual_bucket = control_lookup_bucket_assignments.virtual_bucket
                   AND migration.state = 'blocked' AND lease.owner_id = ?
                   AND lease.fencing_token = ? AND lease.mutation_started = 1
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          now,
          environmentId,
          current.virtualBucket,
          input.operationId,
          environmentId,
          input.ownerId,
          input.fencingToken,
          now
        ),
      session
        .prepare(
          `UPDATE control_operations AS operation
              SET status = 'blocked', last_error_code = ?, last_error_redacted = NULL,
                  lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'running'
              AND lock_owner = ? AND fencing_token = ?
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = operation.environment_id
                   AND lease.operation_id = operation.operation_id AND lease.owner_id = ?
                   AND lease.fencing_token = ? AND lease.mutation_started = 1
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          input.errorCode,
          now,
          input.operationId,
          environmentId,
          input.ownerId,
          input.fencingToken,
          input.ownerId,
          input.fencingToken,
          now
        ),
    ]);
    if (blocked.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error('control_lookup_bucket_migration_block_stale');
    }
    return this.view(environmentId, input.operationId);
  }

  async writeRoute(
    environmentId: string,
    virtualBucketInput: number
  ): Promise<ControlLookupBucketWriteRoute> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    const virtualBucket = bucket(virtualBucketInput);
    const session = primary(this.db);
    const assignment = await session
      .prepare(
        `SELECT assignment.virtual_bucket, assignment.lookup_shard_id,
                assignment.assignment_generation, assignment.state,
                assignment.target_lookup_shard_id,
                source.binding_ref AS source_binding_ref,
                source.residency_partition AS source_residency_partition
           FROM control_lookup_bucket_assignments assignment
           JOIN control_lookup_physical_shards source
             ON source.environment_id = assignment.environment_id
            AND source.lookup_shard_id = assignment.lookup_shard_id
          WHERE assignment.environment_id = ? AND assignment.virtual_bucket = ?`
      )
      .bind(environmentId, virtualBucket)
      .first<AssignmentRow>();
    if (!assignment) throw new Error('control_lookup_bucket_assignment_not_found');
    const migration = await session
      .prepare(
        `SELECT migration.operation_id, migration.environment_id, migration.virtual_bucket,
                migration.source_lookup_shard_id, migration.target_lookup_shard_id,
                migration.source_assignment_generation, migration.target_assignment_generation,
                migration.state, migration.backfill_cursor_json,
                migration.source_row_count, migration.target_row_count,
                migration.verification_digest, migration.verification_attempt_count,
                migration.cutover_started_at,
                migration.cutover_registry_generation, migration.grace_expires_at,
                source.binding_ref AS source_binding_ref,
                target.binding_ref AS target_binding_ref,
                lease.fencing_token, lease.lease_expires_at
           FROM control_lookup_bucket_migrations migration
           JOIN control_lookup_physical_shards source
             ON source.environment_id = migration.environment_id
            AND source.lookup_shard_id = migration.source_lookup_shard_id
           JOIN control_lookup_physical_shards target
             ON target.environment_id = migration.environment_id
            AND target.lookup_shard_id = migration.target_lookup_shard_id
           JOIN control_directory_rewrite_leases lease
             ON lease.environment_id = migration.environment_id
            AND lease.operation_id = migration.operation_id
          WHERE migration.environment_id = ? AND migration.virtual_bucket = ?
            AND migration.state <> 'complete'
          ORDER BY migration.updated_at DESC LIMIT 1`
      )
      .bind(environmentId, virtualBucket)
      .first<MigrationRow>();
    const primaryTarget = routeTarget(
      assignment.lookup_shard_id,
      assignment.source_binding_ref,
      assignment.assignment_generation
    );
    if (!migration) {
      if (assignment.state !== 'active' || assignment.target_lookup_shard_id !== null) {
        throw new Error('control_lookup_bucket_migration_state_missing');
      }
      return { virtualBucket, primary: primaryTarget, mirrors: [], migration: null };
    }
    const source = routeTarget(
      migration.source_lookup_shard_id,
      migration.source_binding_ref,
      migration.source_assignment_generation
    );
    const target = routeTarget(
      migration.target_lookup_shard_id,
      migration.target_binding_ref,
      migration.target_assignment_generation
    );
    const mirror = primaryTarget.lookupShardId === source.lookupShardId ? target : source;
    return {
      virtualBucket,
      primary: primaryTarget,
      mirrors: [mirror],
      migration: { operationId: migration.operation_id, state: migration.state },
    };
  }

  async resolveRouteVersion(
    environmentId: string,
    virtualBucketInput: number,
    assignmentGeneration: number
  ): Promise<ControlLookupBucketRouteTarget> {
    if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 1) {
      throw new Error('invalid_lookup_bucket_assignment_generation');
    }
    const route = await this.writeRoute(environmentId, virtualBucketInput);
    if (route.primary.assignmentGeneration === assignmentGeneration) return route.primary;
    const mirror = route.mirrors.find(
      (candidate) => candidate.assignmentGeneration === assignmentGeneration
    );
    if (mirror && route.migration?.state !== 'complete') return mirror;
    throw new Error('control_lookup_bucket_route_version_unavailable');
  }

  private async assertClaim(
    environmentId: string,
    input: ControlLookupBucketMigrationCutoverRequest,
    expectedState: ControlLookupBucketMigrationState
  ): Promise<ControlLookupBucketMigrationView> {
    safeId(environmentId, 'invalid_lookup_bucket_migration_environment');
    safeId(input.operationId, 'invalid_lookup_bucket_migration_operation');
    safeId(input.ownerId, 'invalid_lookup_bucket_migration_owner');
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error('invalid_lookup_bucket_migration_fencing_token');
    }
    const current = await this.view(environmentId, input.operationId);
    if (current.state !== expectedState) {
      throw new Error('control_lookup_bucket_migration_state_conflict');
    }
    const now = this.now();
    if (current.fencingToken !== input.fencingToken || current.leaseExpiresAt <= now) {
      throw new Error('control_lookup_bucket_migration_stale_claim');
    }
    const lease = await primary(this.db)
      .prepare(
        `SELECT owner_id FROM control_directory_rewrite_leases
          WHERE environment_id = ? AND operation_id = ? AND fencing_token = ?
            AND mutation_started = 1 AND lease_expires_at > ?`
      )
      .bind(environmentId, input.operationId, input.fencingToken, now)
      .first<{ owner_id: string }>();
    if (lease?.owner_id !== input.ownerId) {
      throw new Error('control_lookup_bucket_migration_stale_claim');
    }
    return current;
  }

  private async renewOperationLease(
    session: D1DatabaseSession,
    environmentId: string,
    operationIdValue: string,
    ownerId: string,
    fencingToken: number,
    now: number
  ): Promise<void> {
    const leaseExpiresAt = now + LEASE_SECONDS;
    const renewed = await session
      .prepare(
        `UPDATE control_directory_rewrite_leases
            SET lease_expires_at = ?, updated_at = ?
          WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
            AND fencing_token = ? AND mutation_started = 1 AND lease_expires_at > ?`
      )
      .bind(leaseExpiresAt, now, environmentId, operationIdValue, ownerId, fencingToken, now)
      .run();
    if ((renewed.meta.changes ?? 0) !== 1) {
      throw new Error('control_lookup_bucket_migration_stale_claim');
    }
    const operation = await session
      .prepare(
        `UPDATE control_operations
            SET lock_owner = ?, lock_expires_at = ?, fencing_token = ?, updated_at = ?
          WHERE operation_id = ? AND environment_id = ? AND status = 'running'`
      )
      .bind(ownerId, leaseExpiresAt, fencingToken, now, operationIdValue, environmentId)
      .run();
    if ((operation.meta.changes ?? 0) !== 1) {
      throw new Error('control_lookup_bucket_migration_operation_stale');
    }
  }

  private async view(
    environmentId: string,
    operationIdValue: string
  ): Promise<ControlLookupBucketMigrationView> {
    const row = await primary(this.db)
      .prepare(
        `SELECT migration.operation_id, migration.environment_id, migration.virtual_bucket,
                migration.source_lookup_shard_id, migration.target_lookup_shard_id,
                migration.source_assignment_generation, migration.target_assignment_generation,
                migration.state, migration.backfill_cursor_json, migration.source_row_count,
                migration.target_row_count, migration.verification_digest,
                migration.verification_attempt_count,
                migration.cutover_started_at, migration.cutover_registry_generation,
                migration.grace_expires_at,
                source.binding_ref AS source_binding_ref,
                target.binding_ref AS target_binding_ref,
                lease.fencing_token, lease.lease_expires_at
           FROM control_lookup_bucket_migrations migration
           JOIN control_lookup_physical_shards source
             ON source.environment_id = migration.environment_id
            AND source.lookup_shard_id = migration.source_lookup_shard_id
           JOIN control_lookup_physical_shards target
             ON target.environment_id = migration.environment_id
            AND target.lookup_shard_id = migration.target_lookup_shard_id
           JOIN control_directory_rewrite_leases lease
             ON lease.environment_id = migration.environment_id
            AND lease.operation_id = migration.operation_id
          WHERE migration.environment_id = ? AND migration.operation_id = ?`
      )
      .bind(environmentId, operationIdValue)
      .first<MigrationRow>();
    if (!row) throw new Error('control_lookup_bucket_migration_not_found');
    return {
      operationId: row.operation_id,
      virtualBucket: Number(row.virtual_bucket),
      source: routeTarget(
        row.source_lookup_shard_id,
        row.source_binding_ref,
        Number(row.source_assignment_generation)
      ),
      target: routeTarget(
        row.target_lookup_shard_id,
        row.target_binding_ref,
        Number(row.target_assignment_generation)
      ),
      state: row.state,
      fencingToken: Number(row.fencing_token),
      leaseExpiresAt: Number(row.lease_expires_at),
      backfillCursor: row.backfill_cursor_json,
      sourceRowCount: row.source_row_count === null ? null : Number(row.source_row_count),
      targetRowCount: row.target_row_count === null ? null : Number(row.target_row_count),
      verificationDigest: row.verification_digest,
      verificationAttemptCount: Number(row.verification_attempt_count),
      graceExpiresAt: row.grace_expires_at === null ? null : Number(row.grace_expires_at),
    };
  }
}
