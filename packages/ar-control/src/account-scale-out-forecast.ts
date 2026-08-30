import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type {
  ControlAccountDataRole,
  ControlTenantShardAllocationScope,
} from '@authrim/ar-lib-core/control-plane';
import { planAccountScaleOut } from './account-scale-out-planner';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

interface ForecastRow {
  environment_id: string;
  allocation_scope: ControlTenantShardAllocationScope;
  owner_tenant_key: string;
  owner_tenant_id: string | null;
  data_role: ControlAccountDataRole;
  residency_policy_id: string;
  residency_partition: string;
  policy_generation: number | string;
  successful_allocation_count: number | string;
  observed_at: number | string;
  observed_successful_allocation_count: number | string;
  sample_interval_seconds: number | string;
  ewma_rate_microaccounts_per_second: number | string;
  decision_generation: number | string;
  decision_state: 'warming' | 'stable' | 'provisioning' | 'blocked';
  capacity_request_idempotency_key: string | null;
  requested_operation_id: string | null;
  last_error_code: string | null;
  requested_operation_status: string | null;
  requested_operation_error_code: string | null;
  requested_shard_status: string | null;
  account_forecast_horizon_seconds: number | string;
  account_scale_out_headroom_bps: number | string;
  account_registration_ewma_alpha_bps: number | string;
  account_scale_out_policy_generation: number | string;
  target_account_count: number | string;
  observed_allocated_account_count: number | string;
  raw_capacity_account_count: number | string;
  capacity_unit_count: number | string;
}

export interface AccountScaleOutCapacityRequest {
  environmentId: string;
  allocationScope: ControlTenantShardAllocationScope;
  ownerTenantId: string | null;
  dataRole: ControlAccountDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
  decisionGeneration: number;
}

export interface AccountScaleOutForecastView {
  allocationScope: ControlTenantShardAllocationScope;
  ownerTenantId: string | null;
  dataRole: ControlAccountDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  status: 'warming' | 'stable' | 'provisioning' | 'blocked';
  observedAt: number;
  observedAllocatedAccountCount: number;
  observedSuccessfulAllocationCount: number;
  sampleIntervalSeconds: number;
  sampleRateMicroaccountsPerSecond: number;
  ewmaRateMicroaccountsPerSecond: number;
  forecastHorizonSeconds: number;
  forecastNewAccountCount: number;
  projectedAccountCount: number;
  usableCapacityAccountCount: number;
  capacityUnitCount: number;
  additionalUnitsRequired: number;
  decisionGeneration: number;
  requestedOperationId: string | null;
  lastErrorCode: string | null;
}

export interface AccountScaleOutForecastResult {
  views: AccountScaleOutForecastView[];
  capacityRequests: AccountScaleOutCapacityRequest[];
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

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function capacityIdempotencyKey(input: {
  environmentId: string;
  allocationScope: ControlTenantShardAllocationScope;
  ownerTenantKey: string;
  dataRole: ControlAccountDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  policyGeneration: number;
  decisionGeneration: number;
}): Promise<string> {
  return `account-forecast:${(await digest(input)).slice(0, 48)}`;
}

function validateScope(row: ForecastRow): void {
  if (
    (row.allocation_scope === 'shared_pool' &&
      (row.owner_tenant_key !== '' || row.owner_tenant_id !== null)) ||
    (row.allocation_scope === 'tenant_exclusive' &&
      (!row.owner_tenant_id || row.owner_tenant_key !== row.owner_tenant_id))
  ) {
    throw new Error('account_scale_out_scope_invalid');
  }
}

export class AccountScaleOutForecastService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number
  ) {}

  async observe(
    environmentIdValue: string,
    tenantIdValue?: string
  ): Promise<AccountScaleOutForecastResult> {
    const environmentId = safeId(environmentIdValue, 'account_scale_out_environment_invalid');
    const tenantId =
      tenantIdValue === undefined
        ? null
        : safeId(tenantIdValue, 'account_scale_out_tenant_invalid');
    const observedAt = this.now();
    const session = primary(this.db);
    const result = await session
      .prepare(
        `SELECT forecast.environment_id, forecast.allocation_scope,
                forecast.owner_tenant_key, forecast.owner_tenant_id,
                forecast.data_role, forecast.residency_policy_id,
                forecast.residency_partition, forecast.policy_generation,
                forecast.successful_allocation_count, forecast.observed_at,
                forecast.observed_successful_allocation_count,
                forecast.sample_interval_seconds,
                forecast.ewma_rate_microaccounts_per_second,
                forecast.decision_generation, forecast.decision_state,
                forecast.capacity_request_idempotency_key,
                forecast.requested_operation_id, forecast.last_error_code,
                operation.status AS requested_operation_status,
                operation.last_error_code AS requested_operation_error_code,
                (
                  SELECT shard.status
                    FROM control_desired_resources desired
                    JOIN control_tenant_shards shard
                      ON shard.environment_id = desired.environment_id
                     AND shard.d1_desired_resource_id = desired.desired_resource_id
                   WHERE desired.environment_id = forecast.environment_id
                     AND desired.origin_operation_id = forecast.requested_operation_id
                   ORDER BY shard.shard_id LIMIT 1
                ) AS requested_shard_status,
                policy.account_forecast_horizon_seconds,
                policy.account_scale_out_headroom_bps,
                policy.account_registration_ewma_alpha_bps,
                policy.account_scale_out_policy_generation,
                policy.target_account_count,
                COALESCE((
                  SELECT SUM(COALESCE(capacity.allocated_account_count, 0))
                    FROM control_tenant_shards shard
                    LEFT JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
                   WHERE shard.environment_id = forecast.environment_id
                     AND shard.data_role = forecast.data_role
                     AND shard.residency_policy_id = forecast.residency_policy_id
                     AND shard.residency_partition = forecast.residency_partition
                     AND shard.allocation_scope = forecast.allocation_scope
                     AND ((forecast.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
                          (forecast.allocation_scope = 'tenant_exclusive' AND
                           shard.owner_tenant_id = forecast.owner_tenant_id))
                     AND shard.status = 'active'
                ), 0) AS observed_allocated_account_count,
                COALESCE((
                  SELECT SUM(CASE WHEN shard.status = 'active'
                                  THEN COALESCE(capacity.target_account_count,
                                                policy.target_account_count)
                                  ELSE policy.target_account_count END)
                    FROM control_tenant_shards shard
                    LEFT JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
                   WHERE shard.environment_id = forecast.environment_id
                     AND shard.data_role = forecast.data_role
                     AND shard.residency_policy_id = forecast.residency_policy_id
                     AND shard.residency_partition = forecast.residency_partition
                     AND shard.allocation_scope = forecast.allocation_scope
                     AND ((forecast.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
                          (forecast.allocation_scope = 'tenant_exclusive' AND
                           shard.owner_tenant_id = forecast.owner_tenant_id))
                     AND shard.status IN ('requested', 'provisioning', 'ready', 'active')
                ), 0) AS raw_capacity_account_count,
                COALESCE((
                  SELECT COUNT(*)
                    FROM control_tenant_shards shard
                   WHERE shard.environment_id = forecast.environment_id
                     AND shard.data_role = forecast.data_role
                     AND shard.residency_policy_id = forecast.residency_policy_id
                     AND shard.residency_partition = forecast.residency_partition
                     AND shard.allocation_scope = forecast.allocation_scope
                     AND ((forecast.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
                          (forecast.allocation_scope = 'tenant_exclusive' AND
                           shard.owner_tenant_id = forecast.owner_tenant_id))
                     AND shard.status IN ('requested', 'provisioning', 'ready', 'active')
                ), 0) AS capacity_unit_count
           FROM control_account_scale_out_forecasts forecast
           JOIN control_environment_resource_policies policy
             ON policy.environment_id = forecast.environment_id
           LEFT JOIN control_operations operation
             ON operation.environment_id = forecast.environment_id
            AND operation.operation_id = forecast.requested_operation_id
          WHERE forecast.environment_id = ?
            AND (? IS NULL OR forecast.allocation_scope = 'shared_pool' OR
                 forecast.owner_tenant_id = ?)
          ORDER BY forecast.allocation_scope, forecast.owner_tenant_key,
                   forecast.residency_partition, forecast.data_role`
      )
      .bind(environmentId, tenantId, tenantId)
      .all<ForecastRow>();

    const views: AccountScaleOutForecastView[] = [];
    const capacityRequests: AccountScaleOutCapacityRequest[] = [];
    for (const row of result.results) {
      validateScope(row);
      const policyGeneration = integer(
        row.account_scale_out_policy_generation,
        1,
        'account_scale_out_policy_invalid'
      );
      const samePolicy =
        integer(row.policy_generation, 1, 'account_scale_out_state_invalid') === policyGeneration;
      const plan = planAccountScaleOut({
        observedAt,
        observedAllocatedAccountCount: integer(
          row.observed_allocated_account_count,
          0,
          'account_scale_out_capacity_invalid'
        ),
        observedSuccessfulAllocationCount: integer(
          row.successful_allocation_count,
          0,
          'account_scale_out_state_invalid'
        ),
        previousObservedAt: samePolicy
          ? integer(row.observed_at, 1, 'account_scale_out_state_invalid')
          : null,
        previousSuccessfulAllocationCount: samePolicy
          ? integer(row.observed_successful_allocation_count, 0, 'account_scale_out_state_invalid')
          : null,
        previousEwmaRateMicroaccountsPerSecond: samePolicy
          ? integer(row.ewma_rate_microaccounts_per_second, 0, 'account_scale_out_state_invalid')
          : null,
        forecastHorizonSeconds: integer(
          row.account_forecast_horizon_seconds,
          60,
          'account_scale_out_policy_invalid'
        ),
        ewmaAlphaBps: integer(
          row.account_registration_ewma_alpha_bps,
          1,
          'account_scale_out_policy_invalid'
        ),
        headroomBps: integer(
          row.account_scale_out_headroom_bps,
          0,
          'account_scale_out_policy_invalid'
        ),
        targetAccountCountPerUnit: integer(
          row.target_account_count,
          1,
          'account_scale_out_capacity_invalid'
        ),
        rawCapacityAccountCount: integer(
          row.raw_capacity_account_count,
          0,
          'account_scale_out_capacity_invalid'
        ),
        capacityUnitCount: integer(
          row.capacity_unit_count,
          0,
          'account_scale_out_capacity_invalid'
        ),
      });

      const linkedOperationId = row.requested_operation_id;
      const linkedOperationStatus = row.requested_operation_status;
      if (linkedOperationId !== null && linkedOperationStatus === null) {
        throw new Error('account_scale_out_operation_state_missing');
      }
      const linkedOperationInFlight =
        linkedOperationId !== null &&
        ['queued', 'running', 'waiting_retry'].includes(linkedOperationStatus ?? '');
      const linkedOperationBlocked =
        linkedOperationId !== null &&
        samePolicy &&
        (linkedOperationStatus === 'blocked' || linkedOperationStatus === 'canceled');
      const linkedCapacityReflected =
        linkedOperationId !== null &&
        linkedOperationStatus === 'succeeded' &&
        row.requested_shard_status === 'active';
      const linkedCapacityReflectionMissing =
        linkedOperationId !== null &&
        linkedOperationStatus === 'succeeded' &&
        !linkedCapacityReflected;
      const unlinkedPending =
        linkedOperationId === null &&
        row.decision_state === 'provisioning' &&
        row.capacity_request_idempotency_key !== null;
      const unlinkedBlocked =
        linkedOperationId === null &&
        samePolicy &&
        row.decision_state === 'blocked' &&
        row.capacity_request_idempotency_key !== null;
      const retainDecision =
        linkedOperationInFlight ||
        linkedOperationBlocked ||
        linkedCapacityReflectionMissing ||
        unlinkedPending ||
        unlinkedBlocked;
      const priorDecisionGeneration = integer(
        row.decision_generation,
        0,
        'account_scale_out_state_invalid'
      );
      const shouldStartDecision = plan.shouldProvision && !retainDecision;
      const decisionGeneration = shouldStartDecision
        ? priorDecisionGeneration + 1
        : priorDecisionGeneration;
      const status: AccountScaleOutForecastView['status'] =
        linkedOperationBlocked || unlinkedBlocked
          ? 'blocked'
          : linkedOperationInFlight ||
              linkedCapacityReflectionMissing ||
              unlinkedPending ||
              shouldStartDecision
            ? 'provisioning'
            : plan.hasRateSample || plan.ewmaRateMicroaccountsPerSecond > 0
              ? 'stable'
              : 'warming';
      const idempotencyKey =
        status === 'provisioning' || status === 'blocked'
          ? retainDecision && row.capacity_request_idempotency_key
            ? safeId(
                row.capacity_request_idempotency_key,
                'account_scale_out_idempotency_key_invalid'
              )
            : await capacityIdempotencyKey({
                environmentId,
                allocationScope: row.allocation_scope,
                ownerTenantKey: row.owner_tenant_key,
                dataRole: row.data_role,
                residencyPolicyId: row.residency_policy_id,
                residencyPartition: row.residency_partition,
                policyGeneration,
                decisionGeneration,
              })
          : null;
      const requestedOperationId =
        linkedOperationInFlight || linkedOperationBlocked || linkedCapacityReflectionMissing
          ? linkedOperationId
          : null;
      const lastErrorCode =
        linkedOperationBlocked || unlinkedBlocked
          ? (row.requested_operation_error_code ??
            row.last_error_code ??
            'account_scale_out_blocked')
          : linkedCapacityReflectionMissing
            ? 'account_scale_out_capacity_reflection_missing'
            : null;
      const snapshotDigest = await digest({
        environmentId,
        allocationScope: row.allocation_scope,
        ownerTenantKey: row.owner_tenant_key,
        dataRole: row.data_role,
        residencyPolicyId: row.residency_policy_id,
        residencyPartition: row.residency_partition,
        observedAt,
        successfulAllocationCount: row.successful_allocation_count,
        observedAllocatedAccountCount: plan.projectedAccountCount - plan.forecastNewAccountCount,
        rawCapacityAccountCount: row.raw_capacity_account_count,
        capacityUnitCount: plan.capacityUnitCount,
      });

      await session
        .prepare(
          `UPDATE control_account_scale_out_forecasts
              SET policy_generation = ?, observed_at = ?,
                  observed_successful_allocation_count = successful_allocation_count,
                  sample_interval_seconds = ?,
                  sample_rate_microaccounts_per_second = ?,
                  ewma_rate_microaccounts_per_second = ?,
                  forecast_horizon_seconds = ?, forecast_new_account_count = ?,
                  observed_allocated_account_count = ?, projected_account_count = ?,
                  usable_capacity_account_count = ?, capacity_unit_count = ?,
                  decision_generation = ?, decision_state = ?, snapshot_digest = ?,
                  capacity_request_idempotency_key = ?, requested_operation_id = ?,
                  last_error_code = ?, updated_at = ?
            WHERE environment_id = ? AND allocation_scope = ? AND owner_tenant_key = ?
              AND data_role = ? AND residency_policy_id = ? AND residency_partition = ?
              AND observed_at <= ?`
        )
        .bind(
          policyGeneration,
          observedAt,
          plan.sampleIntervalSeconds,
          plan.sampleRateMicroaccountsPerSecond,
          plan.ewmaRateMicroaccountsPerSecond,
          integer(row.account_forecast_horizon_seconds, 60, 'account_scale_out_policy_invalid'),
          plan.forecastNewAccountCount,
          plan.projectedAccountCount - plan.forecastNewAccountCount,
          plan.projectedAccountCount,
          plan.usableCapacityAccountCount,
          plan.capacityUnitCount,
          decisionGeneration,
          status,
          snapshotDigest,
          idempotencyKey,
          requestedOperationId,
          lastErrorCode,
          observedAt,
          environmentId,
          row.allocation_scope,
          row.owner_tenant_key,
          row.data_role,
          row.residency_policy_id,
          row.residency_partition,
          observedAt
        )
        .run();

      const view: AccountScaleOutForecastView = {
        allocationScope: row.allocation_scope,
        ownerTenantId: row.owner_tenant_id,
        dataRole: row.data_role,
        residencyPolicyId: row.residency_policy_id,
        residencyPartition: row.residency_partition,
        status,
        observedAt,
        observedAllocatedAccountCount: plan.projectedAccountCount - plan.forecastNewAccountCount,
        observedSuccessfulAllocationCount: integer(
          row.successful_allocation_count,
          0,
          'account_scale_out_state_invalid'
        ),
        sampleIntervalSeconds: plan.sampleIntervalSeconds,
        sampleRateMicroaccountsPerSecond: plan.sampleRateMicroaccountsPerSecond,
        ewmaRateMicroaccountsPerSecond: plan.ewmaRateMicroaccountsPerSecond,
        forecastHorizonSeconds: integer(
          row.account_forecast_horizon_seconds,
          60,
          'account_scale_out_policy_invalid'
        ),
        forecastNewAccountCount: plan.forecastNewAccountCount,
        projectedAccountCount: plan.projectedAccountCount,
        usableCapacityAccountCount: plan.usableCapacityAccountCount,
        capacityUnitCount: plan.capacityUnitCount,
        additionalUnitsRequired: plan.additionalUnitsRequired,
        decisionGeneration,
        requestedOperationId,
        lastErrorCode,
      };
      views.push(view);
      if (status === 'provisioning' && requestedOperationId === null && idempotencyKey) {
        capacityRequests.push({
          environmentId,
          allocationScope: row.allocation_scope,
          ownerTenantId: row.owner_tenant_id,
          dataRole: row.data_role,
          residencyPolicyId: safeId(row.residency_policy_id, 'account_scale_out_residency_invalid'),
          residencyPartition: safeId(
            row.residency_partition,
            'account_scale_out_residency_invalid'
          ),
          idempotencyKey,
          decisionGeneration,
        });
      }
    }
    return { views, capacityRequests };
  }

  async recordProvisioningOperation(input: {
    request: AccountScaleOutCapacityRequest;
    operationId: string;
    operationStatus: string;
    lastErrorCode: string | null;
  }): Promise<void> {
    const request = input.request;
    const operationId = safeId(input.operationId, 'account_scale_out_operation_invalid');
    if (
      !['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(
        input.operationStatus
      )
    ) {
      throw new Error('account_scale_out_operation_invalid');
    }
    const ownerTenantKey = request.ownerTenantId ?? '';
    const now = this.now();
    const result = await primary(this.db)
      .prepare(
        `UPDATE control_account_scale_out_forecasts
            SET requested_operation_id = ?,
                decision_state = CASE WHEN ? IN ('blocked', 'canceled')
                                      THEN 'blocked' ELSE 'provisioning' END,
                last_error_code = ?, updated_at = ?
          WHERE environment_id = ? AND allocation_scope = ? AND owner_tenant_key = ?
            AND data_role = ? AND residency_policy_id = ? AND residency_partition = ?
            AND decision_generation = ? AND capacity_request_idempotency_key = ?
            AND requested_operation_id IS NULL`
      )
      .bind(
        operationId,
        input.operationStatus,
        ['blocked', 'canceled'].includes(input.operationStatus) ? input.lastErrorCode : null,
        now,
        request.environmentId,
        request.allocationScope,
        ownerTenantKey,
        request.dataRole,
        request.residencyPolicyId,
        request.residencyPartition,
        request.decisionGeneration,
        request.idempotencyKey
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      const existing = await primary(this.db)
        .prepare(
          `SELECT requested_operation_id
             FROM control_account_scale_out_forecasts
            WHERE environment_id = ? AND allocation_scope = ? AND owner_tenant_key = ?
              AND data_role = ? AND residency_policy_id = ? AND residency_partition = ?
              AND decision_generation = ? AND capacity_request_idempotency_key = ?`
        )
        .bind(
          request.environmentId,
          request.allocationScope,
          ownerTenantKey,
          request.dataRole,
          request.residencyPolicyId,
          request.residencyPartition,
          request.decisionGeneration,
          request.idempotencyKey
        )
        .first<{ requested_operation_id: string | null }>();
      if (existing?.requested_operation_id !== operationId) {
        throw new Error('account_scale_out_operation_link_conflict');
      }
    }
  }

  async recordCapacityRequestFailure(
    request: AccountScaleOutCapacityRequest,
    errorCodeValue: string,
    terminal: boolean
  ): Promise<void> {
    const errorCode = safeId(errorCodeValue, 'account_scale_out_error_code_invalid');
    const ownerTenantKey = request.ownerTenantId ?? '';
    const result = await primary(this.db)
      .prepare(
        `UPDATE control_account_scale_out_forecasts
            SET decision_state = CASE WHEN ? THEN 'blocked' ELSE 'provisioning' END,
                last_error_code = ?, updated_at = ?
          WHERE environment_id = ? AND allocation_scope = ? AND owner_tenant_key = ?
            AND data_role = ? AND residency_policy_id = ? AND residency_partition = ?
            AND decision_generation = ? AND capacity_request_idempotency_key = ?
            AND requested_operation_id IS NULL`
      )
      .bind(
        terminal ? 1 : 0,
        errorCode,
        this.now(),
        request.environmentId,
        request.allocationScope,
        ownerTenantKey,
        request.dataRole,
        request.residencyPolicyId,
        request.residencyPartition,
        request.decisionGeneration,
        request.idempotencyKey
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error('account_scale_out_decision_conflict');
    }
  }
}
