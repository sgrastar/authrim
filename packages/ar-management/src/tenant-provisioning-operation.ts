import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { ControlTenantIsolationPolicy } from '@authrim/ar-lib-core/control-plane';

export const TENANT_PROVISIONING_STEPS = [
  'request_accepted',
  'capacity_check',
  'reserve_default_route',
  'tenant_seed',
  'registry_publish',
  'tenant_smoke',
  'tenant_prepare',
  'lookup_activate',
  'tenant_active',
] as const;

export type TenantProvisioningStep = (typeof TENANT_PROVISIONING_STEPS)[number];
export type TenantProvisioningStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'blocked'
  | 'succeeded'
  | 'canceled';
export type TenantProvisioningKind = 'create' | 'clone';

const TENANT_PROVISIONING_LEASE_SECONDS = 60;

interface OperationRow {
  operation_id: string;
  environment_id: string;
  tenant_id: string;
  tenant_code: string;
  tenant_name: string;
  tenant_description: string | null;
  operation_kind: TenantProvisioningKind;
  source_tenant_id: string | null;
  preparation_payload_json: string | null;
  preparation_result_json: string | null;
  residency_policy_id: string;
  residency_partition: string;
  isolation_policy: ControlTenantIsolationPolicy;
  request_hash: string;
  idempotency_key: string;
  status: TenantProvisioningStatus;
  current_step: TenantProvisioningStep;
  capacity_operation_ids_json: string;
  default_route_allocation_json: string | null;
  attempt_count: number;
  retry_budget_started_at: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  fencing_token: number;
  created_by: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

interface StepRow {
  step_key: TenantProvisioningStep;
  display_order: number;
  status: 'queued' | 'running' | 'waiting_retry' | 'blocked' | 'succeeded' | 'skipped';
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  observed_resource_id: string | null;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

export interface TenantProvisioningOperationView {
  operationId: string;
  environmentId: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  tenantDescription: string | null;
  operationKind: TenantProvisioningKind;
  sourceTenantId: string | null;
  preparationPayload: Record<string, unknown> | null;
  preparationResult: Record<string, unknown> | null;
  residencyPolicyId: string;
  residencyPartition: string;
  isolationPolicy: ControlTenantIsolationPolicy;
  requestHash: string;
  idempotencyKey: string;
  status: TenantProvisioningStatus;
  currentStep: TenantProvisioningStep;
  capacityOperationIds: Record<string, string>;
  defaultRouteAllocation: Record<string, unknown> | null;
  attemptCount: number;
  retryBudgetStartedAt: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  fencingToken: number;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  steps: Array<{
    stepKey: TenantProvisioningStep;
    displayOrder: number;
    status: StepRow['status'];
    attemptCount: number;
    nextAttemptAt: number | null;
    lastErrorCode: string | null;
    observedResourceId: string | null;
    startedAt: number | null;
    completedAt: number | null;
    updatedAt: number;
  }>;
}

export interface TenantProvisioningLease {
  operation: TenantProvisioningOperationView;
  ownerId: string;
  fencingToken: number;
}

function parseObject(value: string | null, code: string): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

function operation(row: OperationRow, steps: StepRow[]): TenantProvisioningOperationView {
  const capacityOperationIds = parseObject(
    row.capacity_operation_ids_json,
    'tenant_provisioning_capacity_state_invalid'
  );
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    tenantId: row.tenant_id,
    tenantCode: row.tenant_code,
    tenantName: row.tenant_name,
    tenantDescription: row.tenant_description,
    operationKind: row.operation_kind ?? 'create',
    sourceTenantId: row.source_tenant_id ?? null,
    preparationPayload: parseObject(
      row.preparation_payload_json ?? null,
      'tenant_provisioning_preparation_payload_invalid'
    ),
    preparationResult: parseObject(
      row.preparation_result_json ?? null,
      'tenant_provisioning_preparation_result_invalid'
    ),
    residencyPolicyId: row.residency_policy_id,
    residencyPartition: row.residency_partition,
    isolationPolicy: row.isolation_policy,
    requestHash: row.request_hash,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    currentStep: row.current_step,
    capacityOperationIds: Object.fromEntries(
      Object.entries(capacityOperationIds ?? {}).map(([key, value]) => {
        if (typeof value !== 'string')
          throw new Error('tenant_provisioning_capacity_state_invalid');
        return [key, value];
      })
    ),
    defaultRouteAllocation: parseObject(
      row.default_route_allocation_json,
      'tenant_provisioning_default_route_invalid'
    ),
    attemptCount: row.attempt_count,
    retryBudgetStartedAt: row.retry_budget_started_at,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    fencingToken: row.fencing_token,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    steps: steps.map((step) => ({
      stepKey: step.step_key,
      displayOrder: step.display_order,
      status: step.status,
      attemptCount: step.attempt_count,
      nextAttemptAt: step.next_attempt_at,
      lastErrorCode: step.last_error_code,
      observedResourceId: step.observed_resource_id,
      startedAt: step.started_at,
      completedAt: step.completed_at,
      updatedAt: step.updated_at,
    })),
  };
}

export class TenantProvisioningOperationRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async get(
    operationId: string,
    environmentId: string
  ): Promise<TenantProvisioningOperationView | null> {
    const row = await this.db.queryOne<OperationRow>(
      `SELECT * FROM tenant_provisioning_operations
        WHERE operation_id = ? AND environment_id = ?`,
      [operationId, environmentId]
    );
    if (!row) return null;
    const steps = await this.db.query<StepRow>(
      `SELECT step_key, display_order, status, attempt_count, next_attempt_at,
              last_error_code, observed_resource_id, started_at, completed_at, updated_at
         FROM tenant_provisioning_operation_steps
        WHERE operation_id = ? ORDER BY display_order`,
      [operationId]
    );
    return operation(row, steps);
  }

  async getByTenant(
    tenantId: string,
    environmentId: string
  ): Promise<TenantProvisioningOperationView | null> {
    const row = await this.db.queryOne<OperationRow>(
      `SELECT * FROM tenant_provisioning_operations
        WHERE tenant_id = ? AND environment_id = ?`,
      [tenantId, environmentId]
    );
    if (!row) return null;
    const steps = await this.db.query<StepRow>(
      `SELECT step_key, display_order, status, attempt_count, next_attempt_at,
              last_error_code, observed_resource_id, started_at, completed_at, updated_at
         FROM tenant_provisioning_operation_steps
        WHERE operation_id = ? ORDER BY display_order`,
      [row.operation_id]
    );
    return operation(row, steps);
  }

  async create(input: {
    operationId: string;
    environmentId: string;
    tenantId: string;
    tenantCode: string;
    tenantName: string;
    tenantDescription: string | null;
    operationKind?: TenantProvisioningKind;
    sourceTenantId?: string | null;
    preparationPayload?: Record<string, unknown> | null;
    residencyPolicyId: string;
    residencyPartition: string;
    isolationPolicy: ControlTenantIsolationPolicy;
    requestHash: string;
    idempotencyKey: string;
    createdBy: string;
    now: number;
  }): Promise<TenantProvisioningOperationView> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO tenant_provisioning_operations (
           operation_id, environment_id, tenant_id, tenant_code, tenant_name,
           tenant_description, operation_kind, source_tenant_id, preparation_payload_json,
           residency_policy_id, residency_partition, isolation_policy, request_hash,
           idempotency_key, status, current_step, retry_budget_started_at,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'request_accepted', ?, ?, ?, ?)`,
        [
          input.operationId,
          input.environmentId,
          input.tenantId,
          input.tenantCode,
          input.tenantName,
          input.tenantDescription,
          input.operationKind ?? 'create',
          input.sourceTenantId ?? null,
          input.preparationPayload ? JSON.stringify(input.preparationPayload) : null,
          input.residencyPolicyId,
          input.residencyPartition,
          input.isolationPolicy,
          input.requestHash,
          input.idempotencyKey,
          input.now,
          input.createdBy,
          input.now,
          input.now,
        ]
      );
      for (const [displayOrder, stepKey] of TENANT_PROVISIONING_STEPS.entries()) {
        await tx.execute(
          `INSERT INTO tenant_provisioning_operation_steps (
             operation_id, step_key, display_order, status, attempt_count,
             completed_at, updated_at
           ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
          [
            input.operationId,
            stepKey,
            displayOrder * 10,
            stepKey === 'request_accepted' ? 'succeeded' : 'queued',
            stepKey === 'request_accepted' ? input.now : null,
            input.now,
          ]
        );
      }
    });
    const created = await this.get(input.operationId, input.environmentId);
    if (!created) throw new Error('tenant_provisioning_operation_create_failed');
    return created;
  }

  async claimNext(
    environmentId: string,
    ownerId: string,
    now: number
  ): Promise<TenantProvisioningLease | null> {
    const candidate = await this.db.queryOne<{ operation_id: string }>(
      `SELECT operation_id FROM tenant_provisioning_operations
        WHERE environment_id = ?
          AND status IN ('queued', 'waiting_retry', 'running')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY created_at, operation_id LIMIT 1`,
      [environmentId, now, now]
    );
    if (!candidate) return null;
    const updated = await this.db.execute(
      `UPDATE tenant_provisioning_operations
          SET status = 'running', attempt_count = attempt_count + 1,
              next_attempt_at = NULL, last_error_code = NULL,
              lease_owner = ?, lease_expires_at = ?, fencing_token = fencing_token + 1,
              started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE operation_id = ? AND environment_id = ?
          AND status IN ('queued', 'waiting_retry', 'running')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      [
        ownerId,
        now + TENANT_PROVISIONING_LEASE_SECONDS,
        now,
        now,
        candidate.operation_id,
        environmentId,
        now,
      ]
    );
    if (updated.rowsAffected !== 1) return null;
    const claimed = await this.get(candidate.operation_id, environmentId);
    if (!claimed) return null;
    return { operation: claimed, ownerId, fencingToken: claimed.fencingToken };
  }

  async checkpoint(
    lease: TenantProvisioningLease,
    input: {
      step: TenantProvisioningStep;
      nextStep?: TenantProvisioningStep;
      stepStatus: StepRow['status'];
      operationStatus: TenantProvisioningStatus;
      now: number;
      nextAttemptAt?: number | null;
      errorCode?: string | null;
      observedResourceId?: string | null;
      preparationResult?: Record<string, unknown>;
      capacityOperationIds?: Record<string, string>;
      defaultRouteAllocation?: Record<string, unknown>;
    }
  ): Promise<void> {
    const completed = input.stepStatus === 'succeeded' ? input.now : null;
    const results = await this.db.transaction(async (tx) => {
      const step = await tx.execute(
        `UPDATE tenant_provisioning_operation_steps
            SET status = ?, attempt_count = attempt_count + 1,
                next_attempt_at = ?, last_error_code = ?, observed_resource_id = ?,
                started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at),
                updated_at = ?
          WHERE operation_id = ? AND step_key = ? AND EXISTS (
            SELECT 1 FROM tenant_provisioning_operations
             WHERE operation_id = ? AND lease_owner = ? AND fencing_token = ?
          )`,
        [
          input.stepStatus,
          input.nextAttemptAt ?? null,
          input.errorCode ?? null,
          input.observedResourceId ?? null,
          input.now,
          completed,
          input.now,
          lease.operation.operationId,
          input.step,
          lease.operation.operationId,
          lease.ownerId,
          lease.fencingToken,
        ]
      );
      const operationUpdate = await tx.execute(
        `UPDATE tenant_provisioning_operations
            SET status = ?, current_step = ?, next_attempt_at = ?, last_error_code = ?,
                capacity_operation_ids_json = COALESCE(?, capacity_operation_ids_json),
                default_route_allocation_json = COALESCE(?, default_route_allocation_json),
                preparation_result_json = COALESCE(?, preparation_result_json),
                lease_owner = CASE WHEN ? = 'running' THEN lease_owner ELSE NULL END,
                lease_expires_at = CASE WHEN ? = 'running' THEN ? ELSE NULL END,
                completed_at = CASE WHEN ? IN ('succeeded', 'canceled') THEN ? ELSE completed_at END,
                updated_at = ?
          WHERE operation_id = ? AND lease_owner = ? AND fencing_token = ?`,
        [
          input.operationStatus,
          input.nextStep ?? input.step,
          input.nextAttemptAt ?? null,
          input.errorCode ?? null,
          input.capacityOperationIds ? JSON.stringify(input.capacityOperationIds) : null,
          input.defaultRouteAllocation ? JSON.stringify(input.defaultRouteAllocation) : null,
          input.preparationResult ? JSON.stringify(input.preparationResult) : null,
          input.operationStatus,
          input.operationStatus,
          input.now + TENANT_PROVISIONING_LEASE_SECONDS,
          input.operationStatus,
          input.now,
          input.now,
          lease.operation.operationId,
          lease.ownerId,
          lease.fencingToken,
        ]
      );
      return { step, operationUpdate };
    });
    if (results.step.rowsAffected !== 1 || results.operationUpdate.rowsAffected !== 1) {
      throw new Error('tenant_provisioning_operation_stale_lease');
    }
  }

  async retryBlocked(
    operationId: string,
    environmentId: string,
    now: number
  ): Promise<TenantProvisioningOperationView | null> {
    const result = await this.db.transaction(async (tx) => {
      const updated = await tx.execute(
        `UPDATE tenant_provisioning_operations
            SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = NULL,
                retry_budget_started_at = ?,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'`,
        [now, now, now, operationId, environmentId]
      );
      if (updated.rowsAffected !== 1) return false;
      await tx.execute(
        `UPDATE tenant_provisioning_operation_steps
            SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = NULL,
                updated_at = ?
          WHERE operation_id = ? AND step_key = (
            SELECT current_step FROM tenant_provisioning_operations WHERE operation_id = ?
          )`,
        [now, now, operationId, operationId]
      );
      return true;
    });
    return result ? this.get(operationId, environmentId) : null;
  }

  async cancel(
    operationId: string,
    environmentId: string,
    now: number
  ): Promise<TenantProvisioningOperationView | null> {
    const updated = await this.db.execute(
      `UPDATE tenant_provisioning_operations
          SET status = 'canceled', next_attempt_at = NULL,
              lease_owner = NULL, lease_expires_at = NULL,
              completed_at = ?, updated_at = ?
        WHERE operation_id = ? AND environment_id = ?
          AND status IN ('queued', 'waiting_retry', 'blocked')`,
      [now, now, operationId, environmentId]
    );
    return updated.rowsAffected === 1 ? this.get(operationId, environmentId) : null;
  }
}
