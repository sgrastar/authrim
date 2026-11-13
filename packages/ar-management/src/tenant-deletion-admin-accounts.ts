import {
  AdminAuditLogRepository,
  chunkForBoundParameters,
  sqlPlaceholders,
  type DatabaseAdapter,
  type Env,
  type PreparedStatement,
} from '@authrim/ar-lib-core';

/**
 * Removing the administrator accounts homed in a tenant that is being deleted.
 *
 * Called by the tenant deletion job only after the point of no return (the authoritative purge is
 * finalized and the tenant's route is disabled). An administrator belongs to one home tenant
 * (`admin_users.tenant_id`, never rewritten); once the tenant is gone nobody can reach its Admin
 * API to remove them, yet they could still sign in, so they go with the tenant.
 *
 * What is kept, and reported instead of removed:
 *  - an administrator holding a current GLOBAL role assignment: platform-wide authority outlives
 *    any one tenant (expiry is compared in epoch milliseconds, as `adminAuth` does);
 *  - an administrator that rows outside the tenant still point to through a foreign key without
 *    cascade (another tenant's agent grants, consents, challenges or token families) or that a
 *    backup restore mapping names (those rows are immutable once the restore is approved, and the
 *    foreign key blocks the delete).
 *
 * D1 has no interactive transaction (the adapter's `transaction` runs statement by statement), so
 * every group of writes here is one `batch`: atomic on D1 and, between BEGIN and COMMIT in order,
 * on PostgreSQL. Each group is idempotent, so a retry (or the finalized-resume branch of the job)
 * reaches the same end state.
 */

const DEFAULT_TENANT_ID = 'default';
/** Reserved scope of the platform's own audit trail; never a tenant to delete. */
const PLATFORM_TENANT_ID = 'platform';
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

/**
 * Administrators handled per atomic batch. The widest statement binds the ids three times
 * (an `IN` list, and twice more through the agent grant selection) plus the tenant id, so 25 ids
 * stay within D1's 100 bound parameters.
 */
const ADMIN_BATCH_SIZE = 25;
if (chunkForBoundParameters(new Array(ADMIN_BATCH_SIZE), 1, 3).length !== 1) {
  throw new Error('tenant_admin_purge_batch_size_invalid');
}

export const TENANT_ADMIN_PURGE_AUDIT_ACTION = 'admin_user.purge_with_tenant';
export const TENANT_ADMIN_DEACTIVATE_AUDIT_ACTION = 'admin_user.deactivate_with_tenant';
export const TENANT_ADMIN_ACCESS_PURGE_AUDIT_ACTION = 'tenant.admin_access_purge';

export interface TenantAdminPurgeLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
}

export interface TenantAdminPurgeAuditEntry {
  action:
    | typeof TENANT_ADMIN_PURGE_AUDIT_ACTION
    | typeof TENANT_ADMIN_DEACTIVATE_AUDIT_ACTION
    | typeof TENANT_ADMIN_ACCESS_PURGE_AUDIT_ACTION;
  /**
   * The event's time: fixed per job (never the clock of the attempt), so a retry writes the very
   * same event and the audit store accepts it instead of refusing a changed one.
   */
  auditAt: number;
  /** Stable per (job, administrator): a retry of the same purge writes the same event. */
  id: string;
  tenantId: string;
  purgedTenantId: string;
  jobId: string;
  /** Null for the tenant-level record. */
  adminUserId: string | null;
  email: string | null;
}

export type TenantAdminPurgeAuditWriter = (entry: TenantAdminPurgeAuditEntry) => Promise<void>;

export type TenantAdminKeptReason =
  | 'current_global_assignment'
  | 'agent_reference_outside_tenant'
  | 'backup_admin_mapping';

export interface TenantAdminPurgeResult {
  removed: number;
  /** `deactivated`: a kept administrator (FK-blocked) was deactivated and lost its credentials. */
  kept: Array<{ adminUserId: string; reason: TenantAdminKeptReason; deactivated?: boolean }>;
}

export interface PurgeTenantHomedAdminsOptions {
  adapter: Pick<DatabaseAdapter, 'query' | 'batch'>;
  /** The tenant being deleted: the exact tenant id of the deletion job. */
  tenantId: string;
  jobId: string;
  /** Epoch milliseconds that stamp every audit event of this job (see the entry's `auditAt`). */
  auditAt: number;
  /** The tenant the audit rows are written under (a live one: never the tenant being deleted). */
  auditTenantId: string;
  writeAudit: TenantAdminPurgeAuditWriter;
  log?: TenantAdminPurgeLogger;
  /** Epoch milliseconds; the clock the expiry of a global assignment is judged by. */
  now?: number;
}

/**
 * The audit writer a job uses: `AdminAuditLogRepository.createAuditLog`, one row per removed
 * administrator. The e-mail goes into the (protected) metadata as `admin_user.delete` does; it is
 * the only trace of who the account was once the row is gone.
 */
export function createTenantAdminPurgeAuditWriter(
  adapter: DatabaseAdapter,
  env: Env
): TenantAdminPurgeAuditWriter {
  const repository = new AdminAuditLogRepository(adapter, env);
  return async (entry) => {
    await repository.createAuditLog({
      id: entry.id,
      tenant_id: entry.tenantId,
      action: entry.action,
      created_at: entry.auditAt,
      resource_type: entry.adminUserId ? 'admin_user' : 'tenant',
      resource_id: entry.adminUserId ?? entry.purgedTenantId,
      result: 'success',
      severity: 'warn',
      request_id: entry.jobId,
      metadata: {
        tenant_id: entry.purgedTenantId,
        job_id: entry.jobId,
        ...(entry.adminUserId ? { admin_user_id: entry.adminUserId, email: entry.email } : {}),
      },
    });
  };
}

function assertPurgeTarget(tenantId: string, auditTenantId: string): void {
  if (tenantId === DEFAULT_TENANT_ID || tenantId === PLATFORM_TENANT_ID) {
    throw new Error('tenant_deletion_target_is_default');
  }
  if (!SAFE_ID.test(tenantId) || !SAFE_ID.test(auditTenantId) || tenantId === auditTenantId) {
    throw new Error('tenant_deletion_job_config_invalid');
  }
}

/** Rows of the tenant itself that nothing but the tenant's deletion reaches, removed up front. */
function tenantLevelStatements(tenantId: string): PreparedStatement[] {
  return [
    // Sessions of any administrator (a platform administrator's included) derived into this
    // tenant: they act in a tenant that no longer exists. The target tenant alone defines the rows
    // (a row with that target and no parent goes too); an administrator's own base session (no
    // derived target) is not touched.
    {
      sql: 'DELETE FROM admin_sessions WHERE derived_target_tenant_id = ?',
      params: [tenantId],
    },
    {
      sql: 'DELETE FROM admin_agent_login_handoffs WHERE target_tenant_id = ?',
      params: [tenantId],
    },
    {
      sql: 'DELETE FROM admin_invitation_enrollments WHERE invitation_id IN (SELECT id FROM admin_invitations WHERE tenant_id = ?)',
      params: [tenantId],
    },
    { sql: 'DELETE FROM admin_invitation_groups WHERE tenant_id = ?', params: [tenantId] },
    { sql: 'DELETE FROM admin_invitations WHERE tenant_id = ?', params: [tenantId] },
  ];
}

/**
 * The tenant's roles, groups and custom roles, once its administrators are gone. A GLOBAL
 * assignment of a kept administrator carries the administrator's home tenant as its own
 * `tenant_id` (`adminAuth` reads assignments by the session's tenant), so these statements never
 * select by `tenant_id` alone: global rows are excluded, and a custom role still held by anyone
 * (a kept administrator's global assignment may use one of the tenant's custom roles) stays.
 */
function tenantAccessStatements(tenantId: string): PreparedStatement[] {
  return [
    {
      sql: "DELETE FROM admin_role_assignments WHERE tenant_id = ? AND scope_type <> 'global'",
      params: [tenantId],
    },
    { sql: 'DELETE FROM admin_group_members WHERE tenant_id = ?', params: [tenantId] },
    { sql: 'DELETE FROM admin_group_role_grants WHERE tenant_id = ?', params: [tenantId] },
    { sql: 'DELETE FROM admin_groups WHERE tenant_id = ?', params: [tenantId] },
    {
      // All or nothing for the tenant: custom roles go only when no role of the tenant is still
      // held (a kept administrator's global assignment may use one that inherits from another,
      // `inherits_from` being followed at sign-in) and no role of another tenant inherits from
      // one of them.
      sql: `DELETE FROM admin_roles
             WHERE tenant_id = ? AND is_system = 0
               AND NOT EXISTS (
                 SELECT 1 FROM admin_role_assignments ra
                   JOIN admin_roles held ON held.id = ra.admin_role_id
                  WHERE held.tenant_id = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM admin_group_role_grants gr
                   JOIN admin_roles held ON held.id = gr.admin_role_id
                  WHERE held.tenant_id = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM admin_roles child
                  WHERE child.inherits_from = admin_roles.id AND child.tenant_id <> ?
               )`,
      params: [tenantId, tenantId, tenantId, tenantId],
    },
  ];
}

/** Administrators of the batch holding a current global assignment: platform authority. */
async function currentGlobalHolders(
  adapter: Pick<DatabaseAdapter, 'query'>,
  ids: string[],
  now: number
): Promise<Set<string>> {
  const rows = await adapter.query<{ admin_user_id: string }>(
    `SELECT DISTINCT admin_user_id FROM admin_role_assignments
      WHERE admin_user_id IN (${sqlPlaceholders(ids.length)})
        AND scope_type = 'global'
        AND (expires_at IS NULL OR expires_at > ?)`,
    [...ids, now]
  );
  return new Set(rows.map((row) => row.admin_user_id));
}

/**
 * Administrators of the batch that rows outside the tenant point to without cascade. A foreign
 * key violation would roll the atomic batch back anyway; this keeps the administrator out of it
 * and says why.
 */
async function referencedElsewhere(
  adapter: Pick<DatabaseAdapter, 'query'>,
  tenantId: string,
  ids: string[]
): Promise<Map<string, TenantAdminKeptReason>> {
  const list = sqlPlaceholders(ids.length);
  const probes: Array<{ reason: TenantAdminKeptReason; sql: string; params: unknown[] }> = [
    ...(['grantor_id', 'delegator_id'] as const).map((column) => ({
      reason: 'agent_reference_outside_tenant' as const,
      sql: `SELECT DISTINCT ${column} AS id FROM admin_agent_grants WHERE tenant_id <> ? AND ${column} IN (${list})`,
      params: [tenantId, ...ids],
    })),
    {
      reason: 'agent_reference_outside_tenant',
      sql: `SELECT DISTINCT user_id AS id FROM agent_consents WHERE tenant_id <> ? AND user_id IN (${list})`,
      params: [tenantId, ...ids],
    },
    {
      reason: 'agent_reference_outside_tenant',
      sql: `SELECT DISTINCT user_id AS id FROM agent_elevation_challenges WHERE tenant_id <> ? AND user_id IN (${list})`,
      params: [tenantId, ...ids],
    },
    {
      reason: 'agent_reference_outside_tenant',
      sql: `SELECT DISTINCT admin_user_id AS id FROM admin_agent_token_families WHERE tenant_id <> ? AND admin_user_id IN (${list})`,
      params: [tenantId, ...ids],
    },
    {
      // A bulk plan of this tenant's grant that controls other tenants is not this tenant's to drop.
      reason: 'agent_reference_outside_tenant',
      sql: `SELECT DISTINCT g.grantor_id AS id
              FROM admin_agent_grants g
              JOIN agent_bulk_plans p ON p.grant_id = g.id
             WHERE g.tenant_id = ? AND p.control_tenant_id <> ? AND g.grantor_id IN (${list})`,
      params: [tenantId, tenantId, ...ids],
    },
    {
      // Restore mappings are immutable once approved (a trigger refuses their deletion).
      reason: 'backup_admin_mapping',
      sql: `SELECT DISTINCT target_admin_id AS id FROM tenant_backup_admin_mappings WHERE target_admin_id IN (${list})`,
      params: [...ids],
    },
  ];
  const kept = new Map<string, TenantAdminKeptReason>();
  for (const probe of probes) {
    const rows = await adapter.query<{ id: string }>(probe.sql, probe.params);
    for (const row of rows) if (!kept.has(row.id)) kept.set(row.id, probe.reason);
  }
  return kept;
}

/**
 * Takes an administrator that cannot be deleted out of use: `is_active = 0` with `updated_at`, the
 * columns `AdminUserRepository.deactivateAccount` sets (every sign-in path and `adminAuth` read
 * `is_active = 1`), and all its sessions, passkeys, second factors, recoveries and setup tokens.
 * The `admin_users` row stays, as the foreign keys that block its deletion need it.
 */
function adminDeactivateStatements(
  tenantId: string,
  ids: string[],
  now: number
): PreparedStatement[] {
  const list = sqlPlaceholders(ids.length);
  return [
    {
      sql: `UPDATE admin_users SET is_active = 0, updated_at = ? WHERE tenant_id = ? AND id IN (${list})`,
      params: [now, tenantId, ...ids],
    },
    ...[
      'admin_sessions',
      'admin_passkeys',
      'admin_second_factors',
      'admin_second_factor_recoveries',
      'admin_setup_tokens',
    ].map((table) => ({
      sql: `DELETE FROM ${table} WHERE admin_user_id IN (${list})`,
      params: [...ids],
    })),
  ];
}

/** The statements that remove a batch of administrators: dependents without cascade, then the rows. */
function adminBatchStatements(tenantId: string, ids: string[]): PreparedStatement[] {
  const list = sqlPlaceholders(ids.length);
  // The tenant's agent grants these administrators issued or hold.
  const grants = `SELECT g.id FROM admin_agent_grants g
                   WHERE g.tenant_id = ? AND (g.grantor_id IN (${list}) OR g.delegator_id IN (${list}))`;
  const grantParams = [tenantId, ...ids, ...ids];
  return [
    {
      sql: `DELETE FROM agent_bulk_tenant_executions
             WHERE EXISTS (
               SELECT 1 FROM agent_bulk_plans p
                WHERE p.id = agent_bulk_tenant_executions.bulk_plan_id
                  AND p.version = agent_bulk_tenant_executions.bulk_plan_version
                  AND p.grant_id IN (${grants}))`,
      params: grantParams,
    },
    { sql: `DELETE FROM agent_bulk_plans WHERE grant_id IN (${grants})`, params: grantParams },
    {
      sql: `DELETE FROM agent_configuration_plan_steps
             WHERE EXISTS (
               SELECT 1 FROM agent_configuration_plans p
                WHERE p.id = agent_configuration_plan_steps.plan_id
                  AND p.version = agent_configuration_plan_steps.plan_version
                  AND p.grant_id IN (${grants}))`,
      params: grantParams,
    },
    {
      sql: `DELETE FROM agent_configuration_plans WHERE grant_id IN (${grants})`,
      params: grantParams,
    },
    {
      sql: `DELETE FROM admin_agent_delegation_jtis WHERE grant_id IN (${grants})`,
      params: grantParams,
    },
    {
      sql: `DELETE FROM admin_agent_token_revocation_outbox WHERE grant_id IN (${grants})`,
      params: grantParams,
    },
    {
      sql: `DELETE FROM admin_agent_token_families
             WHERE admin_user_id IN (${list}) OR grant_id IN (${grants})`,
      params: [...ids, ...grantParams],
    },
    {
      sql: `DELETE FROM agent_elevation_challenges
             WHERE user_id IN (${list}) OR grant_id IN (${grants})`,
      params: [...ids, ...grantParams],
    },
    {
      sql: `DELETE FROM agent_consents WHERE user_id IN (${list}) OR grant_id IN (${grants})`,
      params: [...ids, ...grantParams],
    },
    { sql: `DELETE FROM admin_agent_grants WHERE id IN (${grants})`, params: grantParams },
    {
      sql: `DELETE FROM admin_agent_login_handoffs WHERE admin_user_id IN (${list})`,
      params: [...ids],
    },
    // Sessions, passkeys, second factors and their recoveries, setup tokens, attribute values,
    // notices and preferences, group memberships and role assignments go by ON DELETE CASCADE.
    {
      sql: `DELETE FROM admin_users WHERE tenant_id = ? AND id IN (${list})`,
      params: [tenantId, ...ids],
    },
  ];
}

export async function purgeTenantHomedAdmins(
  options: PurgeTenantHomedAdminsOptions
): Promise<TenantAdminPurgeResult> {
  const { adapter, tenantId, jobId, auditTenantId, auditAt, writeAudit, log } = options;
  if (!Number.isSafeInteger(auditAt) || auditAt < 1)
    throw new Error('tenant_deletion_job_config_invalid');
  assertPurgeTarget(tenantId, auditTenantId);
  const now = options.now ?? Date.now();

  // Recorded before anything is removed, and fail closed: the tenant-level rows below (invitations,
  // derived sessions, handoffs) go even when every administrator is kept, so there is always one
  // record. No counts: a retry finds fewer rows, and the event must stay the same.
  try {
    await writeAudit({
      id: `tenant-admin-access-purge:${jobId}`,
      action: TENANT_ADMIN_ACCESS_PURGE_AUDIT_ACTION,
      auditAt,
      tenantId: auditTenantId,
      purgedTenantId: tenantId,
      jobId,
      adminUserId: null,
      email: null,
    });
  } catch {
    throw new Error('tenant_deletion_admin_purge_audit_failed');
  }
  await adapter.batch(tenantLevelStatements(tenantId));

  const result: TenantAdminPurgeResult = { removed: 0, kept: [] };
  let cursor = '';
  for (;;) {
    // Keyset paging: a kept administrator stays in the table, so the cursor moves past it.
    const page = await adapter.query<{
      id: string;
      email: string | null;
      is_active: number | boolean | null;
    }>(
      'SELECT id, email, is_active FROM admin_users WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?',
      [tenantId, cursor, ADMIN_BATCH_SIZE]
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    const holders = await currentGlobalHolders(
      adapter,
      page.map((row) => row.id),
      now
    );
    for (const id of holders)
      result.kept.push({ adminUserId: id, reason: 'current_global_assignment' });
    const candidates = page.filter((row) => !holders.has(row.id));
    if (candidates.length === 0) continue;

    const blocked = await referencedElsewhere(
      adapter,
      tenantId,
      candidates.map((row) => row.id)
    );
    const targets = candidates.filter((row) => !blocked.has(row.id));
    const stuck = candidates.filter((row) => blocked.has(row.id));

    // Audit first: once the row is gone (or its credentials are) nothing could say that it was.
    // A failed write stops the purge here (the job step fails and retries) with the
    // administrator still in place; the stable event id makes the retry write the same event
    // again, not a second one.
    const audit = async (
      row: { id: string; email: string | null },
      action: TenantAdminPurgeAuditEntry['action'],
      idPrefix: string
    ) => {
      try {
        await writeAudit({
          id: `${idPrefix}:${jobId}:${row.id}`,
          action,
          auditAt,
          tenantId: auditTenantId,
          purgedTenantId: tenantId,
          jobId,
          adminUserId: row.id,
          email: row.email ?? null,
        });
      } catch {
        throw new Error('tenant_deletion_admin_purge_audit_failed');
      }
    };

    // An administrator that cannot be deleted must not stay able to sign in: it is deactivated
    // (as `deactivateAccount` does) and every credential and session it holds is removed. One
    // already inactive was deactivated by an earlier run (or the Admin API), so no second audit.
    if (stuck.length > 0) {
      for (const row of stuck) {
        if (row.is_active === 1 || row.is_active === true) {
          await audit(row, TENANT_ADMIN_DEACTIVATE_AUDIT_ACTION, 'tenant-admin-deactivate');
        }
      }
      await adapter.batch(
        adminDeactivateStatements(
          tenantId,
          stuck.map((row) => row.id),
          now
        )
      );
      for (const row of stuck) {
        result.kept.push({
          adminUserId: row.id,
          reason: blocked.get(row.id) as TenantAdminKeptReason,
          deactivated: true,
        });
      }
    }
    if (targets.length === 0) continue;

    for (const target of targets)
      await audit(target, TENANT_ADMIN_PURGE_AUDIT_ACTION, 'tenant-admin-purge');

    await adapter.batch(
      adminBatchStatements(
        tenantId,
        targets.map((row) => row.id)
      )
    );
    result.removed += targets.length;
  }

  await adapter.batch(tenantAccessStatements(tenantId));

  log?.info('Tenant admin accounts purged with the tenant', {
    job_id: jobId,
    tenant_id: tenantId,
    removed_count: result.removed,
    kept_count: result.kept.length,
    kept_admins: result.kept.slice(0, 50).map((kept) => ({
      id: kept.adminUserId,
      reason: kept.reason,
      ...(kept.deactivated ? { deactivated: true } : {}),
    })),
  });
  return result;
}
