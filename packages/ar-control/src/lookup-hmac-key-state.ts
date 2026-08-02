import type { D1Result } from '@cloudflare/workers-types';
import type {
  ControlLookupHmacKeyMetadata,
  ControlLookupHmacRotationCheckpointRequest,
  ControlLookupHmacRotationMutationRequest,
  ControlLookupHmacRotationSourceCheckpointRequest,
  ControlLookupHmacRotationSourceShardView,
  ControlLookupHmacRotationSourceKind,
  ControlLookupHmacRotationVerificationShardCheckpointRequest,
  ControlLookupHmacRotationVerificationShardView,
  ControlLookupHmacRotationStartRequest,
  ControlLookupHmacRotationVerificationRequest,
  ControlLookupHmacRotationView,
  ControlLookupHmacKeyStateView,
} from '@authrim/ar-lib-core/control-plane';
import { nextDirectoryRewriteFencingToken } from '@authrim/ar-lib-core/control-plane';
import { LOOKUP_HMAC_VERIFICATION_COMPONENTS } from './lookup-hmac-candidate-verifier';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const SETUP_TRANSITION_LEASE_SECONDS = 120;
const SCHEDULED_REWRITE_LEASE_SECONDS = 90;
const MAX_CHECKPOINT_BYTES = 4096;

function candidateVerificationGate(
  environmentId: string,
  operationId: string,
  phase: 'distribution' | 'generation'
): {
  sql: string;
  params: unknown[];
} {
  const expectedWorkers = LOOKUP_HMAC_VERIFICATION_COMPONENTS.map(
    (component) => `${environmentId}-${component}`
  );
  const expectedJson = JSON.stringify(expectedWorkers);
  return {
    sql: `
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) expected
         WHERE NOT EXISTS (
           SELECT 1 FROM control_lookup_hmac_candidate_verifications evidence
            WHERE evidence.environment_id = ? AND evidence.operation_id = ?
              AND evidence.verification_phase = '${phase}'
              AND evidence.worker_script_name = expected.value
              AND evidence.status = 'succeeded'
         )
      )
      AND NOT EXISTS (
        SELECT 1 FROM control_lookup_hmac_candidate_verifications evidence
         WHERE evidence.environment_id = ? AND evidence.operation_id = ?
           AND evidence.verification_phase = '${phase}'
           AND (evidence.status <> 'succeeded' OR evidence.worker_script_name NOT IN (
             SELECT value FROM json_each(?)
           ))
      )
      ${
        phase === 'distribution'
          ? `AND (SELECT COUNT(DISTINCT current_digest)
                    FROM control_lookup_hmac_candidate_verifications
                   WHERE environment_id = ? AND operation_id = ?
                     AND verification_phase = 'distribution' AND status = 'succeeded') = 1
             AND (SELECT COUNT(DISTINCT candidate_digest)
                    FROM control_lookup_hmac_candidate_verifications
                   WHERE environment_id = ? AND operation_id = ?
                     AND verification_phase = 'distribution' AND status = 'succeeded') = 1`
          : `AND (SELECT COUNT(DISTINCT observed_state_revision)
                    FROM control_lookup_hmac_candidate_verifications
                   WHERE environment_id = ? AND operation_id = ?
                     AND verification_phase = 'generation' AND status = 'succeeded') = 1`
      }`,
    params: [
      expectedJson,
      environmentId,
      operationId,
      environmentId,
      operationId,
      expectedJson,
      environmentId,
      operationId,
      ...(phase === 'distribution' ? [environmentId, operationId] : []),
    ],
  };
}

interface RotationRow {
  operation_id: string;
  state: ControlLookupHmacRotationView['state'];
  source_key_generation: number;
  source_key_id: string;
  source_key_slot: 'A' | 'B';
  source_key_fingerprint: string;
  candidate_key_generation: number;
  candidate_key_id: string;
  candidate_key_slot: 'A' | 'B';
  candidate_key_fingerprint: string;
  authoritative_checkpoint_json: string;
  source_row_count: number | null;
  current_row_count: number | null;
  verification_attempt_count: number;
  grace_expires_at: number | null;
  updated_at: number;
  owner_id: string | null;
  fencing_token: number | null;
  lease_expires_at: number | null;
  mutation_started: number | null;
}

interface StateRow {
  state_revision: number;
  rotation_state: ControlLookupHmacKeyStateView['rotationState'];
  write_mode: ControlLookupHmacKeyStateView['writeMode'];
  current_key_generation: number;
  current_key_id: string;
  current_key_slot: 'A' | 'B';
  current_key_fingerprint: string;
  previous_key_generation: number | null;
  previous_key_id: string | null;
  previous_key_slot: 'A' | 'B' | null;
  previous_key_fingerprint: string | null;
  operation_id: string | null;
  updated_at: number;
}

interface RotationSourceRow {
  operation_id: string;
  source_kind: ControlLookupHmacRotationSourceKind;
  data_role: 'tenant_core/users' | 'tenant_pii';
  shard_id: string;
  binding_ref: string;
  route_generation: number;
  cutoff_at: number;
  state: ControlLookupHmacRotationSourceShardView['state'];
  cursor_json: string;
  source_row_count: number;
  completed_at: number | null;
  updated_at: number;
}

interface RotationVerificationShardRow {
  operation_id: string;
  lookup_shard_id: string;
  binding_ref: string;
  state: ControlLookupHmacRotationVerificationShardView['state'];
  cursor_json: string;
  current_row_count: number;
  current_rows_valid: number;
  reservations_valid: number;
  route_references_valid: number;
  completed_at: number | null;
  updated_at: number;
}

export function validateLookupHmacKeyMetadata(
  value: unknown,
  code = 'invalid_lookup_hmac_key_metadata'
): ControlLookupHmacKeyMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4 ||
    Object.keys(candidate).some(
      (key) => !['generation', 'keyId', 'slot', 'fingerprint'].includes(key)
    ) ||
    !Number.isSafeInteger(candidate.generation) ||
    (candidate.generation as number) < 1 ||
    typeof candidate.keyId !== 'string' ||
    !SAFE_ID.test(candidate.keyId) ||
    (candidate.slot !== 'A' && candidate.slot !== 'B') ||
    typeof candidate.fingerprint !== 'string' ||
    !HEX_DIGEST.test(candidate.fingerprint)
  ) {
    throw new Error(code);
  }
  return {
    generation: candidate.generation as number,
    keyId: candidate.keyId,
    slot: candidate.slot,
    fingerprint: candidate.fingerprint,
  };
}

function metadata(
  generation: number | null,
  keyId: string | null,
  slot: 'A' | 'B' | null,
  fingerprint: string | null
): ControlLookupHmacKeyMetadata | null {
  if ([generation, keyId, slot, fingerprint].every((value) => value === null)) return null;
  return validateLookupHmacKeyMetadata({ generation, keyId, slot, fingerprint });
}

function view(row: StateRow): ControlLookupHmacKeyStateView {
  const current = metadata(
    row.current_key_generation,
    row.current_key_id,
    row.current_key_slot,
    row.current_key_fingerprint
  );
  if (!current) throw new Error('lookup_hmac_key_state_row_invalid');
  return {
    stateRevision: row.state_revision,
    rotationState: row.rotation_state,
    writeMode: row.write_mode,
    current,
    previous: metadata(
      row.previous_key_generation,
      row.previous_key_id,
      row.previous_key_slot,
      row.previous_key_fingerprint
    ),
    operationId: row.operation_id,
    updatedAt: row.updated_at,
  };
}

export class LookupHmacKeyStateService {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => number
  ) {}

  async initialize(
    environmentId: string,
    input: { current: ControlLookupHmacKeyMetadata }
  ): Promise<ControlLookupHmacKeyStateView> {
    if (!SAFE_ID.test(environmentId)) throw new Error('invalid_lookup_hmac_environment');
    const current = validateLookupHmacKeyMetadata(input.current);
    const environment = await this.database
      .prepare(`SELECT environment_id FROM control_environments WHERE environment_id = ?`)
      .bind(environmentId)
      .first<{ environment_id: string }>();
    if (!environment) throw new Error('control_environment_not_found');
    const existing = await this.get(environmentId);
    if (existing) {
      if (
        existing.rotationState !== 'stable' ||
        existing.writeMode !== 'current_only' ||
        existing.previous !== null ||
        existing.operationId !== null ||
        existing.current.generation !== current.generation ||
        existing.current.keyId !== current.keyId ||
        existing.current.slot !== current.slot ||
        existing.current.fingerprint !== current.fingerprint
      ) {
        throw new Error('lookup_hmac_key_state_initialization_conflict');
      }
      return existing;
    }
    const now = this.now();
    const inserted = await this.database
      .prepare(
        `INSERT OR IGNORE INTO control_lookup_hmac_key_states (
           environment_id, state_revision, rotation_state, write_mode,
           current_key_generation, current_key_id, current_key_slot,
           current_key_fingerprint, updated_at
         ) VALUES (?, 1, 'stable', 'current_only', ?, ?, ?, ?, ?)`
      )
      .bind(
        environmentId,
        current.generation,
        current.keyId,
        current.slot,
        current.fingerprint,
        now
      )
      .run();
    const created = await this.get(environmentId);
    if (!created) throw new Error('lookup_hmac_key_state_initialization_failed');
    if ((inserted.meta.changes ?? 0) !== 1) {
      if (
        created.current.generation !== current.generation ||
        created.current.keyId !== current.keyId ||
        created.current.slot !== current.slot ||
        created.current.fingerprint !== current.fingerprint
      ) {
        throw new Error('lookup_hmac_key_state_initialization_conflict');
      }
    }
    return created;
  }

  async get(environmentId: string): Promise<ControlLookupHmacKeyStateView | null> {
    const row = await this.database
      .prepare(
        `SELECT state_revision, rotation_state, write_mode, current_key_generation,
                current_key_id, current_key_slot, current_key_fingerprint,
                previous_key_generation, previous_key_id, previous_key_slot,
                previous_key_fingerprint, operation_id, updated_at
           FROM control_lookup_hmac_key_states WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<StateRow>();
    return row ? view(row) : null;
  }

  async getRotation(
    environmentId: string,
    operationIdValue: string
  ): Promise<ControlLookupHmacRotationView | null> {
    const operationId = boundedId(operationIdValue, 'invalid_lookup_hmac_operation');
    return this.rotationByOperation(environmentId, operationId);
  }

  async start(
    environmentId: string,
    input: ControlLookupHmacRotationStartRequest
  ): Promise<ControlLookupHmacRotationView> {
    const candidate = validateLookupHmacKeyMetadata(input.candidate);
    const idempotencyKey = boundedId(input.idempotencyKey, 'invalid_lookup_hmac_idempotency_key');
    const ownerId = boundedId(input.ownerId, 'invalid_lookup_hmac_owner');
    const operationId = `hmac-${(await sha256(`${environmentId}\0${idempotencyKey}`)).slice(0, 32)}`;
    const existing = await this.rotationByOperation(environmentId, operationId);
    if (existing) {
      if (!sameMetadata(existing.candidate, candidate)) {
        throw new Error('lookup_hmac_rotation_idempotency_conflict');
      }
      return this.resumeSetupTransition(environmentId, existing, ownerId);
    }
    const state = await this.get(environmentId);
    if (!state) throw new Error('lookup_hmac_key_state_not_found');
    if (
      state.rotationState !== 'stable' ||
      state.writeMode !== 'current_only' ||
      state.previous !== null ||
      state.operationId !== null
    ) {
      throw new Error('lookup_hmac_rotation_active');
    }
    if (
      candidate.generation !== state.current.generation + 1 ||
      candidate.keyId === state.current.keyId ||
      candidate.slot === state.current.slot ||
      candidate.fingerprint === state.current.fingerprint
    ) {
      throw new Error('invalid_lookup_hmac_rotation_candidate');
    }
    const now = this.now();
    const lease = await this.database
      .prepare(
        `SELECT operation_id, fencing_token, lease_expires_at, mutation_started
           FROM control_directory_rewrite_leases WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<{
        operation_id: string;
        fencing_token: number;
        lease_expires_at: number;
        mutation_started: number;
      }>();
    if (lease && (lease.mutation_started === 1 || lease.lease_expires_at > now)) {
      throw new Error('directory_rewrite_lease_active');
    }
    const fencingToken = nextDirectoryRewriteFencingToken({
      current: lease
        ? {
            operationId: lease.operation_id,
            fencingToken: lease.fencing_token,
            leaseExpiresAt: lease.lease_expires_at,
            mutationStarted: lease.mutation_started === 1,
          }
        : null,
      nextOperationId: operationId,
      now,
    });
    const results = await this.database.batch([
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, attempt_count, created_at, started_at, updated_at
           ) VALUES (?, ?, 'hmac_reindex', ?, 'running', 'admin', 1, ?, ?, ?)`
        )
        .bind(operationId, environmentId, idempotencyKey, now, now, now),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_hmac_rotation_operations (
             operation_id, environment_id, normalization_version,
             source_key_generation, source_key_id, source_key_slot, source_key_fingerprint,
             candidate_key_generation, candidate_key_id, candidate_key_slot,
             candidate_key_fingerprint, state, active_operation_key,
             authoritative_checkpoint_json, updated_at
           )
           SELECT ?, state.environment_id, 1,
                  state.current_key_generation, state.current_key_id, state.current_key_slot,
                  state.current_key_fingerprint, ?, ?, ?, ?, 'distributing', 'active', '{}', ?
             FROM control_lookup_hmac_key_states state
            WHERE state.environment_id = ? AND state.rotation_state = 'stable'
              AND state.write_mode = 'current_only' AND state.previous_key_generation IS NULL
              AND state.operation_id IS NULL`
        )
        .bind(
          operationId,
          candidate.generation,
          candidate.keyId,
          candidate.slot,
          candidate.fingerprint,
          now,
          environmentId
        ),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_directory_rewrite_leases (
             environment_id, operation_id, operation_kind, owner_id, fencing_token,
             checkpoint_json, lease_expires_at, mutation_started, updated_at
           )
           SELECT ?, ?, 'hmac_reindex', ?, ?, '{}', ?, 0, ?
            WHERE EXISTS (
              SELECT 1 FROM control_hmac_rotation_operations
               WHERE environment_id = ? AND operation_id = ? AND state = 'distributing'
            )`
        )
        .bind(
          environmentId,
          operationId,
          ownerId,
          fencingToken,
          now + SETUP_TRANSITION_LEASE_SECONDS,
          now,
          environmentId,
          operationId
        ),
      this.database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET operation_id = ?, operation_kind = 'hmac_reindex', owner_id = ?,
                  fencing_token = ?, checkpoint_json = '{}', lease_expires_at = ?,
                  mutation_started = 0, rollback_verified_at = NULL, updated_at = ?
            WHERE environment_id = ? AND operation_id <> ? AND mutation_started = 0
              AND lease_expires_at <= ?
              AND EXISTS (
                SELECT 1 FROM control_hmac_rotation_operations
                 WHERE environment_id = ? AND operation_id = ? AND state = 'distributing'
              )`
        )
        .bind(
          operationId,
          ownerId,
          fencingToken,
          now + SETUP_TRANSITION_LEASE_SECONDS,
          now,
          environmentId,
          operationId,
          now,
          environmentId,
          operationId
        ),
      this.database
        .prepare(
          `DELETE FROM control_hmac_rotation_operations
            WHERE environment_id = ? AND operation_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases
                 WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
                   AND fencing_token = ? AND lease_expires_at > ?
              )`
        )
        .bind(environmentId, operationId, environmentId, operationId, ownerId, fencingToken, now),
      this.database
        .prepare(
          `DELETE FROM control_operations
            WHERE environment_id = ? AND operation_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM control_hmac_rotation_operations
                 WHERE environment_id = ? AND operation_id = ?
              )`
        )
        .bind(environmentId, operationId, environmentId, operationId),
    ]);
    const insertedRotation = changes(results[1]);
    const acquiredLease = changes(results[2]) + changes(results[3]);
    if (insertedRotation !== 1 || acquiredLease !== 1) {
      throw new Error('directory_rewrite_lease_active');
    }
    return this.requiredRotation(environmentId, operationId);
  }

  async activate(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView> {
    return this.transitionWithKeyState(
      environmentId,
      input,
      'distributing',
      'activation_dual_write',
      'activation_dual_write',
      'dual_write',
      true
    );
  }

  async observeGeneration(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView> {
    await this.snapshotAuthoritativeSources(environmentId, input);
    return this.transitionWithKeyState(
      environmentId,
      input,
      'activation_dual_write',
      'dual_read',
      'dual_read',
      'current_only',
      true
    );
  }

  async claimNext(
    environmentId: string,
    ownerIdValue: string
  ): Promise<ControlLookupHmacRotationView | null> {
    const ownerId = boundedId(ownerIdValue, 'invalid_lookup_hmac_owner');
    const candidate = await this.database
      .prepare(
        `SELECT rotation.operation_id
           FROM control_hmac_rotation_operations rotation
           JOIN control_directory_rewrite_leases lease
             ON lease.environment_id = rotation.environment_id
            AND lease.operation_id = rotation.operation_id
          WHERE rotation.environment_id = ?
            AND rotation.state IN ('dual_read', 'reindexing', 'verifying', 'grace')
            AND (lease.owner_id = ? OR lease.lease_expires_at <= ?)
          ORDER BY rotation.updated_at, rotation.operation_id LIMIT 1`
      )
      .bind(environmentId, ownerId, this.now())
      .first<{ operation_id: string }>();
    if (!candidate) return null;
    const current = await this.requiredRotation(environmentId, candidate.operation_id);
    const now = this.now();
    if (
      current.ownerId === ownerId &&
      current.leaseExpiresAt !== null &&
      current.leaseExpiresAt > now
    ) {
      return current;
    }
    const nextToken = nextDirectoryRewriteFencingToken({
      current: {
        operationId: current.operationId,
        fencingToken: current.fencingToken,
        leaseExpiresAt: current.leaseExpiresAt ?? 0,
        mutationStarted: current.mutationStarted,
      },
      nextOperationId: current.operationId,
      now,
    });
    const leaseStatement = this.database
      .prepare(
        `UPDATE control_directory_rewrite_leases
              SET owner_id = ?, fencing_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND (owner_id = ? OR lease_expires_at <= ?)`
      )
      .bind(
        ownerId,
        nextToken,
        now + SCHEDULED_REWRITE_LEASE_SECONDS,
        now,
        environmentId,
        current.operationId,
        ownerId,
        now
      );
    const transitionStatements = ['dual_read', 'reindexing'].includes(current.state)
      ? [
          this.database
            .prepare(
              `UPDATE control_hmac_rotation_operations SET state = 'reindexing', updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state IN ('dual_read', 'reindexing')
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = ? AND lease.operation_id = ?
                   AND lease.owner_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ? AND lease.mutation_started = 1
              )`
            )
            .bind(
              now,
              environmentId,
              current.operationId,
              environmentId,
              current.operationId,
              ownerId,
              nextToken,
              now
            ),
          this.database
            .prepare(
              `UPDATE control_lookup_hmac_key_states
              SET rotation_state = 'reindexing', state_revision = state_revision + 1,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND rotation_state IN ('dual_read', 'reindexing')
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = ? AND lease.operation_id = ?
                   AND lease.owner_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ? AND lease.mutation_started = 1
              )`
            )
            .bind(
              now,
              environmentId,
              current.operationId,
              environmentId,
              current.operationId,
              ownerId,
              nextToken,
              now
            ),
        ]
      : [];
    const results = await this.database.batch([leaseStatement, ...transitionStatements]);
    if (results.some((item) => changes(item) !== 1)) {
      throw new Error('lookup_hmac_rotation_stale_lease');
    }
    return this.requiredRotation(environmentId, current.operationId);
  }

  async checkpoint(
    environmentId: string,
    input: ControlLookupHmacRotationCheckpointRequest
  ): Promise<ControlLookupHmacRotationView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const ownerId = boundedId(input.ownerId, 'invalid_lookup_hmac_owner');
    const fencingToken = positiveInteger(input.fencingToken, 'invalid_lookup_hmac_fencing_token');
    const sourceRowCount = nonNegativeInteger(
      input.sourceRowCount,
      'invalid_lookup_hmac_row_count'
    );
    const checkpoint = checkpointJson(input.checkpoint);
    const now = this.now();
    const existing = await this.requiredRotation(environmentId, operationId);
    if (JSON.stringify(existing.checkpoint) === checkpoint) {
      if (existing.sourceRowCount !== sourceRowCount) {
        throw new Error('lookup_hmac_rotation_checkpoint_conflict');
      }
      if (
        existing.state !== 'reindexing' ||
        existing.ownerId !== ownerId ||
        existing.fencingToken !== fencingToken ||
        existing.leaseExpiresAt === null ||
        existing.leaseExpiresAt <= now
      ) {
        throw new Error('lookup_hmac_rotation_stale_lease');
      }
      return existing;
    }
    if (existing.sourceRowCount !== null && sourceRowCount < existing.sourceRowCount) {
      throw new Error('lookup_hmac_rotation_checkpoint_regression');
    }
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_hmac_rotation_operations
              SET authoritative_checkpoint_json = ?,
                  source_row_count = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = 'reindexing'
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = ? AND lease.operation_id = ?
                   AND lease.owner_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ? AND lease.mutation_started = 1
              )`
        )
        .bind(
          checkpoint,
          sourceRowCount,
          now,
          environmentId,
          operationId,
          environmentId,
          operationId,
          ownerId,
          fencingToken,
          now
        ),
      this.database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET checkpoint_json = ?, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 1`
        )
        .bind(
          checkpoint,
          now + SCHEDULED_REWRITE_LEASE_SECONDS,
          now,
          environmentId,
          operationId,
          ownerId,
          fencingToken,
          now
        ),
    ]);
    if (results.some((item) => changes(item) !== 1)) {
      throw new Error('lookup_hmac_rotation_stale_lease');
    }
    return this.requiredRotation(environmentId, operationId);
  }

  async getNextSource(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationSourceShardView | null> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    await this.requireActiveLease(environmentId, input, 'reindexing');
    const row = await this.database
      .prepare(
        `SELECT operation_id, source_kind, data_role, shard_id, binding_ref,
                route_generation, cutoff_at, state, cursor_json, source_row_count,
                completed_at, updated_at
           FROM control_lookup_hmac_rotation_sources
          WHERE environment_id = ? AND operation_id = ?
            AND state IN ('pending', 'processing')
          ORDER BY CASE source_kind
                     WHEN 'account_id' THEN 1
                     WHEN 'email_exact' THEN 2
                     WHEN 'external_subject' THEN 3
                   END,
                   shard_id
          LIMIT 1`
      )
      .bind(environmentId, operationId)
      .first<RotationSourceRow>();
    return row ? rotationSourceView(row) : null;
  }

  async checkpointSource(
    environmentId: string,
    input: ControlLookupHmacRotationSourceCheckpointRequest
  ): Promise<ControlLookupHmacRotationSourceShardView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const ownerId = boundedId(input.ownerId, 'invalid_lookup_hmac_owner');
    const fencingToken = positiveInteger(input.fencingToken, 'invalid_lookup_hmac_fencing_token');
    const sourceKind = sourceKindValue(input.sourceKind);
    const shardId = boundedId(input.shardId, 'invalid_lookup_hmac_source_shard');
    const cursor = checkpointJson(input.cursor);
    const sourceRowCount = nonNegativeInteger(
      input.sourceRowCount,
      'invalid_lookup_hmac_row_count'
    );
    if (typeof input.complete !== 'boolean') {
      throw new Error('invalid_lookup_hmac_source_checkpoint');
    }
    const now = this.now();
    await this.requireActiveLease(environmentId, input, 'reindexing');
    const existing = await this.requiredSource(environmentId, operationId, sourceKind, shardId);
    const nextState = input.complete ? 'complete' : 'processing';
    if (
      existing.state === nextState &&
      JSON.stringify(existing.cursor) === cursor &&
      existing.sourceRowCount === sourceRowCount
    ) {
      return existing;
    }
    if (existing.state === 'complete') throw new Error('lookup_hmac_source_already_complete');
    if (sourceRowCount < existing.sourceRowCount) {
      throw new Error('lookup_hmac_rotation_checkpoint_regression');
    }
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_lookup_hmac_rotation_sources
              SET state = ?, cursor_json = ?, source_row_count = ?,
                  completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND source_kind = ? AND shard_id = ?
              AND state IN ('pending', 'processing')
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = ? AND lease.operation_id = ?
                   AND lease.owner_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ? AND lease.mutation_started = 1
              )`
        )
        .bind(
          nextState,
          cursor,
          sourceRowCount,
          input.complete ? 1 : 0,
          now,
          now,
          environmentId,
          operationId,
          sourceKind,
          shardId,
          environmentId,
          operationId,
          ownerId,
          fencingToken,
          now
        ),
      this.database
        .prepare(
          `UPDATE control_hmac_rotation_operations
              SET source_row_count = (
                    SELECT COALESCE(SUM(source.source_row_count), 0)
                      FROM control_lookup_hmac_rotation_sources source
                     WHERE source.environment_id = ? AND source.operation_id = ?
                  ),
                  authoritative_checkpoint_json = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = 'reindexing'`
        )
        .bind(
          environmentId,
          operationId,
          JSON.stringify({ sourceKind, shardId }),
          now,
          environmentId,
          operationId
        ),
      this.database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET checkpoint_json = ?, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 1`
        )
        .bind(
          JSON.stringify({ sourceKind, shardId }),
          now + SCHEDULED_REWRITE_LEASE_SECONDS,
          now,
          environmentId,
          operationId,
          ownerId,
          fencingToken,
          now
        ),
    ]);
    if (results.some((item) => changes(item) !== 1)) {
      throw new Error('lookup_hmac_rotation_stale_lease');
    }
    return this.requiredSource(environmentId, operationId, sourceKind, shardId);
  }

  async beginVerification(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const existing = await this.requiredRotation(environmentId, operationId);
    if (existing.state === 'verifying') {
      await this.requireActiveLease(environmentId, input, 'verifying');
      return existing;
    }
    await this.requireActiveLease(environmentId, input, 'reindexing');
    const incomplete = await this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM control_lookup_hmac_rotation_sources
          WHERE environment_id = ? AND operation_id = ? AND state <> 'complete'`
      )
      .bind(environmentId, operationId)
      .first<{ count: number }>();
    if (
      !incomplete ||
      nonNegativeInteger(incomplete.count, 'lookup_hmac_source_count_invalid') > 0
    ) {
      throw new Error('lookup_hmac_sources_incomplete');
    }
    const now = this.now();
    await this.database
      .prepare(
        `INSERT OR IGNORE INTO control_lookup_hmac_rotation_verification_shards (
           operation_id, environment_id, lookup_shard_id, binding_ref, state,
           cursor_json, current_row_count, current_rows_valid, reservations_valid,
           route_references_valid, updated_at
         )
         SELECT ?, environment_id, lookup_shard_id, binding_ref, 'pending', '{}', 0, 1, 1, 1, ?
           FROM control_lookup_physical_shards
          WHERE environment_id = ? AND status = 'active'`
      )
      .bind(operationId, now, environmentId)
      .run();
    const verificationShards = await this.database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM control_lookup_hmac_rotation_verification_shards
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(environmentId, operationId)
      .first<{ count: number }>();
    if (
      !verificationShards ||
      nonNegativeInteger(verificationShards.count, 'lookup_hmac_verification_shard_count_invalid') <
        1
    ) {
      throw new Error('lookup_hmac_verification_shards_unavailable');
    }
    return this.transitionWithKeyState(
      environmentId,
      input,
      'reindexing',
      'verifying',
      'verifying',
      'current_only',
      true,
      SCHEDULED_REWRITE_LEASE_SECONDS
    );
  }

  async getNextVerificationShard(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationVerificationShardView | null> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    await this.requireActiveLease(environmentId, input, 'verifying');
    const row = await this.database
      .prepare(
        `SELECT operation_id, lookup_shard_id, binding_ref, state, cursor_json,
                current_row_count, current_rows_valid, reservations_valid,
                route_references_valid, completed_at, updated_at
           FROM control_lookup_hmac_rotation_verification_shards
          WHERE environment_id = ? AND operation_id = ?
            AND state IN ('pending', 'processing')
          ORDER BY lookup_shard_id LIMIT 1`
      )
      .bind(environmentId, operationId)
      .first<RotationVerificationShardRow>();
    return row ? rotationVerificationShardView(row) : null;
  }

  async checkpointVerificationShard(
    environmentId: string,
    input: ControlLookupHmacRotationVerificationShardCheckpointRequest
  ): Promise<ControlLookupHmacRotationVerificationShardView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const lookupShardId = boundedId(input.lookupShardId, 'invalid_lookup_hmac_verification_shard');
    const encodedCursor = checkpointJson(input.cursor);
    const currentRowCount = nonNegativeInteger(
      input.currentRowCount,
      'invalid_lookup_hmac_current_row_count'
    );
    const result = verificationShardResult(input.result);
    if (typeof input.complete !== 'boolean') {
      throw new Error('invalid_lookup_hmac_verification_checkpoint');
    }
    await this.requireActiveLease(environmentId, input, 'verifying');
    const existing = await this.requiredVerificationShard(
      environmentId,
      operationId,
      lookupShardId
    );
    const nextState = input.complete ? 'complete' : 'processing';
    if (
      existing.state === nextState &&
      JSON.stringify(existing.cursor) === encodedCursor &&
      existing.currentRowCount === currentRowCount &&
      existing.currentRowsValid === result.currentRowsValid &&
      existing.reservationsValid === result.reservationsValid &&
      existing.routeReferencesValid === result.routeReferencesValid
    ) {
      return existing;
    }
    if (existing.state === 'complete') {
      throw new Error('lookup_hmac_verification_shard_already_complete');
    }
    if (currentRowCount < existing.currentRowCount) {
      throw new Error('lookup_hmac_rotation_checkpoint_regression');
    }
    const now = this.now();
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_lookup_hmac_rotation_verification_shards
              SET state = ?, cursor_json = ?, current_row_count = ?,
                  current_rows_valid = ?, reservations_valid = ?, route_references_valid = ?,
                  completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND lookup_shard_id = ?
              AND state IN ('pending', 'processing')
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = ? AND lease.operation_id = ?
                   AND lease.owner_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ? AND lease.mutation_started = 1
              )`
        )
        .bind(
          nextState,
          encodedCursor,
          currentRowCount,
          result.currentRowsValid ? 1 : 0,
          result.reservationsValid ? 1 : 0,
          result.routeReferencesValid ? 1 : 0,
          input.complete ? 1 : 0,
          now,
          now,
          environmentId,
          operationId,
          lookupShardId,
          environmentId,
          operationId,
          input.ownerId,
          input.fencingToken,
          now
        ),
      this.database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET checkpoint_json = ?, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 1`
        )
        .bind(
          JSON.stringify({ verificationShardId: lookupShardId }),
          now + SCHEDULED_REWRITE_LEASE_SECONDS,
          now,
          environmentId,
          operationId,
          input.ownerId,
          input.fencingToken,
          now
        ),
    ]);
    if (results.some((item) => changes(item) !== 1)) {
      throw new Error('lookup_hmac_rotation_stale_lease');
    }
    return this.requiredVerificationShard(environmentId, operationId, lookupShardId);
  }

  async recordVerification(
    environmentId: string,
    input: ControlLookupHmacRotationVerificationRequest
  ): Promise<ControlLookupHmacRotationView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const currentRowCount = nonNegativeInteger(
      input.currentRowCount,
      'invalid_lookup_hmac_current_row_count'
    );
    const result = verificationResult(input.result);
    const existing = await this.requiredRotation(environmentId, operationId);
    await this.requireActiveLease(environmentId, input, 'verifying');
    const aggregate = await this.database
      .prepare(
        `SELECT COUNT(*) AS shard_count,
                SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS complete_count,
                COALESCE(SUM(current_row_count), 0) AS current_row_count,
                MIN(current_rows_valid) AS current_rows_valid,
                MIN(reservations_valid) AS reservations_valid,
                MIN(route_references_valid) AS route_references_valid
           FROM control_lookup_hmac_rotation_verification_shards
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(environmentId, operationId)
      .first<{
        shard_count: number;
        complete_count: number;
        current_row_count: number;
        current_rows_valid: number | null;
        reservations_valid: number | null;
        route_references_valid: number | null;
      }>();
    if (
      !aggregate ||
      nonNegativeInteger(aggregate.shard_count, 'lookup_hmac_verification_invalid') < 1
    ) {
      throw new Error('lookup_hmac_verification_shards_unavailable');
    }
    const authoritativeResult = {
      sourceShardsComplete: aggregate.complete_count === aggregate.shard_count,
      currentRowsValid: aggregate.current_rows_valid === 1,
      reservationsValid: aggregate.reservations_valid === 1,
      routeReferencesValid: aggregate.route_references_valid === 1,
    };
    if (
      currentRowCount !== aggregate.current_row_count ||
      Object.keys(authoritativeResult).some(
        (key) =>
          result[key as keyof typeof result] !==
          authoritativeResult[key as keyof typeof authoritativeResult]
      )
    ) {
      throw new Error('lookup_hmac_verification_evidence_mismatch');
    }
    const sourceRowCount = existing.sourceRowCount ?? 0;
    const passed =
      Object.values(result).every((value) => value) && currentRowCount >= sourceRowCount;
    const attempt = existing.verificationAttemptCount + 1;
    if (attempt > 3) throw new Error('lookup_hmac_verification_attempt_limit');
    const now = this.now();
    const nextState = passed ? 'grace' : attempt >= 3 ? 'blocked' : 'reindexing';
    const graceExpiresAt = passed ? now + 7 * 24 * 60 * 60 : null;
    const statements = [
      this.database
        .prepare(
          `UPDATE control_hmac_rotation_operations
              SET state = ?, active_operation_key = CASE WHEN ? = 'blocked'
                    THEN 'operation:' || operation_id ELSE 'active' END,
                  current_row_count = ?, verification_result_json = ?,
                  verification_attempt_count = ?, grace_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = 'verifying'`
        )
        .bind(
          nextState,
          nextState,
          currentRowCount,
          JSON.stringify(result),
          attempt,
          graceExpiresAt,
          now,
          environmentId,
          operationId
        ),
      this.database
        .prepare(
          `UPDATE control_lookup_hmac_key_states
              SET rotation_state = ?, state_revision = state_revision + 1, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND rotation_state = 'verifying'`
        )
        .bind(nextState, now, environmentId, operationId),
      this.database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 1`
        )
        .bind(
          now + SCHEDULED_REWRITE_LEASE_SECONDS,
          now,
          environmentId,
          operationId,
          input.ownerId,
          input.fencingToken,
          now
        ),
    ];
    if (!passed && attempt < 3) {
      statements.push(
        this.database
          .prepare(
            `UPDATE control_lookup_hmac_rotation_sources
                SET state = 'pending', cursor_json = '{}', source_row_count = 0,
                    completed_at = NULL, updated_at = ?
              WHERE environment_id = ? AND operation_id = ?`
          )
          .bind(now, environmentId, operationId),
        this.database
          .prepare(
            `DELETE FROM control_lookup_hmac_rotation_verification_shards
              WHERE environment_id = ? AND operation_id = ?`
          )
          .bind(environmentId, operationId)
      );
    }
    const results = await this.database.batch(statements);
    if (results.slice(0, 3).some((item) => changes(item) !== 1)) {
      throw new Error('lookup_hmac_rotation_stale_lease');
    }
    return this.requiredRotation(environmentId, operationId);
  }

  async finalizeVerification(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    await this.requireActiveLease(environmentId, input, 'verifying');
    const aggregate = await this.verificationAggregate(environmentId, operationId);
    return this.recordVerification(environmentId, {
      ...input,
      currentRowCount: aggregate.currentRowCount,
      result: aggregate.result,
    });
  }

  async completeGrace(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const existing = await this.requiredRotation(environmentId, operationId);
    if (existing.state === 'complete') {
      const keyState = await this.get(environmentId);
      if (
        !keyState ||
        keyState.rotationState !== 'stable' ||
        keyState.writeMode !== 'current_only' ||
        keyState.previous !== null ||
        keyState.operationId !== null ||
        !sameMetadata(keyState.current, existing.candidate)
      ) {
        throw new Error('lookup_hmac_rotation_completion_inconsistent');
      }
      return existing;
    }
    await this.requireActiveLease(environmentId, input, 'grace');
    const now = this.now();
    if (existing.graceExpiresAt === null || existing.graceExpiresAt > now) {
      throw new Error('lookup_hmac_grace_not_elapsed');
    }
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_hmac_rotation_operations
              SET state = 'complete', active_operation_key = 'operation:' || operation_id,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = 'grace'`
        )
        .bind(now, environmentId, operationId),
      this.database
        .prepare(
          `UPDATE control_lookup_hmac_key_states
              SET state_revision = state_revision + 1, rotation_state = 'stable',
                  write_mode = 'current_only', previous_key_generation = NULL,
                  previous_key_id = NULL, previous_key_slot = NULL,
                  previous_key_fingerprint = NULL, operation_id = NULL, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND rotation_state = 'grace'`
        )
        .bind(now, environmentId, operationId),
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = 'succeeded', completed_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND status = 'running'`
        )
        .bind(now, now, environmentId, operationId),
      this.database
        .prepare(
          `DELETE FROM control_directory_rewrite_leases
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 1`
        )
        .bind(environmentId, operationId, input.ownerId, input.fencingToken, now),
    ]);
    if (results.some((item) => changes(item) !== 1)) {
      throw new Error('lookup_hmac_rotation_stale_lease');
    }
    return this.requiredRotation(environmentId, operationId);
  }

  private async snapshotAuthoritativeSources(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<void> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const ownerId = boundedId(input.ownerId, 'invalid_lookup_hmac_owner');
    const fencingToken = positiveInteger(input.fencingToken, 'invalid_lookup_hmac_fencing_token');
    const now = this.now();
    const operation = await this.requiredRotation(environmentId, operationId);
    if (!['activation_dual_write', 'dual_read'].includes(operation.state)) {
      throw new Error('lookup_hmac_rotation_state_conflict');
    }
    const sourceStatements = [
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_lookup_hmac_rotation_sources (
             operation_id, environment_id, source_kind, data_role, shard_id,
             binding_ref, route_generation, cutoff_at, state, cursor_json, source_row_count, updated_at
           )
           SELECT ?, environment_id, 'account_id', data_role, shard_id,
                  binding_ref, generation, ?, 'pending', '{}', 0, ?
             FROM control_tenant_shards
            WHERE environment_id = ? AND data_role = 'tenant_core/users' AND status = 'active'`
        )
        .bind(operationId, now * 1000, now, environmentId),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_lookup_hmac_rotation_sources (
             operation_id, environment_id, source_kind, data_role, shard_id,
             binding_ref, route_generation, cutoff_at, state, cursor_json, source_row_count, updated_at
           )
           SELECT ?, environment_id, 'external_subject', data_role, shard_id,
                  binding_ref, generation, ?, 'pending', '{}', 0, ?
             FROM control_tenant_shards
            WHERE environment_id = ? AND data_role = 'tenant_core/users' AND status = 'active'`
        )
        .bind(operationId, now * 1000, now, environmentId),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_lookup_hmac_rotation_sources (
             operation_id, environment_id, source_kind, data_role, shard_id,
             binding_ref, route_generation, cutoff_at, state, cursor_json, source_row_count, updated_at
           )
           SELECT ?, environment_id, 'email_exact', data_role, shard_id,
                  binding_ref, generation, ?, 'pending', '{}', 0, ?
             FROM control_tenant_shards
            WHERE environment_id = ? AND data_role = 'tenant_pii' AND status = 'active'`
        )
        .bind(operationId, now * 1000, now, environmentId),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_lookup_hmac_rotation_sources (
             operation_id, environment_id, source_kind, data_role, shard_id,
             binding_ref, route_generation, cutoff_at, state, cursor_json, source_row_count, updated_at
           )
           SELECT ?, environment_id, 'external_subject', data_role, shard_id,
                  binding_ref, generation, ?, 'pending', '{}', 0, ?
             FROM control_tenant_shards
            WHERE environment_id = ? AND data_role = 'tenant_pii' AND status = 'active'`
        )
        .bind(operationId, now * 1000, now, environmentId),
    ];
    const results =
      operation.state === 'activation_dual_write'
        ? await this.database.batch(sourceStatements)
        : [];
    if (results.some((result) => changes(result) < 0)) {
      throw new Error('lookup_hmac_source_snapshot_failed');
    }
    const drift = await this.database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM control_lookup_hmac_rotation_sources source
           LEFT JOIN control_tenant_shards shard
             ON shard.environment_id = source.environment_id
            AND shard.shard_id = source.shard_id
          WHERE source.environment_id = ? AND source.operation_id = ?
            AND (shard.shard_id IS NULL OR shard.status <> 'active'
              OR shard.binding_ref <> source.binding_ref
              OR shard.generation <> source.route_generation
              OR shard.data_role <> source.data_role)`
      )
      .bind(environmentId, operationId)
      .first<{ count: number }>();
    if (!drift || nonNegativeInteger(drift.count, 'lookup_hmac_source_snapshot_invalid') !== 0) {
      throw new Error('lookup_hmac_source_snapshot_drift');
    }
    const lease = await this.database
      .prepare(
        `SELECT operation_id FROM control_directory_rewrite_leases
          WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
            AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 1`
      )
      .bind(environmentId, operationId, ownerId, fencingToken, now)
      .first<{ operation_id: string }>();
    if (!lease) throw new Error('lookup_hmac_rotation_stale_lease');
  }

  private async requireActiveLease(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest,
    expectedState: ControlLookupHmacRotationView['state']
  ): Promise<void> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const ownerId = boundedId(input.ownerId, 'invalid_lookup_hmac_owner');
    const fencingToken = positiveInteger(input.fencingToken, 'invalid_lookup_hmac_fencing_token');
    const row = await this.database
      .prepare(
        `SELECT rotation.operation_id
           FROM control_hmac_rotation_operations rotation
           JOIN control_directory_rewrite_leases lease
             ON lease.environment_id = rotation.environment_id
            AND lease.operation_id = rotation.operation_id
          WHERE rotation.environment_id = ? AND rotation.operation_id = ? AND rotation.state = ?
            AND lease.owner_id = ? AND lease.fencing_token = ?
            AND lease.lease_expires_at > ? AND lease.mutation_started = 1`
      )
      .bind(environmentId, operationId, expectedState, ownerId, fencingToken, this.now())
      .first<{ operation_id: string }>();
    if (!row) throw new Error('lookup_hmac_rotation_stale_lease');
  }

  private async requiredSource(
    environmentId: string,
    operationId: string,
    sourceKind: ControlLookupHmacRotationSourceKind,
    shardId: string
  ): Promise<ControlLookupHmacRotationSourceShardView> {
    const row = await this.database
      .prepare(
        `SELECT operation_id, source_kind, data_role, shard_id, binding_ref,
                route_generation, cutoff_at, state, cursor_json, source_row_count,
                completed_at, updated_at
           FROM control_lookup_hmac_rotation_sources
          WHERE environment_id = ? AND operation_id = ? AND source_kind = ? AND shard_id = ?`
      )
      .bind(environmentId, operationId, sourceKind, shardId)
      .first<RotationSourceRow>();
    if (!row) throw new Error('lookup_hmac_rotation_source_not_found');
    return rotationSourceView(row);
  }

  private async requiredVerificationShard(
    environmentId: string,
    operationId: string,
    lookupShardId: string
  ): Promise<ControlLookupHmacRotationVerificationShardView> {
    const row = await this.database
      .prepare(
        `SELECT operation_id, lookup_shard_id, binding_ref, state, cursor_json,
                current_row_count, current_rows_valid, reservations_valid,
                route_references_valid, completed_at, updated_at
           FROM control_lookup_hmac_rotation_verification_shards
          WHERE environment_id = ? AND operation_id = ? AND lookup_shard_id = ?`
      )
      .bind(environmentId, operationId, lookupShardId)
      .first<RotationVerificationShardRow>();
    if (!row) throw new Error('lookup_hmac_verification_shard_not_found');
    return rotationVerificationShardView(row);
  }

  private async verificationAggregate(
    environmentId: string,
    operationId: string
  ): Promise<{
    currentRowCount: number;
    result: ControlLookupHmacRotationVerificationRequest['result'];
  }> {
    const aggregate = await this.database
      .prepare(
        `SELECT COUNT(*) AS shard_count,
                SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS complete_count,
                COALESCE(SUM(current_row_count), 0) AS current_row_count,
                MIN(current_rows_valid) AS current_rows_valid,
                MIN(reservations_valid) AS reservations_valid,
                MIN(route_references_valid) AS route_references_valid
           FROM control_lookup_hmac_rotation_verification_shards
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(environmentId, operationId)
      .first<{
        shard_count: number;
        complete_count: number;
        current_row_count: number;
        current_rows_valid: number | null;
        reservations_valid: number | null;
        route_references_valid: number | null;
      }>();
    if (
      !aggregate ||
      nonNegativeInteger(aggregate.shard_count, 'lookup_hmac_verification_invalid') < 1
    ) {
      throw new Error('lookup_hmac_verification_shards_unavailable');
    }
    return {
      currentRowCount: nonNegativeInteger(
        aggregate.current_row_count,
        'lookup_hmac_verification_row_count_invalid'
      ),
      result: {
        sourceShardsComplete: aggregate.complete_count === aggregate.shard_count,
        currentRowsValid: aggregate.current_rows_valid === 1,
        reservationsValid: aggregate.reservations_valid === 1,
        routeReferencesValid: aggregate.route_references_valid === 1,
      },
    };
  }

  private async transitionWithKeyState(
    environmentId: string,
    input: ControlLookupHmacRotationMutationRequest,
    expectedState: ControlLookupHmacRotationView['state'],
    nextState: ControlLookupHmacRotationView['state'],
    keyRotationState: ControlLookupHmacKeyStateView['rotationState'],
    writeMode: ControlLookupHmacKeyStateView['writeMode'],
    mutationStarted: boolean,
    leaseSeconds = SETUP_TRANSITION_LEASE_SECONDS
  ): Promise<ControlLookupHmacRotationView> {
    const operationId = boundedId(input.operationId, 'invalid_lookup_hmac_operation');
    const ownerId = boundedId(input.ownerId, 'invalid_lookup_hmac_owner');
    const fencingToken = positiveInteger(input.fencingToken, 'invalid_lookup_hmac_fencing_token');
    const now = this.now();
    const existing = await this.requiredRotation(environmentId, operationId);
    if (existing.state === nextState) {
      if (
        existing.ownerId !== ownerId ||
        existing.fencingToken !== fencingToken ||
        existing.leaseExpiresAt === null ||
        existing.leaseExpiresAt <= now
      ) {
        throw new Error('lookup_hmac_rotation_stale_lease');
      }
      return existing;
    }
    if (existing.state !== expectedState) {
      throw new Error('lookup_hmac_rotation_state_conflict');
    }
    const verificationPhase =
      expectedState === 'distributing'
        ? 'distribution'
        : expectedState === 'activation_dual_write'
          ? 'generation'
          : null;
    const verificationGate = verificationPhase
      ? candidateVerificationGate(environmentId, operationId, verificationPhase)
      : null;
    if (verificationGate) {
      const verified = await this.database
        .prepare(`SELECT 1 AS ready WHERE 1 = 1 ${verificationGate.sql}`)
        .bind(...verificationGate.params)
        .first<{ ready: number }>();
      if (verified?.ready !== 1) {
        throw new Error(
          verificationPhase === 'distribution'
            ? 'lookup_hmac_candidate_verification_incomplete'
            : 'lookup_hmac_generation_observation_incomplete'
        );
      }
    }
    const atomicVerificationGate = verificationGate?.sql ?? '';
    const atomicVerificationParams = verificationGate?.params ?? [];
    const expectedMutationStarted = expectedState === 'distributing' ? 0 : 1;
    const keyStateStatement =
      expectedState === 'distributing'
        ? this.database
            .prepare(
              `UPDATE control_lookup_hmac_key_states
                  SET state_revision = state_revision + 1, rotation_state = ?, write_mode = ?,
                      previous_key_generation = current_key_generation,
                      previous_key_id = current_key_id, previous_key_slot = current_key_slot,
                      previous_key_fingerprint = current_key_fingerprint,
                      current_key_generation = (
                        SELECT candidate_key_generation FROM control_hmac_rotation_operations
                         WHERE environment_id = ? AND operation_id = ? AND state = ?
                      ),
                      current_key_id = (
                        SELECT candidate_key_id FROM control_hmac_rotation_operations
                         WHERE environment_id = ? AND operation_id = ? AND state = ?
                      ),
                      current_key_slot = (
                        SELECT candidate_key_slot FROM control_hmac_rotation_operations
                         WHERE environment_id = ? AND operation_id = ? AND state = ?
                      ),
                      current_key_fingerprint = (
                        SELECT candidate_key_fingerprint FROM control_hmac_rotation_operations
                         WHERE environment_id = ? AND operation_id = ? AND state = ?
                      ),
                      operation_id = ?, updated_at = ?
                WHERE environment_id = ? AND rotation_state = 'stable' AND operation_id IS NULL
                  AND EXISTS (
                    SELECT 1 FROM control_directory_rewrite_leases lease
                     WHERE lease.environment_id = ? AND lease.operation_id = ?
                       AND lease.owner_id = ? AND lease.fencing_token = ?
                       AND lease.lease_expires_at > ? AND lease.mutation_started = 0
                  )
                  ${atomicVerificationGate}`
            )
            .bind(
              keyRotationState,
              writeMode,
              environmentId,
              operationId,
              expectedState,
              environmentId,
              operationId,
              expectedState,
              environmentId,
              operationId,
              expectedState,
              environmentId,
              operationId,
              expectedState,
              operationId,
              now,
              environmentId,
              environmentId,
              operationId,
              ownerId,
              fencingToken,
              now,
              ...atomicVerificationParams
            )
        : this.database
            .prepare(
              `UPDATE control_lookup_hmac_key_states
                  SET state_revision = state_revision + 1, rotation_state = ?, write_mode = ?,
                      updated_at = ?
                WHERE environment_id = ? AND operation_id = ? AND rotation_state = ?
                  AND EXISTS (
                    SELECT 1 FROM control_directory_rewrite_leases lease
                     WHERE lease.environment_id = ? AND lease.operation_id = ?
                       AND lease.owner_id = ? AND lease.fencing_token = ?
                       AND lease.lease_expires_at > ? AND lease.mutation_started = 1
                  )`
            )
            .bind(
              keyRotationState,
              writeMode,
              now,
              environmentId,
              operationId,
              expectedState,
              environmentId,
              operationId,
              ownerId,
              fencingToken,
              now
            );
    const results = await this.database.batch([
      keyStateStatement,
      this.database
        .prepare(
          `UPDATE control_hmac_rotation_operations SET state = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND state = ?
              AND EXISTS (
                SELECT 1 FROM control_directory_rewrite_leases lease
                 WHERE lease.environment_id = ? AND lease.operation_id = ?
                   AND lease.owner_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ? AND lease.mutation_started = ?
              )
              ${atomicVerificationGate}`
        )
        .bind(
          nextState,
          now,
          environmentId,
          operationId,
          expectedState,
          environmentId,
          operationId,
          ownerId,
          fencingToken,
          now,
          expectedMutationStarted,
          ...atomicVerificationParams
        ),
      this.database
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET mutation_started = ?, lease_expires_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND owner_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = ?` +
            atomicVerificationGate
        )
        .bind(
          mutationStarted ? 1 : 0,
          now + leaseSeconds,
          now,
          environmentId,
          operationId,
          ownerId,
          fencingToken,
          now,
          expectedMutationStarted,
          ...atomicVerificationParams
        ),
    ]);
    if (results.some((item) => changes(item) !== 1)) {
      throw new Error('lookup_hmac_rotation_stale_lease');
    }
    return this.requiredRotation(environmentId, operationId);
  }

  private async resumeSetupTransition(
    environmentId: string,
    existing: ControlLookupHmacRotationView,
    ownerId: string
  ): Promise<ControlLookupHmacRotationView> {
    if (existing.state !== 'distributing' && existing.state !== 'activation_dual_write') {
      return existing;
    }
    const now = this.now();
    if (existing.leaseExpiresAt !== null && existing.leaseExpiresAt > now) {
      if (existing.ownerId !== ownerId) throw new Error('directory_rewrite_lease_active');
      return existing;
    }
    const fencingToken = nextDirectoryRewriteFencingToken({
      current: {
        operationId: existing.operationId,
        fencingToken: existing.fencingToken,
        leaseExpiresAt: existing.leaseExpiresAt ?? 0,
        mutationStarted: existing.mutationStarted,
      },
      nextOperationId: existing.operationId,
      now,
    });
    const updated = await this.database
      .prepare(
        `UPDATE control_directory_rewrite_leases
            SET owner_id = ?, fencing_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE environment_id = ? AND operation_id = ? AND fencing_token = ?
            AND lease_expires_at <= ? AND mutation_started = ?
            AND EXISTS (
              SELECT 1 FROM control_hmac_rotation_operations rotation
               WHERE rotation.environment_id = ? AND rotation.operation_id = ?
                 AND rotation.state IN ('distributing', 'activation_dual_write')
            )`
      )
      .bind(
        ownerId,
        fencingToken,
        now + SETUP_TRANSITION_LEASE_SECONDS,
        now,
        environmentId,
        existing.operationId,
        existing.fencingToken,
        now,
        existing.mutationStarted ? 1 : 0,
        environmentId,
        existing.operationId
      )
      .run();
    if (changes(updated) !== 1) {
      const refreshed = await this.requiredRotation(environmentId, existing.operationId);
      if (
        refreshed.ownerId === ownerId &&
        refreshed.leaseExpiresAt !== null &&
        refreshed.leaseExpiresAt > now
      ) {
        return refreshed;
      }
      throw new Error('directory_rewrite_lease_active');
    }
    return this.requiredRotation(environmentId, existing.operationId);
  }

  private async rotationByOperation(
    environmentId: string,
    operationId: string
  ): Promise<ControlLookupHmacRotationView | null> {
    const row = await this.database
      .prepare(
        `SELECT rotation.operation_id, rotation.state,
                rotation.source_key_generation, rotation.source_key_id,
                rotation.source_key_slot, rotation.source_key_fingerprint,
                rotation.candidate_key_generation, rotation.candidate_key_id,
                rotation.candidate_key_slot, rotation.candidate_key_fingerprint,
                rotation.authoritative_checkpoint_json, rotation.source_row_count,
                rotation.current_row_count, rotation.verification_attempt_count,
                rotation.grace_expires_at, rotation.updated_at,
                lease.owner_id, lease.fencing_token, lease.lease_expires_at,
                lease.mutation_started
           FROM control_hmac_rotation_operations rotation
           LEFT JOIN control_directory_rewrite_leases lease
             ON lease.environment_id = rotation.environment_id
            AND lease.operation_id = rotation.operation_id
          WHERE rotation.environment_id = ? AND rotation.operation_id = ?`
      )
      .bind(environmentId, operationId)
      .first<RotationRow>();
    return row ? rotationView(row) : null;
  }

  private async requiredRotation(
    environmentId: string,
    operationId: string
  ): Promise<ControlLookupHmacRotationView> {
    const result = await this.rotationByOperation(environmentId, operationId);
    if (!result) throw new Error('lookup_hmac_rotation_not_found');
    return result;
  }
}

function changes(result: D1Result<unknown>): number {
  const value = result.meta.changes ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('lookup_hmac_result_invalid');
  return value;
}

function boundedId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code);
  return value as number;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function checkpointJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_lookup_hmac_checkpoint');
  }
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_CHECKPOINT_BYTES) {
    throw new Error('invalid_lookup_hmac_checkpoint');
  }
  return encoded;
}

function sourceKindValue(value: unknown): ControlLookupHmacRotationSourceKind {
  if (value !== 'account_id' && value !== 'email_exact' && value !== 'external_subject') {
    throw new Error('invalid_lookup_hmac_source_kind');
  }
  return value;
}

function verificationResult(
  value: unknown
): ControlLookupHmacRotationVerificationRequest['result'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_lookup_hmac_verification_result');
  }
  const row = value as Record<string, unknown>;
  const keys = [
    'sourceShardsComplete',
    'currentRowsValid',
    'reservationsValid',
    'routeReferencesValid',
  ] as const;
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key as (typeof keys)[number])) ||
    keys.some((key) => typeof row[key] !== 'boolean')
  ) {
    throw new Error('invalid_lookup_hmac_verification_result');
  }
  return {
    sourceShardsComplete: row.sourceShardsComplete as boolean,
    currentRowsValid: row.currentRowsValid as boolean,
    reservationsValid: row.reservationsValid as boolean,
    routeReferencesValid: row.routeReferencesValid as boolean,
  };
}

function verificationShardResult(
  value: unknown
): ControlLookupHmacRotationVerificationShardCheckpointRequest['result'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_lookup_hmac_verification_result');
  }
  const row = value as Record<string, unknown>;
  const keys = ['currentRowsValid', 'reservationsValid', 'routeReferencesValid'] as const;
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key as (typeof keys)[number])) ||
    keys.some((key) => typeof row[key] !== 'boolean')
  ) {
    throw new Error('invalid_lookup_hmac_verification_result');
  }
  return {
    currentRowsValid: row.currentRowsValid as boolean,
    reservationsValid: row.reservationsValid as boolean,
    routeReferencesValid: row.routeReferencesValid as boolean,
  };
}

function rotationSourceView(row: RotationSourceRow): ControlLookupHmacRotationSourceShardView {
  let cursor: unknown;
  try {
    cursor = JSON.parse(row.cursor_json) as unknown;
  } catch {
    throw new Error('lookup_hmac_source_cursor_invalid');
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new Error('lookup_hmac_source_cursor_invalid');
  }
  return {
    operationId: boundedId(row.operation_id, 'lookup_hmac_source_operation_invalid'),
    sourceKind: sourceKindValue(row.source_kind),
    dataRole: row.data_role,
    shardId: boundedId(row.shard_id, 'lookup_hmac_source_shard_invalid'),
    bindingRef: bindingRefValue(row.binding_ref),
    routeGeneration: positiveInteger(
      row.route_generation,
      'lookup_hmac_source_route_generation_invalid'
    ),
    cutoffAt: positiveInteger(row.cutoff_at, 'lookup_hmac_source_cutoff_invalid'),
    state: row.state,
    cursor: cursor as Record<string, unknown>,
    sourceRowCount: nonNegativeInteger(
      row.source_row_count,
      'lookup_hmac_source_row_count_invalid'
    ),
    completedAt: row.completed_at,
    updatedAt: nonNegativeInteger(row.updated_at, 'lookup_hmac_source_updated_at_invalid'),
  };
}

function rotationVerificationShardView(
  row: RotationVerificationShardRow
): ControlLookupHmacRotationVerificationShardView {
  let cursor: unknown;
  try {
    cursor = JSON.parse(row.cursor_json) as unknown;
  } catch {
    throw new Error('lookup_hmac_verification_cursor_invalid');
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new Error('lookup_hmac_verification_cursor_invalid');
  }
  if (
    ![row.current_rows_valid, row.reservations_valid, row.route_references_valid].every(
      (value) => value === 0 || value === 1
    )
  ) {
    throw new Error('lookup_hmac_verification_result_invalid');
  }
  return {
    operationId: boundedId(row.operation_id, 'lookup_hmac_verification_operation_invalid'),
    lookupShardId: boundedId(row.lookup_shard_id, 'lookup_hmac_verification_shard_invalid'),
    bindingRef: bindingRefValue(row.binding_ref),
    state: row.state,
    cursor: cursor as Record<string, unknown>,
    currentRowCount: nonNegativeInteger(
      row.current_row_count,
      'lookup_hmac_verification_row_count_invalid'
    ),
    currentRowsValid: row.current_rows_valid === 1,
    reservationsValid: row.reservations_valid === 1,
    routeReferencesValid: row.route_references_valid === 1,
    completedAt: row.completed_at,
    updatedAt: nonNegativeInteger(row.updated_at, 'lookup_hmac_verification_updated_at_invalid'),
  };
}

function bindingRefValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new Error('lookup_hmac_source_binding_invalid');
  }
  return value;
}

function sameMetadata(
  left: ControlLookupHmacKeyMetadata,
  right: ControlLookupHmacKeyMetadata
): boolean {
  return (
    left.generation === right.generation &&
    left.keyId === right.keyId &&
    left.slot === right.slot &&
    left.fingerprint === right.fingerprint
  );
}

function rotationView(row: RotationRow): ControlLookupHmacRotationView {
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(row.authoritative_checkpoint_json) as unknown;
  } catch {
    throw new Error('lookup_hmac_rotation_checkpoint_invalid');
  }
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new Error('lookup_hmac_rotation_checkpoint_invalid');
  }
  return {
    operationId: row.operation_id,
    state: row.state,
    source: validateLookupHmacKeyMetadata({
      generation: row.source_key_generation,
      keyId: row.source_key_id,
      slot: row.source_key_slot,
      fingerprint: row.source_key_fingerprint,
    }),
    candidate: validateLookupHmacKeyMetadata({
      generation: row.candidate_key_generation,
      keyId: row.candidate_key_id,
      slot: row.candidate_key_slot,
      fingerprint: row.candidate_key_fingerprint,
    }),
    checkpoint: checkpoint as Record<string, unknown>,
    sourceRowCount: row.source_row_count,
    currentRowCount: row.current_row_count,
    verificationAttemptCount: row.verification_attempt_count,
    graceExpiresAt: row.grace_expires_at,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token ?? 0,
    leaseExpiresAt: row.lease_expires_at,
    mutationStarted: row.mutation_started === 1,
    updatedAt: row.updated_at,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
