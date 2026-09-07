import { randomUUID } from 'node:crypto';
import {
  executeD1Batch,
  type D1BatchExecutionResult,
  type D1BatchStatement,
} from './cloudflare.js';

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_WORKER_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_VERSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_ACTOR_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,199}$/u;

export type WorkerDeploymentLeaseBatchExecutor = (
  databaseId: string,
  batch: readonly D1BatchStatement[]
) => Promise<D1BatchExecutionResult[]>;

export interface SetupWorkerDeploymentLease {
  environmentId: string;
  workerScriptName: string;
  operationId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  expectedSourceVersionId: string;
  mutationStarted: boolean;
}

interface LeaseRow extends Record<string, unknown> {
  environment_id: unknown;
  worker_script_name: unknown;
  owner_operation_id: unknown;
  fencing_token: unknown;
  lease_expires_at: unknown;
  expected_source_version_id: unknown;
  mutation_started: unknown;
}

function resultRows<T extends Record<string, unknown>>(
  results: readonly D1BatchExecutionResult[],
  index: number
): T[] {
  const rows = results[index]?.results;
  if (!Array.isArray(rows)) throw new Error('worker_deployment_lease_response_invalid');
  return rows as T[];
}

function parseLease(row: LeaseRow | undefined): SetupWorkerDeploymentLease | null {
  if (!row) return null;
  if (
    typeof row.environment_id !== 'string' ||
    typeof row.worker_script_name !== 'string' ||
    typeof row.owner_operation_id !== 'string' ||
    typeof row.fencing_token !== 'number' ||
    !Number.isSafeInteger(row.fencing_token) ||
    row.fencing_token < 1 ||
    typeof row.lease_expires_at !== 'number' ||
    !Number.isSafeInteger(row.lease_expires_at) ||
    typeof row.expected_source_version_id !== 'string' ||
    (row.mutation_started !== 0 && row.mutation_started !== 1)
  ) {
    throw new Error('worker_deployment_lease_response_invalid');
  }
  return {
    environmentId: row.environment_id,
    workerScriptName: row.worker_script_name,
    operationId: row.owner_operation_id,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at,
    expectedSourceVersionId: row.expected_source_version_id,
    mutationStarted: row.mutation_started === 1,
  };
}

function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now <= 0)
    throw new Error('worker_deployment_lease_time_invalid');
}

function validateTtl(ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
    throw new Error('worker_deployment_lease_ttl_invalid');
  }
  return ttlSeconds;
}

export class SetupWorkerDeploymentLeaseCoordinator {
  readonly operationId: string;
  private initialized = false;
  private completed = false;

  constructor(
    private readonly input: {
      databaseId: string;
      environmentId: string;
      actorId: string;
      accountId?: string;
      executeBatch?: WorkerDeploymentLeaseBatchExecutor;
      now?: () => number;
      ttlSeconds?: number;
      operationId?: string;
    }
  ) {
    if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
      throw new Error('worker_deployment_lease_environment_invalid');
    }
    if (!SAFE_ACTOR_ID.test(input.actorId)) {
      throw new Error('worker_deployment_lease_actor_invalid');
    }
    if (input.accountId && !/^[a-f0-9]{32}$/u.test(input.accountId)) {
      throw new Error('worker_deployment_lease_account_invalid');
    }
    this.operationId = input.operationId ?? `op_setup_deploy_${randomUUID().replaceAll('-', '')}`;
  }

  private get execute(): WorkerDeploymentLeaseBatchExecutor {
    return (
      this.input.executeBatch ??
      ((databaseId, batch) =>
        executeD1Batch(databaseId, batch, { accountId: this.input.accountId }))
    );
  }

  private get now(): number {
    const now = this.input.now?.() ?? Math.floor(Date.now() / 1000);
    validateTime(now);
    return now;
  }

  private get ttlSeconds(): number {
    return validateTtl(this.input.ttlSeconds ?? 300);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const now = this.now;
    const results = await this.execute(this.input.databaseId, [
      {
        sql: `INSERT OR IGNORE INTO control_operations (
          operation_id, environment_id, operation_kind, idempotency_key, status,
          requested_by_type, requested_by_id, attempt_count, created_at, started_at, updated_at
        ) VALUES (?, ?, 'setup_worker_deployment', ?, 'running', 'setup', ?, 1, ?, ?, ?)`,
        params: [
          this.operationId,
          this.input.environmentId,
          `setup-worker-deployment:${this.operationId}`,
          this.input.actorId,
          now,
          now,
          now,
        ],
      },
      {
        sql: `INSERT OR IGNORE INTO control_audit_events (
          event_id, environment_id, operation_id, event_type, actor_type, actor_id,
          resource_kind, resource_id, outcome, redacted_payload_json, created_at
        ) VALUES (?, ?, ?, 'control.worker_deployment.setup.started', 'setup', ?,
                  'worker_deployment', ?, 'attempted', '{}', ?)`,
        params: [
          `audit:${this.operationId}:started`,
          this.input.environmentId,
          this.operationId,
          this.input.actorId,
          this.operationId,
          now,
        ],
      },
      {
        sql: `SELECT operation_id FROM control_operations
               WHERE operation_id = ? AND environment_id = ? AND status = 'running'`,
        params: [this.operationId, this.input.environmentId],
      },
    ]);
    if (resultRows(results, 2).length !== 1) {
      throw new Error('worker_deployment_operation_initialization_failed');
    }
    this.initialized = true;
  }

  async acquire(input: {
    workerScriptName: string;
    expectedSourceVersionId: string;
  }): Promise<SetupWorkerDeploymentLease> {
    if (!SAFE_WORKER_SCRIPT_NAME.test(input.workerScriptName)) {
      throw new Error('worker_deployment_lease_worker_invalid');
    }
    if (!SAFE_VERSION_ID.test(input.expectedSourceVersionId)) {
      throw new Error('worker_deployment_lease_source_version_invalid');
    }
    await this.initialize();
    const now = this.now;
    const expiresAt = now + this.ttlSeconds;
    const results = await this.execute(this.input.databaseId, [
      {
        sql: `INSERT INTO control_worker_deployment_leases (
          environment_id, worker_script_name, owner_operation_id, fencing_token,
          lease_expires_at, expected_source_version_id, mutation_started, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, 0, ?)
        ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
          owner_operation_id = excluded.owner_operation_id,
          fencing_token = control_worker_deployment_leases.fencing_token + 1,
          lease_expires_at = excluded.lease_expires_at,
          expected_source_version_id = CASE
            WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             AND control_worker_deployment_leases.mutation_started = 1
            THEN control_worker_deployment_leases.expected_source_version_id
            ELSE excluded.expected_source_version_id
          END,
          mutation_started = CASE
            WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
            THEN control_worker_deployment_leases.mutation_started ELSE 0 END,
          previous_deployment_id = CASE
            WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
            THEN control_worker_deployment_leases.previous_deployment_id ELSE NULL END,
          patch_result_version_id = NULL,
          patch_result_deployment_id = NULL,
          updated_at = excluded.updated_at
        WHERE control_worker_deployment_leases.lease_expires_at <= excluded.updated_at
           OR control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
           OR (
             control_worker_deployment_leases.mutation_started = 0
             AND EXISTS (
               SELECT 1 FROM control_operations owner
                WHERE owner.operation_id = control_worker_deployment_leases.owner_operation_id
                  AND owner.environment_id = control_worker_deployment_leases.environment_id
                  AND owner.status = 'blocked'
             )
           )`,
        params: [
          this.input.environmentId,
          input.workerScriptName,
          this.operationId,
          expiresAt,
          input.expectedSourceVersionId,
          now,
        ],
      },
      {
        sql: `SELECT environment_id, worker_script_name, owner_operation_id, fencing_token,
                     lease_expires_at, expected_source_version_id, mutation_started
                FROM control_worker_deployment_leases
               WHERE environment_id = ? AND worker_script_name = ?`,
        params: [this.input.environmentId, input.workerScriptName],
      },
    ]);
    const lease = parseLease(resultRows<LeaseRow>(results, 1)[0]);
    if (!lease || lease.operationId !== this.operationId) {
      throw new Error('worker_deployment_lease_busy');
    }
    if (lease.expectedSourceVersionId !== input.expectedSourceVersionId) {
      throw new Error('worker_deployment_lease_source_version_changed');
    }
    return lease;
  }

  async renew(lease: SetupWorkerDeploymentLease): Promise<SetupWorkerDeploymentLease> {
    const now = this.now;
    const expiresAt = now + this.ttlSeconds;
    const results = await this.execute(this.input.databaseId, [
      {
        sql: `UPDATE control_worker_deployment_leases
                 SET fencing_token = fencing_token + 1, lease_expires_at = ?, updated_at = ?
               WHERE environment_id = ? AND worker_script_name = ?
                 AND owner_operation_id = ? AND fencing_token = ? AND lease_expires_at > ?`,
        params: [
          expiresAt,
          now,
          lease.environmentId,
          lease.workerScriptName,
          lease.operationId,
          lease.fencingToken,
          now,
        ],
      },
      {
        sql: `SELECT environment_id, worker_script_name, owner_operation_id, fencing_token,
                     lease_expires_at, expected_source_version_id, mutation_started
                FROM control_worker_deployment_leases
               WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?`,
        params: [lease.environmentId, lease.workerScriptName, lease.operationId],
      },
    ]);
    const renewed = parseLease(resultRows<LeaseRow>(results, 1)[0]);
    if (!renewed || renewed.fencingToken !== lease.fencingToken + 1) {
      throw new Error('worker_deployment_lease_stale_fencing_token');
    }
    return renewed;
  }

  async assertCurrent(lease: SetupWorkerDeploymentLease): Promise<void> {
    const now = this.now;
    const results = await this.execute(this.input.databaseId, [
      {
        sql: `SELECT environment_id, worker_script_name, owner_operation_id, fencing_token,
                     lease_expires_at, expected_source_version_id, mutation_started
                FROM control_worker_deployment_leases
               WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                 AND fencing_token = ? AND lease_expires_at > ?`,
        params: [
          lease.environmentId,
          lease.workerScriptName,
          lease.operationId,
          lease.fencingToken,
          now,
        ],
      },
    ]);
    const current = parseLease(resultRows<LeaseRow>(results, 0)[0]);
    if (!current || current.expectedSourceVersionId !== lease.expectedSourceVersionId) {
      throw new Error('worker_deployment_lease_stale_fencing_token');
    }
  }

  async markMutationStarted(
    lease: SetupWorkerDeploymentLease,
    previousDeploymentId?: string
  ): Promise<SetupWorkerDeploymentLease> {
    if (previousDeploymentId && !SAFE_VERSION_ID.test(previousDeploymentId)) {
      throw new Error('worker_deployment_lease_previous_deployment_invalid');
    }
    const now = this.now;
    const results = await this.execute(this.input.databaseId, [
      {
        sql: `UPDATE control_worker_deployment_leases
                 SET mutation_started = 1, previous_deployment_id = COALESCE(previous_deployment_id, ?),
                     updated_at = ?
               WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                 AND fencing_token = ? AND lease_expires_at > ?
                 AND expected_source_version_id = ?`,
        params: [
          previousDeploymentId ?? null,
          now,
          lease.environmentId,
          lease.workerScriptName,
          lease.operationId,
          lease.fencingToken,
          now,
          lease.expectedSourceVersionId,
        ],
      },
      {
        sql: `SELECT environment_id, worker_script_name, owner_operation_id, fencing_token,
                     lease_expires_at, expected_source_version_id, mutation_started
                FROM control_worker_deployment_leases
               WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                 AND fencing_token = ?`,
        params: [
          lease.environmentId,
          lease.workerScriptName,
          lease.operationId,
          lease.fencingToken,
        ],
      },
    ]);
    const started = parseLease(resultRows<LeaseRow>(results, 1)[0]);
    if (!started?.mutationStarted) {
      throw new Error('worker_deployment_lease_stale_fencing_token');
    }
    return started;
  }

  async release(lease: SetupWorkerDeploymentLease): Promise<void> {
    const results = await this.execute(this.input.databaseId, [
      {
        sql: `DELETE FROM control_worker_deployment_leases
               WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                 AND fencing_token = ?`,
        params: [
          lease.environmentId,
          lease.workerScriptName,
          lease.operationId,
          lease.fencingToken,
        ],
      },
      {
        sql: `SELECT owner_operation_id FROM control_worker_deployment_leases
               WHERE environment_id = ? AND worker_script_name = ?`,
        params: [lease.environmentId, lease.workerScriptName],
      },
    ]);
    if (resultRows(results, 1).length !== 0) {
      throw new Error('worker_deployment_lease_release_failed');
    }
  }

  async complete(success: boolean, errorCode?: string): Promise<void> {
    if (this.completed || !this.initialized) return;
    const now = this.now;
    const status = success ? 'succeeded' : 'blocked';
    const outcome = success ? 'succeeded' : 'blocked';
    const safeErrorCode = errorCode?.replace(/[^a-zA-Z0-9._:-]/gu, '_').slice(0, 128) || null;
    const results = await this.execute(this.input.databaseId, [
      {
        sql: `UPDATE control_operations
                 SET status = ?, last_error_code = ?, completed_at = ?, updated_at = ?
               WHERE operation_id = ? AND environment_id = ? AND status = 'running'
                 AND NOT EXISTS (
                   SELECT 1 FROM control_worker_deployment_leases
                    WHERE owner_operation_id = control_operations.operation_id
                      AND (? = 1 OR mutation_started = 1)
                 )`,
        params: [
          status,
          safeErrorCode,
          success ? now : null,
          now,
          this.operationId,
          this.input.environmentId,
          success ? 1 : 0,
        ],
      },
      {
        sql: `INSERT OR IGNORE INTO control_audit_events (
          event_id, environment_id, operation_id, event_type, actor_type, actor_id,
          resource_kind, resource_id, outcome, redacted_payload_json, created_at
        )
        SELECT ?, ?, ?, 'control.worker_deployment.setup.completed', 'setup', ?,
               'worker_deployment', ?, ?, json_object('error_code', ?), ?
         WHERE EXISTS (
           SELECT 1 FROM control_operations
            WHERE operation_id = ? AND environment_id = ? AND status = ?
         )`,
        params: [
          `audit:${this.operationId}:completed`,
          this.input.environmentId,
          this.operationId,
          this.input.actorId,
          this.operationId,
          outcome,
          safeErrorCode,
          now,
          this.operationId,
          this.input.environmentId,
          status,
        ],
      },
      {
        sql: `SELECT status FROM control_operations
               WHERE operation_id = ? AND environment_id = ?`,
        params: [this.operationId, this.input.environmentId],
      },
    ]);
    const row = resultRows<{ status: unknown }>(results, 2)[0];
    if (row?.status !== status) throw new Error('worker_deployment_operation_completion_failed');
    this.completed = true;
  }
}
