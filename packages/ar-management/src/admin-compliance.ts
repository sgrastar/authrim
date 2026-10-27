/**
 * Admin Compliance API Endpoints
 *
 * Compliance monitoring and status for administrative dashboard:
 * - GET  /api/admin/compliance/status          - Compliance checks and the facts behind them
 * Access reviews: compliance/access-reviews.ts. Reports: compliance/report-routes.ts.
 *
 * Security:
 * - RBAC: tenant_admin or higher required
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
  resolveTenantRuntimeProfilesFromEnv,
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

async function auditLogStats(env: Env, auditProfile: AuditProfile, tenantId: string) {
  const hotQuery = getAuditHotQuerySupportForProfile(env, auditProfile, tenantId);
  if (!hotQuery.supported || !hotQuery.context) {
    return { hotQueryStatus: hotQuery.status, total: null, last30Days: null };
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
  return {
    hotQueryStatus: 'supported' as const,
    total: Number(row?.total ?? 0),
    last30Days: Number(row?.last_30_days ?? 0),
  };
}

/** Rows read per statement when counting users with a role across stores. */
const ROLE_USER_PAGE = 5000;

/**
 * Roles defined for the tenant, and users holding one: an unexpired role assignment, or a role
 * SCIM gave them (user_roles, which sign-in reads too). The roles are in the metadata database
 * (`adapter`); the assignments are read in every store they may be in (a routed tenant keeps them
 * with each account, its SCIM roles may be in another store) and kept when they name one of the
 * roles, each user counted once across them.
 */
export async function roleUsage(env: Env, tenantId: string, adapter: DatabaseAdapter) {
  const [roles, stores] = await Promise.all([
    adapter.query<{ id: string }>('SELECT id FROM roles WHERE tenant_id = ?', [tenantId]),
    tenantCoreStores(env, tenantId),
  ]);
  const roleIds = new Set(roles.map((role) => role.id));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const users = new Set<string>();
  await Promise.all(
    stores.map(async ({ adapter: store }) => {
      let after = { userId: '', roleId: '' };
      for (;;) {
        const page = await store.query<{ user_id: string; role_id: string }>(
          `SELECT user_id, role_id FROM (
             SELECT subject_id AS user_id, role_id
               FROM role_assignments
              WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)
             UNION
             SELECT user_id, role_id
               FROM user_roles
              WHERE tenant_id = ?
           )
           WHERE user_id > ? OR (user_id = ? AND role_id > ?)
           ORDER BY user_id, role_id
           LIMIT ?`,
          [tenantId, nowSeconds, tenantId, after.userId, after.userId, after.roleId, ROLE_USER_PAGE]
        );
        for (const row of page) if (roleIds.has(row.role_id)) users.add(row.user_id);
        if (page.length < ROLE_USER_PAGE) break;
        const last = page[page.length - 1]!;
        after = { userId: last.user_id, roleId: last.role_id };
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
  const auditProfile = (
    await resolveTenantRuntimeProfilesFromEnv(c.env, tenantId, { strict: true })
  ).auditProfile;
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
      entries_last_30_days: audit.last30Days,
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
      hot_query_status: audit.hotQueryStatus,
    },
    mfa: { enforcement, admins, users },
    access_control: access,
    accounts: { pending_deletions: users.deleting },
    generated_at: new Date().toISOString(),
  };
}
