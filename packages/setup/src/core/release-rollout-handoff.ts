import { createHash } from 'node:crypto';
import {
  executeD1Batch,
  type D1BatchExecutionResult,
  type D1BatchStatement,
} from './cloudflare.js';
import type { MigrationReleaseArtifactPlan } from './migration-release-publication.js';
import type { ReleaseMigrationManifest } from './release-migrations.js';

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u;
const SAFE_STREAM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SAFE_DIGEST = /^[a-f0-9]{64}$/u;

type D1BatchExecutor = (
  databaseId: string,
  statements: readonly D1BatchStatement[]
) => Promise<D1BatchExecutionResult[]>;

export type ReleaseRolloutHandoffPhase =
  | 'requested'
  | 'database_rollout'
  | 'awaiting_setup'
  | 'verifying'
  | 'completed'
  | 'blocked';

export interface ReleaseRolloutHandoffStatus {
  operationId: string;
  sourceVersion: string | null;
  targetVersion: string;
  releaseId: string;
  manifestDigest: string;
  phase: ReleaseRolloutHandoffPhase;
  completedTargets: number;
  totalTargets: number;
  lastErrorCode: string | null;
  updatedAt: number;
}

interface ReleaseRolloutHandoffRow extends Record<string, unknown> {
  operation_id: string;
  source_version: string | null;
  target_version: string;
  release_id: string;
  manifest_digest: string;
  handoff_state: string;
  completed_targets: number;
  total_targets: number;
  last_error_code: string | null;
  updated_at: number;
}

export interface ReleaseRolloutHandoffPlan {
  operationId: string;
  streamIds: string[];
  statements: D1BatchStatement[];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertVersion(value: string, field: string): void {
  if (!SAFE_VERSION.test(value)) throw new Error(`release_rollout_${field}_invalid`);
}

function rolloutPolicy(
  manifest: ReleaseMigrationManifest
): NonNullable<ReleaseMigrationManifest['rollout']> {
  const policy = manifest.rollout;
  if (
    !policy ||
    policy.databaseExecution !== 'setup_then_control' ||
    policy.workerActivation !== 'after_required_databases' ||
    (policy.adminMutationMode !== 'available' && policy.adminMutationMode !== 'read_only')
  ) {
    throw new Error('release_rollout_policy_invalid');
  }
  return policy;
}

function resultRows(result: D1BatchExecutionResult | undefined): Record<string, unknown>[] {
  if (!result || !Array.isArray(result.results)) {
    throw new Error('release_rollout_handoff_verification_failed');
  }
  return result.results.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('release_rollout_handoff_verification_failed');
    }
    return row as Record<string, unknown>;
  });
}

function parseStatus(row: Record<string, unknown> | undefined): ReleaseRolloutHandoffStatus {
  if (!row) throw new Error('release_rollout_handoff_not_found');
  const candidate = row as ReleaseRolloutHandoffRow;
  if (
    typeof candidate.operation_id !== 'string' ||
    !/^op_release_rollout_[a-f0-9]{32}$/u.test(candidate.operation_id) ||
    (candidate.source_version !== null &&
      (typeof candidate.source_version !== 'string' ||
        !SAFE_VERSION.test(candidate.source_version))) ||
    typeof candidate.target_version !== 'string' ||
    !SAFE_VERSION.test(candidate.target_version) ||
    typeof candidate.release_id !== 'string' ||
    !SAFE_VERSION.test(candidate.release_id) ||
    typeof candidate.manifest_digest !== 'string' ||
    !SAFE_DIGEST.test(candidate.manifest_digest) ||
    ![
      'requested',
      'database_rollout',
      'awaiting_setup',
      'verifying',
      'completed',
      'blocked',
    ].includes(candidate.handoff_state) ||
    !Number.isSafeInteger(candidate.completed_targets) ||
    candidate.completed_targets < 0 ||
    !Number.isSafeInteger(candidate.total_targets) ||
    candidate.total_targets < candidate.completed_targets ||
    (candidate.last_error_code !== null && typeof candidate.last_error_code !== 'string') ||
    !Number.isSafeInteger(candidate.updated_at) ||
    candidate.updated_at < 1
  ) {
    throw new Error('release_rollout_handoff_status_invalid');
  }
  return {
    operationId: candidate.operation_id,
    sourceVersion: candidate.source_version,
    targetVersion: candidate.target_version,
    releaseId: candidate.release_id,
    manifestDigest: candidate.manifest_digest,
    phase: candidate.handoff_state as ReleaseRolloutHandoffPhase,
    completedTargets: candidate.completed_targets,
    totalTargets: candidate.total_targets,
    lastErrorCode: candidate.last_error_code,
    updatedAt: candidate.updated_at,
  };
}

function statusSelect(): string {
  return `SELECT rollout.operation_id, rollout.source_version, rollout.target_version,
                 rollout.release_id, rollout.manifest_digest, rollout.handoff_state,
                 COALESCE(SUM(CASE WHEN target.state = 'succeeded' THEN 1 ELSE 0 END), 0)
                   AS completed_targets,
                 COUNT(target.target_id) AS total_targets,
                 operation.last_error_code, rollout.updated_at
            FROM control_release_migration_rollouts rollout
            JOIN control_operations operation
              ON operation.operation_id = rollout.operation_id
             AND operation.environment_id = rollout.environment_id
       LEFT JOIN control_release_migration_targets target
              ON target.operation_id = rollout.operation_id
           WHERE rollout.operation_id = ? AND rollout.environment_id = ?
        GROUP BY rollout.operation_id, rollout.source_version, rollout.target_version,
                 rollout.release_id, rollout.manifest_digest, rollout.handoff_state,
                 operation.last_error_code, rollout.updated_at`;
}

export function buildReleaseRolloutHandoffPlan(input: {
  environmentId: string;
  sourceVersion?: string;
  targetVersion: string;
  artifact: MigrationReleaseArtifactPlan;
  manifest: ReleaseMigrationManifest;
  managedStreamIds: readonly string[];
  actorId: string;
  now?: number;
}): ReleaseRolloutHandoffPlan {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('release_rollout_environment_invalid');
  }
  if (input.sourceVersion) assertVersion(input.sourceVersion, 'source_version');
  assertVersion(input.targetVersion, 'target_version');
  if (input.targetVersion !== input.manifest.productVersion) {
    throw new Error('release_rollout_target_version_mismatch');
  }
  if (!SAFE_DIGEST.test(input.artifact.manifestDigest)) {
    throw new Error('release_rollout_manifest_digest_invalid');
  }
  const expectedObjectKey = `releases/${input.artifact.releaseId}/${input.artifact.manifestDigest}/manifest.json`;
  if (input.artifact.manifestObjectKey !== expectedObjectKey) {
    throw new Error('release_rollout_manifest_object_key_invalid');
  }
  if (
    input.actorId.length < 1 ||
    input.actorId.length > 200 ||
    Array.from(input.actorId).some((character) => character.charCodeAt(0) < 0x20)
  ) {
    throw new Error('release_rollout_actor_invalid');
  }
  const policy = rolloutPolicy(input.manifest);
  const artifactStreams = new Set(input.artifact.streamIds);
  const streamIds = [...new Set(input.managedStreamIds)].sort();
  if (
    streamIds.length === 0 ||
    streamIds.length !== input.managedStreamIds.length ||
    streamIds.some((streamId) => !SAFE_STREAM_ID.test(streamId) || !artifactStreams.has(streamId))
  ) {
    throw new Error('release_rollout_managed_streams_invalid');
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('release_rollout_time_invalid');
  const operationId = `op_release_rollout_${digest(
    `${input.environmentId}\0${input.artifact.releaseId}\0${input.artifact.manifestDigest}`
  ).slice(0, 32)}`;
  const idempotencyKey = `release-rollout:${input.artifact.releaseId}:${input.artifact.manifestDigest}`;
  const handoffAuditEventId = `audit:${operationId}:handoff`;
  const handoffAuditPayload = JSON.stringify({
    source_version: input.sourceVersion ?? null,
    target_version: input.targetVersion,
    release_id: input.artifact.releaseId,
    manifest_digest: input.artifact.manifestDigest,
    streams: streamIds,
  });
  const statements: D1BatchStatement[] = [
    {
      sql: `INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, created_at, updated_at
      ) VALUES (?, ?, 'release_migration_rollout', ?, 'queued', 'setup', ?, 0, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING`,
      params: [operationId, input.environmentId, idempotencyKey, input.actorId, now, now],
    },
    {
      sql: `INSERT INTO control_release_migration_rollouts (
        operation_id, environment_id, source_version, target_version, release_id,
        manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
        admin_mutation_mode, handoff_state, active_environment_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING`,
      params: [
        operationId,
        input.environmentId,
        input.sourceVersion ?? null,
        input.targetVersion,
        input.artifact.releaseId,
        input.artifact.manifestDigest,
        input.artifact.manifestObjectKey,
        policy.databaseExecution,
        policy.workerActivation,
        policy.adminMutationMode,
        input.environmentId,
        now,
        now,
      ],
    },
    ...[
      ['apply_managed_migrations', 10],
      ['await_setup', 20],
      ['verify_release', 30],
    ].map(([stepKey, displayOrder]) => ({
      sql: `INSERT OR IGNORE INTO control_operation_steps (
        operation_id, step_key, display_order, status, attempt_count, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, ?)`,
      params: [operationId, stepKey, displayOrder, now],
    })),
  ];
  for (const streamId of streamIds) {
    statements.push({
      sql: `INSERT OR IGNORE INTO control_operation_release_pins (
        operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
      ) SELECT ?, ?, ?, catalog.release_id, catalog.manifest_digest, ?
          FROM control_migration_release_catalog catalog
         WHERE catalog.environment_id = ? AND catalog.stream_id = ?
           AND catalog.release_id = ? AND catalog.manifest_digest = ?
           AND catalog.manifest_r2_object_key = ? AND catalog.state = 'active'`,
      params: [
        operationId,
        input.environmentId,
        streamId,
        now,
        input.environmentId,
        streamId,
        input.artifact.releaseId,
        input.artifact.manifestDigest,
        input.artifact.manifestObjectKey,
      ],
    });
  }
  statements.push({
    sql: `UPDATE control_operations
             SET updated_at = CASE WHEN EXISTS (
               SELECT 1 FROM control_release_migration_rollouts rollout
                WHERE rollout.operation_id = control_operations.operation_id
                  AND rollout.environment_id = control_operations.environment_id
                  AND rollout.target_version = ? AND rollout.release_id = ?
                  AND rollout.manifest_digest = ? AND rollout.manifest_r2_object_key = ?
                  AND (SELECT COUNT(*) FROM control_operation_release_pins pin
                        WHERE pin.operation_id = rollout.operation_id) = ?
             ) THEN updated_at ELSE NULL END
           WHERE operation_id = ? AND environment_id = ?`,
    params: [
      input.targetVersion,
      input.artifact.releaseId,
      input.artifact.manifestDigest,
      input.artifact.manifestObjectKey,
      streamIds.length,
      operationId,
      input.environmentId,
    ],
  });
  statements.push({
    sql: `INSERT OR IGNORE INTO control_audit_events (
      event_id, environment_id, operation_id, event_type, actor_type, actor_id,
      resource_kind, resource_id, outcome, redacted_payload_json, created_at
    ) VALUES (?, ?, ?, 'control.release_migration.handoff_requested', 'setup', ?,
      'release_migration_rollout', ?, 'succeeded', ?, ?)`,
    params: [
      handoffAuditEventId,
      input.environmentId,
      operationId,
      input.actorId,
      operationId,
      handoffAuditPayload,
      now,
    ],
  });
  statements.push({
    sql: `UPDATE control_operations
             SET updated_at = CASE WHEN EXISTS (
               SELECT 1 FROM control_audit_events audit
                WHERE audit.event_id = ? AND audit.environment_id = ?
                  AND audit.operation_id = ? AND audit.event_type = ?
                  AND audit.actor_type = 'setup' AND audit.actor_id = ?
                  AND audit.resource_kind = 'release_migration_rollout'
                  AND audit.resource_id = ? AND audit.outcome = 'succeeded'
                  AND audit.redacted_payload_json = ?
             ) THEN updated_at ELSE NULL END
           WHERE operation_id = ? AND environment_id = ?`,
    params: [
      handoffAuditEventId,
      input.environmentId,
      operationId,
      'control.release_migration.handoff_requested',
      input.actorId,
      operationId,
      handoffAuditPayload,
      operationId,
      input.environmentId,
    ],
  });
  statements.push({
    sql: `SELECT rollout.operation_id, rollout.target_version, rollout.release_id,
                 rollout.manifest_digest, rollout.manifest_r2_object_key,
                 COUNT(pin.stream_id) AS pin_count
            FROM control_release_migration_rollouts rollout
       LEFT JOIN control_operation_release_pins pin ON pin.operation_id = rollout.operation_id
           WHERE rollout.operation_id = ? AND rollout.environment_id = ?
        GROUP BY rollout.operation_id, rollout.target_version, rollout.release_id,
                 rollout.manifest_digest, rollout.manifest_r2_object_key`,
    params: [operationId, input.environmentId],
  });
  return { operationId, streamIds, statements };
}

export async function createReleaseRolloutHandoff(input: {
  controlDatabaseId: string;
  environmentId: string;
  sourceVersion?: string;
  targetVersion: string;
  artifact: MigrationReleaseArtifactPlan;
  manifest: ReleaseMigrationManifest;
  managedStreamIds: readonly string[];
  actorId: string;
  now?: number;
  executeBatch?: D1BatchExecutor;
}): Promise<ReleaseRolloutHandoffStatus> {
  const plan = buildReleaseRolloutHandoffPlan(input);
  const results = await (input.executeBatch ?? executeD1Batch)(
    input.controlDatabaseId,
    plan.statements
  );
  const rows = resultRows(results.at(-1));
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.operation_id !== plan.operationId ||
    row.target_version !== input.targetVersion ||
    row.release_id !== input.artifact.releaseId ||
    row.manifest_digest !== input.artifact.manifestDigest ||
    row.manifest_r2_object_key !== input.artifact.manifestObjectKey ||
    row.pin_count !== plan.streamIds.length
  ) {
    throw new Error('release_rollout_handoff_verification_failed');
  }
  return getReleaseRolloutHandoffStatus({
    controlDatabaseId: input.controlDatabaseId,
    environmentId: input.environmentId,
    operationId: plan.operationId,
    executeBatch: input.executeBatch,
  });
}

export async function getReleaseRolloutHandoffStatus(input: {
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  executeBatch?: D1BatchExecutor;
}): Promise<ReleaseRolloutHandoffStatus> {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('release_rollout_environment_invalid');
  }
  if (!/^op_release_rollout_[a-f0-9]{32}$/u.test(input.operationId)) {
    throw new Error('release_rollout_operation_id_invalid');
  }
  const results = await (input.executeBatch ?? executeD1Batch)(input.controlDatabaseId, [
    { sql: statusSelect(), params: [input.operationId, input.environmentId] },
  ]);
  return parseStatus(resultRows(results[0])[0]);
}

export async function waitForReleaseRolloutAwaitingSetup(input: {
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  executeBatch?: D1BatchExecutor;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  onProgress?: (status: ReleaseRolloutHandoffStatus) => void;
}): Promise<ReleaseRolloutHandoffStatus> {
  const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000;
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('release_rollout_wait_timeout_invalid');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('release_rollout_poll_interval_invalid');
  }
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const clock = input.clock ?? Date.now;
  const deadline = clock() + timeoutMs;
  while (true) {
    const status = await getReleaseRolloutHandoffStatus(input);
    input.onProgress?.(status);
    if (
      status.phase === 'awaiting_setup' ||
      status.phase === 'verifying' ||
      status.phase === 'completed'
    ) {
      return status;
    }
    if (status.phase === 'blocked') {
      throw new Error(`release_rollout_blocked:${status.lastErrorCode ?? 'unknown'}`);
    }
    if (clock() >= deadline) return status;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - clock())));
  }
}

async function transitionReleaseRollout(input: {
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  transition: 'begin_verification' | 'complete';
  actorId: string;
  now?: number;
  executeBatch?: D1BatchExecutor;
}): Promise<ReleaseRolloutHandoffStatus> {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('release_rollout_environment_invalid');
  }
  if (!/^op_release_rollout_[a-f0-9]{32}$/u.test(input.operationId)) {
    throw new Error('release_rollout_operation_id_invalid');
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('release_rollout_time_invalid');
  const statements: D1BatchStatement[] =
    input.transition === 'begin_verification'
      ? [
          {
            sql: `UPDATE control_operation_steps
                     SET status = 'succeeded', completed_at = ?, updated_at = ?
                   WHERE operation_id = ? AND step_key = 'await_setup' AND status = 'running'
                     AND EXISTS (
                       SELECT 1 FROM control_release_migration_rollouts rollout
                        WHERE rollout.operation_id = ? AND rollout.environment_id = ?
                          AND rollout.handoff_state = 'awaiting_setup'
                     )`,
            params: [now, now, input.operationId, input.operationId, input.environmentId],
          },
          {
            sql: `UPDATE control_operation_steps
                     SET status = 'running', attempt_count = attempt_count + 1,
                         started_at = COALESCE(started_at, ?), updated_at = ?
                   WHERE operation_id = ? AND step_key = 'verify_release' AND status = 'queued'
                     AND EXISTS (
                       SELECT 1 FROM control_release_migration_rollouts rollout
                        WHERE rollout.operation_id = ? AND rollout.environment_id = ?
                          AND rollout.handoff_state = 'awaiting_setup'
                     )`,
            params: [now, now, input.operationId, input.operationId, input.environmentId],
          },
          {
            sql: `UPDATE control_release_migration_rollouts
                     SET handoff_state = 'verifying', setup_resumed_at = COALESCE(setup_resumed_at, ?),
                         updated_at = ?
                   WHERE operation_id = ? AND environment_id = ?
                     AND handoff_state = 'awaiting_setup'`,
            params: [now, now, input.operationId, input.environmentId],
          },
        ]
      : [
          {
            sql: `UPDATE control_operation_steps
                     SET status = 'succeeded', progress_current = progress_total,
                         completed_at = ?, updated_at = ?
                   WHERE operation_id = ? AND step_key = 'verify_release' AND status = 'running'
                     AND EXISTS (
                       SELECT 1 FROM control_release_migration_rollouts rollout
                        WHERE rollout.operation_id = ? AND rollout.environment_id = ?
                          AND rollout.handoff_state = 'verifying'
                     )`,
            params: [now, now, input.operationId, input.operationId, input.environmentId],
          },
          {
            sql: `UPDATE control_operations
                     SET status = 'succeeded', completed_at = ?, last_error_code = NULL,
                         lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
                   WHERE operation_id = ? AND environment_id = ? AND status = 'running'
                     AND EXISTS (
                       SELECT 1 FROM control_release_migration_rollouts rollout
                        WHERE rollout.operation_id = ? AND rollout.environment_id = ?
                          AND rollout.handoff_state = 'verifying'
                     )`,
            params: [
              now,
              now,
              input.operationId,
              input.environmentId,
              input.operationId,
              input.environmentId,
            ],
          },
          {
            sql: `UPDATE control_release_migration_rollouts
                     SET handoff_state = 'completed', active_environment_key = 'completed:' || operation_id,
                         completed_at = ?, updated_at = ?
                   WHERE operation_id = ? AND environment_id = ? AND handoff_state = 'verifying'
                     AND EXISTS (
                       SELECT 1 FROM control_operations operation
                        WHERE operation.operation_id = control_release_migration_rollouts.operation_id
                          AND operation.status = 'succeeded'
                     )`,
            params: [now, now, input.operationId, input.environmentId],
          },
        ];
  statements.push(
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
        event_id, environment_id, operation_id, event_type, actor_type, actor_id,
        resource_kind, resource_id, outcome, redacted_payload_json, created_at
      ) SELECT ?, ?, ?, ?, 'setup', ?, 'release_migration_rollout', ?, 'succeeded', '{}', ?
         WHERE EXISTS (
           SELECT 1 FROM control_release_migration_rollouts rollout
            WHERE rollout.operation_id = ? AND rollout.environment_id = ?
              AND rollout.handoff_state = ?
         )`,
      params: [
        `audit:${input.operationId}:${input.transition}`,
        input.environmentId,
        input.operationId,
        input.transition === 'begin_verification'
          ? 'control.release_migration.setup_resumed'
          : 'control.release_migration.completed',
        input.actorId,
        input.operationId,
        now,
        input.operationId,
        input.environmentId,
        input.transition === 'begin_verification' ? 'verifying' : 'completed',
      ],
    },
    { sql: statusSelect(), params: [input.operationId, input.environmentId] }
  );
  const results = await (input.executeBatch ?? executeD1Batch)(input.controlDatabaseId, statements);
  const status = parseStatus(resultRows(results.at(-1))[0]);
  const expectedPhase = input.transition === 'begin_verification' ? 'verifying' : 'completed';
  if (status.phase !== expectedPhase) {
    throw new Error(`release_rollout_${input.transition}_conflict:${status.phase}`);
  }
  return status;
}

export function beginReleaseRolloutVerification(
  input: Omit<Parameters<typeof transitionReleaseRollout>[0], 'transition'>
): Promise<ReleaseRolloutHandoffStatus> {
  return transitionReleaseRollout({ ...input, transition: 'begin_verification' });
}

export function completeReleaseRolloutHandoff(
  input: Omit<Parameters<typeof transitionReleaseRollout>[0], 'transition'>
): Promise<ReleaseRolloutHandoffStatus> {
  return transitionReleaseRollout({ ...input, transition: 'complete' });
}
