import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const routes = vi.hoisted(() => ({
  metadata: null as unknown,
  accounts: new Map<string, unknown>(),
  suspended: new Set<string>(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveTenantMetadataContext: vi.fn(async (_env: unknown, tenantId: string) => ({
    tenantId,
    coreDb: routes.metadata,
    route: { allocationScope: 'shared_pool' },
  })),
  resolveAccountCoreDataContext: vi.fn(async (_env: unknown, input: { accountId: string }) => {
    if (routes.suspended.has(input.accountId)) {
      throw new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' });
    }
    const coreDb = routes.accounts.get(input.accountId);
    if (!coreDb) throw new Error('account_data_route_not_found');
    return { coreDb };
  }),
}));

import {
  accessSummaryRows,
  applyOrganizationBulkMembers,
  jobRBACStores,
  type JobRBACStores,
} from '../admin-job-rbac';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter };

const NOW = 1_800_000_000;

function addAccount(store: Store, id: string, lifecycle = 'active') {
  store.db
    .prepare(
      `INSERT INTO users_core (id, tenant_id, created_at, updated_at) VALUES (?, 'tenant-a', ?, ?)`
    )
    .run(id, NOW, NOW);
  store.db
    .prepare(
      `INSERT INTO identity_accounts
         (id, tenant_id, account_type, lifecycle_state, legacy_user_id, created_at, updated_at)
       VALUES (?, 'tenant-a', 'user', ?, ?, ?, ?)`
    )
    .run(`account:${id}`, lifecycle, id, NOW, NOW);
}

function memberships(store: Store) {
  return store.db
    .prepare(
      `SELECT subject_id, org_id, membership_type FROM subject_org_membership
        WHERE tenant_id = 'tenant-a' ORDER BY subject_id, org_id`
    )
    .all();
}

/**
 * Organisations in the tenant metadata database, memberships in each account's database: three
 * separate SQLite databases, as the job meets three D1 databases.
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
        `INSERT INTO organizations (id, tenant_id, name, created_at, updated_at)
         VALUES ('org-1', 'tenant-a', 'Org One', ?, ?), ('org-2', 'tenant-a', 'Org Two', ?, ?)`
      )
      .run(NOW, NOW, NOW, NOW);
    addAccount(first, 'user-1');
    addAccount(second, 'user-2');
    addAccount(second, 'user-gone', 'deleted');
    const routes = new Map<string, DatabaseAdapter>([
      ['user-1', first.adapter],
      ['user-2', second.adapter],
      ['user-gone', second.adapter],
    ]);
    stores = {
      metadata: metadata.adapter,
      accountOf: async (userId) => routes.get(userId) ?? null,
      accounts: async () => [first.adapter, second.adapter],
    };
  });

  it("adds each membership in its member's account database", async () => {
    const outcome = await applyOrganizationBulkMembers(stores, {
      tenantId: 'tenant-a',
      orgId: 'org-1',
      action: 'add',
      membershipType: 'admin',
      userIds: ['user-1', 'user-2', 'user-gone', 'user-unknown'],
      nowSeconds: NOW,
    });

    expect(outcome).toEqual({
      succeeded: 2,
      skipped: 0,
      failures: [
        { user_id: 'user-gone', error: 'user_not_found' },
        { user_id: 'user-unknown', error: 'user_not_found' },
      ],
    });
    expect(memberships(first)).toEqual([
      { subject_id: 'user-1', org_id: 'org-1', membership_type: 'admin' },
    ]);
    expect(memberships(second)).toEqual([
      { subject_id: 'user-2', org_id: 'org-1', membership_type: 'admin' },
    ]);
    expect(memberships(metadata)).toEqual([]);

    const again = await applyOrganizationBulkMembers(stores, {
      tenantId: 'tenant-a',
      orgId: 'org-1',
      action: 'add',
      membershipType: 'member',
      userIds: ['user-2'],
      nowSeconds: NOW,
    });
    expect(again.failures).toEqual([{ user_id: 'user-2', error: 'membership_already_exists' }]);
  });

  it("removes each membership from its member's account database", async () => {
    await applyOrganizationBulkMembers(stores, {
      tenantId: 'tenant-a',
      orgId: 'org-1',
      action: 'add',
      membershipType: 'member',
      userIds: ['user-1', 'user-2'],
      nowSeconds: NOW,
    });
    const outcome = await applyOrganizationBulkMembers(stores, {
      tenantId: 'tenant-a',
      orgId: 'org-1',
      action: 'remove',
      membershipType: 'member',
      userIds: ['user-2', 'user-2'],
      nowSeconds: NOW,
    });

    expect(outcome).toEqual({ succeeded: 1, skipped: 1, failures: [] });
    expect(memberships(first)).toHaveLength(1);
    expect(memberships(second)).toEqual([]);
  });

  it('resolves each member through its route, a suspended or unknown one as no account', async () => {
    routes.metadata = metadata.adapter;
    routes.accounts = new Map([
      ['user-1', first.adapter],
      ['user-2', second.adapter],
    ]);
    routes.suspended = new Set(['user-2']);
    const resolved = await jobRBACStores({} as never, 'tenant-a');

    const outcome = await applyOrganizationBulkMembers(resolved, {
      tenantId: 'tenant-a',
      orgId: 'org-1',
      action: 'add',
      membershipType: 'member',
      userIds: ['user-2', 'user-unknown', 'user-1'],
      nowSeconds: NOW,
    });

    // The suspended member does not stop the job: the members after it are still added.
    expect(outcome).toEqual({
      succeeded: 1,
      skipped: 0,
      failures: [
        { user_id: 'user-2', error: 'user_not_found' },
        { user_id: 'user-unknown', error: 'user_not_found' },
      ],
    });
    expect(memberships(first)).toEqual([
      { subject_id: 'user-1', org_id: 'org-1', membership_type: 'member' },
    ]);
  });

  it('refuses an organisation the tenant does not have', async () => {
    await expect(
      applyOrganizationBulkMembers(stores, {
        tenantId: 'tenant-a',
        orgId: 'org-other',
        action: 'add',
        membershipType: 'member',
        userIds: ['user-1'],
        nowSeconds: NOW,
      })
    ).rejects.toThrow('Organization does not belong to the job tenant');
  });

  it('summarises organisations and their memberships across the account databases', async () => {
    await applyOrganizationBulkMembers(stores, {
      tenantId: 'tenant-a',
      orgId: 'org-1',
      action: 'add',
      membershipType: 'member',
      userIds: ['user-1', 'user-2'],
      nowSeconds: NOW,
    });
    // A membership of an organisation since removed is not one of the tenant's organisations'.
    second.db
      .prepare(
        `INSERT INTO subject_org_membership
           (id, tenant_id, subject_id, org_id, membership_type, is_primary, created_at, updated_at)
         VALUES ('m-gone', 'tenant-a', 'user-2', 'org-gone', 'member', 0, ?, ?)`
      )
      .run(NOW, NOW);

    expect(await accessSummaryRows(stores, 'tenant-a')).toEqual([
      { metric: 'organizations', count: 2 },
      { metric: 'organization_memberships', count: 2 },
    ]);
  });
});
