/**
 * Admin Compliance API Endpoints
 *
 * Compliance monitoring and status for administrative dashboard:
 * - GET  /api/admin/compliance/status          - Compliance checks and the facts behind them
 * Access reviews: compliance/access-reviews.ts. Reports: compliance/report-routes.ts.
 *
 * Security:
 * - RBAC: ar_tenant_admin or higher required
 * - Rate limit: moderate profile
 * - Tenant isolation: All queries filtered by tenant_id
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import { createLogReadAdapter } from './log-read-adapter';
import { logQueryErrorResponse } from './log-archive-query';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  type DatabaseAdapter,
  getTenantIdFromContext,
  getLogger,
  requireAdminDatabaseAdapter,
  ensureDatabaseAdapter,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  getTenantMetadataContextFromHono,
  resolveTenantAuditProfileFromEnv,
  rbacIdBatches,
  type AuditProfile,
} from '@authrim/ar-lib-core';
import {
  getAuditHotQuerySqlSpec,
  getAuditHotQuerySupportForProfile,
  getAuditTimeRange,
} from './audit-hot-query';
import {
  buildComplianceChecks,
  summarizeFrameworks,
  worstStatus,
} from './compliance/compliance-checks';
import { countAdminMfa, countUserMfa, readMfaEnforcement } from './compliance/mfa-coverage';
import { usesRoutedAccountStorage } from './tenant-routed-storage';
import { tenantCoreStores } from './compliance/tenant-stores';
import {
  buildRetentionInventory,
  type RetentionCategoryId,
} from './compliance/retention-inventory';
import { retentionAttention } from './routes/settings/data-retention';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create database adapter from context
 */
function createAdapter(c: Context<{ Bindings: Env }>, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

// =============================================================================
// Handlers
// =============================================================================

/** Admin audit records: all of them, and those of the last 30 days. */
async function adminAuditLogStats(env: Env, tenantId: string, fromMs: number) {
  const logRead = createLogReadAdapter({ env, tenantId, dataset: 'admin.admin_audit_log' });
  const row = await logRead.adapter.queryOne<{
    total: number | null;
    last_30_days: number | null;
  }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_30_days
       FROM admin_audit_log
      WHERE tenant_id = ?`,
    [fromMs, tenantId]
  );
  return { total: Number(row?.total ?? 0), last30Days: Number(row?.last_30_days ?? 0) };
}

async function auditLogStats(env: Env, auditProfile: AuditProfile, tenantId: string) {
  const hotQuery = getAuditHotQuerySupportForProfile(env, auditProfile, tenantId);
  if (!hotQuery.supported || !hotQuery.context) {
    return {
      hotQueryStatus: hotQuery.status,
      total: null,
      last30Days: null,
      adminTotal: null,
      adminLast30Days: null,
    };
  }
  const nowTs = Math.floor(Date.now() / 1000);
  const context = hotQuery.context;
  const logRead = createLogReadAdapter({
    env,
    tenantId,
    adapter: context.adapter,
    dataset: context.mode === 'legacy' ? 'core.audit_log' : 'core.event_log',
  });
  const { tableName } = getAuditHotQuerySqlSpec(hotQuery.context);
  const [fromTs] = getAuditTimeRange(nowTs - 30 * 24 * 60 * 60, nowTs, hotQuery.context);
  const row = await logRead.adapter.queryOne<{
    total: number | null;
    last_30_days: number | null;
  }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_30_days
       FROM ${tableName}
      WHERE tenant_id = ?`,
    [fromTs, tenantId]
  );
  // Admin operations are recorded in the admin audit log, which keeps milliseconds.
  const admin = await adminAuditLogStats(env, tenantId, (nowTs - 30 * 24 * 60 * 60) * 1000);
  return {
    hotQueryStatus: 'supported' as const,
    total: Number(row?.total ?? 0),
    last30Days: Number(row?.last_30_days ?? 0),
    adminTotal: admin.total,
    adminLast30Days: admin.last30Days,
  };
}

/** Rows read per statement when counting users with a role across stores. */
const ROLE_USER_PAGE = 5000;

/** The deepest group nesting followed, as the RBAC evaluation does (resolveGroupAncestors). */
const MAX_GROUP_DEPTH = 16;

/**
 * The groups whose members hold a role through them: an active group with an unexpired role
 * assignment of one of `roleIds`, and every active group below it (a member of a child holds what
 * its ancestors are given). An inactive group grants nothing and ends the path through it, as in
 * resolveGroupAncestors. Read from the granted groups down, so a tenant whose groups hold no role
 * reads one statement.
 */
async function roleHoldingGroups(
  adapter: DatabaseAdapter,
  tenantId: string,
  roleIds: Set<string>,
  nowSeconds: number
): Promise<Set<string>> {
  const grants = await adapter.query<{ group_id: string; role_id: string }>(
    `SELECT group_id, role_id FROM group_role_assignments
      WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    [tenantId, nowSeconds]
  );
  const granted = [
    ...new Set(grants.filter((grant) => roleIds.has(grant.role_id)).map((grant) => grant.group_id)),
  ];
  const holding = new Set<string>();
  if (granted.length === 0) return holding;
  type Node = { id: string; lifecycle_state: string };
  const read = async (column: 'id' | 'parent_group_id', ids: string[]) => {
    const nodes: Node[] = [];
    for (const batch of rbacIdBatches(ids)) {
      nodes.push(
        ...(await adapter.query<Node>(
          `SELECT id, lifecycle_state FROM "groups"
            WHERE tenant_id = ? AND ${column} IN (${batch.map(() => '?').join(', ')})`,
          [tenantId, ...batch]
        ))
      );
    }
    return nodes;
  };
  let frontier = await read('id', granted);
  for (let depth = 0; depth <= MAX_GROUP_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      if (node.lifecycle_state !== 'active' || holding.has(node.id)) continue;
      holding.add(node.id);
      next.push(node.id);
    }
    frontier = next.length > 0 ? await read('parent_group_id', next) : [];
  }
  return holding;
}

/**
 * Roles defined for the tenant, and users holding one: an unexpired role assignment of the user,
 * or a membership in force of a group that holds a role (an unexpired group role assignment, of
 * the group or an ancestor). The roles, groups and group role assignments are in the metadata
 * database (`adapter`); the users' assignments and memberships are read in every store they may
 * be in (a routed tenant keeps them with each account), each user counted once across them.
 * Counted per tenant from the tables, not per user, so the report never walks every account.
 */
export async function roleUsage(env: Env, tenantId: string, adapter: DatabaseAdapter) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [roles, stores] = await Promise.all([
    adapter.query<{ id: string }>('SELECT id FROM roles WHERE tenant_id = ?', [tenantId]),
    tenantCoreStores(env, tenantId),
  ]);
  const roleIds = new Set(roles.map((role) => role.id));
  const groupIds = await roleHoldingGroups(adapter, tenantId, roleIds, nowSeconds);
  const scanMemberships = groupIds.size > 0;
  const users = new Set<string>();
  await Promise.all(
    stores.map(async ({ adapter: store }) => {
      let after = { userId: '', ref: '' };
      for (;;) {
        // `r:<role>` for a direct assignment, `g:<group>` for a membership in force (read only
        // when some group holds a role).
        const page = await store.query<{ user_id: string; ref: string }>(
          `SELECT user_id, ref FROM (
             SELECT subject_id AS user_id, 'r:' || role_id AS ref
               FROM role_assignments
              WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)${
                scanMemberships
                  ? `
             UNION
             SELECT subject_id AS user_id, 'g:' || group_id AS ref
               FROM group_memberships
              WHERE tenant_id = ? AND lifecycle_state = 'active'
                AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at > ?)
                AND (stale_after IS NULL OR stale_after > ?)`
                  : ''
              }
           ) AS holdings
           WHERE user_id > ? OR (user_id = ? AND ref > ?)
           ORDER BY user_id, ref
           LIMIT ?`,
          [
            tenantId,
            nowSeconds,
            ...(scanMemberships ? [tenantId, nowSeconds, nowSeconds, nowSeconds] : []),
            after.userId,
            after.userId,
            after.ref,
            ROLE_USER_PAGE,
          ]
        );
        for (const row of page) {
          const id = row.ref.slice(2);
          if (row.ref.startsWith('r:') ? roleIds.has(id) : groupIds.has(id)) users.add(row.user_id);
        }
        if (page.length < ROLE_USER_PAGE) break;
        const last = page[page.length - 1];
        after = { userId: last.user_id, ref: last.ref };
      }
    })
  );
  return {
    active_roles: roleIds.size,
    users_with_roles: users.size,
  };
}

/**
 * GET /api/admin/compliance/status
 *
 * The tenant's compliance checks (each a fact read from what Authrim enforces, tagged with the
 * frameworks it supports) and the facts behind them: data retention, audit logging, MFA
 * enforcement and coverage for admins and users, and role-based access. Answers 503 when any of
 * them cannot be read, rather than reporting a default as the state.
 */
export async function adminComplianceStatusHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('ADMIN-COMPLIANCE');
  try {
    return c.json(await readComplianceStatus(c));
  } catch (error) {
    const incomplete = logQueryErrorResponse(c, error);
    if (incomplete) return incomplete;
    log.warn('Compliance status could not be read', { tenantId, error: String(error) });
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The compliance status cannot be read; try again',
      },
      503
    );
  }
}

/** The tenant's compliance status (what the status API answers); throws when any part cannot be read. */
export async function readComplianceStatus(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const adapter = createAdapter(c, tenantId);
  const adminAdapter = requireAdminDatabaseAdapter(c.env, 'admin-compliance-mfa');
  // One strict read of the audit profile for the retention and the counts.
  const auditProfile = await resolveTenantAuditProfileFromEnv(c.env, tenantId, { strict: true });
  const piiStores = await resolveTenantAssignedDatabaseSourcesFromRegistry(c.env, {
    tenantId,
    role: 'tenant_pii',
    dataRole: 'tenant_pii',
    maxStores: 32,
    concurrency: 4,
  });
  const [retention, audit, enforcement, admins, users, rbac] = await Promise.all([
    buildRetentionInventory({
      env: c.env,
      tenantId,
      coreAdapter: adapter,
      auditProfile,
      piiAdapters: piiStores.map((store, index) =>
        ensureDatabaseAdapter(store.source, `compliance-pii:${index}`)
      ),
    }),
    auditLogStats(c.env, auditProfile, tenantId),
    readMfaEnforcement(c.env, tenantId),
    countAdminMfa(adminAdapter, tenantId),
    countUserMfa(c.env, tenantId, {
      routed: usesRoutedAccountStorage(getTenantMetadataContextFromHono(c)),
    }),
    roleUsage(c.env, tenantId, adapter),
  ]);

  const attention = retentionAttention(retention);
  const retentionDays = (id: RetentionCategoryId) =>
    retention.find((category) => category.id === id)?.retention.value ?? null;
  const expiredRecords = retention.reduce(
    (sum, category) => sum + (category.counts?.expired ?? 0),
    0
  );
  const access = rbac;
  const checks = buildComplianceChecks({
    retention: { attention, expired_records: expiredRecords },
    audit: {
      hot_query_status: audit.hotQueryStatus,
      // Both logs count: a tenant whose only activity was admin work is still being audited.
      entries_last_30_days:
        audit.last30Days === null ? null : audit.last30Days + (audit.adminLast30Days ?? 0),
    },
    mfa: { enforcement, admins, users },
    rbac: access,
  });

  return {
    tenant_id: tenantId,
    overall_status: worstStatus(checks.map((check) => check.status)),
    frameworks: summarizeFrameworks(checks),
    checks,
    data_retention: { expired_records: expiredRecords, attention },
    audit_log: {
      enabled: true,
      event_retention_days: retentionDays('audit_events'),
      pii_retention_days: retentionDays('audit_pii'),
      total_entries: audit.total,
      entries_last_30_days: audit.last30Days,
      admin_total_entries: audit.adminTotal,
      admin_entries_last_30_days: audit.adminLast30Days,
      hot_query_status: audit.hotQueryStatus,
    },
    mfa: { enforcement, admins, users },
    access_control: access,
    accounts: { pending_deletions: users.deleting },
    generated_at: new Date().toISOString(),
  };
}
