import {
  createLookupBlindIndex,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = { generation: 7, secret: '0123456789abcdef0123456789abcdef' };
const PREVIOUS_KEY = { generation: 6, secret: 'abcdef0123456789abcdef0123456789' };

vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: vi.fn(async () => ({
    writeKeys: [KEY],
    readKeys: [KEY, PREVIOUS_KEY],
    state: { current: { generation: 7 } },
  })),
}));

import {
  eraseAccountPiiAfterDirectoryRemovalPrepared,
  markAccountDirectoryRemovalsReady,
  prepareAccountDirectoryRemoval,
} from '../account-directory-removal-producer';

function route(accountIndex: Awaited<ReturnType<typeof createLookupBlindIndex>>) {
  const publication: AccountDirectoryPublication = {
    operationId: 'create-operation',
    tenantId: 'tenant-a',
    accountId: 'account:user-a',
    idempotencyKey: 'create-account',
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
        {
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: 'pii-1',
          bindingRef: 'TDB_PII_1',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
    indexes: [accountIndex],
  };
  return publication;
}

describe('account directory removal producer', () => {
  let executed: Array<{ sql: string; params: unknown[] }>;
  let core: DatabaseAdapter;
  let pii: DatabaseAdapter;
  let routePublication: AccountDirectoryPublication;

  beforeEach(async () => {
    executed = [];
    routePublication = route(await createLookupBlindIndex('account_id', 'account:user-a', KEY));
    const batch = vi.fn(async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      for (const { sql, params = [] } of statements) {
        executed.push({ sql, params });
      }
      return statements.map(() => ({ rowsAffected: 1, success: true }));
    });
    core = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("event_kind = 'account_deleted'")) return [];
        return [];
      }),
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes("event_kind = 'account_created'")) {
          return {
            id: 'account:user-a',
            account_route_generation: 1,
            payload_json: JSON.stringify(routePublication),
          };
        }
        return null;
      }),
      execute: vi.fn(async () => ({ rowsAffected: 1, success: true })),
      batch,
      close: vi.fn(),
      getType: () => 'd1',
      healthCheck: vi.fn(async () => true),
    } as unknown as DatabaseAdapter;
    pii = {
      queryOne: vi.fn(async () => ({ value_json: JSON.stringify('person@example.com') })),
      query: vi.fn(async () => []),
      execute: vi.fn(),
      batch: vi.fn(),
      close: vi.fn(),
      getType: () => 'd1',
      healthCheck: vi.fn(async () => true),
    } as unknown as DatabaseAdapter;
  });

  it('persists only blind indexes and prepares the account fail-closed', async () => {
    const publications = await prepareAccountDirectoryRemoval(
      {} as Env,
      { tenantId: 'tenant-a', userId: 'user-a', core, pii },
      100
    );

    expect(publications).toHaveLength(1);
    expect(publications[0].indexes).toHaveLength(4);
    expect(
      publications[0].indexes.map((index) => [index.indexKind, index.hmacKeyGeneration]).sort()
    ).toEqual([
      ['account_id', 6],
      ['account_id', 7],
      ['email_exact', 6],
      ['email_exact', 7],
    ]);
    const insert = executed.find((entry) => entry.sql.includes('account_routing_outbox'));
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert?.params)).not.toContain('person@example.com');
    expect(executed.some((entry) => entry.sql.includes("lifecycle_state = 'deleting'"))).toBe(true);
  });

  it('allows deletion recovery from an active account when its create outbox is pending', async () => {
    await prepareAccountDirectoryRemoval(
      {} as Env,
      { tenantId: 'tenant-a', userId: 'user-a', core, pii },
      100
    );

    const routeQuery = vi
      .mocked(core.queryOne)
      .mock.calls.find(([sql]) => sql.includes("event_kind = 'account_created'"))?.[0];
    expect(routeQuery).toContain("account.lifecycle_state = 'active'");
    expect(routeQuery).toContain("account.directory_publication_state = 'active'");
    expect(routeQuery).not.toContain("outbox.status = 'succeeded'");
  });

  it('chunks many external identities without exceeding the removal contract bound', async () => {
    vi.mocked(pii.query).mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        provider_id: `provider-${index}`,
        provider_user_id: `subject-${index}`,
      }))
    );

    const publications = await prepareAccountDirectoryRemoval(
      {} as Env,
      { tenantId: 'tenant-a', userId: 'user-a', core, pii },
      100
    );

    expect(publications.length).toBeGreaterThan(1);
    expect(publications.every((publication) => publication.indexes.length <= 24)).toBe(true);
    expect(new Set(publications.map((publication) => publication.operationId)).size).toBe(
      publications.length
    );
  });

  it('adopts an existing durable removal without rereading erased PII', async () => {
    const existing = {
      operationId: 'existing-removal',
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      idempotencyKey: 'existing-removal',
      routeProjection: routePublication.routeProjection,
      scope: 'account' as const,
      indexes: routePublication.indexes,
    };
    vi.mocked(core.query).mockResolvedValue([{ payload_json: JSON.stringify(existing) }]);

    await expect(
      prepareAccountDirectoryRemoval(
        {} as Env,
        { tenantId: 'tenant-a', userId: 'user-a', core, pii },
        100
      )
    ).resolves.toEqual([existing]);
    expect(pii.query).not.toHaveBeenCalled();
    expect(pii.queryOne).not.toHaveBeenCalled();
  });

  it('marks every chunk ready after authoritative deletion', async () => {
    await markAccountDirectoryRemovalsReady(
      core,
      [
        {
          operationId: 'one',
          tenantId: 'tenant-a',
          accountId: 'account:user-a',
          idempotencyKey: 'one',
          routeProjection: routePublication.routeProjection,
          scope: 'account',
          indexes: routePublication.indexes,
        },
        {
          operationId: 'two',
          tenantId: 'tenant-a',
          accountId: 'account:user-a',
          idempotencyKey: 'two',
          routeProjection: routePublication.routeProjection,
          scope: 'account',
          indexes: routePublication.indexes,
        },
      ],
      100
    );

    expect(core.execute).toHaveBeenCalledTimes(2);
  });

  it('cancels replacement work before erasing raw account PII', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(pii.batch).mockImplementation(async (statements) => {
      calls.push(
        ...statements.map((statement) => ({
          sql: statement.sql,
          params: statement.params ?? [],
        }))
      );
      return statements.map(() => ({ rowsAffected: 1, success: true }));
    });

    await eraseAccountPiiAfterDirectoryRemovalPrepared(
      pii,
      { tenantId: 'tenant-a', userId: 'user-a' },
      100
    );

    expect(calls[0].sql).toContain('identity_identifier_replacement_operations');
    expect(calls.map((call) => call.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('old_value_json = NULL'),
        expect.stringContaining("normalized_value_json = 'null'"),
        expect.stringContaining('value_json = NULL'),
        expect.stringContaining('DELETE FROM linked_identities'),
        expect.stringContaining('DELETE FROM subject_identifiers'),
      ])
    );
    const subjectDelete = calls.find((call) =>
      call.sql.includes('DELETE FROM subject_identifiers')
    );
    expect(subjectDelete).toEqual({
      sql: expect.stringContaining('tenant_parent.tenant_id = ?'),
      params: ['user-a', 'tenant-a'],
    });
    expect(subjectDelete?.sql).not.toContain('subject_identifiers.tenant_id');
  });
});
