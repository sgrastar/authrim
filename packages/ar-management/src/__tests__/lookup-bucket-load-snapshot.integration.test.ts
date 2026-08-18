// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  signLookupShardRegistry,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectLookupBucketLoadSnapshot } from '../lookup-bucket-load-snapshot';

type SqlValue = string | number | null | Uint8Array;

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
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
  const session = {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    batch: async () => [],
    withSession: () => session,
  };
  return session as unknown as D1Database;
}

describe('collectLookupBucketLoadSnapshot', () => {
  let lookupA: DatabaseSync;
  let lookupB: DatabaseSync;
  let privateJwk: JWK;
  let publicJwk: JWK;
  const now = 10_000;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'lookup-key', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'lookup-key', alg: 'EdDSA' };
  });

  beforeEach(() => {
    lookupA = new DatabaseSync(':memory:');
    lookupB = new DatabaseSync(':memory:');
    for (const database of [lookupA, lookupB]) {
      database.exec(
        `CREATE TABLE lookup_bucket_counters (
           virtual_bucket INTEGER PRIMARY KEY,
           estimated_active_identifier_count INTEGER NOT NULL,
           estimated_active_alias_count INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL
         );`
      );
    }
    lookupA.exec(
      `WITH RECURSIVE bucket(value) AS (
         SELECT 0 UNION ALL SELECT value + 1 FROM bucket WHERE value < 2047
       )
       INSERT INTO lookup_bucket_counters
       SELECT value, CASE WHEN value = 7 THEN 900 ELSE 1 END,
              CASE WHEN value = 7 THEN 4 ELSE 0 END, ${now} FROM bucket;`
    );
    lookupB.exec(
      `WITH RECURSIVE bucket(value) AS (
         SELECT 2048 UNION ALL SELECT value + 1 FROM bucket WHERE value < 4095
       )
       INSERT INTO lookup_bucket_counters SELECT value, 2, 0, ${now} FROM bucket;`
    );
  });

  afterEach(() => {
    lookupA.close();
    lookupB.close();
  });

  async function environment(): Promise<Env> {
    const token = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 5,
        issuedAt: now - 10,
        expiresAt: now + 600,
        ranges: [
          {
            startBucket: 0,
            endBucket: 2047,
            assignmentGeneration: 3,
            lookupShardId: 'lookup-a',
            bindingRef: 'LOOKUP_A',
          },
          {
            startBucket: 2048,
            endBucket: 4095,
            assignmentGeneration: 4,
            lookupShardId: 'lookup-b',
            bindingRef: 'LOOKUP_B',
          },
        ],
      },
      privateJwk,
    });
    const values = new Map([
      [buildLookupShardRegistrySnapshotKey('test'), token],
      [buildLookupShardRegistryGenerationKey('test'), '5'],
    ]);
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => values.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      LOOKUP_A: d1(lookupA),
      LOOKUP_B: d1(lookupB),
    } as unknown as Env;
  }

  it('collects all signed assignments with counter-only observations', async () => {
    const result = await collectLookupBucketLoadSnapshot(
      await environment(),
      'management-planner',
      now
    );

    expect(result.buckets).toHaveLength(4096);
    expect(result.buckets[7]).toEqual({
      virtualBucket: 7,
      lookupShardId: 'lookup-a',
      assignmentGeneration: 3,
      activeIdentifierCount: 900,
      activeAliasCount: 4,
      counterUpdatedAt: now,
    });
    expect(result.buckets[2048]).toMatchObject({
      lookupShardId: 'lookup-b',
      assignmentGeneration: 4,
      activeIdentifierCount: 2,
      activeAliasCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('bindingRef');
  });

  it('fails closed when a signed active bucket has no counter', async () => {
    lookupA.prepare(`DELETE FROM lookup_bucket_counters WHERE virtual_bucket = 7`).run();

    await expect(
      collectLookupBucketLoadSnapshot(await environment(), 'management-planner', now)
    ).rejects.toThrow('lookup_bucket_load_snapshot_incomplete');
  });
});
