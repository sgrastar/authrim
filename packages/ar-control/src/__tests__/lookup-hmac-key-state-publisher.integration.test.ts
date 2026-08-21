import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  verifyLookupHmacKeyState,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LookupHmacKeyStatePublisher } from '../lookup-hmac-key-state-publisher';
import type { ControlEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

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

describe('LookupHmacKeyStatePublisher', () => {
  let database: DatabaseSync;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let now: number;
  let values: Map<string, string>;
  let writes: string[];
  let failGenerationWrite: boolean;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'registry-key-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'registry-key-a', alg: 'EdDSA' };
  });

  beforeEach(() => {
    now = 1_800_000_000;
    values = new Map();
    writes = [];
    failGenerationWrite = false;
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
       INSERT INTO control_lookup_hmac_key_states (
         environment_id, state_revision, rotation_state, write_mode,
         current_key_generation, current_key_id, current_key_slot, current_key_fingerprint,
         updated_at
       ) VALUES (
         'test', 1, 'stable', 'current_only', 1, 'lookup-key-1', 'A',
         '${FINGERPRINT_A}', 1
       );`
    );
  });

  afterEach(() => database.close());

  function env(): ControlEnv {
    return {
      CONTROL_DB: d1(database),
      TENANT_RUNTIME_REGISTRY: {
        get: async (key: string) => values.get(key) ?? null,
        put: vi.fn(async (key: string, value: string) => {
          writes.push(key);
          if (failGenerationWrite && key.endsWith(':generation')) {
            failGenerationWrite = false;
            throw new Error('simulated_kv_response_loss');
          }
          values.set(key, value);
        }),
      } as unknown as KVNamespace,
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: JSON.stringify(privateJwk),
      RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT: 'A',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key-a',
    } as unknown as ControlEnv;
  }

  it('publishes a signed stable state before its generation pointer', async () => {
    const result = await new LookupHmacKeyStatePublisher(env(), () => now).publishEnvironment(
      'test'
    );
    expect(result).toEqual({
      environmentId: 'test',
      generation: 1,
      stateRevision: 1,
      status: 'published',
    });
    expect(writes).toEqual([
      buildLookupHmacKeyStateSnapshotKey('test'),
      buildLookupHmacKeyStateGenerationKey('test'),
    ]);
    const token = values.get(buildLookupHmacKeyStateSnapshotKey('test'));
    if (!token) throw new Error('missing_test_snapshot');
    await expect(
      verifyLookupHmacKeyState({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now,
      })
    ).resolves.toMatchObject({
      generation: 1,
      rotationState: 'stable',
      writeMode: 'current_only',
      current: { generation: 1, keyId: 'lookup-key-1', slot: 'A' },
      previous: null,
    });
  });

  it('publishes a new generation when desired state changes to dual-write', async () => {
    const publisher = new LookupHmacKeyStatePublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    database.exec(
      `UPDATE control_lookup_hmac_key_states
          SET state_revision = 2, rotation_state = 'activation_dual_write',
              write_mode = 'dual_write', current_key_generation = 2,
              current_key_id = 'lookup-key-2', current_key_slot = 'B',
              current_key_fingerprint = '${FINGERPRINT_B}', previous_key_generation = 1,
              previous_key_id = 'lookup-key-1', previous_key_slot = 'A',
              previous_key_fingerprint = '${FINGERPRINT_A}', updated_at = 2
        WHERE environment_id = 'test'`
    );
    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 2,
      stateRevision: 2,
      status: 'published',
    });
    const token = values.get(buildLookupHmacKeyStateSnapshotKey('test'));
    if (!token) throw new Error('missing_test_snapshot');
    await expect(
      verifyLookupHmacKeyState({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now,
      })
    ).resolves.toMatchObject({
      generation: 2,
      rotationState: 'activation_dual_write',
      writeMode: 'dual_write',
      current: { generation: 2, slot: 'B' },
      previous: { generation: 1, slot: 'A' },
    });
  });

  it('does not republish unchanged state outside the refresh window', async () => {
    const publisher = new LookupHmacKeyStatePublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    writes = [];
    await expect(publisher.publishEnvironment('test')).resolves.toMatchObject({
      generation: 1,
      stateRevision: 1,
      status: 'unchanged',
    });
    expect(writes).toEqual([]);
  });

  it('republishes active state when the KV generation pointer is missing', async () => {
    const publisher = new LookupHmacKeyStatePublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    values.delete(buildLookupHmacKeyStateGenerationKey('test'));
    writes = [];

    await expect(publisher.publishEnvironment('test')).resolves.toMatchObject({
      generation: 1,
      stateRevision: 1,
      status: 'resumed',
    });
    expect(writes).toEqual([
      buildLookupHmacKeyStateSnapshotKey('test'),
      buildLookupHmacKeyStateGenerationKey('test'),
    ]);
  });

  it('resumes the exact prepared snapshot after generation-pointer response loss', async () => {
    const publisher = new LookupHmacKeyStatePublisher(env(), () => now);
    failGenerationWrite = true;
    await expect(publisher.publishEnvironment('test')).rejects.toThrow(
      'simulated_kv_response_loss'
    );
    const prepared = database
      .prepare(`SELECT snapshot_jws FROM control_lookup_hmac_key_state_publications`)
      .get() as { snapshot_jws: string };
    await expect(publisher.publishEnvironment('test')).resolves.toMatchObject({
      generation: 1,
      stateRevision: 1,
      status: 'resumed',
    });
    expect(values.get(buildLookupHmacKeyStateSnapshotKey('test'))).toBe(prepared.snapshot_jws);
  });

  it('refreshes an expiring state with a monotonic publication generation', async () => {
    const publisher = new LookupHmacKeyStatePublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    now += 1201;
    await expect(publisher.publishEnvironment('test')).resolves.toMatchObject({
      generation: 2,
      stateRevision: 1,
      status: 'published',
    });
    expect(values.get(buildLookupHmacKeyStateGenerationKey('test'))).toBe('2');
  });
});
