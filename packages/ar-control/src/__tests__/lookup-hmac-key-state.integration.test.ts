import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupHmacKeyStateService } from '../lookup-hmac-key-state';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FINGERPRINT = 'a'.repeat(64);

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
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

describe('LookupHmacKeyStateService', () => {
  let database: DatabaseSync;
  let service: LookupHmacKeyStateService;

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
       ) VALUES
         ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1),
         ('other', 'other', 'urn:authrim:control:other', 'active', 1, 1)`
    );
    service = new LookupHmacKeyStateService(d1(database), () => 100);
  });

  afterEach(() => database.close());

  it('initializes and idempotently returns the same secret-free stable state', async () => {
    const request = {
      current: {
        generation: 1,
        keyId: 'lookup-key-1',
        slot: 'A' as const,
        fingerprint: FINGERPRINT,
      },
    };
    await expect(service.initialize('test', request)).resolves.toEqual({
      stateRevision: 1,
      rotationState: 'stable',
      writeMode: 'current_only',
      current: request.current,
      previous: null,
      operationId: null,
      updatedAt: 100,
    });
    await expect(service.initialize('test', request)).resolves.toMatchObject({
      stateRevision: 1,
      current: request.current,
    });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_lookup_hmac_key_states`).get()
    ).toEqual({ count: 1 });
  });

  it('rejects conflicting reinitialization without changing the active key', async () => {
    await service.initialize('test', {
      current: { generation: 1, keyId: 'lookup-key-1', slot: 'A', fingerprint: FINGERPRINT },
    });
    await expect(
      service.initialize('test', {
        current: {
          generation: 2,
          keyId: 'lookup-key-2',
          slot: 'B',
          fingerprint: 'b'.repeat(64),
        },
      })
    ).rejects.toThrow('lookup_hmac_key_state_initialization_conflict');
    await expect(service.get('test')).resolves.toMatchObject({
      current: { generation: 1, keyId: 'lookup-key-1', slot: 'A' },
    });
  });

  it('rejects malformed metadata and unknown fields before a database write', async () => {
    await expect(
      service.initialize('test', {
        current: {
          generation: 1,
          keyId: 'lookup-key-1',
          slot: 'A',
          fingerprint: 'secret-material',
          secret: 'must-not-enter-control',
        } as never,
      })
    ).rejects.toThrow('invalid_lookup_hmac_key_metadata');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_lookup_hmac_key_states`).get()
    ).toEqual({ count: 0 });
  });

  it('scopes initialization to an existing environment', async () => {
    await expect(
      service.initialize('missing', {
        current: { generation: 1, keyId: 'lookup-key-1', slot: 'A', fingerprint: FINGERPRINT },
      })
    ).rejects.toThrow('control_environment_not_found');
    await service.initialize('other', {
      current: { generation: 1, keyId: 'lookup-key-1', slot: 'A', fingerprint: FINGERPRINT },
    });
    await expect(service.get('test')).resolves.toBeNull();
  });
});
