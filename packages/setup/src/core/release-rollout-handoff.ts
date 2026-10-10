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
  /** Canonical JSON of the bound target set, or null when the rollout carries none. */
  expectedTargetsJson: string | null;
  statements: D1BatchStatement[];
}

/** One database Setup verified before the handoff, as Control identifies a snapshot target. */
export interface ReleaseRolloutExpectedTarget {
  streamId: string;
  databaseId: string;
}

/** Stable code Control uses when its snapshot differs from the bound expected target set. */
export const RELEASE_TARGET_SET_MISMATCH_CODE = 'release_target_set_mismatch';

const SAFE_DATABASE_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u;

/**
 * Canonical JSON of the target set Control must find in its snapshot, or null when none is bound.
 * The form is sorted and duplicate-free so the same set always yields the same string and a
 * re-created handoff can be compared byte for byte. `streamIds` restricts the streams a target
 * may name; omit it to normalize a value read back from Control.
 */
export function canonicalizeExpectedTargets(
  targets: readonly ReleaseRolloutExpectedTarget[] | null | undefined,
  streamIds?: readonly string[]
): string | null {
  if (targets === null || targets === undefined) return null;
  const unique = new Map<string, ReleaseRolloutExpectedTarget>();
  for (const target of targets) {
    if (
      !target ||
      typeof target.streamId !== 'string' ||
      typeof target.databaseId !== 'string' ||
      !SAFE_STREAM_ID.test(target.streamId) ||
      (streamIds !== undefined && !streamIds.includes(target.streamId)) ||
      !SAFE_DATABASE_ID.test(target.databaseId)
    ) {
      throw new Error('release_rollout_expected_targets_invalid');
    }
    unique.set(`${target.streamId}\0${target.databaseId}`, {
      streamId: target.streamId,
      databaseId: target.databaseId,
    });
  }
  return JSON.stringify(
    [...unique.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, target]) => ({ streamId: target.streamId, databaseId: target.databaseId }))
  );
}

function canonicalStoredExpectedTargets(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('release_rollout_expected_targets_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('release_rollout_expected_targets_invalid');
  }
  if (!Array.isArray(parsed)) throw new Error('release_rollout_expected_targets_invalid');
  return canonicalizeExpectedTargets(parsed as ReleaseRolloutExpectedTarget[]);
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
  /**
   * The databases Setup verified before the handoff. Supplied only for a same-version draft append,
   * whose Control snapshot must equal this set; every other rollout leaves it unset (no binding).
   */
  expectedTargets?: readonly ReleaseRolloutExpectedTarget[] | null;
  /**
   * Allow this call to re-arm a rollout that Control blocked with release_target_set_mismatch.
   * Only the first handoff call of a Setup run that has just recomputed and re-verified
   * `expectedTargets` against the lock may set it. Any later call of the same run (and every
   * plain idempotent re-create) must leave a block in place: it would otherwise reuse a set that
   * was verified before Control found the difference.
   */
  rearmBlockedTargetSetMismatch?: boolean;
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
  const expectedTargetsJson = canonicalizeExpectedTargets(input.expectedTargets, streamIds);
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
        admin_mutation_mode, handoff_state, active_environment_key, created_at, updated_at,
        expected_targets_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)
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
        expectedTargetsJson,
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
  if (expectedTargetsJson !== null && input.rearmBlockedTargetSetMismatch === true) {
    // Control blocked this very rollout because its snapshot differed from the set Setup had
    // verified (release_target_set_mismatch). Only a fresh Setup run that recomputed and
    // re-verified the set may continue: it replaces the bound set and returns the rollout to
    // 'requested' so Control takes a new snapshot. Control never does this on its own, and an
    // operator target retry cannot, so a stale set is never reused. The operation is handed back
    // with an already expired lease so the next reconciler pass claims it; the blocked step is
    // restarted by that snapshot.
    const blockedByMismatch = `EXISTS (
      SELECT 1 FROM control_operations operation
       WHERE operation.operation_id = ? AND operation.environment_id = ?
         AND operation.status = 'blocked' AND operation.last_error_code = ?
    )`;
    const blockedByMismatchParams = [
      operationId,
      input.environmentId,
      RELEASE_TARGET_SET_MISMATCH_CODE,
    ];
    statements.push(
      {
        sql: `INSERT OR IGNORE INTO control_audit_events (
          event_id, environment_id, operation_id, event_type, actor_type, actor_id,
          resource_kind, resource_id, outcome, redacted_payload_json, created_at
        ) SELECT 'audit:' || rollout.operation_id || ':target-set-rearm:' || operation.attempt_count,
                 rollout.environment_id, rollout.operation_id,
                 'control.release_migration.target_set_rearmed', 'setup', ?,
                 'release_migration_rollout', rollout.operation_id, 'succeeded', ?, ?
            FROM control_release_migration_rollouts rollout
            JOIN control_operations operation
              ON operation.operation_id = rollout.operation_id
             AND operation.environment_id = rollout.environment_id
           WHERE rollout.operation_id = ? AND rollout.environment_id = ?
             AND rollout.handoff_state = 'blocked' AND ${blockedByMismatch}`,
        params: [
          input.actorId,
          JSON.stringify({
            previous_error_code: RELEASE_TARGET_SET_MISMATCH_CODE,
            expected_target_count: (JSON.parse(expectedTargetsJson) as unknown[]).length,
          }),
          now,
          operationId,
          input.environmentId,
          ...blockedByMismatchParams,
        ],
      },
      {
        sql: `UPDATE control_release_migration_rollouts
                 SET expected_targets_json = ?, handoff_state = 'requested',
                     target_snapshot_at = NULL, updated_at = ?
               WHERE operation_id = ? AND environment_id = ? AND handoff_state = 'blocked'
                 AND ${blockedByMismatch}`,
        params: [
          expectedTargetsJson,
          now,
          operationId,
          input.environmentId,
          ...blockedByMismatchParams,
        ],
      },
      {
        sql: `UPDATE control_operations
                 SET status = 'running', last_error_code = NULL, next_attempt_at = NULL,
                     lock_owner = 'setup:target-set-rearm', lock_expires_at = 1, updated_at = ?
               WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
                 AND last_error_code = ?
                 AND EXISTS (
                   SELECT 1 FROM control_release_migration_rollouts rollout
                    WHERE rollout.operation_id = control_operations.operation_id
                      AND rollout.handoff_state = 'requested'
                 )`,
        params: [now, operationId, input.environmentId, RELEASE_TARGET_SET_MISMATCH_CODE],
      }
    );
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
                 rollout.expected_targets_json,
                 COUNT(pin.stream_id) AS pin_count
            FROM control_release_migration_rollouts rollout
       LEFT JOIN control_operation_release_pins pin ON pin.operation_id = rollout.operation_id
           WHERE rollout.operation_id = ? AND rollout.environment_id = ?
        GROUP BY rollout.operation_id, rollout.target_version, rollout.release_id,
                 rollout.manifest_digest, rollout.manifest_r2_object_key,
                 rollout.expected_targets_json`,
    params: [operationId, input.environmentId],
  });
  return { operationId, streamIds, expectedTargetsJson, statements };
}

export async function createReleaseRolloutHandoff(input: {
  controlDatabaseId: string;
  environmentId: string;
  sourceVersion?: string;
  targetVersion: string;
  artifact: MigrationReleaseArtifactPlan;
  manifest: ReleaseMigrationManifest;
  managedStreamIds: readonly string[];
  expectedTargets?: readonly ReleaseRolloutExpectedTarget[] | null;
  rearmBlockedTargetSetMismatch?: boolean;
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
  // An existing handoff (same operation) keeps the target set it was created with. A different
  // set, or the presence or absence of one, means the earlier handoff was prepared for another
  // verification and must not be reused as if it matched this one.
  if (canonicalStoredExpectedTargets(row.expected_targets_json) !== plan.expectedTargetsJson) {
    throw new Error('release_rollout_expected_targets_mismatch');
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

export async function getActiveReleaseRolloutHandoffStatus(input: {
  controlDatabaseId: string;
  environmentId: string;
  executeBatch?: D1BatchExecutor;
}): Promise<ReleaseRolloutHandoffStatus | null> {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('release_rollout_environment_invalid');
  }
  const executeBatch = input.executeBatch ?? executeD1Batch;
  const tableCheck = await executeBatch(input.controlDatabaseId, [
    {
      sql: `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'control_release_migration_rollouts'`,
    },
  ]);
  if (resultRows(tableCheck[0]).length === 0) return null;

  const results = await executeBatch(input.controlDatabaseId, [
    {
      sql: `SELECT rollout.operation_id, rollout.source_version, rollout.target_version,
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
             WHERE rollout.environment_id = ?
               AND rollout.active_environment_key = ?
               AND rollout.handoff_state <> 'completed'
          GROUP BY rollout.operation_id, rollout.source_version, rollout.target_version,
                   rollout.release_id, rollout.manifest_digest, rollout.handoff_state,
                   operation.last_error_code, rollout.updated_at
          ORDER BY rollout.updated_at DESC, rollout.operation_id DESC
             LIMIT 2`,
      params: [input.environmentId, input.environmentId],
    },
  ]);
  const rows = resultRows(results[0]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('release_rollout_active_state_ambiguous');
  return parseStatus(rows[0]);
}

/**
 * Blocked codes that Control's reconciler clears by itself on a later cron tick (see
 * `resumeArtifactFormatBlockedRollouts`, `resumeProviderBlockedRollouts` and
 * `resumeExecutorBlockedRollouts` in ar-control's release-migration-rollout-reconciler).
 * Setup waits a bounded grace period for these instead of failing on the first read, because the
 * block is often a leftover from the Control version that was running before this update
 * deployed the new one. Every other code needs an operator and still fails immediately.
 */
export const CONTROL_AUTO_RESUMED_BLOCK_CODES: readonly string[] = [
  // Resumed once a newer Control can read and validate the same content-addressed artifact.
  'migration_artifact_manifest_invalid',
  // Resumed once the target D1 database shows up in Control's observed resources.
  'release_target_provider_database_unavailable',
  // Resumed once a Control with a migration executor runs the cron.
  'release_migration_executor_unavailable',
];

/** Control's reconciler runs every minute; 3 minutes covers at least 2-3 ticks after a deploy. */
export const CONTROL_RESUME_GRACE_MS = 3 * 60 * 1000;

export interface ReleaseRolloutWaitContext {
  /** Set while setup waits for Control to resume a blocked rollout by itself. */
  awaitingControlResume?: {
    errorCode: string;
    elapsedMs: number;
    graceMs: number;
  };
}

export function formatReleaseRolloutProgress(
  status: ReleaseRolloutHandoffStatus,
  context?: ReleaseRolloutWaitContext
): string {
  const waiting = context?.awaitingControlResume;
  if (waiting) {
    const elapsed = Math.floor(waiting.elapsedMs / 1000);
    const grace = Math.floor(waiting.graceMs / 1000);
    return `Control database rollout is blocked (${waiting.errorCode}); waiting for Control to resume it (${elapsed}s/${grace}s)`;
  }
  return `Control database rollout: ${status.completedTargets}/${status.totalTargets} (${status.phase})`;
}

export async function waitForReleaseRolloutAwaitingSetup(input: {
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  timeoutMs?: number;
  /** Grace period for a rollout blocked by a code Control resumes by itself. */
  controlResumeGraceMs?: number;
  pollIntervalMs?: number;
  executeBatch?: D1BatchExecutor;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  onProgress?: (status: ReleaseRolloutHandoffStatus, context?: ReleaseRolloutWaitContext) => void;
}): Promise<ReleaseRolloutHandoffStatus> {
  const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000;
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  const controlResumeGraceMs = input.controlResumeGraceMs ?? CONTROL_RESUME_GRACE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('release_rollout_wait_timeout_invalid');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('release_rollout_poll_interval_invalid');
  }
  if (!Number.isSafeInteger(controlResumeGraceMs) || controlResumeGraceMs < 0) {
    throw new Error('release_rollout_control_resume_grace_invalid');
  }
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const clock = input.clock ?? Date.now;
  let deadline = clock() + timeoutMs;
  // Grace is counted from the first blocked observation and reset whenever the rollout leaves
  // the blocked state (or comes back with a different code).
  let blockedSince: number | null = null;
  let blockedCode: string | null = null;
  while (true) {
    const status = await getReleaseRolloutHandoffStatus(input);
    if (status.phase !== 'blocked') {
      if (blockedSince !== null) {
        // Control resumed the rollout; give the resumed migration a full observation window
        // rather than whatever was left of the one the blocked wait consumed.
        deadline = Math.max(deadline, clock() + timeoutMs);
      }
      blockedSince = null;
      blockedCode = null;
    }
    if (status.phase === 'blocked') {
      const code = status.lastErrorCode ?? 'unknown';
      if (!CONTROL_AUTO_RESUMED_BLOCK_CODES.includes(code)) {
        input.onProgress?.(status);
        throw new Error(`release_rollout_blocked:${code}`);
      }
      if (blockedSince === null || blockedCode !== code) {
        blockedSince = clock();
        blockedCode = code;
      }
      const elapsedMs = clock() - blockedSince;
      if (elapsedMs >= controlResumeGraceMs) {
        input.onProgress?.(status);
        throw new Error(
          `release_rollout_blocked:${code} (Control did not resume the rollout within ` +
            `${Math.round(controlResumeGraceMs / 1000)}s; check that the ar-control Worker is ` +
            'deployed at the target version and its cron trigger is running, then run this update again)'
        );
      }
      input.onProgress?.(status, {
        awaitingControlResume: { errorCode: code, elapsedMs, graceMs: controlResumeGraceMs },
      });
      await sleep(Math.min(pollIntervalMs, Math.max(1, controlResumeGraceMs - elapsedMs)));
      continue;
    }
    input.onProgress?.(status);
    if (
      status.phase === 'awaiting_setup' ||
      status.phase === 'verifying' ||
      status.phase === 'completed'
    ) {
      return status;
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

export interface ReleaseRolloutTargetRow {
  streamId: string;
  databaseId: string | null;
  state: string;
}

/** The Control rollout's own record of which databases it migrated (and their outcome). */
export async function listReleaseRolloutTargets(input: {
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  executeBatch?: D1BatchExecutor;
}): Promise<ReleaseRolloutTargetRow[]> {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('release_rollout_environment_invalid');
  }
  if (!/^op_release_rollout_[a-f0-9]{32}$/u.test(input.operationId)) {
    throw new Error('release_rollout_operation_id_invalid');
  }
  const results = await (input.executeBatch ?? executeD1Batch)(input.controlDatabaseId, [
    {
      sql: `SELECT stream_id, provider_database_id, state
              FROM control_release_migration_targets
             WHERE operation_id = ? AND environment_id = ?
          ORDER BY stream_id, target_id`,
      params: [input.operationId, input.environmentId],
    },
  ]);
  return resultRows(results[0]).map((row) => {
    if (
      typeof row.stream_id !== 'string' ||
      (row.provider_database_id !== null && typeof row.provider_database_id !== 'string') ||
      typeof row.state !== 'string'
    ) {
      throw new Error('release_rollout_target_row_invalid');
    }
    return { streamId: row.stream_id, databaseId: row.provider_database_id, state: row.state };
  });
}

/**
 * Check that Control actually migrated every database Setup expects it to own. The expected set is
 * fixed from the lock before the handoff; a database that Control dropped from its snapshot (for
 * example a failed shard) or did not finish must stop Setup from recording it as migrated.
 * Databases Control migrated beyond the expected set are reported but are not an error.
 */
export function verifyControlRolloutCoversTargets(input: {
  expected: ReadonlyArray<{ databaseId: string; streamId: string }>;
  rows: readonly ReleaseRolloutTargetRow[];
}): { missing: string[]; unexpected: string[] } {
  const key = (databaseId: string, streamId: string): string => `${databaseId}:${streamId}`;
  const succeeded = new Set(
    input.rows
      .filter((row) => row.state === 'succeeded' && row.databaseId)
      .map((row) => key(row.databaseId!, row.streamId))
  );
  const expected = new Set(input.expected.map((item) => key(item.databaseId, item.streamId)));
  return {
    missing: [...expected].filter((item) => !succeeded.has(item)).sort(),
    unexpected: [...succeeded].filter((item) => !expected.has(item)).sort(),
  };
}

export interface ControlSnapshotPreviewRow {
  streamId: string;
  databaseId: string | null;
}

/**
 * Read-only preview of the databases Control will snapshot for a release rollout. It mirrors the
 * reconciler's snapshot selection (tenant and lookup shards in an active status with a present D1)
 * so Setup can compare Control's set with the lock's before any handoff exists.
 */
export async function listControlSnapshotPreview(input: {
  controlDatabaseId: string;
  environmentId: string;
  executeBatch?: D1BatchExecutor;
}): Promise<ControlSnapshotPreviewRow[]> {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('release_rollout_environment_invalid');
  }
  const results = await (input.executeBatch ?? executeD1Batch)(input.controlDatabaseId, [
    {
      sql: `SELECT CASE WHEN shard.data_role = 'tenant_pii' THEN 'pii-d1' ELSE 'core-d1' END
                      AS stream_id,
                    observed.provider_resource_id AS provider_database_id
               FROM control_tenant_shards shard
               JOIN control_desired_resources desired
                 ON desired.desired_resource_id = shard.d1_desired_resource_id
                AND desired.environment_id = shard.environment_id
                AND desired.desired_state = 'present'
          LEFT JOIN control_observed_resources observed
                 ON observed.observed_resource_id = desired.observed_resource_id
                AND observed.environment_id = desired.environment_id
                AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
              WHERE shard.environment_id = ?
                AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'degraded')
          UNION ALL
             SELECT 'lookup-d1' AS stream_id,
                    observed.provider_resource_id AS provider_database_id
               FROM control_lookup_physical_shards shard
               JOIN control_desired_resources desired
                 ON desired.desired_resource_id = shard.d1_desired_resource_id
                AND desired.environment_id = shard.environment_id
                AND desired.desired_state = 'present'
          LEFT JOIN control_observed_resources observed
                 ON observed.observed_resource_id = desired.observed_resource_id
                AND observed.environment_id = desired.environment_id
                AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
              WHERE shard.environment_id = ?
                AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'draining')`,
      params: [input.environmentId, input.environmentId],
    },
  ]);
  return resultRows(results[0]).map((row) => {
    if (
      typeof row.stream_id !== 'string' ||
      (row.provider_database_id !== null && typeof row.provider_database_id !== 'string')
    ) {
      throw new Error('release_rollout_snapshot_row_invalid');
    }
    return { streamId: row.stream_id, databaseId: row.provider_database_id };
  });
}
