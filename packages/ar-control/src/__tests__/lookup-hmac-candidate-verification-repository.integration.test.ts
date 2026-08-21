import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  D1LookupHmacCandidateVerificationRepository,
  LOOKUP_HMAC_VERIFICATION_COMPONENTS,
  type DistributingLookupHmacRotation,
} from '../lookup-hmac-candidate-verifier';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
  } as unknown as D1Database;
}

const rotation: DistributingLookupHmacRotation = {
  environmentId: 'test',
  operationId: 'hmac-rotation-1',
  current: {
    generation: 1,
    keyId: 'lookup-v1',
    slot: 'A',
    fingerprint: 'a'.repeat(64),
  },
  candidate: {
    generation: 2,
    keyId: 'lookup-v2',
    slot: 'B',
    fingerprint: 'b'.repeat(64),
  },
};

describe('D1LookupHmacCandidateVerificationRepository', () => {
  let database: DatabaseSync;
  let repository: D1LookupHmacCandidateVerificationRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/001_pre_1_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, fencing_token, created_at, updated_at
       ) VALUES (
         'hmac-rotation-1', 'test', 'rotate_lookup_hmac', 'lookup-hmac-v2', 'running',
         'setup', 1, 1, 1
       );
       INSERT INTO control_hmac_rotation_operations (
         operation_id, environment_id, normalization_version,
         source_key_generation, source_key_id, source_key_slot, source_key_fingerprint,
         candidate_key_generation, candidate_key_id, candidate_key_slot,
         candidate_key_fingerprint, state, active_operation_key, updated_at
       ) VALUES (
         'hmac-rotation-1', 'test', 1,
         1, 'lookup-v1', 'A', '${'a'.repeat(64)}',
         2, 'lookup-v2', 'B', '${'b'.repeat(64)}',
         'distributing', 'active', 1
       )`
    );
    repository = new D1LookupHmacCandidateVerificationRepository(d1(database));
  });

  afterEach(() => database.close());

  it('records only the fixed target set and reports complete exact evidence', async () => {
    for (const component of LOOKUP_HMAC_VERIFICATION_COMPONENTS) {
      await repository.record(
        {
          rotation,
          phase: 'distribution',
          workerScriptName: `test-${component}`,
          status: 'succeeded',
          currentDigest: 'c'.repeat(64),
          candidateDigest: 'd'.repeat(64),
          observedStateRevision: null,
          errorCode: null,
          verifiedAt: 100,
        },
        100
      );
    }

    await expect(repository.status('test', rotation.operationId, 'distribution')).resolves.toEqual({
      phase: 'distribution',
      expected: 5,
      succeeded: 5,
      failed: 0,
      pending: [],
      complete: true,
    });
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count,
                MAX(length(current_digest)) AS current_length,
                MAX(length(candidate_digest)) AS candidate_length
           FROM control_lookup_hmac_candidate_verifications`
      )
      .get();
    expect(row).toEqual({ count: 5, current_length: 64, candidate_length: 64 });
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('rejects unknown targets and malformed phase evidence before persistence', async () => {
    await expect(
      repository.record(
        {
          rotation,
          phase: 'distribution',
          workerScriptName: 'test-unknown',
          status: 'succeeded',
          currentDigest: 'c'.repeat(64),
          candidateDigest: 'd'.repeat(64),
          observedStateRevision: null,
          errorCode: null,
          verifiedAt: 100,
        },
        100
      )
    ).rejects.toThrow('control_lookup_hmac_candidate_evidence_invalid');
    await expect(
      repository.record(
        {
          rotation,
          phase: 'generation',
          workerScriptName: 'test-ar-auth',
          status: 'succeeded',
          currentDigest: 'c'.repeat(64),
          candidateDigest: null,
          observedStateRevision: 2,
          errorCode: null,
          verifiedAt: 100,
        },
        100
      )
    ).rejects.toThrow('control_lookup_hmac_candidate_evidence_invalid');
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM control_lookup_hmac_candidate_verifications')
        .get()
    ).toEqual({ count: 0 });
  });

  it('fails closed when persisted evidence contains an unexpected target', async () => {
    database
      .prepare(
        `INSERT INTO control_lookup_hmac_candidate_verifications (
           environment_id, operation_id, verification_phase, worker_script_name,
           current_digest, candidate_digest, observed_state_revision, status,
           last_error_code, verified_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'test',
        rotation.operationId,
        'distribution',
        'test-unknown',
        'c'.repeat(64),
        'd'.repeat(64),
        null,
        'succeeded',
        null,
        100,
        100
      );

    await expect(repository.status('test', rotation.operationId, 'distribution')).rejects.toThrow(
      'control_lookup_hmac_verification_status_invalid'
    );
  });
});
