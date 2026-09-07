// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  signLookupShardRegistry,
  type ControlLookupBucketWriteRoute,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLookupBucketWriteResolver } from '../lookup-bucket-write-route';

type SqlValue = string | number | null | Uint8Array;

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run<T>() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [] as T[],
      meta: { changes: Number(result.changes) },
    };
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
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch<T>(statements: BoundStatement[]) {
      const results = [];
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of statements) results.push(await statement.run<T>());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    getBookmark: () => 'bookmark',
  };
  return {
    ...session,
    withSession: () => session,
  } as unknown as D1Database;
}

describe('createLookupBucketWriteResolver', () => {
  let source: DatabaseSync;
  let target: DatabaseSync;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let registryToken: string;
  let route: ControlLookupBucketWriteRoute;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'lookup-route-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'lookup-route-a', alg: 'EdDSA' };
  });

  beforeEach(async () => {
    source = new DatabaseSync(':memory:');
    target = new DatabaseSync(':memory:');
    source.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    target.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const now = Math.floor(Date.now() / 1000);
    registryToken = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 8,
        issuedAt: now - 1,
        expiresAt: now + 3600,
        ranges: [
          {
            startBucket: 0,
            endBucket: 4095,
            assignmentGeneration: 3,
            lookupShardId: 'lookup-a',
            bindingRef: 'LOOKUP_A',
          },
        ],
      },
      privateJwk,
    });
    route = {
      virtualBucket: 7,
      primary: {
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_A',
        assignmentGeneration: 3,
      },
      mirrors: [
        {
          lookupShardId: 'lookup-b',
          bindingRef: 'LOOKUP_B',
          assignmentGeneration: 4,
        },
      ],
      migration: {
        operationId: 'lookup-bucket:operation',
        state: 'backfilling',
      },
    };
  });

  afterEach(() => {
    source.close();
    target.close();
  });

  function env(): Env {
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      TENANT_RUNTIME_REGISTRY: {
        get: vi.fn(async (key: string) => {
          if (key === buildLookupShardRegistrySnapshotKey('test')) return registryToken;
          if (key === buildLookupShardRegistryGenerationKey('test')) return '8';
          return null;
        }),
      } as unknown as KVNamespace,
      CONTROL: {
        getLookupBucketWriteRoute: vi.fn(async () => route),
      } as unknown as Env['CONTROL'],
      LOOKUP_A: d1(source),
      LOOKUP_B: d1(target),
    } as unknown as Env;
  }

  it('writes to both routes and requires reflected reads to agree', async () => {
    const resolveBucket = await createLookupBucketWriteResolver(env());
    const database = await resolveBucket(7);
    await database.prepare(`INSERT INTO entries (id, value) VALUES (?, ?)`).bind('a', 'one').run();

    expect(source.prepare(`SELECT value FROM entries WHERE id = 'a'`).get()).toEqual({
      value: 'one',
    });
    expect(target.prepare(`SELECT value FROM entries WHERE id = 'a'`).get()).toEqual({
      value: 'one',
    });
    await expect(
      database.prepare(`SELECT id, value FROM entries WHERE id = ?`).bind('a').first()
    ).resolves.toEqual({ id: 'a', value: 'one' });

    target.prepare(`UPDATE entries SET value = 'tampered' WHERE id = 'a'`).run();
    await expect(
      database.prepare(`SELECT id, value FROM entries WHERE id = ?`).bind('a').first()
    ).rejects.toThrow('lookup_write_reflection_mismatch');
  });

  it('rejects a Control route that omits the signed active assignment', async () => {
    route = {
      ...route,
      primary: {
        lookupShardId: 'lookup-b',
        bindingRef: 'LOOKUP_B',
        assignmentGeneration: 4,
      },
      mirrors: [],
      migration: null,
    };
    const resolveBucket = await createLookupBucketWriteResolver(env());

    await expect(resolveBucket(7)).rejects.toThrow('lookup_write_registry_route_mismatch');
  });
});
