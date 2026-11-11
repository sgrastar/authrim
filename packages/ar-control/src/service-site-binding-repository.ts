import type { D1Database } from '@cloudflare/workers-types';
import type {
  WorkerBindingPatchLease,
  WorkerBindingPatchState,
  WorkerSettingsPatchTarget,
} from '@authrim/ar-lib-core/control-plane';
import type { ServiceSiteBindingRow } from './service-site-binding';

const LEASE_SECONDS = 15 * 60;
export const SERVICE_SITE_STABILIZATION_SECONDS = 30;

export interface ServiceSiteBindingTarget extends WorkerSettingsPatchTarget {
  environmentId: string;
  generation: number;
  state?: string;
  patchResultVersionId?: string | null;
  patchResultDeploymentId?: string | null;
}

export interface ServiceSiteDeploymentLease extends WorkerBindingPatchLease {
  environmentId: string;
  workerScriptName: string;
  ownerOperationId: string;
  fencingToken: number;
  leaseExpiresAt: number;
}

interface LeaseRow {
  environment_id: string;
  worker_script_name: string;
  owner_operation_id: string;
  fencing_token: number;
  lease_expires_at: number;
  expected_source_version_id: string;
  previous_deployment_id: string | null;
  mutation_started: number;
  mutation_started_at: number | null;
}

function leaseFromRow(row: LeaseRow): ServiceSiteDeploymentLease {
  return {
    environmentId: row.environment_id,
    workerScriptName: row.worker_script_name,
    ownerOperationId: row.owner_operation_id,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: Number(row.lease_expires_at),
    expectedSourceVersionId: row.expected_source_version_id,
    previousDeploymentId: row.previous_deployment_id,
    mutationStarted: row.mutation_started === 1,
    mutationStartedAt: row.mutation_started_at,
  };
}

export function serviceSiteTarget(row: ServiceSiteBindingRow): ServiceSiteBindingTarget {
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    workerScriptName: row.router_worker_script_name,
    previousRestoreSettingsJson: row.previous_restore_settings_json,
    generation: Number(row.generation),
    state: row.state,
    patchResultVersionId: row.patch_result_version_id,
    patchResultDeploymentId: row.patch_result_deployment_id,
  };
}

// A statement fragment that only matches while the caller still owns the router's lease.
const LEASE_FENCE = `EXISTS (
  SELECT 1 FROM control_worker_deployment_leases lease
   WHERE lease.environment_id = ? AND lease.worker_script_name = ?
     AND lease.owner_operation_id = ? AND lease.fencing_token = ?
     AND lease.lease_expires_at > ?
)`;

/**
 * D1 state of the service site attachment. Every write is keyed by the operation that owns the
 * row, so a run that lost the row to a newer request cannot overwrite the newer state.
 */
export class D1ServiceSiteBindingRepository implements WorkerBindingPatchState<
  ServiceSiteBindingTarget,
  ServiceSiteDeploymentLease
> {
  constructor(private readonly db: D1Database) {}

  async listDue(limit: number, now: number): Promise<ServiceSiteBindingRow[]> {
    const result = await this.db
      .prepare(
        `SELECT binding.* FROM control_service_site_bindings binding
           JOIN control_environments environment
             ON environment.environment_id = binding.environment_id
            AND environment.lifecycle_state = 'active'
          WHERE binding.state IN ('pending', 'settings_patched', 'rollback_required')
            AND (binding.next_attempt_at IS NULL OR binding.next_attempt_at <= ?)
            AND (binding.state <> 'settings_patched' OR binding.stabilization_not_before <= ?)
          ORDER BY binding.updated_at
          LIMIT ?`
      )
      .bind(now, now, Math.max(1, Math.min(25, Math.floor(limit))))
      .all<ServiceSiteBindingRow>();
    return result.results;
  }

  async isRouterActive(environmentId: string, scriptName: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS found FROM control_desired_worker_inventory
          WHERE environment_id = ? AND worker_script_name = ?
            AND package_name = '@authrim/ar-router' AND status = 'active'`
      )
      .bind(environmentId, scriptName)
      .first<{ found: number }>();
    return row?.found === 1;
  }

  async acquireDeploymentLease(
    row: ServiceSiteBindingRow,
    expectedSourceVersionId: string,
    now: number
  ): Promise<ServiceSiteDeploymentLease | null> {
    const lease = await this.db
      .prepare(
        `INSERT INTO control_worker_deployment_leases (
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
             ELSE excluded.expected_source_version_id END,
           mutation_started = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.mutation_started ELSE 0 END,
           mutation_started_at = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.mutation_started_at ELSE NULL END,
           previous_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.previous_deployment_id ELSE NULL END,
           patch_result_version_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_version_id ELSE NULL END,
           patch_result_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_deployment_id ELSE NULL END,
           updated_at = excluded.updated_at
         WHERE control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
            OR control_worker_deployment_leases.lease_expires_at <= ?
         RETURNING *`
      )
      .bind(
        row.environment_id,
        row.router_worker_script_name,
        row.operation_id,
        now + LEASE_SECONDS,
        expectedSourceVersionId,
        now,
        now
      )
      .first<LeaseRow>();
    return lease ? leaseFromRow(lease) : null;
  }

  async leaseIsCurrent(lease: ServiceSiteDeploymentLease, now: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS active FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?`
      )
      .bind(
        lease.environmentId,
        lease.workerScriptName,
        lease.ownerOperationId,
        lease.fencingToken,
        now
      )
      .first<{ active: number }>();
    return row?.active === 1;
  }

  async releaseDeploymentLease(lease: ServiceSiteDeploymentLease): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ?`
      )
      .bind(lease.environmentId, lease.workerScriptName, lease.ownerOperationId, lease.fencingToken)
      .run();
  }

  async markOperationRunning(row: ServiceSiteBindingRow, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_operations
            SET status = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, ?), next_attempt_at = NULL, updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND status IN ('queued', 'running', 'waiting_retry')`
      )
      .bind(now, now, row.operation_id, row.environment_id)
      .run();
  }

  /** Remembers the router's binding name and the binding it replaces, before the first PATCH. */
  async recordBindingPlan(
    row: ServiceSiteBindingRow,
    bindingName: string,
    previousBindingJson: string | null,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_service_site_bindings
            SET binding_name = ?, previous_binding_json = ?, updated_at = ?
          WHERE environment_id = ? AND operation_id = ?
            AND state IN ('pending', 'rollback_required')`
      )
      .bind(bindingName, previousBindingJson, now, row.environment_id, row.operation_id)
      .run();
  }

  async recordAlreadySatisfied(input: {
    target: ServiceSiteBindingTarget;
    lease: ServiceSiteDeploymentLease;
    versionId: string;
    deploymentId: string;
    settingsJson: string;
    now: number;
  }): Promise<void> {
    const changed = await this.db
      .prepare(
        `UPDATE control_service_site_bindings
            SET state = 'settings_patched', expected_source_version_id = ?,
                previous_deployment_id = ?, patch_result_version_id = ?,
                patch_result_deployment_id = ?, stabilization_not_before = ?,
                last_error_code = NULL, next_attempt_at = NULL, updated_at = ?
          WHERE environment_id = ? AND operation_id = ? AND state = 'pending'
            AND ${LEASE_FENCE}`
      )
      .bind(
        input.lease.expectedSourceVersionId,
        input.deploymentId,
        input.versionId,
        input.deploymentId,
        input.now + SERVICE_SITE_STABILIZATION_SECONDS,
        input.now,
        input.target.environmentId,
        input.target.operationId,
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.ownerOperationId,
        input.lease.fencingToken,
        input.now
      )
      .run();
    if (Number(changed.meta?.changes ?? 0) !== 1) throw new Error('service_site_fence_lost');
  }

  async recordPatchStarted(input: {
    target: ServiceSiteBindingTarget;
    lease: ServiceSiteDeploymentLease;
    previousDeploymentId: string;
    restoreSettingsJson: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET mutation_started = 1, mutation_started_at = COALESCE(mutation_started_at, ?),
                  previous_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND lease_expires_at > ?`
        )
        .bind(
          input.now,
          input.previousDeploymentId,
          input.now,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_service_site_bindings
              SET expected_source_version_id = ?, previous_deployment_id = ?,
                  previous_restore_settings_json = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = 'pending'
              AND ${LEASE_FENCE}`
        )
        .bind(
          input.lease.expectedSourceVersionId,
          input.previousDeploymentId,
          input.restoreSettingsJson,
          input.now,
          input.target.environmentId,
          input.target.operationId,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error('service_site_fence_lost');
    }
  }

  async rearmPatchIntent(input: {
    target: ServiceSiteBindingTarget;
    lease: ServiceSiteDeploymentLease;
    now: number;
  }): Promise<boolean> {
    const changed = await this.db
      .prepare(
        `UPDATE control_worker_deployment_leases
            SET mutation_started = 0, mutation_started_at = NULL,
                previous_deployment_id = NULL, updated_at = ?
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?
            AND mutation_started = 1 AND patch_result_version_id IS NULL
            AND patch_result_deployment_id IS NULL`
      )
      .bind(
        input.now,
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.ownerOperationId,
        input.lease.fencingToken,
        input.now
      )
      .run();
    return Number(changed.meta?.changes ?? 0) === 1;
  }

  async recordPatchResult(input: {
    target: ServiceSiteBindingTarget;
    lease: ServiceSiteDeploymentLease;
    versionId: string;
    deploymentId: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET patch_result_version_id = ?, patch_result_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND lease_expires_at > ?`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_service_site_bindings
              SET state = 'settings_patched', patch_result_version_id = ?,
                  patch_result_deployment_id = ?, stabilization_not_before = ?,
                  last_error_code = NULL, next_attempt_at = NULL, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = 'pending'
              AND ${LEASE_FENCE}`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now + SERVICE_SITE_STABILIZATION_SECONDS,
          input.now,
          input.target.environmentId,
          input.target.operationId,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error('service_site_fence_lost');
    }
  }

  async recordTransientError(
    target: ServiceSiteBindingTarget,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_service_site_bindings
              SET last_error_code = ?, next_attempt_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND state IN ('pending', 'settings_patched', 'rollback_required')`
        )
        .bind(errorCode, nextAttemptAt, now, target.environmentId, target.operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(nextAttemptAt, errorCode, errorCode, now, target.operationId, target.environmentId),
    ]);
  }

  async markRollbackRequired(
    target: ServiceSiteBindingTarget,
    errorCode: string,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_service_site_bindings
            SET state = 'rollback_required', last_error_code = ?, next_attempt_at = NULL,
                updated_at = ?
          WHERE environment_id = ? AND operation_id = ?
            AND state IN ('pending', 'settings_patched')`
      )
      .bind(errorCode, now, target.environmentId, target.operationId)
      .run();
  }

  async markBlocked(target: ServiceSiteBindingTarget, errorCode: string, now: number) {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_service_site_bindings
              SET state = 'blocked', last_error_code = ?, next_attempt_at = NULL, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND state IN ('pending', 'settings_patched', 'rollback_required')`
        )
        .bind(errorCode, now, target.environmentId, target.operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?,
                  last_error_redacted = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(errorCode, errorCode, now, target.operationId, target.environmentId),
      this.audit(target, 'service_site.blocked', 'blocked', { errorCode }, now),
    ]);
  }

  async markRolledBack(
    target: ServiceSiteBindingTarget,
    attachedWorkerName: string | null,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_service_site_bindings
              SET state = 'rolled_back', attached_worker_name = ?, next_attempt_at = NULL,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = 'rollback_required'`
        )
        .bind(attachedWorkerName, now, target.environmentId, target.operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = 'service_site_binding_rolled_back',
                  last_error_redacted = 'service_site_binding_rolled_back', updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(now, target.operationId, target.environmentId),
      this.audit(target, 'service_site.rolled_back', 'failed', {}, now),
    ]);
  }

  async markSucceeded(
    row: ServiceSiteBindingRow,
    lease: ServiceSiteDeploymentLease | null,
    now: number
  ): Promise<void> {
    const attached = row.desired_state === 'attached' ? row.desired_worker_name : null;
    const statements = [
      this.db
        .prepare(
          `UPDATE control_service_site_bindings
              SET state = 'succeeded', attached_worker_name = ?, last_error_code = NULL,
                  next_attempt_at = NULL, completed_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND state IN ('pending', 'settings_patched')`
        )
        .bind(attached, now, now, row.environment_id, row.operation_id),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'succeeded', next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('queued', 'running', 'waiting_retry')
              AND EXISTS (
                SELECT 1 FROM control_service_site_bindings binding
                 WHERE binding.environment_id = ? AND binding.operation_id = ?
                   AND binding.state = 'succeeded'
              )`
        )
        .bind(now, now, row.operation_id, row.environment_id, row.environment_id, row.operation_id),
      this.audit(
        serviceSiteTarget(row),
        row.desired_state === 'attached' ? 'service_site.attached' : 'service_site.detached',
        'succeeded',
        { bindingName: row.binding_name, workerName: attached },
        now
      ),
    ];
    if (lease) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM control_worker_deployment_leases
              WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                AND fencing_token = ?`
          )
          .bind(
            lease.environmentId,
            lease.workerScriptName,
            lease.ownerOperationId,
            lease.fencingToken
          )
      );
    }
    await this.db.batch(statements);
    const reflected = await this.db
      .prepare(
        `SELECT state FROM control_service_site_bindings
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(row.environment_id, row.operation_id)
      .first<{ state: string }>();
    if (reflected?.state !== 'succeeded') throw new Error('service_site_fence_lost');
  }

  private audit(
    target: ServiceSiteBindingTarget,
    eventType: string,
    outcome: 'succeeded' | 'failed' | 'blocked',
    payload: Record<string, string | null>,
    now: number
  ) {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_events (
           event_id, environment_id, operation_id, event_type, actor_type, actor_id,
           resource_kind, resource_id, outcome, redacted_payload_json, created_at
         ) VALUES (?, ?, ?, ?, 'worker', 'ar-control', 'service_site_binding', ?, ?, ?, ?)`
      )
      .bind(
        `audit_${eventType.replace(/\./gu, '_')}_${target.operationId.slice(-32)}`,
        target.environmentId,
        target.operationId,
        eventType,
        target.environmentId,
        outcome,
        JSON.stringify(payload),
        now
      );
  }
}
