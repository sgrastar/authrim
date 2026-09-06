import type { D1Database, D1DatabaseSession, D1PreparedStatement } from '@cloudflare/workers-types';
import type {
  ControlLookupBucketLoadSnapshotRequest,
  ControlLookupScaleOutForecastView,
} from '@authrim/ar-lib-core/control-plane';
import {
  LOOKUP_MAX_VIRTUAL_BUCKET,
  LOOKUP_VIRTUAL_BUCKET_COUNT,
} from '@authrim/ar-lib-core/services/lookup-directory/contract';
import { planLookupScaleOut } from './lookup-scale-out-planner';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const CAPACITY_WEIGHT_SCALE = 1_000;

interface PolicyRow {
  lookup_forecast_horizon_seconds: number | string;
  lookup_target_active_route_count: number | string;
  lookup_scale_out_headroom_bps: number | string;
  lookup_registration_ewma_alpha_bps: number | string;
  lookup_scale_out_policy_generation: number | string;
}

interface AssignmentRow {
  virtual_bucket: number | string;
  lookup_shard_id: string;
  assignment_generation: number | string;
  state: string;
  target_lookup_shard_id: string | null;
}

interface ShardRow {
  lookup_shard_id: string;
  residency_policy_id: string;
  residency_partition: string;
  lookup_capacity_domain_id: string;
  residency_lookup_capacity_domain_id: string;
  status: string;
  capacity_weight: number | string;
}

interface ResidencyRow {
  residency_policy_id: string;
  residency_partition: string;
  lookup_capacity_domain_id: string;
  jurisdiction: string | null;
  location_hint: string | null;
}

interface ForecastRow {
  lookup_capacity_domain_id: string;
  residency_policy_id: string;
  residency_partition: string;
  policy_generation: number | string;
  observed_at: number | string;
  observed_active_route_count: number | string;
  observed_successful_publication_count: number | string;
  ewma_rate_microrows_per_second: number | string;
  capacity_unit_count: number | string;
  decision_generation: number | string;
  decision_state: 'warming' | 'stable' | 'provisioning' | 'blocked';
  capacity_request_idempotency_key: string | null;
  requested_operation_id: string | null;
  reflected_operation_id: string | null;
  last_error_code: string | null;
  requested_operation_status: string | null;
  requested_operation_error_code: string | null;
  requested_lookup_shard_status: string | null;
}

interface ProvisioningReconciliationRow {
  environment_id: string;
  lookup_capacity_domain_id: string;
  residency_policy_id: string;
  residency_partition: string;
  policy_generation: number | string;
  decision_generation: number | string;
  projected_active_route_count: number | string;
  requested_operation_id: string;
  requested_operation_status: string;
  requested_operation_error_code: string | null;
  lookup_target_active_route_count: number | string;
  lookup_scale_out_headroom_bps: number | string;
}

interface ProvisioningCapacityRow {
  capacity_unit_count: number | string;
  capacity_weight_milliunits: number | string;
  reflected_target_count: number | string;
}

interface UnlinkedCapacityRequestRow {
  environment_id: string;
  lookup_capacity_domain_id: string;
  residency_policy_id: string;
  residency_partition: string;
  capacity_request_idempotency_key: string;
  decision_generation: number | string;
}

interface CapacityDomainObservation {
  lookupCapacityDomainId: string;
  residencyPolicyId: string;
  residencyPartition: string;
  jurisdiction: string | null;
  locationHint: string | null;
  activeRouteCount: number;
  successfulPublicationCount: number;
  capacityWeightMilliunits: number;
  capacityUnitCount: number;
}

export interface LookupScaleOutCapacityRequest {
  lookupCapacityDomainId: string;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
  decisionGeneration: number;
}

export interface LookupScaleOutForecastResult {
  views: ControlLookupScaleOutForecastView[];
  capacityRequest: LookupScaleOutCapacityRequest | null;
}

export interface LookupScaleOutReconciliationResult {
  settledCount: number;
  blockedCount: number;
  capacityRequests: Array<LookupScaleOutCapacityRequest & { environmentId: string }>;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return db.withSession('first-primary');
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function integer(value: unknown, minimum: number, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(code);
  return number;
}

function safeAdd(left: number, right: number, code: string): number {
  return integer(left + right, 0, code);
}

function safeProduct(left: number, right: number, code: string): number {
  return integer(left * right, 0, code);
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function idempotencyKey(input: {
  lookupCapacityDomainId: string;
  policyGeneration: number;
  decisionGeneration: number;
}): Promise<string> {
  const value = `lookup-forecast:${input.lookupCapacityDomainId}:${input.policyGeneration}:${input.decisionGeneration}`;
  if (SAFE_ID.test(value)) return value;
  return `lookup-forecast:${await digest(input)}`;
}

export class LookupScaleOutForecastService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number
  ) {}

  async observe(
    environmentIdValue: string,
    input: ControlLookupBucketLoadSnapshotRequest
  ): Promise<LookupScaleOutForecastResult> {
    const environmentId = safeId(environmentIdValue, 'lookup_scale_out_environment_invalid');
    safeId(input.ownerId, 'lookup_scale_out_owner_invalid');
    const now = this.now();
    if (
      !Number.isSafeInteger(input.observedAt) ||
      input.observedAt < now - 5 * 60 ||
      input.observedAt > now + 5 ||
      !Array.isArray(input.buckets) ||
      input.buckets.length !== LOOKUP_VIRTUAL_BUCKET_COUNT
    ) {
      throw new Error('lookup_scale_out_snapshot_invalid');
    }

    const session = primary(this.db);
    const [policyResult, assignmentResult, shardResult, residencyResult, previousResult] =
      await session.batch([
        session
          .prepare(
            `SELECT lookup_forecast_horizon_seconds, lookup_target_active_route_count,
                  lookup_scale_out_headroom_bps, lookup_registration_ewma_alpha_bps,
                  lookup_scale_out_policy_generation
             FROM control_environment_resource_policies WHERE environment_id = ?`
          )
          .bind(environmentId),
        session
          .prepare(
            `SELECT virtual_bucket, lookup_shard_id, assignment_generation, state,
                  target_lookup_shard_id
             FROM control_lookup_bucket_assignments
            WHERE environment_id = ? ORDER BY virtual_bucket`
          )
          .bind(environmentId),
        session
          .prepare(
            `SELECT shard.lookup_shard_id,
                    json_extract(desired.desired_spec_json, '$.residency_policy_id')
                      AS residency_policy_id,
                    shard.residency_partition,
                    COALESCE(
                      json_extract(desired.desired_spec_json, '$.lookup_capacity_domain_id'),
                      residency.lookup_capacity_domain_id,
                      'lookup:' || residency.residency_policy_id || ':' ||
                        residency.residency_partition
                    ) AS lookup_capacity_domain_id,
                    COALESCE(
                      residency.lookup_capacity_domain_id,
                      'lookup:' || residency.residency_policy_id || ':' ||
                        residency.residency_partition
                    ) AS residency_lookup_capacity_domain_id,
                    shard.status, shard.capacity_weight
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
              WHERE shard.environment_id = ? ORDER BY shard.lookup_shard_id`
          )
          .bind(environmentId),
        session
          .prepare(
            `SELECT residency_policy_id, residency_partition,
                    COALESCE(
                      lookup_capacity_domain_id,
                      'lookup:' || residency_policy_id || ':' || residency_partition
                    ) AS lookup_capacity_domain_id,
                    jurisdiction, location_hint
             FROM control_residency_partitions
            WHERE environment_id = ? AND status = 'active'
            ORDER BY residency_partition, residency_policy_id`
          )
          .bind(environmentId),
        session
          .prepare(
            `SELECT forecast.lookup_capacity_domain_id,
                  forecast.residency_policy_id, forecast.residency_partition,
                  forecast.policy_generation, forecast.observed_at,
                  forecast.observed_active_route_count,
                  forecast.observed_successful_publication_count,
                  forecast.ewma_rate_microrows_per_second, forecast.capacity_unit_count,
                  forecast.decision_generation, forecast.decision_state,
                  forecast.capacity_request_idempotency_key,
                  forecast.requested_operation_id, forecast.last_error_code,
                  operation.operation_id AS reflected_operation_id,
                  operation.status AS requested_operation_status,
                  operation.last_error_code AS requested_operation_error_code,
                  (
                    SELECT lookup_shard.status
                      FROM control_desired_resources desired
                      JOIN control_lookup_physical_shards lookup_shard
                        ON lookup_shard.environment_id = desired.environment_id
                       AND lookup_shard.d1_desired_resource_id = desired.desired_resource_id
                     WHERE desired.environment_id = forecast.environment_id
                       AND desired.origin_operation_id = COALESCE(
                         forecast.requested_operation_id, operation.operation_id
                       )
                     ORDER BY lookup_shard.lookup_shard_id
                     LIMIT 1
                  ) AS requested_lookup_shard_status
             FROM control_lookup_scale_out_forecasts forecast
             LEFT JOIN control_operations operation
               ON operation.environment_id = forecast.environment_id
              AND operation.operation_kind = 'provision_shard'
              AND (
                operation.operation_id = forecast.requested_operation_id
                OR (
                  forecast.requested_operation_id IS NULL
                  AND operation.idempotency_key = forecast.capacity_request_idempotency_key
                )
              )
            WHERE forecast.environment_id = ?
              AND EXISTS (
                SELECT 1 FROM control_residency_partitions residency
                 WHERE residency.environment_id = forecast.environment_id
                   AND COALESCE(
                     residency.lookup_capacity_domain_id,
                     'lookup:' || residency.residency_policy_id || ':' ||
                       residency.residency_partition
                   ) = forecast.lookup_capacity_domain_id
                   AND residency.status = 'active'
              )
            ORDER BY forecast.lookup_capacity_domain_id`
          )
          .bind(environmentId),
      ]);
    const policyRows = (policyResult?.results ?? []) as unknown as PolicyRow[];
    const assignments = (assignmentResult?.results ?? []) as unknown as AssignmentRow[];
    const shards = (shardResult?.results ?? []) as unknown as ShardRow[];
    const residencies = (residencyResult?.results ?? []) as unknown as ResidencyRow[];
    const previous = (previousResult?.results ?? []) as unknown as ForecastRow[];
    const policy = policyRows.length === 1 ? policyRows[0] : null;
    if (!policy) throw new Error('lookup_scale_out_policy_missing');
    if (assignments.length !== input.buckets.length) {
      throw new Error('lookup_scale_out_snapshot_incomplete');
    }

    const policyGeneration = integer(
      policy.lookup_scale_out_policy_generation,
      1,
      'lookup_scale_out_policy_invalid'
    );
    const forecastHorizonSeconds = integer(
      policy.lookup_forecast_horizon_seconds,
      300,
      'lookup_scale_out_policy_invalid'
    );
    const targetActiveRouteCount = integer(
      policy.lookup_target_active_route_count,
      1,
      'lookup_scale_out_policy_invalid'
    );
    const headroomBps = integer(
      policy.lookup_scale_out_headroom_bps,
      0,
      'lookup_scale_out_policy_invalid'
    );
    const ewmaAlphaBps = integer(
      policy.lookup_registration_ewma_alpha_bps,
      1,
      'lookup_scale_out_policy_invalid'
    );

    const domains = new Map<string, CapacityDomainObservation>();
    for (const row of residencies) {
      const residencyPolicyId = safeId(
        row.residency_policy_id,
        'lookup_scale_out_residency_invalid'
      );
      const residencyPartition = safeId(
        row.residency_partition,
        'lookup_scale_out_residency_invalid'
      );
      const lookupCapacityDomainId = safeId(
        row.lookup_capacity_domain_id,
        'lookup_scale_out_residency_invalid'
      );
      const current = domains.get(lookupCapacityDomainId);
      if (
        current &&
        (current.residencyPartition !== residencyPartition ||
          current.jurisdiction !== row.jurisdiction ||
          current.locationHint !== row.location_hint)
      ) {
        throw new Error('lookup_scale_out_capacity_domain_incompatible');
      }
      if (!current || residencyPolicyId.localeCompare(current.residencyPolicyId) < 0) {
        domains.set(lookupCapacityDomainId, {
          lookupCapacityDomainId,
          residencyPolicyId,
          residencyPartition,
          jurisdiction: row.jurisdiction,
          locationHint: row.location_hint,
          activeRouteCount: current?.activeRouteCount ?? 0,
          successfulPublicationCount: current?.successfulPublicationCount ?? 0,
          capacityWeightMilliunits: current?.capacityWeightMilliunits ?? 0,
          capacityUnitCount: current?.capacityUnitCount ?? 0,
        });
      }
    }

    const shardById = new Map<string, ShardRow>();
    for (const row of shards) {
      const shardId = safeId(row.lookup_shard_id, 'lookup_scale_out_shard_invalid');
      safeId(row.residency_policy_id, 'lookup_scale_out_shard_invalid');
      const residencyPartition = safeId(row.residency_partition, 'lookup_scale_out_shard_invalid');
      const lookupCapacityDomainId = safeId(
        row.lookup_capacity_domain_id,
        'lookup_scale_out_shard_invalid'
      );
      const residencyLookupCapacityDomainId = safeId(
        row.residency_lookup_capacity_domain_id,
        'lookup_scale_out_shard_invalid'
      );
      if (lookupCapacityDomainId !== residencyLookupCapacityDomainId) {
        throw new Error('lookup_scale_out_capacity_domain_drift');
      }
      const domain = domains.get(lookupCapacityDomainId);
      if (!domain || domain.residencyPartition !== residencyPartition) {
        throw new Error('lookup_scale_out_residency_missing');
      }
      const capacityWeight = Number(row.capacity_weight);
      if (!Number.isFinite(capacityWeight) || capacityWeight <= 0) {
        throw new Error('lookup_scale_out_capacity_invalid');
      }
      shardById.set(shardId, row);
      if (!['requested', 'provisioning', 'ready', 'active'].includes(row.status)) continue;
      const capacityWeightMilliunits = Math.round(capacityWeight * CAPACITY_WEIGHT_SCALE);
      integer(capacityWeightMilliunits, 1, 'lookup_scale_out_capacity_invalid');
      domain.capacityWeightMilliunits = safeAdd(
        domain.capacityWeightMilliunits,
        capacityWeightMilliunits,
        'lookup_scale_out_capacity_invalid'
      );
      domain.capacityUnitCount += 1;
    }

    const observations = new Map(input.buckets.map((row) => [row.virtualBucket, row] as const));
    if (observations.size !== input.buckets.length) {
      throw new Error('lookup_scale_out_snapshot_invalid');
    }
    for (const assignment of assignments) {
      const virtualBucket = integer(
        assignment.virtual_bucket,
        0,
        'lookup_scale_out_assignment_invalid'
      );
      if (virtualBucket > LOOKUP_MAX_VIRTUAL_BUCKET) {
        throw new Error('lookup_scale_out_assignment_invalid');
      }
      const observation = observations.get(virtualBucket);
      const shardId = safeId(assignment.lookup_shard_id, 'lookup_scale_out_assignment_invalid');
      const shard = shardById.get(shardId);
      const activeAssignment =
        assignment.state === 'active' && assignment.target_lookup_shard_id === null;
      const sourcePublishedDuringMigration =
        ['copying', 'verifying', 'cutover_pending', 'blocked'].includes(assignment.state) &&
        assignment.target_lookup_shard_id !== null;
      if (
        (!activeAssignment && !sourcePublishedDuringMigration) ||
        !observation ||
        !shard ||
        shard.status !== 'active' ||
        observation.lookupShardId !== shardId ||
        observation.assignmentGeneration !== Number(assignment.assignment_generation)
      ) {
        throw new Error('lookup_scale_out_assignment_mismatch');
      }
      for (const value of [
        observation.activeIdentifierCount,
        observation.activeAliasCount,
        observation.successfulRoutePublicationCount,
        observation.publicationCounterUpdatedAt,
        observation.counterUpdatedAt,
      ]) {
        integer(value, 0, 'lookup_scale_out_observation_invalid');
      }
      if (
        observation.counterUpdatedAt > input.observedAt + 5 ||
        observation.publicationCounterUpdatedAt > input.observedAt + 5
      ) {
        throw new Error('lookup_scale_out_observation_stale');
      }
      const domain = domains.get(shard.lookup_capacity_domain_id);
      if (!domain) throw new Error('lookup_scale_out_capacity_invalid');
      domain.activeRouteCount = safeAdd(
        domain.activeRouteCount,
        observation.activeIdentifierCount + observation.activeAliasCount,
        'lookup_scale_out_observation_invalid'
      );
      domain.successfulPublicationCount = safeAdd(
        domain.successfulPublicationCount,
        observation.successfulRoutePublicationCount,
        'lookup_scale_out_observation_invalid'
      );
    }

    const previousByDomain = new Map<string, ForecastRow>();
    for (const row of previous) {
      const lookupCapacityDomainId = safeId(
        row.lookup_capacity_domain_id,
        'lookup_scale_out_state_invalid'
      );
      if (previousByDomain.has(lookupCapacityDomainId)) {
        throw new Error('lookup_scale_out_state_invalid');
      }
      previousByDomain.set(lookupCapacityDomainId, row);
    }
    const views: ControlLookupScaleOutForecastView[] = [];
    const upserts: D1PreparedStatement[] = [];
    let capacityRequest: LookupScaleOutCapacityRequest | null = null;
    for (const partition of [...domains.values()].sort((left, right) =>
      left.lookupCapacityDomainId.localeCompare(right.lookupCapacityDomainId)
    )) {
      const prior = previousByDomain.get(partition.lookupCapacityDomainId);
      const samePolicy = prior && Number(prior.policy_generation) === policyGeneration;
      const plan = planLookupScaleOut({
        observedAt: input.observedAt,
        observedActiveRouteCount: partition.activeRouteCount,
        observedSuccessfulPublicationCount: partition.successfulPublicationCount,
        previousObservedAt: samePolicy
          ? integer(prior.observed_at, 1, 'lookup_scale_out_state_invalid')
          : null,
        previousSuccessfulPublicationCount: samePolicy
          ? integer(
              prior.observed_successful_publication_count,
              0,
              'lookup_scale_out_state_invalid'
            )
          : null,
        previousEwmaRateMicrorowsPerSecond: samePolicy
          ? integer(prior.ewma_rate_microrows_per_second, 0, 'lookup_scale_out_state_invalid')
          : null,
        forecastHorizonSeconds,
        ewmaAlphaBps,
        headroomBps,
        targetActiveRouteCountPerUnit: targetActiveRouteCount,
        capacityWeightMilliunits: partition.capacityWeightMilliunits,
        capacityUnitCount: partition.capacityUnitCount,
      });
      const linkedOperationId =
        prior?.requested_operation_id ?? prior?.reflected_operation_id ?? null;
      const linkedOperationStatus = prior?.requested_operation_status ?? null;
      if (linkedOperationId !== null && linkedOperationStatus === null) {
        throw new Error('lookup_scale_out_operation_state_missing');
      }
      const linkedOperationInFlight =
        linkedOperationId !== null &&
        ['queued', 'running', 'waiting_retry'].includes(linkedOperationStatus ?? '');
      const linkedOperationTerminalFailure =
        linkedOperationId !== null &&
        (linkedOperationStatus === 'blocked' || linkedOperationStatus === 'canceled');
      const linkedOperationSucceeded =
        linkedOperationId !== null && linkedOperationStatus === 'succeeded';
      const linkedCapacityReflected =
        linkedOperationSucceeded && prior?.requested_lookup_shard_status === 'active';
      if (
        linkedOperationId !== null &&
        !linkedOperationInFlight &&
        !linkedOperationTerminalFailure &&
        !linkedOperationSucceeded
      ) {
        throw new Error('lookup_scale_out_operation_state_invalid');
      }
      const linkedCapacityReflectionMissing = linkedOperationSucceeded && !linkedCapacityReflected;
      const retainLinkedOperation =
        linkedOperationInFlight ||
        linkedOperationTerminalFailure ||
        linkedCapacityReflectionMissing;
      const reuseUnlinkedBlockedDecision =
        linkedOperationId === null &&
        plan.shouldProvision &&
        samePolicy &&
        prior?.decision_state === 'blocked' &&
        Number(prior?.capacity_unit_count) === partition.capacityUnitCount;
      const reuseUnlinkedPendingDecision =
        linkedOperationId === null &&
        plan.shouldProvision &&
        samePolicy &&
        prior?.decision_state === 'provisioning' &&
        Number(prior?.capacity_unit_count) === partition.capacityUnitCount;
      const reuseDecision =
        retainLinkedOperation || reuseUnlinkedBlockedDecision || reuseUnlinkedPendingDecision;
      const linkedOperationErrorCode = linkedOperationTerminalFailure
        ? (prior?.requested_operation_error_code ??
          prior?.last_error_code ??
          'lookup_scale_out_capacity_operation_blocked')
        : linkedCapacityReflectionMissing
          ? 'lookup_scale_out_capacity_reflection_missing'
          : reuseUnlinkedBlockedDecision
            ? (prior?.last_error_code ?? 'lookup_scale_out_capacity_request_blocked')
            : null;
      const priorDecisionGeneration = prior
        ? integer(prior.decision_generation, 0, 'lookup_scale_out_state_invalid')
        : 0;
      const decisionGeneration = reuseDecision
        ? priorDecisionGeneration
        : plan.shouldProvision
          ? priorDecisionGeneration + 1
          : priorDecisionGeneration;
      const status: ControlLookupScaleOutForecastView['status'] = retainLinkedOperation
        ? linkedOperationTerminalFailure || linkedCapacityReflectionMissing
          ? 'blocked'
          : 'provisioning'
        : reuseUnlinkedBlockedDecision
          ? 'blocked'
          : plan.shouldProvision
            ? 'provisioning'
            : plan.hasRateSample
              ? 'stable'
              : 'warming';
      const capacityRequestIdempotencyKey = plan.shouldProvision
        ? reuseDecision && prior?.capacity_request_idempotency_key
          ? safeId(
              prior.capacity_request_idempotency_key,
              'lookup_scale_out_idempotency_key_invalid'
            )
          : await idempotencyKey({
              lookupCapacityDomainId: partition.lookupCapacityDomainId,
              policyGeneration,
              decisionGeneration,
            })
        : null;
      const snapshotDigest = await digest({
        observedAt: input.observedAt,
        lookupCapacityDomainId: partition.lookupCapacityDomainId,
        residencyPolicyId: partition.residencyPolicyId,
        residencyPartition: partition.residencyPartition,
        activeRouteCount: partition.activeRouteCount,
        successfulPublicationCount: partition.successfulPublicationCount,
        capacityWeightMilliunits: partition.capacityWeightMilliunits,
        capacityUnitCount: partition.capacityUnitCount,
      });
      const requestedOperationId = retainLinkedOperation ? linkedOperationId : null;
      const lastErrorCode = status === 'blocked' ? linkedOperationErrorCode : null;
      upserts.push(
        session
          .prepare(
            `INSERT INTO control_lookup_scale_out_forecasts (
             environment_id, lookup_capacity_domain_id,
             residency_policy_id, residency_partition, policy_generation,
             observed_at, observed_active_route_count, observed_successful_publication_count,
             sample_interval_seconds, sample_rate_microrows_per_second,
             ewma_rate_microrows_per_second, forecast_horizon_seconds,
             forecast_new_route_count, projected_active_route_count,
             usable_capacity_route_count, capacity_unit_count, decision_generation,
             decision_state, snapshot_digest, capacity_request_idempotency_key,
             requested_operation_id, last_error_code,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(environment_id, lookup_capacity_domain_id) DO UPDATE SET
             residency_policy_id = excluded.residency_policy_id,
             residency_partition = excluded.residency_partition,
             policy_generation = excluded.policy_generation,
             observed_at = excluded.observed_at,
             observed_active_route_count = excluded.observed_active_route_count,
             observed_successful_publication_count = excluded.observed_successful_publication_count,
             sample_interval_seconds = excluded.sample_interval_seconds,
             sample_rate_microrows_per_second = excluded.sample_rate_microrows_per_second,
             ewma_rate_microrows_per_second = excluded.ewma_rate_microrows_per_second,
             forecast_horizon_seconds = excluded.forecast_horizon_seconds,
             forecast_new_route_count = excluded.forecast_new_route_count,
             projected_active_route_count = excluded.projected_active_route_count,
             usable_capacity_route_count = excluded.usable_capacity_route_count,
             capacity_unit_count = excluded.capacity_unit_count,
             decision_generation = excluded.decision_generation,
             decision_state = excluded.decision_state,
             snapshot_digest = excluded.snapshot_digest,
             capacity_request_idempotency_key = excluded.capacity_request_idempotency_key,
             requested_operation_id = excluded.requested_operation_id,
             last_error_code = excluded.last_error_code,
             updated_at = excluded.updated_at
           WHERE excluded.observed_at > control_lookup_scale_out_forecasts.observed_at
              OR (
                excluded.observed_at = control_lookup_scale_out_forecasts.observed_at
                AND excluded.snapshot_digest = control_lookup_scale_out_forecasts.snapshot_digest
                AND excluded.decision_state = control_lookup_scale_out_forecasts.decision_state
                AND COALESCE(excluded.requested_operation_id, '') =
                    COALESCE(control_lookup_scale_out_forecasts.requested_operation_id, '')
              )`
          )
          .bind(
            environmentId,
            partition.lookupCapacityDomainId,
            partition.residencyPolicyId,
            partition.residencyPartition,
            policyGeneration,
            input.observedAt,
            partition.activeRouteCount,
            partition.successfulPublicationCount,
            plan.sampleIntervalSeconds,
            plan.sampleRateMicrorowsPerSecond,
            plan.ewmaRateMicrorowsPerSecond,
            forecastHorizonSeconds,
            plan.forecastNewRouteCount,
            plan.projectedActiveRouteCount,
            plan.usableCapacityRouteCount,
            partition.capacityUnitCount,
            decisionGeneration,
            status,
            snapshotDigest,
            capacityRequestIdempotencyKey,
            requestedOperationId,
            lastErrorCode,
            now,
            now
          )
      );
      const view: ControlLookupScaleOutForecastView = {
        lookupCapacityDomainId: partition.lookupCapacityDomainId,
        residencyPolicyId: partition.residencyPolicyId,
        residencyPartition: partition.residencyPartition,
        status,
        observedAt: input.observedAt,
        observedActiveRouteCount: partition.activeRouteCount,
        observedSuccessfulPublicationCount: partition.successfulPublicationCount,
        sampleIntervalSeconds: plan.sampleIntervalSeconds,
        sampleRateMicrorowsPerSecond: plan.sampleRateMicrorowsPerSecond,
        ewmaRateMicrorowsPerSecond: plan.ewmaRateMicrorowsPerSecond,
        forecastHorizonSeconds,
        forecastNewRouteCount: plan.forecastNewRouteCount,
        projectedActiveRouteCount: plan.projectedActiveRouteCount,
        usableCapacityRouteCount: plan.usableCapacityRouteCount,
        capacityUnitCount: partition.capacityUnitCount,
        additionalUnitsRequired: plan.additionalUnitsRequired,
        decisionGeneration,
        requestedOperationId,
        lastErrorCode,
      };
      views.push(view);
      if (
        plan.shouldProvision &&
        status === 'provisioning' &&
        !requestedOperationId &&
        !capacityRequest
      ) {
        capacityRequest = {
          lookupCapacityDomainId: partition.lookupCapacityDomainId,
          residencyPolicyId: partition.residencyPolicyId,
          residencyPartition: partition.residencyPartition,
          idempotencyKey: safeId(
            capacityRequestIdempotencyKey,
            'lookup_scale_out_idempotency_key_invalid'
          ),
          decisionGeneration,
        };
      }
    }
    const persisted = await session.batch(upserts);
    if (persisted.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error('lookup_scale_out_observation_stale');
    }
    return { views, capacityRequest };
  }

  async reconcileProvisioningOperations(): Promise<LookupScaleOutReconciliationResult> {
    const session = primary(this.db);
    const [unlinkedResult, candidateResult] = await Promise.all([
      session
        .prepare(
          `SELECT environment_id, lookup_capacity_domain_id, residency_policy_id,
                  residency_partition, capacity_request_idempotency_key,
                  decision_generation
             FROM control_lookup_scale_out_forecasts
            WHERE decision_state = 'provisioning'
              AND requested_operation_id IS NULL
              AND capacity_request_idempotency_key IS NOT NULL
            ORDER BY updated_at, environment_id, lookup_capacity_domain_id
            LIMIT 8`
        )
        .bind()
        .all<UnlinkedCapacityRequestRow>(),
      session
        .prepare(
          `SELECT forecast.environment_id, forecast.lookup_capacity_domain_id,
                forecast.residency_policy_id, forecast.residency_partition,
                forecast.policy_generation,
                forecast.decision_generation, forecast.projected_active_route_count,
                forecast.requested_operation_id,
                operation.status AS requested_operation_status,
                operation.last_error_code AS requested_operation_error_code,
                policy.lookup_target_active_route_count,
                policy.lookup_scale_out_headroom_bps
           FROM control_lookup_scale_out_forecasts forecast
           JOIN control_operations operation
             ON operation.environment_id = forecast.environment_id
            AND operation.operation_id = forecast.requested_operation_id
            AND operation.operation_kind = 'provision_shard'
           JOIN control_environment_resource_policies policy
             ON policy.environment_id = forecast.environment_id
          WHERE forecast.decision_state = 'provisioning'
            AND forecast.requested_operation_id IS NOT NULL
            AND operation.status IN ('succeeded', 'blocked', 'canceled')
          ORDER BY forecast.updated_at, forecast.environment_id,
                   forecast.lookup_capacity_domain_id
          LIMIT 8`
        )
        .bind()
        .all<ProvisioningReconciliationRow>(),
    ]);
    const unlinked = unlinkedResult.results;
    const candidates = candidateResult.results;
    const pendingCapacityRequests = unlinked.map((row) => ({
      environmentId: safeId(row.environment_id, 'lookup_scale_out_environment_invalid'),
      lookupCapacityDomainId: safeId(
        row.lookup_capacity_domain_id,
        'lookup_scale_out_state_invalid'
      ),
      residencyPolicyId: safeId(row.residency_policy_id, 'lookup_scale_out_residency_invalid'),
      residencyPartition: safeId(row.residency_partition, 'lookup_scale_out_residency_invalid'),
      idempotencyKey: safeId(
        row.capacity_request_idempotency_key,
        'lookup_scale_out_idempotency_key_invalid'
      ),
      decisionGeneration: integer(row.decision_generation, 0, 'lookup_scale_out_state_invalid'),
    }));
    if (candidates.length === 0) {
      return { settledCount: 0, blockedCount: 0, capacityRequests: pendingCapacityRequests };
    }

    const capacityResults = await session.batch<ProvisioningCapacityRow>(
      candidates.map((candidate) =>
        session
          .prepare(
            `SELECT COUNT(*) AS capacity_unit_count,
                    COALESCE(SUM(CAST(ROUND(shard.capacity_weight * ?) AS INTEGER)), 0)
                      AS capacity_weight_milliunits,
                    COALESCE(SUM(CASE
                      WHEN desired.origin_operation_id = ? AND shard.status = 'active' THEN 1
                      ELSE 0
                    END), 0) AS reflected_target_count
               FROM control_lookup_physical_shards shard
               JOIN control_desired_resources desired
                 ON desired.environment_id = shard.environment_id
                AND desired.desired_resource_id = shard.d1_desired_resource_id
               JOIN control_residency_partitions residency
                 ON residency.environment_id = shard.environment_id
                AND residency.residency_policy_id =
                    json_extract(desired.desired_spec_json, '$.residency_policy_id')
                AND residency.residency_partition = shard.residency_partition
              WHERE shard.environment_id = ?
                AND shard.status IN ('requested', 'provisioning', 'ready', 'active')
                AND COALESCE(
                      json_extract(desired.desired_spec_json, '$.lookup_capacity_domain_id'),
                      residency.lookup_capacity_domain_id,
                      'lookup:' || residency.residency_policy_id || ':' ||
                        residency.residency_partition
                    ) = ?`
          )
          .bind(
            CAPACITY_WEIGHT_SCALE,
            candidate.requested_operation_id,
            candidate.environment_id,
            candidate.lookup_capacity_domain_id
          )
      )
    );

    const now = this.now();
    const updates: Array<{
      statement: D1PreparedStatement;
      outcome: 'settled' | 'blocked' | 'request';
      request?: LookupScaleOutCapacityRequest & { environmentId: string };
    }> = [];
    for (const [index, candidate] of candidates.entries()) {
      const environmentId = safeId(
        candidate.environment_id,
        'lookup_scale_out_environment_invalid'
      );
      const lookupCapacityDomainId = safeId(
        candidate.lookup_capacity_domain_id,
        'lookup_scale_out_state_invalid'
      );
      const residencyPolicyId = safeId(
        candidate.residency_policy_id,
        'lookup_scale_out_residency_invalid'
      );
      const residencyPartition = safeId(
        candidate.residency_partition,
        'lookup_scale_out_residency_invalid'
      );
      const operationId = safeId(
        candidate.requested_operation_id,
        'lookup_scale_out_operation_invalid'
      );
      const decisionGeneration = integer(
        candidate.decision_generation,
        0,
        'lookup_scale_out_state_invalid'
      );
      const policyGeneration = integer(
        candidate.policy_generation,
        1,
        'lookup_scale_out_policy_invalid'
      );
      const capacity = capacityResults[index]?.results[0];
      if (!capacity) throw new Error('lookup_scale_out_capacity_invalid');
      const capacityUnitCount = integer(
        capacity.capacity_unit_count,
        0,
        'lookup_scale_out_capacity_invalid'
      );
      const capacityWeightMilliunits = integer(
        capacity.capacity_weight_milliunits,
        0,
        'lookup_scale_out_capacity_invalid'
      );
      const reflectedTargetCount = integer(
        capacity.reflected_target_count,
        0,
        'lookup_scale_out_capacity_invalid'
      );
      const targetActiveRouteCount = integer(
        candidate.lookup_target_active_route_count,
        1,
        'lookup_scale_out_policy_invalid'
      );
      const headroomBps = integer(
        candidate.lookup_scale_out_headroom_bps,
        0,
        'lookup_scale_out_policy_invalid'
      );
      if (headroomBps > 9_000) throw new Error('lookup_scale_out_policy_invalid');
      const usablePerStandardUnit = Math.floor(
        safeProduct(
          targetActiveRouteCount,
          10_000 - headroomBps,
          'lookup_scale_out_capacity_invalid'
        ) / 10_000
      );
      const usableCapacityRouteCount = Math.floor(
        safeProduct(
          usablePerStandardUnit,
          capacityWeightMilliunits,
          'lookup_scale_out_capacity_invalid'
        ) / CAPACITY_WEIGHT_SCALE
      );

      const terminalFailure =
        candidate.requested_operation_status === 'blocked' ||
        candidate.requested_operation_status === 'canceled';
      if (terminalFailure || reflectedTargetCount === 0) {
        const errorCode = terminalFailure
          ? candidate.requested_operation_error_code &&
            SAFE_ID.test(candidate.requested_operation_error_code)
            ? candidate.requested_operation_error_code
            : 'lookup_scale_out_capacity_operation_blocked'
          : 'lookup_scale_out_capacity_reflection_missing';
        updates.push({
          outcome: 'blocked',
          statement: session
            .prepare(
              `UPDATE control_lookup_scale_out_forecasts
                  SET decision_state = 'blocked', last_error_code = ?,
                      capacity_unit_count = ?, usable_capacity_route_count = ?, updated_at = ?
                WHERE environment_id = ? AND lookup_capacity_domain_id = ?
                  AND decision_generation = ? AND decision_state = 'provisioning'
                  AND requested_operation_id = ?`
            )
            .bind(
              errorCode,
              capacityUnitCount,
              usableCapacityRouteCount,
              now,
              environmentId,
              lookupCapacityDomainId,
              decisionGeneration,
              operationId
            ),
        });
        continue;
      }

      const projectedActiveRouteCount = integer(
        candidate.projected_active_route_count,
        0,
        'lookup_scale_out_forecast_overflow'
      );
      if (projectedActiveRouteCount <= usableCapacityRouteCount) {
        updates.push({
          outcome: 'settled',
          statement: session
            .prepare(
              `UPDATE control_lookup_scale_out_forecasts
                  SET decision_state = 'stable', capacity_request_idempotency_key = NULL,
                      requested_operation_id = NULL, last_error_code = NULL,
                      capacity_unit_count = ?, usable_capacity_route_count = ?, updated_at = ?
                WHERE environment_id = ? AND lookup_capacity_domain_id = ?
                  AND decision_generation = ? AND decision_state = 'provisioning'
                  AND requested_operation_id = ?`
            )
            .bind(
              capacityUnitCount,
              usableCapacityRouteCount,
              now,
              environmentId,
              lookupCapacityDomainId,
              decisionGeneration,
              operationId
            ),
        });
        continue;
      }

      const nextDecisionGeneration = decisionGeneration + 1;
      const nextIdempotencyKey = await idempotencyKey({
        lookupCapacityDomainId,
        policyGeneration,
        decisionGeneration: nextDecisionGeneration,
      });
      const request = {
        environmentId,
        lookupCapacityDomainId,
        residencyPolicyId,
        residencyPartition,
        idempotencyKey: nextIdempotencyKey,
        decisionGeneration: nextDecisionGeneration,
      };
      updates.push({
        outcome: 'request',
        request,
        statement: session
          .prepare(
            `UPDATE control_lookup_scale_out_forecasts
                SET decision_generation = ?, capacity_request_idempotency_key = ?,
                    requested_operation_id = NULL, last_error_code = NULL,
                    capacity_unit_count = ?, usable_capacity_route_count = ?, updated_at = ?
              WHERE environment_id = ? AND lookup_capacity_domain_id = ?
                AND decision_generation = ? AND decision_state = 'provisioning'
                AND requested_operation_id = ?`
          )
          .bind(
            nextDecisionGeneration,
            nextIdempotencyKey,
            capacityUnitCount,
            usableCapacityRouteCount,
            now,
            environmentId,
            lookupCapacityDomainId,
            decisionGeneration,
            operationId
          ),
      });
    }

    const results = await session.batch(updates.map((update) => update.statement));
    const applied = updates.filter((_update, index) => (results[index]?.meta.changes ?? 0) === 1);
    return {
      settledCount: applied.filter((update) => update.outcome === 'settled').length,
      blockedCount: applied.filter((update) => update.outcome === 'blocked').length,
      capacityRequests: [
        ...pendingCapacityRequests,
        ...applied.flatMap((update) =>
          update.outcome === 'request' && update.request ? [update.request] : []
        ),
      ],
    };
  }

  async recordProvisioningOperation(
    environmentIdValue: string,
    request: LookupScaleOutCapacityRequest,
    operationIdValue: string,
    operationStatus = 'running',
    operationErrorCode: string | null = null
  ): Promise<void> {
    const environmentId = safeId(environmentIdValue, 'lookup_scale_out_environment_invalid');
    const operationId = safeId(operationIdValue, 'lookup_scale_out_operation_invalid');
    if (
      !['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(
        operationStatus
      )
    ) {
      throw new Error('lookup_scale_out_operation_state_invalid');
    }
    const blocked = operationStatus === 'blocked' || operationStatus === 'canceled';
    const errorCode = blocked
      ? operationErrorCode && SAFE_ID.test(operationErrorCode)
        ? operationErrorCode
        : 'lookup_scale_out_capacity_operation_blocked'
      : null;
    const decisionState = blocked ? 'blocked' : 'provisioning';
    const result = await primary(this.db)
      .prepare(
        `UPDATE control_lookup_scale_out_forecasts
            SET requested_operation_id = ?, decision_state = ?,
                last_error_code = ?, updated_at = ?
          WHERE environment_id = ? AND lookup_capacity_domain_id = ?
            AND decision_generation = ?
            AND (
              decision_state = 'provisioning'
              OR (requested_operation_id = ? AND decision_state = ?)
            )`
      )
      .bind(
        operationId,
        decisionState,
        errorCode,
        this.now(),
        environmentId,
        request.lookupCapacityDomainId,
        request.decisionGeneration,
        operationId,
        decisionState
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error('lookup_scale_out_decision_stale');
    }
  }

  async recordCapacityRequestRetry(
    environmentIdValue: string,
    request: LookupScaleOutCapacityRequest,
    errorCode: string
  ): Promise<void> {
    const environmentId = safeId(environmentIdValue, 'lookup_scale_out_environment_invalid');
    const code = safeId(errorCode, 'lookup_scale_out_error_code_invalid');
    await primary(this.db)
      .prepare(
        `UPDATE control_lookup_scale_out_forecasts
            SET decision_state = 'provisioning', last_error_code = ?, updated_at = ?
          WHERE environment_id = ? AND lookup_capacity_domain_id = ?
            AND decision_generation = ? AND decision_state = 'provisioning'
            AND requested_operation_id IS NULL`
      )
      .bind(
        code,
        this.now(),
        environmentId,
        request.lookupCapacityDomainId,
        request.decisionGeneration
      )
      .run();
  }

  async blockCapacityRequest(
    environmentIdValue: string,
    request: LookupScaleOutCapacityRequest,
    errorCode: string
  ): Promise<void> {
    const environmentId = safeId(environmentIdValue, 'lookup_scale_out_environment_invalid');
    const code = safeId(errorCode, 'lookup_scale_out_error_code_invalid');
    const result = await primary(this.db)
      .prepare(
        `UPDATE control_lookup_scale_out_forecasts
            SET decision_state = 'blocked', last_error_code = ?, updated_at = ?
          WHERE environment_id = ? AND lookup_capacity_domain_id = ?
            AND decision_generation = ? AND decision_state = 'provisioning'
            AND requested_operation_id IS NULL`
      )
      .bind(
        code,
        this.now(),
        environmentId,
        request.lookupCapacityDomainId,
        request.decisionGeneration
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error('lookup_scale_out_decision_stale');
    }
  }
}
