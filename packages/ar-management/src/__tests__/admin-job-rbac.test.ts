import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const routes = vi.hoisted(() => ({
  metadata: null as unknown,
  /** The tenant's user stores, in the registry. */
  userStores: [] as unknown[],
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveTenantMetadataContext: vi.fn(async (_env: unknown, tenantId: string) => ({
    tenantId,
    coreDb: routes.metadata,
    route: { allocationScope: 'shared_pool' },
  })),
  resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(async () =>
    routes.userStores.map((source, index) => ({ bindingRef: `DB_USERS_${index}`, source }))
  ),
}));

import { accessSummaryRows, jobRBACStores, type JobRBACStores } from '../admin-job-rbac';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter };

const NOW = 1_800_000_000;

function join(store: Store, id: string, groupId: string, subjectId: string, source = 'manual') {
  store.db
    .prepare(
      `INSERT INTO group_memberships
         (id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, ?)`
    )
    .run(id, groupId, subjectId, source, source === 'manual' ? '' : id, NOW, NOW);
}

/**
 * Groups in the tenant metadata database, memberships in each account's database: three separate
 * SQLite databases, as the job meets three D1 databases.
 */
describe('admin job RBAC under routed account storage', () => {
  let metadata: Store;
  let first: Store;
  let second: Store;
  let stores: JobRBACStores;

  beforeEach(() => {
    metadata = openCoreStore();
    first = openCoreStore();
    second = openCoreStore();
    metadata.db
      .prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, created_at, updated_at)
         VALUES ('grp-1', 'tenant-a', 'one', 'Group One', ?, ?),
                ('grp-2', 'tenant-a', 'two', 'Group Two', ?, ?)`
      )
      .run(NOW, NOW, NOW, NOW);
    stores = {
      metadata: metadata.adapter,
      accounts: async () => [first.adapter, second.adapter],
    };
  });

  it('summarises groups and their members across the account databases', async () => {
    join(first, 'm-1', 'grp-1', 'user-1');
    // A second source of the same membership counts the subject once.
    join(first, 'm-1b', 'grp-1', 'user-1', 'scim');
    join(second, 'm-2', 'grp-1', 'user-2');
    join(second, 'm-3', 'grp-2', 'user-2');
    // A membership of a group since removed is not one of the tenant's groups'.
    join(second, 'm-gone', 'grp-gone', 'user-2');

    expect(await accessSummaryRows(stores, 'tenant-a')).toEqual([
      { metric: 'groups', count: 2 },
      { metric: 'group_memberships', count: 3 },
    ]);
  });

  it('reads every user store of a routed tenant', async () => {
    routes.metadata = metadata.adapter;
    routes.userStores = [first.adapter, second.adapter];
    join(first, 'm-1', 'grp-1', 'user-1');
    join(second, 'm-2', 'grp-2', 'user-2');

    const resolved = await jobRBACStores({} as never, 'tenant-a');

    expect(resolved.metadata).toBe(metadata.adapter);
    expect(await accessSummaryRows(resolved, 'tenant-a')).toEqual([
      { metric: 'groups', count: 2 },
      { metric: 'group_memberships', count: 2 },
    ]);
  });
});
