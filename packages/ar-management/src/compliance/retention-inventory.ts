/**
 * How long each kind of data is kept for a tenant, read from what actually decides it.
 *
 * Retention is not one policy: audit logs follow the audit profile (or a logging destination,
 * or the tenant's PII config), tokens and sessions simply expire, the lookup directory has its
 * own policy, and some data is removed by a scheduled task. Each category says what keeps it,
 * where an admin changes that, and what removes the data, so the compliance view never shows a
 * value nothing enforces. Values that cannot be read throw (the API answers 503); nothing here
 * falls back to a default the runtime would not use.
 */
import {
  resolveEffectiveSettings,
  resolvePlatformSettingsWithSources,
  resolveTenantRuntimeProfilesFromEnv,
  type AuditProfile,
  resolveTenantAuditRetentionFromEnv,
  readTenantSessionSettingsStrict,
  loadTenantProfileStrict,
  sessionTtlFromSettings,
  SESSION_TTL_DEFINITIONS,
  type AuditRetentionSource,
  type DatabaseAdapter,
  type Env,
  type SessionTtlContext,
} from '@authrim/ar-lib-core';
import { getAuditHotQuerySqlSpec, getAuditHotQuerySupportForProfile } from '../audit-hot-query';
import {
  diagnosticRetentionDays,
  getScheduledMaintenanceTaskView,
  type ScheduledMaintenanceTaskId,
} from '../r2-storage-maintenance';
import { readTenantRetentionRuns, type TenantRetentionRun } from '../retention-tenant-runs';
import { REPORT_EXPIRY_DAYS } from './reports';

export type RetentionCategoryId =
  | 'audit_events'
  | 'audit_pii'
  | 'check_api_audit'
  | 'user_tombstones'
  | 'compliance_reports'
  | 'lookup_directory'
  | 'diagnostic_logs'
  | 'sessions'
  | 'refresh_tokens'
  | 'authorization_codes'
  | 'access_tokens';

export const RETENTION_CATEGORY_IDS: readonly RetentionCategoryId[] = [
  'audit_events',
  'audit_pii',
  'check_api_audit',
  'user_tombstones',
  'compliance_reports',
  'lookup_directory',
  'diagnostic_logs',
  'sessions',
  'refresh_tokens',
  'authorization_codes',
  'access_tokens',
];

/** What decides the retention. */
export type RetentionSource =
  | { kind: 'setting'; category: string; key: string; level: 'tenant' | 'platform' }
  | { kind: 'session_settings'; keys: string[] }
  | { kind: 'audit'; from: AuditRetentionSource }
  | { kind: 'lookup_policy' }
  /** A default each record may differ from (set when the record is made). */
  | { kind: 'default' };

/** Where an admin changes it. */
export type RetentionEdit =
  | { kind: 'settings'; category: string; key: string; level: 'tenant' | 'platform' }
  | { kind: 'session_settings' }
  | { kind: 'audit_pii_config' }
  | { kind: 'audit_profile' }
  /** The audit storage routing rules (a rule sets this retention for the tenant's writes). */
  | { kind: 'audit_routing_rules' }
  | { kind: 'lookup_directory' }
  | { kind: 'none' };

/** What removes the data once it is past its retention. */
export type RetentionDeletion =
  | {
      kind: 'scheduled_task';
      task: ScheduledMaintenanceTaskId;
      enabled: boolean;
      disabled_reason: string | null;
      status: string;
      last_started_at: number | null;
      last_completed_at: number | null;
      last_error_code: string | null;
      next_run_at: number | null;
      /** When the task last ran for this tenant (a run covers only some tenants). */
      tenant_last_run: TenantRetentionRun | null;
    }
  /** Kept with an expiry by the store that holds it (Durable Objects); gone when it expires. */
  | { kind: 'expiry' }
  /** Not kept: a signed token is valid until it expires and nothing stores it. */
  | { kind: 'not_stored' }
  /** Kept past expiry: nothing removes it once it expires (refresh token families). */
  | { kind: 'not_deleted'; reason: 'expired_refresh_families_kept' }
  /**
   * Nothing removes it yet: the lookup directory policy is projected to Control (`projection`),
   * but no purge acts on it.
   */
  | {
      kind: 'not_deleted';
      reason: 'lookup_purge_not_available';
      projection: 'current' | 'pending';
    };

export interface RetentionCategory {
  id: RetentionCategoryId;
  retention: { value: number; unit: 'days' | 'seconds' };
  source: RetentionSource;
  edit: RetentionEdit;
  deletion: RetentionDeletion;
  /**
   * When the value is a default that something more specific can change: a logging route
   * (by event category or app), an app's own token settings, or the sign-in method.
   */
  varies: 'by_route' | 'by_app' | 'by_sign_in_method' | 'by_request' | null;
  /** A limit below the setting that applies instead (the tenant profile's token lifetime). */
  cap?: { kind: 'tenant_profile'; seconds: number };
  /** Records kept now and those past their retention; null when they cannot be counted here. */
  counts: { total: number; expired: number } | null;
  /**
   * For sessions: an active session can be extended by `per_refresh_seconds` at a time, and
   * nothing bounds how long it may last in all (`absolute_limit_seconds` null).
   */
  extension?: { per_refresh_seconds: number; absolute_limit_seconds: number | null };
  /**
   * Per sign-in method, for sessions: the settings that set it (`key`), or a lifetime fixed in
   * code (`fixed: true`; `key` names the sign-in path).
   */
  breakdown?: Array<{ key: string; seconds: number; fixed?: boolean }>;
  /**
   * For audit logs: a copy also goes to an archive (R2). The deletion above covers the primary
   * store only; Authrim deletes nothing from the archive (an R2 lifecycle rule set outside
   * Authrim may).
   */
  archive?: { deletion: 'not_deleted' };
}

export interface RetentionInventoryInput {
  env: Env;
  tenantId: string;
  /** The tenant's default core database (audit hot query aside). */
  coreAdapter: DatabaseAdapter;
  /** The tenant's PII stores (deleted users' tombstones). */
  piiAdapters: DatabaseAdapter[];
  /** Skip the record counts (the categories list does not need them). */
  withCounts?: boolean;
  /** The tenant's audit profile read strictly, when the caller has it (else read here). */
  auditProfile?: AuditProfile;
  now?: number;
}

const DAY_SECONDS = 24 * 60 * 60;
/** The most one session refresh extends a session by (ar-auth session-management.ts). */
const SESSION_REFRESH_MAX_SECONDS = DAY_SECONDS;
/** Sign-in paths whose sessions have a lifetime fixed in code, not set by session settings. */
const FIXED_SESSION_LIFETIMES: ReadonlyArray<{ key: string; seconds: number; fixed: true }> = [
  // ar-bridge handlers/callback.ts
  { key: 'external_idp_login', seconds: DAY_SECONDS, fixed: true },
  // ar-saml sp/acs.ts
  { key: 'saml_login', seconds: 60 * 60, fixed: true },
  // ar-bridge handlers/handoff.ts
  { key: 'session_handoff', seconds: 60 * 60, fixed: true },
  // ar-auth session-management.ts (a session made for an RP from a session token)
  { key: 'rp_session', seconds: DAY_SECONDS, fixed: true },
];
/** Deleted users' tombstones get this retention unless the deletion asks for another. */
export const USER_TOMBSTONE_RETENTION_DAYS = 90;
const LOOKUP_RETENTION_MIN_DAYS = 30;
const LOOKUP_RETENTION_MAX_DAYS = 3650;

function positiveInteger(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`retention_inventory_invalid_${what}`);
}

function sumCounts(rows: Array<{ total: number | null; expired: number | null } | null>): {
  total: number;
  expired: number;
} {
  let total = 0;
  let expired = 0;
  for (const row of rows) {
    total += Number(row?.total ?? 0);
    expired += Number(row?.expired ?? 0);
  }
  return { total, expired };
}

async function scheduledTask(
  env: Env,
  task: ScheduledMaintenanceTaskId,
  now: number,
  tenantRun: TenantRetentionRun | null
): Promise<RetentionDeletion> {
  const view = await getScheduledMaintenanceTaskView(env, task, now);
  return {
    kind: 'scheduled_task',
    task,
    enabled: view.enabled,
    disabled_reason: view.disabledReason,
    status: view.status,
    last_started_at: view.lastStartedAt,
    last_completed_at: view.lastCompletedAt,
    last_error_code: view.lastErrorCode,
    next_run_at: view.nextRunAt,
    tenant_last_run: tenantRun,
  };
}

function auditEdit(from: AuditRetentionSource): RetentionEdit {
  if (from === 'delivery_plan') return { kind: 'audit_routing_rules' };
  if (from === 'audit_profile') return { kind: 'audit_profile' };
  return { kind: 'audit_pii_config' };
}

async function auditEventCounts(
  env: Env,
  auditProfile: AuditProfile,
  tenantId: string,
  now: number
): Promise<{ total: number; expired: number } | null> {
  const hotQuery = getAuditHotQuerySupportForProfile(env, auditProfile);
  if (!hotQuery.supported || !hotQuery.context) return null;
  const { tableName } = getAuditHotQuerySqlSpec(hotQuery.context);
  // Only the unified event log records each entry's retention_until; the older table does not.
  if (tableName !== 'event_log') return null;
  const row = await hotQuery.context.adapter.queryOne<{ total: number; expired: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN retention_until IS NOT NULL AND retention_until < ? THEN 1 ELSE 0 END) AS expired
       FROM event_log WHERE tenant_id = ?`,
    [now, tenantId]
  );
  return sumCounts([row]);
}

async function lookupPolicy(adapter: DatabaseAdapter, tenantId: string) {
  const row = await adapter.queryOne<{
    retention_days: number | string;
    policy_generation: number | string;
  }>(
    'SELECT retention_days, policy_generation FROM lookup_retention_policies WHERE tenant_id = ?',
    [tenantId],
    { consistencyClass: 'primary_required' }
  );
  // A tenant without a row has the table's default (180 days), as the purge does.
  const days = row ? Number(row.retention_days) : 180;
  if (
    !Number.isSafeInteger(days) ||
    days < LOOKUP_RETENTION_MIN_DAYS ||
    days > LOOKUP_RETENTION_MAX_DAYS
  ) {
    throw new Error('retention_inventory_invalid_lookup_policy');
  }
  // The policy in effect is projected once a projection of its generation succeeded; older
  // generations left pending are superseded.
  const projected = row
    ? await adapter.queryOne<{ projected: number }>(
        `SELECT COUNT(*) AS projected FROM lookup_retention_policy_projection_outbox
          WHERE tenant_id = ? AND policy_generation = ? AND status = 'succeeded'`,
        [tenantId, Number(row.policy_generation)],
        { consistencyClass: 'primary_required' }
      )
    : null;
  return { days, projectionPending: row !== null && Number(projected?.projected ?? 0) === 0 };
}

/** Every category, in RETENTION_CATEGORY_IDS order. */
export async function buildRetentionInventory(
  input: RetentionInventoryInput
): Promise<RetentionCategory[]> {
  const { env, tenantId, coreAdapter, piiAdapters } = input;
  const now = input.now ?? Date.now();
  const withCounts = input.withCounts !== false;
  // One strict read of the profile for the retention and the counts, so they agree.
  const auditProfile =
    input.auditProfile ??
    (await resolveTenantRuntimeProfilesFromEnv(env, tenantId, { strict: true })).auditProfile;

  const [audit, checkAudit, diagnostic, oauth, sessionSettings, lookup, tenantProfile] =
    await Promise.all([
      resolveTenantAuditRetentionFromEnv(env, tenantId, { auditProfile }),
      // Not the runtime cache: an admin sees a change as soon as it is saved.
      resolvePlatformSettingsWithSources(env, 'check-api-audit', { fresh: true }),
      resolveEffectiveSettings(env, 'diagnostic-logging', { tenantId, fresh: true }),
      resolveEffectiveSettings(env, 'oauth', { tenantId, fresh: true }),
      readTenantSessionSettingsStrict(env, tenantId),
      lookupPolicy(coreAdapter, tenantId),
      // Its max_token_ttl_seconds caps every access token issued for the tenant.
      loadTenantProfileStrict(env.AUTHRIM_CONFIG, env, tenantId),
    ]);
  // Whole days: a write adds them to the calendar date, dropping any fraction.
  const auditEventDays = positiveInteger(audit.event.days, 'audit_event_retention_days');
  const auditPiiDays = positiveInteger(audit.pii.days, 'audit_pii_retention_days');
  const auditArchive = (archived: boolean) =>
    archived ? { archive: { deletion: 'not_deleted' as const } } : {};
  const checkAuditDays = positiveInteger(
    checkAudit.values['audit.check_api_retention_days'],
    'check_api_retention_days'
  );
  // As the cleanup applies it (fractions of a day included, within 1 to 3650 days).
  const rawDiagnosticDays = diagnostic['diagnostic-logging.retention_days'];
  if (
    rawDiagnosticDays !== undefined &&
    rawDiagnosticDays !== null &&
    (typeof rawDiagnosticDays !== 'number' || !Number.isFinite(rawDiagnosticDays))
  ) {
    throw new Error('retention_inventory_invalid_diagnostic_retention_days');
  }
  const diagnosticDays = diagnosticRetentionDays(rawDiagnosticDays as number | null | undefined);

  const tenantRuns = await readTenantRetentionRuns(env, tenantId);
  const [auditTask, checkAuditTask, tombstoneTask, diagnosticTask, reportTask] = await Promise.all([
    scheduledTask(env, 'audit_retention', now, tenantRuns.audit_retention ?? null),
    scheduledTask(
      env,
      'check_api_audit_retention',
      now,
      tenantRuns.check_api_audit_retention ?? null
    ),
    scheduledTask(
      env,
      'user_tombstone_retention',
      now,
      tenantRuns.user_tombstone_retention ?? null
    ),
    scheduledTask(
      env,
      'r2_diagnostic_log_retention',
      now,
      tenantRuns.r2_diagnostic_log_retention ?? null
    ),
    scheduledTask(
      env,
      'compliance_report_retention',
      now,
      tenantRuns.compliance_report_retention ?? null
    ),
  ]);

  const [eventCounts, checkAuditCounts, tombstoneCounts, reportCounts] = withCounts
    ? await Promise.all([
        auditEventCounts(env, auditProfile, tenantId, now),
        coreAdapter
          .queryOne<{ total: number; expired: number }>(
            `SELECT COUNT(*) AS total, SUM(CASE WHEN checked_at < ? THEN 1 ELSE 0 END) AS expired
               FROM permission_check_audit WHERE tenant_id = ?`,
            [Math.floor(now / 1000) - checkAuditDays * DAY_SECONDS, tenantId]
          )
          .then((row) => sumCounts([row])),
        Promise.all(
          piiAdapters.map((adapter) =>
            adapter.queryOne<{ total: number; expired: number }>(
              `SELECT COUNT(*) AS total, SUM(CASE WHEN retention_until < ? THEN 1 ELSE 0 END) AS expired
                 FROM users_pii_tombstone WHERE tenant_id = ?`,
              [now, tenantId]
            )
          )
        ).then(sumCounts),
        // Reports whose file is kept now (as the retention task finds them: completed, or never
        // completed with a file left), and those past their time.
        coreAdapter
          .queryOne<{ total: number; expired: number }>(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS expired
               FROM compliance_reports
              WHERE tenant_id = ? AND status IN ('completed', 'generating', 'failed')
                AND (object_catalog_id IS NOT NULL OR object_key_base IS NOT NULL)`,
            [new Date(now).toISOString(), tenantId]
          )
          .then((row) => sumCounts([row])),
      ])
    : [null, null, null, null];

  const sessionBreakdown: Array<{ key: string; seconds: number; fixed?: boolean }> = [
    ...(Object.keys(SESSION_TTL_DEFINITIONS) as SessionTtlContext[]).map((context) => {
      const ttl = sessionTtlFromSettings(env, sessionSettings, context);
      return { key: ttl.key, seconds: ttl.seconds };
    }),
    ...FIXED_SESSION_LIFETIMES,
  ];

  const oauthSeconds = (key: string) => positiveInteger(oauth[key], key.replace('oauth.', ''));
  const oauthCategory = (
    id: RetentionCategoryId,
    key: string,
    deletion: RetentionDeletion,
    capSeconds?: number
  ): RetentionCategory => {
    const configured = oauthSeconds(key);
    const capped = capSeconds !== undefined && capSeconds < configured;
    return {
      id,
      retention: { value: capped ? capSeconds : configured, unit: 'seconds' },
      source: { kind: 'setting', category: 'oauth', key, level: 'tenant' },
      edit: { kind: 'settings', category: 'oauth', key, level: 'tenant' },
      deletion,
      varies: 'by_app',
      counts: null,
      ...(capped ? { cap: { kind: 'tenant_profile' as const, seconds: capSeconds } } : {}),
    };
  };

  return [
    {
      id: 'audit_events',
      retention: { value: auditEventDays, unit: 'days' },
      source: { kind: 'audit', from: audit.event.source },
      edit: auditEdit(audit.event.source),
      deletion: auditTask,
      varies: audit.event.variesByRoute ? 'by_route' : null,
      counts: eventCounts,
      ...auditArchive(audit.event.archived),
    },
    {
      id: 'audit_pii',
      retention: { value: auditPiiDays, unit: 'days' },
      source: { kind: 'audit', from: audit.pii.source },
      edit: auditEdit(audit.pii.source),
      deletion: auditTask,
      varies: audit.pii.variesByRoute ? 'by_route' : null,
      counts: null,
      ...auditArchive(audit.pii.archived),
    },
    {
      id: 'check_api_audit',
      retention: { value: checkAuditDays, unit: 'days' },
      source: {
        kind: 'setting',
        category: 'check-api-audit',
        key: 'audit.check_api_retention_days',
        level: 'platform',
      },
      edit: {
        kind: 'settings',
        category: 'check-api-audit',
        key: 'audit.check_api_retention_days',
        level: 'platform',
      },
      deletion: checkAuditTask,
      varies: null,
      counts: checkAuditCounts,
    },
    {
      id: 'user_tombstones',
      retention: { value: USER_TOMBSTONE_RETENTION_DAYS, unit: 'days' },
      source: { kind: 'default' },
      edit: { kind: 'none' },
      deletion: tombstoneTask,
      // An erasure request may set its own retention; each tombstone keeps its retention_until.
      varies: 'by_request',
      counts: tombstoneCounts,
    },
    {
      id: 'compliance_reports',
      retention: { value: REPORT_EXPIRY_DAYS, unit: 'days' },
      source: { kind: 'default' },
      edit: { kind: 'none' },
      deletion: reportTask,
      varies: null,
      counts: reportCounts,
    },
    {
      id: 'lookup_directory',
      retention: { value: lookup.days, unit: 'days' },
      source: { kind: 'lookup_policy' },
      edit: { kind: 'lookup_directory' },
      deletion: {
        kind: 'not_deleted',
        reason: 'lookup_purge_not_available',
        projection: lookup.projectionPending ? 'pending' : 'current',
      },
      varies: null,
      counts: null,
    },
    {
      id: 'diagnostic_logs',
      retention: { value: diagnosticDays, unit: 'days' },
      source: {
        kind: 'setting',
        category: 'diagnostic-logging',
        key: 'diagnostic-logging.retention_days',
        level: 'tenant',
      },
      edit: {
        kind: 'settings',
        category: 'diagnostic-logging',
        key: 'diagnostic-logging.retention_days',
        level: 'tenant',
      },
      deletion: diagnosticTask,
      varies: null,
      counts: null,
    },
    {
      id: 'sessions',
      retention: {
        value: Math.max(...sessionBreakdown.map((entry) => entry.seconds)),
        unit: 'seconds',
      },
      source: {
        kind: 'session_settings',
        keys: sessionBreakdown.filter((entry) => !entry.fixed).map((entry) => entry.key),
      },
      edit: { kind: 'session_settings' },
      deletion: { kind: 'expiry' },
      varies: 'by_sign_in_method',
      counts: null,
      // POST /api/sessions/refresh extends by up to a day each time, with no absolute limit.
      extension: { per_refresh_seconds: SESSION_REFRESH_MAX_SECONDS, absolute_limit_seconds: null },
      breakdown: sessionBreakdown,
    },
    // A family ends its validity at expiry but its record stays until it is rotated or revoked.
    oauthCategory('refresh_tokens', 'oauth.refresh_token_expiry', {
      kind: 'not_deleted',
      reason: 'expired_refresh_families_kept',
    }),
    oauthCategory('authorization_codes', 'oauth.auth_code_ttl', { kind: 'expiry' }),
    oauthCategory(
      'access_tokens',
      'oauth.access_token_expiry',
      { kind: 'not_stored' },
      tenantProfile.max_token_ttl_seconds
    ),
  ];
}
