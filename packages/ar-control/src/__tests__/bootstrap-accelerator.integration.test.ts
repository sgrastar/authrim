import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signBootstrapAcceleratorProof } from '@authrim/ar-lib-core/control-plane';
import {
  admitInitialBootstrapAcceleration,
  releaseInitialBootstrapAcceleration,
} from '../bootstrap-accelerator';
import type { ControlEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = 1_786_406_400;
let privateJwk: JWK;

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async first<T>() {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]) {
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

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'smoke-a', alg: 'EdDSA', use: 'sig' };
});

describe('initial bootstrap accelerator admission', () => {
  let database: DatabaseSync;
  let env: ControlEnv;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/001_pre_1_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('test', 'test', 'urn:authrim:control:test', 'creating', 1, 1);
      INSERT INTO control_bootstrap_handoffs (
        environment_id, state, ownership_fingerprint, release_manifest_digest, updated_at
      ) VALUES ('test', 'pending_verification', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 1);
    `);
    env = {
      CONTROL_DB: d1(database),
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
      SMOKE_RPC_SIGNING_JWK_SLOT_A: JSON.stringify(privateJwk),
    } as unknown as ControlEnv;
  });

  async function proof(jti: string) {
    return signBootstrapAcceleratorProof({
      environmentId: 'test',
      jti,
      privateJwk,
      keyId: 'smoke-a',
      now: NOW,
    });
  }

  it('admits one pending-handoff execution and rejects replay or overlap', async () => {
    const first = await admitInitialBootstrapAcceleration({
      env,
      proof: await proof('setup-proof-1'),
      now: NOW,
    });
    expect(first.state).toBe('acquired');
    await expect(
      admitInitialBootstrapAcceleration({ env, proof: await proof('setup-proof-1'), now: NOW })
    ).resolves.toEqual({ state: 'replayed' });
    await expect(
      admitInitialBootstrapAcceleration({ env, proof: await proof('setup-proof-2'), now: NOW })
    ).resolves.toEqual({ state: 'busy' });

    if (first.state !== 'acquired') throw new Error('expected_acquired_admission');
    await releaseInitialBootstrapAcceleration({ env, claims: first.claims });
    await expect(
      admitInitialBootstrapAcceleration({ env, proof: await proof('setup-proof-3'), now: NOW })
    ).resolves.toMatchObject({ state: 'acquired' });
  });

  it('does not admit work after the handoff is accepted', async () => {
    database.exec(
      `UPDATE control_bootstrap_handoffs
          SET state = 'accepted', verified_at = 2, accepted_at = 2, updated_at = 2
        WHERE environment_id = 'test'`
    );
    await expect(
      admitInitialBootstrapAcceleration({ env, proof: await proof('setup-proof-4'), now: NOW })
    ).resolves.toEqual({ state: 'inactive' });
  });
});
