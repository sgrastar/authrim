import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { D1BatchExecutionResult, D1BatchStatement } from '../core/cloudflare.js';
import {
  activateControlSigningKeyRotation,
  stageControlSigningKeyRotation,
  type StagedSigningKeyRotation,
} from '../core/signing-key-rotation.js';
import { generateEd25519JwkKeyPair } from '../core/keys.js';
import type { ControlKeyState } from '../core/lock.js';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const temporaryDirectories: string[] = [];
type SqlValue = string | number | bigint | null | Uint8Array;

function sqlValues(values: readonly unknown[] | undefined): SqlValue[] {
  return (values ?? []).map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError('unsupported_test_sql_value');
  });
}

function sqliteBatchExecutor(database: DatabaseSync) {
  return async (
    _databaseId: string,
    batch: readonly D1BatchStatement[]
  ): Promise<D1BatchExecutionResult[]> => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const results = batch.map((statement) => {
        const prepared = database.prepare(statement.sql);
        const params = sqlValues(statement.params);
        const rows = /^\s*SELECT\b/iu.test(statement.sql)
          ? (prepared.all(...params) as unknown[])
          : (prepared.run(...params), []);
        return { success: true as const, results: rows };
      });
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
}

const staged: StagedSigningKeyRotation = {
  purpose: 'smoke_rpc',
  activeSlot: 'A',
  candidateSlot: 'B',
  activeKeyId: 'smoke-v1',
  candidateKeyId: 'smoke-v2',
  activeFingerprint: 'a'.repeat(64),
  candidateFingerprint: 'b'.repeat(64),
  privateSecretName: 'SMOKE_RPC_SIGNING_JWK_SLOT_B',
  verifyingSecretName: 'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  operationId: `op_key_stage_${'c'.repeat(32)}`,
  resumed: false,
};

describe('signing-key activation evidence gate', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(ROOT_DIR, 'migrations/control/001_pre_1_0_control_baseline.sql'), 'utf8')
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
       INSERT INTO control_signing_key_metadata (
         environment_id, key_purpose, slot, key_id, public_jwk_json,
         public_key_fingerprint, state, active_key_guard, activated_at, updated_at
       ) VALUES
         ('test', 'smoke_rpc', 'a', 'smoke-v1',
          '{"kty":"OKP","crv":"Ed25519","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","kid":"smoke-v1","alg":"EdDSA"}',
          '${'a'.repeat(64)}', 'active', 'active', 100, 100),
         ('test', 'smoke_rpc', 'b', 'smoke-v2',
          '{"kty":"OKP","crv":"Ed25519","x":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","kid":"smoke-v2","alg":"EdDSA"}',
          '${'b'.repeat(64)}', 'staged', 'slot:b', NULL, 101);
       INSERT INTO control_signing_key_verifications (
         environment_id, key_purpose, key_id, slot, worker_script_name,
         status, attempt_count, last_error_code, verified_at, updated_at
       ) VALUES (
         'test', 'smoke_rpc', 'smoke-v2', 'b', 'test-ar-auth',
         'succeeded', 1, NULL, 102, 102
       )`
    );
  });

  afterEach(async () => {
    database.close();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('keeps the old active key and emits no success audit until every target succeeded', async () => {
    const executeBatch = sqliteBatchExecutor(database);
    await expect(
      activateControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir: '/unused',
        staged,
        expectedWorkerScriptNames: ['test-ar-auth', 'test-ar-management'],
        now: 200,
        executeBatch,
      })
    ).rejects.toThrow('signing_key_rotation_activation_reflection_failed');
    expect(
      database
        .prepare(
          `SELECT slot, state FROM control_signing_key_metadata
            WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' ORDER BY slot`
        )
        .all()
    ).toEqual([
      { slot: 'a', state: 'active' },
      { slot: 'b', state: 'staged' },
    ]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_operations`).get()).toEqual({
      count: 0,
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
      count: 0,
    });

    database.exec(
      `INSERT INTO control_signing_key_verifications (
         environment_id, key_purpose, key_id, slot, worker_script_name,
         status, attempt_count, last_error_code, verified_at, updated_at
       ) VALUES (
         'test', 'smoke_rpc', 'smoke-v2', 'b', 'test-ar-management',
         'succeeded', 1, NULL, 103, 103
       )`
    );
    await expect(
      activateControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir: '/unused',
        staged,
        expectedWorkerScriptNames: ['test-ar-auth', 'test-ar-management'],
        now: 201,
        executeBatch,
      })
    ).resolves.toBeUndefined();
    expect(
      database
        .prepare(
          `SELECT slot, state FROM control_signing_key_metadata
            WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' ORDER BY slot`
        )
        .all()
    ).toEqual([
      { slot: 'a', state: 'previous' },
      { slot: 'b', state: 'active' },
    ]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
      count: 1,
    });
  });

  it.each([
    ['candidate', `slot = 'b'`, 'public_key_fingerprint'],
    ['active', `slot = 'a'`, 'public_key_fingerprint'],
  ] as const)(
    'does not partially activate when the %s metadata changes after verification',
    async (_name, rowPredicate, column) => {
      database.exec(
        `INSERT INTO control_signing_key_verifications (
           environment_id, key_purpose, key_id, slot, worker_script_name,
           status, attempt_count, last_error_code, verified_at, updated_at
         ) VALUES (
           'test', 'smoke_rpc', 'smoke-v2', 'b', 'test-ar-management',
           'succeeded', 1, NULL, 103, 103
         );
         UPDATE control_signing_key_metadata
            SET ${column} = '${'c'.repeat(64)}'
          WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' AND ${rowPredicate}`
      );

      await expect(
        activateControlSigningKeyRotation({
          controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
          environmentId: 'test',
          keysDir: '/unused',
          staged,
          expectedWorkerScriptNames: ['test-ar-auth', 'test-ar-management'],
          now: 200,
          executeBatch: sqliteBatchExecutor(database),
        })
      ).rejects.toThrow('signing_key_rotation_activation_reflection_failed');

      expect(
        database
          .prepare(
            `SELECT slot, state FROM control_signing_key_metadata
              WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' ORDER BY slot`
          )
          .all()
      ).toEqual([
        { slot: 'a', state: 'active' },
        { slot: 'b', state: 'staged' },
      ]);
      expect(database.prepare(`SELECT COUNT(*) AS count FROM control_operations`).get()).toEqual({
        count: 0,
      });
      expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
        count: 0,
      });
    }
  );

  it('preserves rollback metadata and emits no success audit when the active row changes after preflight', async () => {
    const active = generateEd25519JwkKeyPair('smoke-race-active');
    const previous = generateEd25519JwkKeyPair('smoke-race-previous');
    const concurrent = generateEd25519JwkKeyPair('smoke-race-concurrent');
    const digest = (jwk: Record<string, unknown>) =>
      createHash('sha256')
        .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
        .digest('hex');
    database.exec(`DELETE FROM control_signing_key_verifications`);
    database
      .prepare(
        `UPDATE control_signing_key_metadata
            SET key_id = ?, public_jwk_json = ?, public_key_fingerprint = ?,
                state = 'active', active_key_guard = 'active', updated_at = 100
          WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' AND slot = 'a'`
      )
      .run(active.keyId, JSON.stringify(active.publicJwk), digest(active.publicJwk));
    database
      .prepare(
        `UPDATE control_signing_key_metadata
            SET key_id = ?, public_jwk_json = ?, public_key_fingerprint = ?,
                state = 'previous', active_key_guard = 'slot:b', updated_at = 100
          WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' AND slot = 'b'`
      )
      .run(previous.keyId, JSON.stringify(previous.publicJwk), digest(previous.publicJwk));
    const keysDir = await mkdtemp(join(tmpdir(), 'authrim-signing-stage-race-'));
    temporaryDirectories.push(keysDir);
    const controlKeyState: ControlKeyState = {
      runtimeRegistry: {
        activeSlot: 'A',
        activeKeyId: 'runtime-v1',
        activeFingerprint: 'd'.repeat(64),
        updatedAt: 100,
      },
      smokeRpc: {
        activeSlot: 'A',
        activeKeyId: active.keyId,
        activeFingerprint: digest(active.publicJwk),
        previousSlot: 'B',
        previousKeyId: previous.keyId,
        previousFingerprint: digest(previous.publicJwk),
        updatedAt: 100,
      },
      lookupHmac: {
        stateRevision: 1,
        activeGeneration: 1,
        activeSlot: 'A',
        activeKeyId: 'lookup-v1',
        activeFingerprint: 'e'.repeat(64),
        updatedAt: 100,
      },
    };
    const executeSqliteBatch = sqliteBatchExecutor(database);
    let callCount = 0;
    const executeBatch = async (databaseId: string, batch: readonly D1BatchStatement[]) => {
      callCount += 1;
      const result = await executeSqliteBatch(databaseId, batch);
      if (callCount === 1) {
        database
          .prepare(
            `UPDATE control_signing_key_metadata
                SET key_id = ?, public_jwk_json = ?, public_key_fingerprint = ?, updated_at = 101
              WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' AND slot = 'a'`
          )
          .run(
            concurrent.keyId,
            JSON.stringify(concurrent.publicJwk),
            digest(concurrent.publicJwk)
          );
      }
      return result;
    };

    await expect(
      stageControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir,
        purpose: 'smoke_rpc',
        controlKeyState,
        now: 10_000,
        executeBatch,
      })
    ).rejects.toThrow('signing_key_rotation_stage_reflection_failed');

    expect(
      database
        .prepare(
          `SELECT slot, key_id, state FROM control_signing_key_metadata
            WHERE environment_id = 'test' AND key_purpose = 'smoke_rpc' ORDER BY slot`
        )
        .all()
    ).toEqual([
      { slot: 'a', key_id: concurrent.keyId, state: 'active' },
      { slot: 'b', key_id: previous.keyId, state: 'previous' },
    ]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_operations`).get()).toEqual({
      count: 0,
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
      count: 0,
    });
  });
});
