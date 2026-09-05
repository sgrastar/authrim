import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupRetentionProjectionService } from '../lookup-retention-projection';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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
        throw new Error('unsupported_test_sql_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    getBookmark: () => 'test-bookmark',
  } as unknown as D1DatabaseSession;
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

describe('LookupRetentionProjectionService', () => {
  let database: DatabaseSync;
  let now: number;
  let service: LookupRetentionProjectionService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('env-a', 'test', 'urn:authrim:control:env-a', 'active', 1, 1)`
    );
    now = 10_000;
    service = new LookupRetentionProjectionService(d1(database), () => now);
  });

  afterEach(() => database.close());

  it('applies policy generations monotonically and accepts exact idempotent retries', async () => {
    const request = {
      tenantId: 'tenant-a',
      policyGeneration: 1,
      retentionDays: 180,
      sourceOperationId: 'policy-op-1',
      sourceUpdatedAt: 9_000,
    };
    await expect(service.applyPolicy('env-a', request)).resolves.toMatchObject(request);
    await expect(service.applyPolicy('env-a', request)).resolves.toMatchObject(request);
    await expect(
      service.applyPolicy('env-a', {
        ...request,
        retentionDays: 30,
        sourceOperationId: 'policy-op-conflict',
      })
    ).rejects.toThrow('control_lookup_retention_projection_stale');
    now = 11_000;
    await expect(
      service.applyPolicy('env-a', {
        ...request,
        policyGeneration: 2,
        retentionDays: 365,
        sourceOperationId: 'policy-op-2',
        sourceUpdatedAt: 10_500,
      })
    ).resolves.toMatchObject({ policyGeneration: 2, retentionDays: 365 });
  });

  it('rejects stale hold state and reports policy and hold projections together', async () => {
    await service.applyPolicy('env-a', {
      tenantId: 'tenant-a',
      policyGeneration: 1,
      retentionDays: 180,
      sourceOperationId: 'policy-op-1',
      sourceUpdatedAt: 9_000,
    });
    const active = {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      holdId: 'hold-a',
      projectionGeneration: 2,
      holdVersion: 1,
      projectionState: 'active' as const,
      sourceOperationId: 'hold-op-1',
      sourceUpdatedAt: 9_500,
    };
    await service.applyLegalHold('env-a', active);
    await expect(
      service.applyLegalHold('env-a', {
        ...active,
        projectionGeneration: 1,
        sourceOperationId: 'hold-op-stale',
      })
    ).rejects.toThrow('control_account_legal_hold_projection_stale');
    now = 11_000;
    await service.applyLegalHold('env-a', {
      ...active,
      projectionGeneration: 3,
      holdVersion: 2,
      projectionState: 'inactive',
      sourceOperationId: 'hold-op-2',
      sourceUpdatedAt: 10_500,
    });
    await expect(service.status('env-a', 'tenant-a', 'account-a')).resolves.toMatchObject({
      policy: { retentionDays: 180, policyGeneration: 1 },
      legalHold: { projectionState: 'inactive', projectionGeneration: 3 },
    });
    await expect(service.status('env-a', 'tenant-a', 'account-missing')).resolves.toMatchObject({
      policy: { retentionDays: 180 },
      legalHold: null,
    });
  });
});
