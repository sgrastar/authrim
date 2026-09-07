import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1SigningKeyVerificationRepository } from '../signing-key-candidate-verifier';

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

  async all<T>() {
    return { success: true, results: this.statement.all() as T[], meta: {} };
  }

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

describe('D1SigningKeyVerificationRepository', () => {
  let database: DatabaseSync;
  let repository: D1SigningKeyVerificationRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
       INSERT INTO control_signing_key_metadata (
         environment_id, key_purpose, slot, key_id, public_jwk_json,
         public_key_fingerprint, state, active_key_guard, updated_at
       ) VALUES (
         'test', 'smoke_rpc', 'b', 'smoke-v2',
         '{"kty":"OKP","crv":"Ed25519","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","kid":"smoke-v2","alg":"EdDSA"}',
         '${'a'.repeat(64)}', 'staged', 'slot:b', 100
       )`
    );
    repository = new D1SigningKeyVerificationRepository(d1(database));
  });

  afterEach(() => database.close());

  it('lists staged public metadata and upserts bounded redacted evidence', async () => {
    await expect(repository.listStaged()).resolves.toEqual([
      { environmentId: 'test', purpose: 'smoke_rpc', slot: 'B', keyId: 'smoke-v2' },
    ]);
    const staged = (await repository.listStaged())[0];
    await repository.record(
      {
        staged,
        workerScriptName: 'test-ar-auth',
        status: 'failed',
        errorCode: 'runtime_key_verification_smoke_keys_unavailable',
        verifiedAt: null,
      },
      101
    );
    await repository.record(
      {
        staged,
        workerScriptName: 'test-ar-auth',
        status: 'succeeded',
        errorCode: null,
        verifiedAt: 102,
      },
      102
    );

    expect(
      database
        .prepare(
          `SELECT status, attempt_count, last_error_code, verified_at, updated_at
             FROM control_signing_key_verifications`
        )
        .get()
    ).toEqual({
      status: 'succeeded',
      attempt_count: 2,
      last_error_code: null,
      verified_at: 102,
      updated_at: 102,
    });
  });

  it('cannot persist evidence for an unregistered key', async () => {
    await expect(
      repository.record(
        {
          staged: {
            environmentId: 'test',
            purpose: 'smoke_rpc',
            slot: 'A',
            keyId: 'unknown',
          },
          workerScriptName: 'test-ar-auth',
          status: 'succeeded',
          errorCode: null,
          verifiedAt: 102,
        },
        102
      )
    ).rejects.toThrow();
  });
});
