/**
 * Tenant-wide RBAC reads across the tenant's account databases
 *
 * A tenant's role assignments and organisation memberships are account data, spread over its
 * account databases (see tenant-rbac.ts). The admin views that count or list them for the whole
 * tenant read each of those databases (the bounded set of stores the tenant is assigned, each
 * once) and add up or merge what they find. A subject's rows are all in its own account
 * database, so counts of distinct subjects add up across databases.
 *
 * In a single-database deployment the set is that one database.
 */

import type { DatabaseAdapter } from '../db';

/** The tenant's account databases, each once. */
export type TenantAccountStores = readonly DatabaseAdapter[];

/** A row read from one of the account databases, with the index of that database. */
export interface AccountStoreRow<T> {
  store: number;
  row: T;
}

export interface AccountStorePage<T> {
  total: number;
  items: AccountStoreRow<T>[];
}

/**
 * The deepest page (offset + limit) read across several databases. Each database is read from
 * its first row to the end of the page and the rows are merged, so a deeper page costs more in
 * every database.
 */
export const MAX_MERGED_PAGE_WINDOW = 10_000;

/** A page asked for past MAX_MERGED_PAGE_WINDOW across several databases. */
export class MergedPageTooDeepError extends Error {
  constructor() {
    super('rbac_merged_page_too_deep');
    this.name = 'MergedPageTooDeepError';
  }
}

// D1 binds at most 100 parameters per statement; the tenant id and a time take two.
const ID_BATCH_SIZE = 90;

function batches(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const result: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += ID_BATCH_SIZE) {
    result.push(unique.slice(offset, offset + ID_BATCH_SIZE));
  }
  return result;
}

function addCounts(
  total: Map<string, number>,
  rows: readonly { key: string; count: number | null }[]
) {
  for (const { key, count } of rows) total.set(key, (total.get(key) ?? 0) + Number(count ?? 0));
}

/**
 * Role assignments by role, across the databases: the subjects holding each role (`per:
 * 'subject'`) or the assignments themselves (`per: 'assignment'`). Only of `roleIds` when given;
 * only those unexpired at `activeAt` (seconds) when given. Roles nobody holds are absent.
 */
export async function countRoleAssignments(
  stores: TenantAccountStores,
  tenantId: string,
  options: { per: 'subject' | 'assignment'; roleIds?: readonly string[]; activeAt?: number }
): Promise<Map<string, number>> {
  const counted = options.per === 'subject' ? 'COUNT(DISTINCT subject_id)' : 'COUNT(*)';
  const active =
    options.activeAt === undefined ? '' : ' AND (expires_at IS NULL OR expires_at > ?)';
  const activeParams = options.activeAt === undefined ? [] : [options.activeAt];
  const roleBatches = options.roleIds === undefined ? [null] : batches(options.roleIds);
  const total = new Map<string, number>();
  await Promise.all(
    stores.map(async (adapter) => {
      for (const roleIds of roleBatches) {
        if (roleIds?.length === 0) continue;
        const byRole = roleIds ? ` AND role_id IN (${roleIds.map(() => '?').join(', ')})` : '';
        addCounts(
          total,
          await adapter.query<{ key: string; count: number | null }>(
            `SELECT role_id AS key, ${counted} AS count FROM role_assignments
              WHERE tenant_id = ?${byRole}${active}
              GROUP BY role_id`,
            [tenantId, ...(roleIds ?? []), ...activeParams]
          )
        );
      }
    })
  );
  return total;
}

/** Organisation memberships by organisation, across the databases; only of `orgIds` when given. */
export async function countOrganizationMembers(
  stores: TenantAccountStores,
  tenantId: string,
  orgIds?: readonly string[]
): Promise<Map<string, number>> {
  const orgBatches = orgIds === undefined ? [null] : batches(orgIds);
  const total = new Map<string, number>();
  await Promise.all(
    stores.map(async (adapter) => {
      for (const ids of orgBatches) {
        if (ids?.length === 0) continue;
        const byOrg = ids ? ` AND org_id IN (${ids.map(() => '?').join(', ')})` : '';
        addCounts(
          total,
          await adapter.query<{ key: string; count: number | null }>(
            `SELECT org_id AS key, COUNT(*) AS count FROM subject_org_membership
              WHERE tenant_id = ?${byOrg}
              GROUP BY org_id`,
            [tenantId, ...(ids ?? [])]
          )
        );
      }
    })
  );
  return total;
}

interface NewestFirst {
  id: string;
  created_at: number;
}

function newestFirst(left: NewestFirst, right: NewestFirst): number {
  return (
    Number(right.created_at) - Number(left.created_at) ||
    (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)
  );
}

/**
 * One page of rows, newest first (created_at, then id, descending), across the databases. With
 * one database the page is read as it is; with several, each is read up to the end of the page
 * and the rows merged, up to MAX_MERGED_PAGE_WINDOW.
 */
async function newestFirstPage<T extends NewestFirst>(
  dbs: TenantAccountStores,
  page: { limit: number; offset: number },
  read: (adapter: DatabaseAdapter, limit: number, offset: number) => Promise<T[]>
): Promise<AccountStoreRow<T>[]> {
  if (dbs.length === 1) {
    return (await read(dbs[0]!, page.limit, page.offset)).map((row) => ({ store: 0, row }));
  }
  const window = page.offset + page.limit;
  if (window > MAX_MERGED_PAGE_WINDOW) throw new MergedPageTooDeepError();
  const perStore = await Promise.all(dbs.map((adapter) => read(adapter, window, 0)));
  return perStore
    .flatMap((rows, store) => rows.map((row) => ({ store, row })))
    .sort((left, right) => newestFirst(left.row, right.row))
    .slice(page.offset, window);
}

async function sumCounts(
  dbs: TenantAccountStores,
  sql: string,
  params: unknown[]
): Promise<number> {
  const counts = await Promise.all(
    dbs.map((adapter) => adapter.queryOne<{ count: number | null }>(sql, params))
  );
  return counts.reduce((sum, row) => sum + Number(row?.count ?? 0), 0);
}

export interface RoleAssignmentListRow {
  id: string;
  subject_id: string;
  scope_type: string;
  scope_target: string;
  assigned_by: string | null;
  expires_at: number | null;
  created_at: number;
}

/** The unexpired assignments of a role at `activeAt` (seconds), newest first, a page of them. */
export async function listRoleAssignmentsPage(
  stores: TenantAccountStores,
  tenantId: string,
  roleId: string,
  page: { activeAt: number; limit: number; offset: number }
): Promise<AccountStorePage<RoleAssignmentListRow>> {
  const [total, items] = await Promise.all([
    sumCounts(
      stores,
      `SELECT COUNT(*) AS count FROM role_assignments
        WHERE tenant_id = ? AND role_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, roleId, page.activeAt]
    ),
    newestFirstPage(stores, page, (adapter, limit, offset) =>
      adapter.query<RoleAssignmentListRow>(
        `SELECT id, subject_id, scope_type, scope_target, assigned_by, expires_at, created_at
           FROM role_assignments
          WHERE tenant_id = ? AND role_id = ? AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
        [tenantId, roleId, page.activeAt, limit, offset]
      )
    ),
  ]);
  return { total, items };
}

export interface OrganizationMemberListRow {
  id: string;
  subject_id: string;
  org_id: string;
  membership_type: string;
  is_primary: number | boolean | null;
  created_at: number;
}

/** The members of an organisation, newest first, a page of them. */
export async function listOrganizationMembersPage(
  stores: TenantAccountStores,
  tenantId: string,
  orgId: string,
  page: { limit: number; offset: number }
): Promise<AccountStorePage<OrganizationMemberListRow>> {
  const [total, items] = await Promise.all([
    sumCounts(
      stores,
      'SELECT COUNT(*) AS count FROM subject_org_membership WHERE tenant_id = ? AND org_id = ?',
      [tenantId, orgId]
    ),
    newestFirstPage(stores, page, (adapter, limit, offset) =>
      adapter.query<OrganizationMemberListRow>(
        `SELECT id, subject_id, org_id, membership_type, is_primary, created_at
           FROM subject_org_membership
          WHERE tenant_id = ? AND org_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
        [tenantId, orgId, limit, offset]
      )
    ),
  ]);
  return { total, items };
}
