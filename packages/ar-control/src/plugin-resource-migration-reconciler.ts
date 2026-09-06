import {
  decideControlProvisioningFailure,
  type ApplyMigrationReleaseResult,
} from '@authrim/ar-lib-core/control-plane';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import {
  ApiMigrationEngine,
  cloudflareMigrationExecutor,
  type MigrationD1Executor,
} from './migration-engine';
import { MigrationReleaseArtifactReader, R2ReleaseArtifactStore } from './release-artifact';

const LEASE_SECONDS = 120;

interface MigrationRow {
  plugin_resource_id: string;
  environment_id: string;
  operation_id: string;
  provider_database_id: string;
  desired_spec_json: string;
  stream_id: string;
  release_id: string;
  manifest_digest: string;
  manifest_r2_object_key: string;
  migration_state: 'requested' | 'applying' | 'waiting_retry';
  operation_status: 'queued' | 'running' | 'waiting_retry';
  next_attempt_at: number | null;
  created_at: number;
}

interface Claim {
  fencing_token: number;
  attempt_count: number;
  created_at: number;
}

function ownershipFingerprint(desiredSpecJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(desiredSpecJson);
  } catch {
    throw new Error('plugin_resource_desired_spec_invalid');
  }
  const fingerprint =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).ownershipFingerprint
      : null;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error('plugin_resource_desired_spec_invalid');
  }
  return fingerprint;
}

export class PluginResourceMigrationReconciler {
  private readonly engine: ApiMigrationEngine;

  constructor(
    private readonly database: D1Database,
    migrationReleases: R2Bucket,
    d1Api: MigrationD1Executor,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {
    this.engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new R2ReleaseArtifactStore(migrationReleases)),
      cloudflareMigrationExecutor(d1Api),
      () => this.now() * 1_000
    );
  }

  async reconcile(limit = 5): Promise<number> {
    const now = this.now();
    const rows = await this.database
      .prepare(
        `SELECT migration.plugin_resource_id, migration.environment_id,
                migration.operation_id, resource.provider_resource_id AS provider_database_id,
                resource.desired_spec_json, migration.stream_id, migration.release_id,
                migration.manifest_digest, catalog.manifest_r2_object_key,
                migration.state AS migration_state, operation.status AS operation_status,
                operation.next_attempt_at, operation.created_at
           FROM control_plugin_resource_migration_state AS migration
           JOIN control_plugin_desired_resources AS resource
             ON resource.plugin_resource_id = migration.plugin_resource_id
            AND resource.environment_id = migration.environment_id
            AND resource.operation_id = migration.operation_id
           JOIN control_operations AS operation
             ON operation.operation_id = migration.operation_id
            AND operation.environment_id = migration.environment_id
           JOIN control_migration_release_catalog AS catalog
             ON catalog.environment_id = migration.environment_id
            AND catalog.stream_id = migration.stream_id
            AND catalog.release_id = migration.release_id
            AND catalog.manifest_digest = migration.manifest_digest
          WHERE resource.resource_kind = 'd1' AND resource.status = 'ready'
            AND resource.provider_resource_id IS NOT NULL
            AND (
              resource.lifecycle_mode = 'existing' OR (
                resource.lifecycle_mode = 'managed'
                AND resource.provider_create_state = 'identified'
                AND resource.provider_identity_checkpointed_at IS NOT NULL
              )
            )
            AND migration.state IN ('requested', 'applying', 'waiting_retry')
            AND operation.status IN ('queued', 'running', 'waiting_retry')
            AND (operation.next_attempt_at IS NULL OR operation.next_attempt_at <= ?)
          ORDER BY operation.created_at, migration.plugin_resource_id
          LIMIT ?`
      )
      .bind(now, Math.max(1, Math.min(10, Math.floor(limit))))
      .all<MigrationRow>();
    let processed = 0;
    for (const row of rows.results) {
      if (await this.reconcileOne(row)) processed += 1;
    }
    return processed;
  }

  private async reconcileOne(row: MigrationRow): Promise<boolean> {
    const now = this.now();
    const claim = await this.database
      .prepare(
        `UPDATE control_operations
            SET status = 'running', lock_owner = 'plugin-resource-migration-reconciler',
                lock_expires_at = ?, fencing_token = fencing_token + 1,
                attempt_count = attempt_count + 1, next_attempt_at = NULL,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND status IN ('queued', 'running', 'waiting_retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
          RETURNING fencing_token, attempt_count, created_at`
      )
      .bind(now + LEASE_SECONDS, now, now, row.operation_id, row.environment_id, now, now)
      .first<Claim>();
    if (!claim) return false;

    let stepKey: string;
    try {
      stepKey = `plugin_resource_${ownershipFingerprint(row.desired_spec_json).slice(0, 20)}_migration`;
    } catch (error) {
      await this.recordFailure(row, claim, null, error);
      return true;
    }
    const claimedState = await this.database
      .prepare(
        `UPDATE control_plugin_resource_migration_state
            SET state = 'applying', provider_database_id = ?,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
            AND state IN ('requested', 'applying', 'waiting_retry')
          RETURNING plugin_resource_id`
      )
      .bind(
        row.provider_database_id,
        now,
        now,
        row.plugin_resource_id,
        row.environment_id,
        row.operation_id
      )
      .first<{ plugin_resource_id: string }>();
    if (!claimedState) {
      await this.release(row, claim, now);
      return false;
    }
    await this.database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND step_key = ? AND status IN ('queued', 'waiting_retry')`
      )
      .bind(now, now, row.operation_id, stepKey)
      .run();

    try {
      const result = await this.engine.apply({
        databaseId: row.provider_database_id,
        pin: {
          environmentId: row.environment_id,
          streamId: row.stream_id,
          releaseId: row.release_id,
          manifestDigest: row.manifest_digest,
          manifestObjectKey: row.manifest_r2_object_key,
        },
      });
      await this.recordSuccess(row, claim, stepKey, result);
    } catch (error) {
      await this.recordFailure(row, claim, stepKey, error);
    }
    return true;
  }

  private async recordSuccess(
    row: MigrationRow,
    claim: Claim,
    stepKey: string,
    result: ApplyMigrationReleaseResult
  ): Promise<void> {
    if (
      result.streamId !== row.stream_id ||
      result.releaseId !== row.release_id ||
      result.manifestDigest !== row.manifest_digest ||
      result.appliedFiles + result.skippedFiles !== result.totalFiles
    ) {
      throw new Error('plugin_resource_migration_result_mismatch');
    }
    const now = this.now();
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_plugin_resource_migration_state
              SET state = 'ready', expected_file_count = ?, applied_file_count = ?,
                  last_filename = ?, last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
              AND state = 'applying'
              AND EXISTS (
                SELECT 1 FROM control_operations
                 WHERE operation_id = ? AND environment_id = ?
                   AND lock_owner = 'plugin-resource-migration-reconciler' AND fencing_token = ?
              )`
        )
        .bind(
          result.totalFiles,
          result.totalFiles,
          result.lastFilename,
          now,
          now,
          row.plugin_resource_id,
          row.environment_id,
          row.operation_id,
          row.operation_id,
          row.environment_id,
          claim.fencing_token
        ),
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', observed_resource_id = ?, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = ? AND status = 'running'`
        )
        .bind(row.provider_database_id, now, now, row.operation_id, stepKey),
      this.database
        .prepare(
          `UPDATE control_operations
              SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND lock_owner = 'plugin-resource-migration-reconciler' AND fencing_token = ?`
        )
        .bind(now, row.operation_id, row.environment_id, claim.fencing_token),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'plugin.resource.migration.ready', 'worker', 'ar-control',
             'plugin_resource', ?, 'succeeded', ?, ?)`
        )
        .bind(
          `audit_plugin_migration_${row.plugin_resource_id.slice(-32)}_${claim.fencing_token}`,
          row.environment_id,
          row.operation_id,
          row.plugin_resource_id,
          JSON.stringify({
            streamId: row.stream_id,
            releaseId: row.release_id,
            manifestDigest: row.manifest_digest,
            fileCount: result.totalFiles,
          }),
          now
        ),
    ]);
  }

  private async recordFailure(
    row: MigrationRow,
    claim: Claim,
    stepKey: string | null,
    error: unknown
  ): Promise<void> {
    const now = this.now();
    const decision = decideControlProvisioningFailure({
      effect: 'apply_migrations',
      operation: {
        operationId: row.operation_id,
        attemptCount: claim.attempt_count,
        createdAt: claim.created_at,
      },
      error,
      failedAt: now,
    });
    const blocked = decision.disposition === 'blocked';
    const statements = [
      this.database
        .prepare(
          `UPDATE control_plugin_resource_migration_state
              SET state = ?, last_error_code = ?, updated_at = ?
            WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?`
        )
        .bind(
          blocked ? 'blocked' : 'waiting_retry',
          decision.code,
          now,
          row.plugin_resource_id,
          row.environment_id,
          row.operation_id
        ),
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = ?, next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = ?, lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND lock_owner = 'plugin-resource-migration-reconciler' AND fencing_token = ?`
        )
        .bind(
          blocked ? 'blocked' : 'waiting_retry',
          decision.nextAttemptAt,
          decision.code,
          decision.code,
          now,
          row.operation_id,
          row.environment_id,
          claim.fencing_token
        ),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'plugin.resource.migration.failed', 'worker', 'ar-control',
             'plugin_resource', ?, ?, ?, ?)`
        )
        .bind(
          `audit_plugin_migration_${row.plugin_resource_id.slice(-32)}_${claim.fencing_token}`,
          row.environment_id,
          row.operation_id,
          row.plugin_resource_id,
          blocked ? 'blocked' : 'failed',
          JSON.stringify({ code: decision.code, streamId: row.stream_id }),
          now
        ),
    ];
    if (stepKey) {
      statements.push(
        this.database
          .prepare(
            `UPDATE control_operation_steps
                SET status = ?, next_attempt_at = ?, last_error_code = ?,
                    last_error_redacted = ?, updated_at = ?
              WHERE operation_id = ? AND step_key = ? AND status = 'running'`
          )
          .bind(
            blocked ? 'blocked' : 'waiting_retry',
            decision.nextAttemptAt,
            decision.code,
            decision.code,
            now,
            row.operation_id,
            stepKey
          )
      );
    }
    await this.database.batch(statements);
  }

  private async release(row: MigrationRow, claim: Claim, now: number): Promise<void> {
    await this.database
      .prepare(
        `UPDATE control_operations
            SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND lock_owner = 'plugin-resource-migration-reconciler' AND fencing_token = ?`
      )
      .bind(now, row.operation_id, row.environment_id, claim.fencing_token)
      .run();
  }
}
