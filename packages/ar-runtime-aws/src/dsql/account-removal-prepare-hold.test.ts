/**
 * An account removal refused for a legal hold reaches the caller as such through the Aurora DSQL
 * adapter, whose transaction replaces what its callback throws.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY_REMOVAL_ACCOUNT_HELD,
  createLookupBlindIndex,
  insertPreparedAccountDirectoryRemovals,
  type AccountDirectoryRemovalPublication,
} from '@authrim/ar-lib-core';
import { AuroraDsqlAdapter, type DsqlClient, type DsqlQueryResult } from './adapter';

const config = {
  hostname: 'abcdefghijklmnopqrstuv1234.dsql.ap-northeast-1.on.aws',
  region: 'ap-northeast-1',
  user: 'authrim_probe',
};

async function removal(): Promise<AccountDirectoryRemovalPublication> {
  const accountId = 'account:user-a';
  return {
    operationId: 'remove-user-a',
    tenantId: 'tenant-a',
    accountId,
    idempotencyKey: 'remove-user-a',
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
    scope: 'account',
    indexes: [
      await createLookupBlindIndex('account_id', accountId, {
        generation: 1,
        secret: '0123456789abcdef0123456789abcdef',
      }),
    ],
  };
}

/** Each attempt's guard matches the next count of `guardRows`; the first COMMIT may conflict. */
function adapterWith(guardRows: number[], conflictOnFirstCommit = false) {
  const queries: string[] = [];
  let commits = 0;
  let guards = 0;
  const connection = {
    query: vi.fn(async (sql: string): Promise<DsqlQueryResult> => {
      queries.push(sql);
      if (sql === 'COMMIT' && conflictOnFirstCommit && commits++ === 0) {
        throw Object.assign(new Error('change conflicts with another transaction'), {
          code: '40001',
        });
      }
      if (sql.includes('UPDATE account_legal_hold_states')) {
        return { rows: [], rowCount: guardRows[Math.min(guards++, guardRows.length - 1)] };
      }
      return { rows: [], rowCount: /^(BEGIN|COMMIT|ROLLBACK)/u.test(sql) ? 0 : 1 };
    }),
    release: vi.fn(),
  } satisfies DsqlClient;
  const adapter = new AuroraDsqlAdapter(config, {
    poolFactory: () => ({ connect: async () => connection, end: async () => undefined }),
    sleep: async () => undefined,
    random: () => 0.5,
  });
  return { adapter, queries };
}

describe('account removal prepare on Aurora DSQL', () => {
  it('reports a legal hold as held, writing nothing after the hold authority row', async () => {
    const { adapter, queries } = adapterWith([0]);

    await expect(
      insertPreparedAccountDirectoryRemovals(adapter, [await removal()], 1_800_000_000)
    ).rejects.toThrow(DIRECTORY_REMOVAL_ACCOUNT_HELD);
    expect(queries.some((sql) => sql.includes('account_routing_outbox'))).toBe(false);
    expect(queries.some((sql) => sql.includes('UPDATE identity_accounts'))).toBe(false);
  });

  it('reports a hold placed at the same time (a write conflict) as held, after running again', async () => {
    // The first attempt loses the conflict on the hold authority row; the second sees the hold.
    const { adapter, queries } = adapterWith([1, 0], true);

    await expect(
      insertPreparedAccountDirectoryRemovals(adapter, [await removal()], 1_800_000_000)
    ).rejects.toThrow(DIRECTORY_REMOVAL_ACCOUNT_HELD);
    expect(queries.filter((sql) => /^BEGIN/u.test(sql))).toHaveLength(2);
  });

  it('prepares the removal in one transaction when no hold stands', async () => {
    const { adapter, queries } = adapterWith([1]);

    await insertPreparedAccountDirectoryRemovals(adapter, [await removal()], 1_800_000_000);
    expect(queries[0]).toMatch(/^BEGIN/u);
    expect(queries[1]).toContain('UPDATE account_legal_hold_states');
    expect(queries.at(-1)).toBe('COMMIT');
  });
});
