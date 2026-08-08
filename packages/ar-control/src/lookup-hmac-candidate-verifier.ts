import type { ControlLookupHmacKeyMetadata } from '@authrim/ar-lib-core/control-plane';
import { getTenantDatabaseBindingPrefix } from '@authrim/ar-lib-core/services/tenant-database-naming';
import { signControlRuntimeSmokeRequest } from './runtime-smoke-signer';
import type { ControlEnv } from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_WORKER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_ERROR = /^(?:runtime|control|lookup)_[a-z0-9_]{1,119}$/u;
const SAFE_ERROR_FRAGMENT =
  /(?:^|[^a-z0-9_])((?:runtime|control|lookup)_[a-z0-9_]{1,119})(?=$|[^a-z0-9_])/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const LOOKUP_HMAC_TEST_VECTOR = 'authrim-control-lookup-hmac-v1';

function lookupHmacTestBinding(environmentId: string): string {
  return `${getTenantDatabaseBindingPrefix(environmentId)}_LOOKUP_HMAC_TEST`;
}

export const LOOKUP_HMAC_VERIFICATION_BINDINGS = {
  'ar-lib-core': 'SMOKE_AR_LIB_CORE',
  'ar-auth': 'SMOKE_AR_AUTH',
  'ar-token': 'SMOKE_AR_TOKEN',
  'ar-userinfo': 'SMOKE_AR_USERINFO',
  'ar-management': 'SMOKE_AR_MANAGEMENT',
} as const satisfies Readonly<Record<string, keyof ControlEnv>>;

export const LOOKUP_HMAC_VERIFICATION_COMPONENTS = Object.keys(
  LOOKUP_HMAC_VERIFICATION_BINDINGS
) as Array<keyof typeof LOOKUP_HMAC_VERIFICATION_BINDINGS>;

export interface DistributingLookupHmacRotation {
  environmentId: string;
  operationId: string;
  current: ControlLookupHmacKeyMetadata;
  candidate: ControlLookupHmacKeyMetadata;
}

export interface LookupHmacCandidateEvidence {
  rotation: DistributingLookupHmacRotation;
  phase: 'distribution' | 'generation';
  workerScriptName: string;
  status: 'succeeded' | 'failed';
  currentDigest: string | null;
  candidateDigest: string | null;
  observedStateRevision: number | null;
  errorCode: string | null;
  verifiedAt: number | null;
}

export interface LookupHmacCandidateVerificationRepository {
  listDistributing(): Promise<DistributingLookupHmacRotation[]>;
  listAwaitingGeneration(): Promise<DistributingLookupHmacRotation[]>;
  record(evidence: LookupHmacCandidateEvidence, now: number): Promise<void>;
}

export interface LookupHmacVerificationStatus {
  phase: 'distribution' | 'generation';
  expected: number;
  succeeded: number;
  failed: number;
  pending: string[];
  complete: boolean;
}

interface RotationRow {
  environment_id: string;
  operation_id: string;
  source_key_generation: number;
  source_key_id: string;
  source_key_slot: 'A' | 'B';
  source_key_fingerprint: string;
  candidate_key_generation: number;
  candidate_key_id: string;
  candidate_key_slot: 'A' | 'B';
  candidate_key_fingerprint: string;
}

function metadata(input: {
  generation: number;
  keyId: string;
  slot: 'A' | 'B';
  fingerprint: string;
}): ControlLookupHmacKeyMetadata {
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !SAFE_ID.test(input.keyId) ||
    (input.slot !== 'A' && input.slot !== 'B') ||
    !HEX_DIGEST.test(input.fingerprint)
  ) {
    throw new Error('control_lookup_hmac_candidate_state_invalid');
  }
  return input;
}

function validateRotation(rotation: DistributingLookupHmacRotation): void {
  if (!SAFE_ID.test(rotation.environmentId) || !SAFE_ID.test(rotation.operationId)) {
    throw new Error('control_lookup_hmac_candidate_state_invalid');
  }
  metadata(rotation.current);
  metadata(rotation.candidate);
  if (
    rotation.candidate.generation !== rotation.current.generation + 1 ||
    rotation.candidate.slot === rotation.current.slot ||
    rotation.candidate.keyId === rotation.current.keyId ||
    rotation.candidate.fingerprint === rotation.current.fingerprint
  ) {
    throw new Error('control_lookup_hmac_candidate_state_invalid');
  }
}

export function lookupHmacVerificationErrorCode(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    if (SAFE_ERROR.test(current.message)) return current.message;
    const wrapped = SAFE_ERROR_FRAGMENT.exec(current.message)?.[1];
    if (wrapped && SAFE_ERROR.test(wrapped)) return wrapped;
    current = current.cause;
  }
  return 'control_lookup_hmac_candidate_verification_failed';
}

function sameMetadata(
  actual: ControlLookupHmacKeyMetadata,
  expected: ControlLookupHmacKeyMetadata
): boolean {
  return (
    actual.generation === expected.generation &&
    actual.keyId === expected.keyId &&
    actual.slot === expected.slot &&
    actual.fingerprint === expected.fingerprint
  );
}

export class D1LookupHmacCandidateVerificationRepository implements LookupHmacCandidateVerificationRepository {
  constructor(private readonly db: D1Database) {}

  async listDistributing(): Promise<DistributingLookupHmacRotation[]> {
    return this.listByState('distributing');
  }

  async listAwaitingGeneration(): Promise<DistributingLookupHmacRotation[]> {
    return this.listByState('activation_dual_write');
  }

  private async listByState(
    state: 'distributing' | 'activation_dual_write'
  ): Promise<DistributingLookupHmacRotation[]> {
    const result = await this.db
      .prepare(
        `SELECT environment_id, operation_id,
                source_key_generation, source_key_id, source_key_slot, source_key_fingerprint,
                candidate_key_generation, candidate_key_id, candidate_key_slot,
                candidate_key_fingerprint
           FROM control_hmac_rotation_operations
          WHERE state = ?
          ORDER BY updated_at, operation_id
          LIMIT 1`
      )
      .bind(state)
      .all<RotationRow>();
    return result.results.map((row) => ({
      environmentId: row.environment_id,
      operationId: row.operation_id,
      current: metadata({
        generation: row.source_key_generation,
        keyId: row.source_key_id,
        slot: row.source_key_slot,
        fingerprint: row.source_key_fingerprint,
      }),
      candidate: metadata({
        generation: row.candidate_key_generation,
        keyId: row.candidate_key_id,
        slot: row.candidate_key_slot,
        fingerprint: row.candidate_key_fingerprint,
      }),
    }));
  }

  async record(evidence: LookupHmacCandidateEvidence, now: number): Promise<void> {
    validateRotation(evidence.rotation);
    const expectedWorkers = new Set(
      LOOKUP_HMAC_VERIFICATION_COMPONENTS.map(
        (component) => `${evidence.rotation.environmentId}-${component}`
      )
    );
    const validSucceededDistribution =
      evidence.status === 'succeeded' &&
      evidence.phase === 'distribution' &&
      typeof evidence.currentDigest === 'string' &&
      HEX_DIGEST.test(evidence.currentDigest) &&
      typeof evidence.candidateDigest === 'string' &&
      HEX_DIGEST.test(evidence.candidateDigest) &&
      evidence.observedStateRevision === null &&
      evidence.errorCode === null &&
      Number.isSafeInteger(evidence.verifiedAt) &&
      (evidence.verifiedAt as number) >= 1;
    const validSucceededGeneration =
      evidence.status === 'succeeded' &&
      evidence.phase === 'generation' &&
      evidence.currentDigest === null &&
      evidence.candidateDigest === null &&
      Number.isSafeInteger(evidence.observedStateRevision) &&
      (evidence.observedStateRevision as number) >= 1 &&
      evidence.errorCode === null &&
      Number.isSafeInteger(evidence.verifiedAt) &&
      (evidence.verifiedAt as number) >= 1;
    const validFailure =
      evidence.status === 'failed' &&
      evidence.currentDigest === null &&
      evidence.candidateDigest === null &&
      evidence.observedStateRevision === null &&
      typeof evidence.errorCode === 'string' &&
      SAFE_ERROR.test(evidence.errorCode) &&
      evidence.verifiedAt === null;
    if (
      !SAFE_WORKER.test(evidence.workerScriptName) ||
      !expectedWorkers.has(evidence.workerScriptName) ||
      !Number.isSafeInteger(now) ||
      now < 1 ||
      (!validSucceededDistribution && !validSucceededGeneration && !validFailure)
    ) {
      throw new Error('control_lookup_hmac_candidate_evidence_invalid');
    }
    await this.db
      .prepare(
        `INSERT INTO control_lookup_hmac_candidate_verifications (
           environment_id, operation_id, verification_phase, worker_script_name, current_digest,
           candidate_digest, observed_state_revision, status, attempt_count, last_error_code,
           verified_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(environment_id, operation_id, verification_phase, worker_script_name)
         DO UPDATE SET
           current_digest = excluded.current_digest,
           candidate_digest = excluded.candidate_digest,
           observed_state_revision = excluded.observed_state_revision,
           status = excluded.status,
           attempt_count = control_lookup_hmac_candidate_verifications.attempt_count + 1,
           last_error_code = excluded.last_error_code,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        evidence.rotation.environmentId,
        evidence.rotation.operationId,
        evidence.phase,
        evidence.workerScriptName,
        evidence.currentDigest,
        evidence.candidateDigest,
        evidence.observedStateRevision,
        evidence.status,
        evidence.errorCode,
        evidence.verifiedAt,
        now
      )
      .run();
  }

  async status(
    environmentId: string,
    operationId: string,
    phase: 'distribution' | 'generation'
  ): Promise<LookupHmacVerificationStatus> {
    if (!SAFE_ID.test(environmentId) || !SAFE_ID.test(operationId)) {
      throw new Error('control_lookup_hmac_verification_status_invalid');
    }
    const expected = LOOKUP_HMAC_VERIFICATION_COMPONENTS.map(
      (component) => `${environmentId}-${component}`
    );
    const result = await this.db
      .prepare(
        `SELECT worker_script_name, status
           FROM control_lookup_hmac_candidate_verifications
          WHERE environment_id = ? AND operation_id = ? AND verification_phase = ?
          ORDER BY worker_script_name`
      )
      .bind(environmentId, operationId, phase)
      .all<{ worker_script_name: string; status: 'succeeded' | 'failed' }>();
    const expectedSet = new Set(expected);
    const seen = new Set<string>();
    let succeeded = 0;
    let failed = 0;
    for (const row of result.results) {
      if (
        !expectedSet.has(row.worker_script_name) ||
        seen.has(row.worker_script_name) ||
        (row.status !== 'succeeded' && row.status !== 'failed')
      ) {
        throw new Error('control_lookup_hmac_verification_status_invalid');
      }
      seen.add(row.worker_script_name);
      if (row.status === 'succeeded') succeeded += 1;
      else failed += 1;
    }
    return {
      phase,
      expected: expected.length,
      succeeded,
      failed,
      pending: expected.filter((worker) => !seen.has(worker)),
      complete: succeeded === expected.length,
    };
  }
}

export class LookupHmacCandidateVerifier {
  constructor(
    private readonly repository: LookupHmacCandidateVerificationRepository,
    private readonly env: ControlEnv,
    private readonly now: () => number
  ) {}

  async reconcile(): Promise<{ attempted: number; succeeded: number; failed: number }> {
    const summary = { attempted: 0, succeeded: 0, failed: 0 };
    for (const rotation of await this.repository.listDistributing()) {
      const result = await this.verifyDistribution(rotation);
      summary.attempted += result.attempted;
      summary.succeeded += result.succeeded;
      summary.failed += result.failed;
    }
    for (const rotation of await this.repository.listAwaitingGeneration()) {
      const result = await this.verifyGeneration(rotation);
      summary.attempted += result.attempted;
      summary.succeeded += result.succeeded;
      summary.failed += result.failed;
    }
    return summary;
  }

  private async verifyDistribution(
    rotation: DistributingLookupHmacRotation
  ): Promise<{ attempted: number; succeeded: number; failed: number }> {
    validateRotation(rotation);
    const summary = { attempted: 0, succeeded: 0, failed: 0 };
    let baseline: { currentDigest: string; candidateDigest: string } | null = null;
    for (const [component, bindingName] of Object.entries(LOOKUP_HMAC_VERIFICATION_BINDINGS)) {
      summary.attempted += 1;
      const workerScriptName = `${rotation.environmentId}-${component}`;
      if (!SAFE_WORKER.test(workerScriptName)) {
        throw new Error('control_lookup_hmac_candidate_target_invalid');
      }
      try {
        const binding = this.env[bindingName];
        if (!binding || typeof binding.verifyLookupHmacCandidate !== 'function') {
          throw new Error('control_lookup_hmac_candidate_service_missing');
        }
        const token = await signControlRuntimeSmokeRequest({
          env: this.env,
          now: this.now(),
          request: {
            environmentId: rotation.environmentId,
            operationId: rotation.operationId,
            attempt: 1,
            targetWorker: workerScriptName,
            bindingRef: lookupHmacTestBinding(rotation.environmentId),
            expectedMigrationGeneration: 1,
            dataRole: 'tenant_core/default',
            residencyPartition: 'default',
          },
        });
        const result = await binding.verifyLookupHmacCandidate({
          purpose: 'lookup_hmac',
          operationId: rotation.operationId,
          testVector: LOOKUP_HMAC_TEST_VECTOR,
          token,
          current: rotation.current,
          candidate: rotation.candidate,
        });
        if (result.ok === false) {
          if (
            Object.keys(result).sort().join(',') !== 'errorCode,ok' ||
            !SAFE_ERROR.test(result.errorCode)
          ) {
            throw new Error('control_lookup_hmac_candidate_result_mismatch');
          }
          throw new Error(result.errorCode);
        }
        if (
          result.ok !== true ||
          result.purpose !== 'lookup_hmac' ||
          result.operationId !== rotation.operationId ||
          result.targetWorker !== workerScriptName ||
          !sameMetadata(result.current, rotation.current) ||
          !sameMetadata(result.candidate, rotation.candidate) ||
          !HEX_DIGEST.test(result.current.digest) ||
          !HEX_DIGEST.test(result.candidate.digest) ||
          !Number.isSafeInteger(result.verifiedAt) ||
          result.verifiedAt < 1
        ) {
          throw new Error('control_lookup_hmac_candidate_result_mismatch');
        }
        baseline ??= {
          currentDigest: result.current.digest,
          candidateDigest: result.candidate.digest,
        };
        if (
          baseline.currentDigest !== result.current.digest ||
          baseline.candidateDigest !== result.candidate.digest
        ) {
          throw new Error('control_lookup_hmac_candidate_digest_mismatch');
        }
        await this.repository.record(
          {
            rotation,
            phase: 'distribution',
            workerScriptName,
            status: 'succeeded',
            currentDigest: result.current.digest,
            candidateDigest: result.candidate.digest,
            observedStateRevision: null,
            errorCode: null,
            verifiedAt: result.verifiedAt,
          },
          this.now()
        );
        summary.succeeded += 1;
      } catch (error) {
        await this.repository.record(
          {
            rotation,
            phase: 'distribution',
            workerScriptName,
            status: 'failed',
            currentDigest: null,
            candidateDigest: null,
            observedStateRevision: null,
            errorCode: lookupHmacVerificationErrorCode(error),
            verifiedAt: null,
          },
          this.now()
        );
        summary.failed += 1;
      }
    }
    return summary;
  }

  private async verifyGeneration(
    rotation: DistributingLookupHmacRotation
  ): Promise<{ attempted: number; succeeded: number; failed: number }> {
    validateRotation(rotation);
    const summary = { attempted: 0, succeeded: 0, failed: 0 };
    for (const [component, bindingName] of Object.entries(LOOKUP_HMAC_VERIFICATION_BINDINGS)) {
      summary.attempted += 1;
      const workerScriptName = `${rotation.environmentId}-${component}`;
      try {
        const binding = this.env[bindingName];
        if (!binding || typeof binding.observeLookupHmacGeneration !== 'function') {
          throw new Error('control_lookup_hmac_generation_service_missing');
        }
        const token = await signControlRuntimeSmokeRequest({
          env: this.env,
          now: this.now(),
          request: {
            environmentId: rotation.environmentId,
            operationId: rotation.operationId,
            attempt: 1,
            targetWorker: workerScriptName,
            bindingRef: lookupHmacTestBinding(rotation.environmentId),
            expectedMigrationGeneration: 1,
            dataRole: 'tenant_core/default',
            residencyPartition: 'default',
          },
        });
        const result = await binding.observeLookupHmacGeneration({
          purpose: 'lookup_hmac_generation',
          operationId: rotation.operationId,
          token,
          current: rotation.candidate,
          previous: rotation.current,
        });
        if (result.ok === false) {
          if (
            Object.keys(result).sort().join(',') !== 'errorCode,ok' ||
            !SAFE_ERROR.test(result.errorCode)
          ) {
            throw new Error('control_lookup_hmac_generation_result_mismatch');
          }
          throw new Error(result.errorCode);
        }
        if (
          result.ok !== true ||
          result.purpose !== 'lookup_hmac_generation' ||
          result.operationId !== rotation.operationId ||
          result.targetWorker !== workerScriptName ||
          !sameMetadata(result.current, rotation.candidate) ||
          !sameMetadata(result.previous, rotation.current) ||
          !Number.isSafeInteger(result.stateRevision) ||
          result.stateRevision < 1 ||
          !Number.isSafeInteger(result.observedAt) ||
          result.observedAt < 1
        ) {
          throw new Error('control_lookup_hmac_generation_result_mismatch');
        }
        await this.repository.record(
          {
            rotation,
            phase: 'generation',
            workerScriptName,
            status: 'succeeded',
            currentDigest: null,
            candidateDigest: null,
            observedStateRevision: result.stateRevision,
            errorCode: null,
            verifiedAt: result.observedAt,
          },
          this.now()
        );
        summary.succeeded += 1;
      } catch (error) {
        await this.repository.record(
          {
            rotation,
            phase: 'generation',
            workerScriptName,
            status: 'failed',
            currentDigest: null,
            candidateDigest: null,
            observedStateRevision: null,
            errorCode: lookupHmacVerificationErrorCode(error),
            verifiedAt: null,
          },
          this.now()
        );
        summary.failed += 1;
      }
    }
    return summary;
  }
}
