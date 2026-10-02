/**
 * Compliance reports: a file an admin generates as evidence (an access review's decisions and
 * what applying them did, who has MFA, the compliance checks at that moment, audit log entries of
 * a period), kept encrypted for REPORT_EXPIRY_DAYS and then deleted.
 *
 * A report is generated when it is requested, up to MAX_REPORT_ROWS rows (beyond that it fails as
 * too large rather than being cut short). The file is stored encrypted in EXPORT_ARTIFACTS and
 * catalogued in the admin database, whose catalog the artifact cleanup deletes from once the
 * compliance_report_retention task marks the report expired. Rows identify people by their IDs,
 * never adding names or email addresses; the reasons reviewers wrote are included as written
 * (they are the review's evidence).
 */
import {
  DEFAULT_ADMIN_SIGN_IN_ROLES,
  ensureDatabaseAdapter,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  tombstoneObjectCatalogEntryForTenant,
  type AuditProfile,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { toCsv } from '../admin-job-executor';
import {
  fromStoredAuditTimestamp,
  getAuditHotQuerySqlSpec,
  getAuditHotQuerySupportForProfile,
} from '../audit-hot-query';

export const COMPLIANCE_REPORT_TYPES = [
  'access_review',
  'mfa_coverage',
  'compliance_status',
  'audit_log',
] as const;
export type ComplianceReportType = (typeof COMPLIANCE_REPORT_TYPES)[number];

/** Rows a report may have; a larger one fails (too_large) instead of being cut short. */
export const MAX_REPORT_ROWS = 10_000;
/** Days a generated report can be downloaded before it is deleted. */
export const REPORT_EXPIRY_DAYS = 30;
/** The longest audit log period one report covers. */
export const MAX_AUDIT_REPORT_DAYS = 366;

export class ReportTooLargeError extends Error {
  constructor() {
    super('report_too_large');
  }
}

export class ReportUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

export interface GeneratedReport {
  content: string;
  contentType: 'text/csv' | 'application/json';
  format: 'csv' | 'json';
  rowCount: number;
}

function csvReport(rows: Array<Record<string, unknown>>, headers: string[]): GeneratedReport {
  if (rows.length > MAX_REPORT_ROWS) throw new ReportTooLargeError();
  // A header line even when there are no rows, so an empty report still says what it lists.
  const content = rows.length > 0 ? toCsv(rows) : headers.join(',');
  return { content, contentType: 'text/csv', format: 'csv', rowCount: rows.length };
}

/** An access review's items: each decision, who made it and why, and what applying it did. */
export async function accessReviewReport(
  adapter: DatabaseAdapter,
  tenantId: string,
  reviewId: string
): Promise<GeneratedReport> {
  const review = await adapter.queryOne<{ id: string }>(
    'SELECT id FROM access_reviews WHERE tenant_id = ? AND id = ?',
    [tenantId, reviewId]
  );
  if (!review) throw new ReportUnavailableError('access_review_not_found');
  const headers = [
    'item_id',
    'user_id',
    'permission_type',
    'permission_value',
    'decision',
    'decided_by',
    'decided_at',
    'justification',
    'apply_status',
    'applied_at',
    'apply_error',
  ];
  const rows = await adapter.query<Record<string, unknown>>(
    `SELECT id AS item_id, user_id, permission_type, permission_value, decision, decided_by,
            decided_at, justification, apply_status, applied_at, apply_error
       FROM access_review_items
      WHERE tenant_id = ? AND review_id = ?
      ORDER BY id
      LIMIT ?`,
    [tenantId, reviewId, MAX_REPORT_ROWS + 1]
  );
  return csvReport(rows, headers);
}

/**
 * Who has MFA: each admin who can administer the tenant (a passkey: admin sign-in is passkey
 * only) and each active user (a passkey, an active TOTP), as the compliance status counts them.
 */
export async function mfaCoverageReport(
  env: Env,
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  options: { routed: boolean; now?: number }
): Promise<GeneratedReport> {
  const now = options.now ?? Date.now();
  const roleNames = DEFAULT_ADMIN_SIGN_IN_ROLES;
  const admins = await adminAdapter.query<{ id: string; has_passkey: number }>(
    `SELECT u.id,
            CASE WHEN EXISTS (SELECT 1 FROM admin_passkeys p WHERE p.admin_user_id = u.id)
                 THEN 1 ELSE 0 END AS has_passkey
       FROM admin_users u
      WHERE u.is_active = 1
        AND u.status = 'active'
        AND EXISTS (
          SELECT 1
            FROM admin_role_assignments ra
            JOIN admin_roles r ON ra.admin_role_id = r.id
           WHERE ra.admin_user_id = u.id
             AND ra.tenant_id = u.tenant_id
             AND (r.tenant_id = u.tenant_id OR (r.tenant_id = 'default' AND r.is_system = 1))
             AND r.name IN (${roleNames.map(() => '?').join(', ')})
             AND (
               ra.scope_type = 'global'
               OR (
                 ra.scope_type = 'tenant'
                 AND (ra.scope_id = ? OR (ra.scope_id IS NULL AND ra.tenant_id = ?))
               )
             )
             AND (ra.expires_at IS NULL OR ra.expires_at > ?)
        )
      ORDER BY u.id
      LIMIT ?`,
    [...roleNames, tenantId, tenantId, now, MAX_REPORT_ROWS + 1]
  );
  if (admins.length > MAX_REPORT_ROWS) throw new ReportTooLargeError();

  const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    ...(options.routed ? { dataRole: 'tenant_core/users' as const } : {}),
    maxStores: 32,
    concurrency: 4,
  });
  const seen = new Set<string>();
  const users: Array<{
    user_id: string;
    registration_state: string | null;
    has_passkey: number;
    has_totp: number;
  }> = [];
  for (const store of stores) {
    // A database two assignments name is read once.
    if (seen.has(store.bindingRef)) continue;
    seen.add(store.bindingRef);
    const left = MAX_REPORT_ROWS - admins.length - users.length;
    const rows = await ensureDatabaseAdapter(
      store.source,
      `compliance-report-mfa:${store.bindingRef}`
    ).query<{
      user_id: string;
      registration_state: string | null;
      has_passkey: number;
      has_totp: number;
    }>(
      `SELECT a.legacy_user_id AS user_id, a.registration_state,
              CASE WHEN EXISTS (
                SELECT 1 FROM passkeys p WHERE p.tenant_id = a.tenant_id AND p.user_id = a.legacy_user_id
              ) THEN 1 ELSE 0 END AS has_passkey,
              CASE WHEN EXISTS (
                SELECT 1 FROM totp_credentials t
                 WHERE t.tenant_id = a.tenant_id AND t.user_id = a.legacy_user_id AND t.status = 'active'
              ) THEN 1 ELSE 0 END AS has_totp
         FROM identity_accounts a
        WHERE a.tenant_id = ? AND a.account_type = 'user' AND a.lifecycle_state = 'active'
        ORDER BY a.legacy_user_id
        LIMIT ?`,
      [tenantId, left + 1]
    );
    if (rows.length > left) throw new ReportTooLargeError();
    users.push(...rows);
  }

  const yesNo = (value: number) => (Number(value) === 1 ? 'yes' : 'no');
  return csvReport(
    [
      ...admins.map((admin) => ({
        kind: 'admin',
        id: admin.id,
        registration_state: '',
        passkey: yesNo(admin.has_passkey),
        totp: '',
      })),
      ...users.map((user) => ({
        kind: 'user',
        id: user.user_id,
        registration_state: user.registration_state ?? 'registered',
        passkey: yesNo(user.has_passkey),
        totp: yesNo(user.has_totp),
      })),
    ],
    ['kind', 'id', 'registration_state', 'passkey', 'totp']
  );
}

/** Audit log entries of a period (from inclusive, to exclusive), oldest first, from the hot store. */
export async function auditLogReport(
  env: Env,
  auditProfile: AuditProfile,
  tenantId: string,
  period: { fromMs: number; toMs: number }
): Promise<GeneratedReport> {
  const support = getAuditHotQuerySupportForProfile(env, auditProfile);
  if (!support.supported || !support.context) {
    throw new ReportUnavailableError('audit_log_not_queryable');
  }
  const context = support.context;
  const { tableName } = getAuditHotQuerySqlSpec(context);
  const toStored = (ms: number) =>
    context.createdAtUnit === 'milliseconds' ? ms : Math.floor(ms / 1000);
  const columns =
    tableName === 'event_log'
      ? `id, created_at, event_type AS action, event_category, result, severity,
         anonymized_user_id AS actor, client_id, error_code`
      : `id, created_at, action, NULL AS event_category, NULL AS result, severity,
         user_id AS actor, NULL AS client_id, NULL AS error_code`;
  const rows = await context.adapter.query<Record<string, unknown> & { created_at: number }>(
    `SELECT ${columns} FROM ${tableName}
      WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
      ORDER BY created_at, id
      LIMIT ?`,
    [tenantId, toStored(period.fromMs), toStored(period.toMs), MAX_REPORT_ROWS + 1]
  );
  return csvReport(
    rows.map(({ created_at, ...row }) => ({
      id: row.id,
      occurred_at: fromStoredAuditTimestamp(Number(created_at), context),
      action: row.action,
      event_category: row.event_category,
      result: row.result,
      severity: row.severity,
      actor: row.actor,
      client_id: row.client_id,
      error_code: row.error_code,
    })),
    [
      'id',
      'occurred_at',
      'action',
      'event_category',
      'result',
      'severity',
      'actor',
      'client_id',
      'error_code',
    ]
  );
}

/** The compliance status at this moment, as the status API answers it (JSON). */
export function complianceStatusReport(status: unknown): GeneratedReport {
  return {
    content: JSON.stringify(status, null, 2),
    contentType: 'application/json',
    format: 'json',
    rowCount: 1,
  };
}

/**
 * Removes a report's file: its catalog entry is tombstoned (the artifact cleanup deletes the
 * objects), or, when it was never catalogued, the objects stored under its key are deleted.
 */
export async function removeReportFile(
  env: Env,
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  keyBase: string | null,
  catalogId: string | null
): Promise<void> {
  if (catalogId) {
    await tombstoneObjectCatalogEntryForTenant(adminAdapter, tenantId, catalogId, Date.now());
    return;
  }
  if (!keyBase) return;
  if (!env.EXPORT_ARTIFACTS) throw new Error('compliance_report_bucket_unavailable');
  let cursor: string | undefined;
  do {
    const listed = await env.EXPORT_ARTIFACTS.list({ prefix: `${keyBase}.`, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await env.EXPORT_ARTIFACTS.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
