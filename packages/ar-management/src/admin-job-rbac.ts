/**
 * The RBAC parts of admin jobs: organisation bulk membership changes and the access summary
 * report. Organisations are tenant settings, in the tenant metadata database; memberships are
 * account data, each in its account's database.
 */
import {
  countOrganizationMembers,
  ensureDatabaseAdapter,
  resolveAccountCoreDataContext,
  resolveTenantMetadataContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { tenantCoreStores } from './compliance/tenant-stores';
import { isInactiveAccountRouteError } from './rbac-account-stores';
import { usesRoutedAccountStorage } from './tenant-routed-storage';

export interface JobRBACStores {
  /** The tenant metadata database: organisation definitions. */
  metadata: DatabaseAdapter;
  /** The database of the user's account, or null when the tenant has no active such account. */
  accountOf(userId: string): Promise<DatabaseAdapter | null>;
  /** Every database the tenant's accounts are in, each once. */
  accounts(): Promise<DatabaseAdapter[]>;
}

/** The tenant's RBAC databases for a job (which has no request to resolve them from). */
export async function jobRBACStores(env: Env, tenantId: string): Promise<JobRBACStores> {
  const context = await resolveTenantMetadataContext(env, tenantId);
  const metadata = ensureDatabaseAdapter(context.coreDb, 'admin-job-rbac-metadata');
  if (!usesRoutedAccountStorage(context)) {
    return { metadata, accountOf: async () => metadata, accounts: async () => [metadata] };
  }
  return {
    metadata,
    async accountOf(userId) {
      try {
        const account = await resolveAccountCoreDataContext(env, { tenantId, accountId: userId });
        return ensureDatabaseAdapter(account.coreDb, 'admin-job-rbac-account');
      } catch (error) {
        // No account, or one no longer active: neither may join or leave an organisation.
        if (
          (error instanceof Error && error.message === 'account_data_route_not_found') ||
          isInactiveAccountRouteError(error)
        ) {
          return null;
        }
        throw error;
      }
    },
    async accounts() {
      const stores = await tenantCoreStores(env, tenantId, {
        accountsOfRoutedTenant: true,
        purpose: 'admin-job-rbac',
      });
      return stores.map((store) => store.adapter);
    },
  };
}

export interface OrganizationBulkMembersInput {
  tenantId: string;
  orgId: string;
  action: 'add' | 'remove';
  membershipType: 'member' | 'admin' | 'owner';
  userIds: readonly string[];
  nowSeconds: number;
}

export interface OrganizationBulkMembersOutcome {
  succeeded: number;
  skipped: number;
  failures: Array<{ user_id: string; error: string }>;
}

/**
 * Adds or removes the users' memberships of the organisation, each in its account's database.
 * A user without an active account fails; adding a membership the user has fails; removing one
 * the user does not have is skipped.
 */
export async function applyOrganizationBulkMembers(
  stores: JobRBACStores,
  input: OrganizationBulkMembersInput
): Promise<OrganizationBulkMembersOutcome> {
  const { tenantId, orgId } = input;
  const org = await stores.metadata.queryOne<{ id: string }>(
    'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
    [orgId, tenantId]
  );
  if (!org) throw new Error('Organization does not belong to the job tenant');

  const outcome: OrganizationBulkMembersOutcome = { succeeded: 0, skipped: 0, failures: [] };
  for (const userId of input.userIds) {
    const account = await stores.accountOf(userId);
    const user = await account?.queryOne<{ id: string }>(
      "SELECT legacy_user_id as id FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ? AND lifecycle_state = 'active'",
      [userId, tenantId]
    );
    if (!account || !user) {
      outcome.failures.push({ user_id: userId, error: 'user_not_found' });
      continue;
    }

    const existing = await account.queryOne<{ id: string }>(
      `SELECT id FROM subject_org_membership
       WHERE tenant_id = ? AND org_id = ? AND subject_id = ?`,
      [tenantId, orgId, userId]
    );

    if (input.action === 'add') {
      if (existing) {
        outcome.failures.push({ user_id: userId, error: 'membership_already_exists' });
        continue;
      }
      await account.execute(
        `INSERT INTO subject_org_membership (
          id, tenant_id, subject_id, org_id, membership_type, is_primary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          userId,
          orgId,
          input.membershipType,
          input.nowSeconds,
          input.nowSeconds,
        ]
      );
      outcome.succeeded += 1;
      continue;
    }

    if (!existing) {
      outcome.skipped += 1;
      continue;
    }
    await account.execute(
      'DELETE FROM subject_org_membership WHERE tenant_id = ? AND org_id = ? AND subject_id = ?',
      [tenantId, orgId, userId]
    );
    outcome.succeeded += 1;
  }
  return outcome;
}

/** The access summary report: the tenant's organisations and the memberships of them. */
export async function accessSummaryRows(
  stores: JobRBACStores,
  tenantId: string
): Promise<Array<{ metric: string; count: number }>> {
  const [organizations, accounts] = await Promise.all([
    stores.metadata.query<{ id: string }>('SELECT id FROM organizations WHERE tenant_id = ?', [
      tenantId,
    ]),
    stores.accounts(),
  ]);
  const members = await countOrganizationMembers(accounts, tenantId);
  return [
    { metric: 'organizations', count: organizations.length },
    {
      metric: 'organization_memberships',
      count: organizations.reduce((sum, org) => sum + (members.get(org.id) ?? 0), 0),
    },
  ];
}
