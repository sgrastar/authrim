/**
 * The RBAC parts of admin jobs: the access summary report. Groups are tenant settings, in the
 * tenant metadata database; memberships are account data, each in its account's database.
 */
import {
  countGroupMembers,
  ensureDatabaseAdapter,
  resolveTenantMetadataContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { tenantCoreStores } from './compliance/tenant-stores';
import { usesRoutedAccountStorage } from './tenant-routed-storage';

export interface JobRBACStores {
  /** The tenant metadata database: group definitions. */
  metadata: DatabaseAdapter;
  /** Every database the tenant's accounts are in, each once. */
  accounts(): Promise<DatabaseAdapter[]>;
}

/** The tenant's RBAC databases for a job (which has no request to resolve them from). */
export async function jobRBACStores(env: Env, tenantId: string): Promise<JobRBACStores> {
  const context = await resolveTenantMetadataContext(env, tenantId);
  const metadata = ensureDatabaseAdapter(context.coreDb, 'admin-job-rbac-metadata');
  if (!usesRoutedAccountStorage(context)) {
    return { metadata, accounts: async () => [metadata] };
  }
  return {
    metadata,
    async accounts() {
      const stores = await tenantCoreStores(env, tenantId, {
        accountsOfRoutedTenant: true,
        purpose: 'admin-job-rbac',
      });
      return stores.map((store) => store.adapter);
    },
  };
}

/**
 * The access summary report: the tenant's groups and the subjects whose membership of them holds
 * now (a subject counted once per group, however many sources give it the membership).
 */
export async function accessSummaryRows(
  stores: JobRBACStores,
  tenantId: string
): Promise<Array<{ metric: string; count: number }>> {
  const [groups, accounts] = await Promise.all([
    stores.metadata.query<{ id: string }>('SELECT id FROM "groups" WHERE tenant_id = ?', [
      tenantId,
    ]),
    stores.accounts(),
  ]);
  const members = await countGroupMembers(
    accounts,
    tenantId,
    groups.map((group) => group.id)
  );
  return [
    { metric: 'groups', count: groups.length },
    {
      metric: 'group_memberships',
      count: groups.reduce((sum, group) => sum + (members.get(group.id) ?? 0), 0),
    },
  ];
}
