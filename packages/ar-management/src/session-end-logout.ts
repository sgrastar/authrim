/**
 * Downstream logout for sessions an admin action ended.
 *
 * Suspending, locking or bulk-suspending an account, revoking all of a user's sessions, deleting
 * or anonymizing an account, and deactivating or deleting it through SCIM, end the user's
 * sessions by moving the user's session revocation epoch. The relying parties signed
 * in through those sessions are then told as on a user logout: one OIDC Back-Channel Logout
 * token per client with that client's sid, the Simple Logout Webhook, the same retries and the
 * same failure records (`GET /api/admin/logout-failures`), through the shared fan-out.
 *
 * The sessions an action ended are returned by the revocation itself (read in the same
 * transaction as the epoch move), so a session an earlier or a concurrent revocation ended is
 * not told again. They are kept as admin jobs of `SESSIONS_PER_LOGOUT_JOB` sessions each: a job
 * is run at once after the admin response, and one that could not be run to its end (a target
 * that could not be read, the time after the response running out) is retried by the scheduled
 * run.
 */
import {
  createAuditLog,
  createLogger,
  transitionAccountAuthenticationStateEndingSessions,
  purgeEndedSessionsFromSessionClientStore,
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveLogoutConfig,
  resolveLogoutIssuer,
  resolveLogoutTargetsFromSessionClientStore,
  resolveLogoutWebhookConfig,
  sendBackchannelLogoutFanout,
  sendLogoutWebhookFanout,
  SessionClientRepository,
  type Env,
  type Logger,
  type LogoutFanoutSession,
  type LogoutFanoutSummary,
} from '@authrim/ar-lib-core';

export const SESSION_END_LOGOUT_JOB_TYPE = 'users/session-end-logout';

/**
 * Sessions per job. A job is sent within the time a request may keep working after its response
 * (sessions go 5 at a time, each client send times out after a few seconds, retries share one
 * budget), so a large action becomes several jobs.
 */
export const SESSIONS_PER_LOGOUT_JOB = 10;

/** The admin action that ended the sessions (recorded with every audit entry of the fan-out). */
export type AdminSessionEndAction =
  | 'user.suspend'
  | 'user.lock'
  | 'user.sessions_revoked'
  | 'support_ops.action.execute'
  | 'bulk_user_update'
  | 'user.deleted'
  | 'user.anonymized'
  | 'scim.user.deactivate'
  | 'scim.user.delete';

const ADMIN_SESSION_END_ACTIONS: ReadonlySet<string> = new Set<AdminSessionEndAction>([
  'user.suspend',
  'user.lock',
  'user.sessions_revoked',
  'support_ops.action.execute',
  'bulk_user_update',
  'user.deleted',
  'user.anonymized',
  'scim.user.deactivate',
  'scim.user.delete',
]);

export interface AdminSessionEndTrigger {
  action: AdminSessionEndAction;
  /** The lifecycle operation, support action or job the sessions ended under. */
  operationId?: string;
  /** The admin (or SCIM token) who acted, when one did. */
  actorId?: string;
  /**
   * The id the audit records name the user by, when not the user's own: an anonymized account is
   * named by its hash only, as its anonymization's own audit does. Only for an action that ended
   * the sessions of one user.
   */
  auditUserId?: string;
}

/** A session an admin action ended. */
export interface EndedSession {
  userId: string;
  sessionId: string;
}

interface SessionEndLogoutJobConfig {
  trigger: AdminSessionEndTrigger;
  sessions: EndedSession[];
}

export interface AdminSessionEndLogoutSummary {
  sessions: number;
  backchannel: LogoutFanoutSummary | null;
  webhook: LogoutFanoutSummary | null;
}

const defaultLog = createLogger().module('ADMIN-SESSION-END-LOGOUT');

/** How many sessions' logout targets are read at once. */
const READ_CONCURRENCY = 10;

export function endedSessionsOf(userId: string, sessionIds: string[]): EndedSession[] {
  return sessionIds.map((sessionId) => ({ userId, sessionId }));
}

async function mapConcurrently<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    })
  );
  return results;
}

/** The id the audit records name this user by (see `AdminSessionEndTrigger.auditUserId`). */
export function auditUserIdOf(trigger: AdminSessionEndTrigger, userId: string): string {
  return trigger.auditUserId ?? userId;
}

/**
 * Move an account's authentication state to a lifecycle that ends its sessions, through the
 * revocation that returns the sessions it ended, and add those to `ended` (for telling their
 * relying parties). A transition taken before (a retry) ended none.
 */
export async function transitionEndingSessions(
  env: Env,
  ended: EndedSession[],
  transition: {
    tenantId: string;
    userId: string;
    lifecycle: Parameters<
      typeof transitionAccountAuthenticationStateEndingSessions
    >[1]['lifecycle'];
    sourceVersionMs: number;
    operationId: string;
  }
): Promise<void> {
  const { endedSessionIds } = await transitionAccountAuthenticationStateEndingSessions(env, {
    ...transition,
    revokeSessions: true,
  });
  ended.push(...endedSessionsOf(transition.userId, endedSessionIds));
}

function triggerMetadata(trigger: AdminSessionEndTrigger): Record<string, string> {
  return {
    trigger_action: trigger.action,
    ...(trigger.operationId ? { operation_id: trigger.operationId } : {}),
    ...(trigger.actorId ? { actor_id: trigger.actorId } : {}),
  };
}

/**
 * Record in the audit, for each user, that the downstream logout for the sessions an action
 * ended was started and by which action (the admin request's own audit when there is one).
 */
export async function auditSessionEndLogoutStarted(
  env: Env,
  params: {
    tenantId: string;
    sessions: EndedSession[];
    trigger: AdminSessionEndTrigger;
    jobIds: string[];
    log?: Logger;
  }
): Promise<void> {
  const log = params.log ?? defaultLog;
  const sessionCounts = new Map<string, number>();
  for (const { userId } of params.sessions) {
    sessionCounts.set(userId, (sessionCounts.get(userId) ?? 0) + 1);
  }
  await Promise.all(
    [...sessionCounts].map(([userId, sessionCount]) =>
      createAuditLog(env, {
        tenantId: params.tenantId,
        userId: auditUserIdOf(params.trigger, userId),
        action: 'user.downstream_logout',
        resource: 'user',
        resourceId: auditUserIdOf(params.trigger, userId),
        ipAddress: '',
        userAgent: '',
        metadata: JSON.stringify({
          ...triggerMetadata(params.trigger),
          session_count: sessionCount,
          job_ids: params.jobIds,
        }),
        severity: params.jobIds.length > 0 ? 'info' : 'warning',
      }).catch((error) => {
        log.error(
          'Failed to create audit log for admin session end',
          { action: 'audit_log' },
          error as Error
        );
      })
    )
  );
}

/**
 * Keep the downstream logout for these sessions as admin jobs, `SESSIONS_PER_LOGOUT_JOB` sessions
 * each. Returns the job ids (none when there is no session).
 */
export async function enqueueSessionEndLogout(
  env: Env,
  params: {
    tenantId: string;
    sessions: EndedSession[];
    trigger: AdminSessionEndTrigger;
    createdBy?: string;
  }
): Promise<string[]> {
  if (params.sessions.length === 0) return [];
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'management-session-end-logout');
  const nowTs = Math.floor(Date.now() / 1000);
  const jobs: Array<{ id: string; config: SessionEndLogoutJobConfig }> = [];
  for (let offset = 0; offset < params.sessions.length; offset += SESSIONS_PER_LOGOUT_JOB) {
    jobs.push({
      id: crypto.randomUUID(),
      config: {
        trigger: params.trigger,
        sessions: params.sessions.slice(offset, offset + SESSIONS_PER_LOGOUT_JOB),
      },
    });
  }
  await adapter.batch(
    jobs.map((job) => ({
      sql: `INSERT INTO admin_jobs (
              id, tenant_id, job_type, status, progress, config, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      params: [
        job.id,
        params.tenantId,
        SESSION_END_LOGOUT_JOB_TYPE,
        JSON.stringify({
          total: job.config.sessions.length,
          processed: 0,
          succeeded: 0,
          failed: 0,
          stage: 'queued',
        }),
        JSON.stringify(job.config),
        params.createdBy ?? params.trigger.actorId ?? 'system',
        nowTs,
        nowTs,
      ],
    }))
  );
  return jobs.map((job) => job.id);
}

/**
 * Tell the relying parties signed in through these sessions. Throws, before anything is sent,
 * when the issuer or a session's logout targets cannot be read: the job is then retried. Once
 * sending starts, each relying party's failure is recorded by the fan-out (failure list, alert)
 * and does not fail the job.
 */
export async function sendAdminSessionEndLogout(
  env: Env,
  params: {
    tenantId: string;
    sessions: EndedSession[];
    trigger: AdminSessionEndTrigger;
    /** When the work began: the retry budget counts from it (default: now). */
    startedAt?: number;
    log?: Logger;
  }
): Promise<AdminSessionEndLogoutSummary> {
  const startedAt = params.startedAt ?? Date.now();
  const log = params.log ?? defaultLog;
  const { tenantId, trigger } = params;
  const metadata = triggerMetadata(trigger);

  const [issuer, coreAdapter, logoutConfig, webhookConfig] = await Promise.all([
    // A lookup of the tenant's primary domain that fails fails the job (retried) instead of
    // signing with another issuer.
    resolveLogoutIssuer(env, tenantId),
    resolveAuthCorePersistenceAdapterFromEnv(env, 'management-session-end-logout', { tenantId }),
    // Settings that cannot be read fail the job (retried): defaults could send what the tenant
    // turned off, or skip what it turned on.
    resolveLogoutConfig(env, tenantId),
    resolveLogoutWebhookConfig(env, tenantId),
  ]);
  const repository = new SessionClientRepository(coreAdapter, tenantId);

  // Ending a session by epoch leaves its SessionClientStore records, so the targets can be read
  // after it ended. A target that cannot be read fails the job, to be read again on its retry.
  const sessions = await mapConcurrently(
    params.sessions,
    READ_CONCURRENCY,
    async ({ sessionId, userId }): Promise<LogoutFanoutSession> => {
      const targets = await resolveLogoutTargetsFromSessionClientStore(
        env,
        tenantId,
        sessionId,
        repository,
        issuer
      );
      return {
        sessionId,
        userId,
        backchannelClients: targets?.backchannelClients ?? [],
        webhookClients: targets?.webhookClients ?? [],
      };
    }
  );

  const audits = sessions.map((session) =>
    createAuditLog(env, {
      tenantId,
      userId: auditUserIdOf(trigger, session.userId),
      action: 'user.logout',
      resource: 'session',
      resourceId: session.sessionId,
      // Sent after the admin request: no user request applies.
      ipAddress: '',
      userAgent: '',
      metadata: JSON.stringify({
        reason: 'admin_session_end',
        ...metadata,
        backchannel_client_ids: logoutConfig.backchannel.enabled
          ? session.backchannelClients.map((client) => client.client_id)
          : [],
        webhook_client_ids: webhookConfig.enabled
          ? session.webhookClients.map((client) => client.client_id)
          : [],
      }),
      severity: 'info',
    }).catch((error) => {
      log.error(
        'Failed to create audit log for admin session end',
        { action: 'audit_log' },
        error as Error
      );
    })
  );

  const [backchannel, webhook] = await Promise.all([
    sendBackchannelLogoutFanout(env, {
      tenantId,
      issuer,
      sessions,
      config: logoutConfig.backchannel,
      startedAt,
      log,
      onAlert: async (details) => {
        await createAuditLog(env, {
          tenantId,
          userId: auditUserIdOf(trigger, details.userId),
          action: 'backchannel_logout.failed',
          resource: 'session',
          resourceId: details.sessionId,
          ipAddress: '',
          userAgent: '',
          metadata: JSON.stringify({
            client_id: details.clientId,
            attempts: details.attempts,
            trigger: 'admin_session_end',
            ...metadata,
          }),
          severity: 'warning',
        });
      },
    }),
    sendLogoutWebhookFanout(env, { issuer, sessions, config: webhookConfig, log }),
    Promise.all(audits),
  ]);

  // A session whose sending broke off may have clients not told: the job is retried (a relying
  // party told twice ends nothing more).
  if ((backchannel?.sessionErrors ?? 0) > 0 || (webhook?.sessionErrors ?? 0) > 0) {
    throw new Error('session_end_logout_sessions_not_sent');
  }
  // The fan-out answers null both when there was nothing to send and when it could not send (no
  // signing key, an error before sending): with clients to tell, the job is retried.
  if (
    backchannel === null &&
    logoutConfig.backchannel.enabled &&
    sessions.some((session) => session.backchannelClients.length > 0)
  ) {
    throw new Error('session_end_logout_backchannel_not_sent');
  }
  if (
    webhook === null &&
    webhookConfig.enabled &&
    sessions.some((session) => session.webhookClients.length > 0)
  ) {
    throw new Error('session_end_logout_webhook_not_sent');
  }

  // Every relying party has been told: the sessions' records are no longer needed. Only here,
  // after the checks above: a job that throws is retried and reads the targets again. A failed
  // removal is left to the store's expiry.
  await purgeEndedSessionsFromSessionClientStore(
    env,
    tenantId,
    params.sessions.map((session) => session.sessionId)
  );

  const summary = { sessions: sessions.length, backchannel, webhook };
  log.info('Downstream logout for admin session end completed', {
    action: trigger.action,
    ...summary,
  });
  return summary;
}

/** Error codes this module throws; anything else is recorded as `unexpected`. */
const LOGOUT_JOB_ERROR_CODE = /^(session_end_logout_[a-z_]+|tenant_lifecycle_unavailable)$/u;

/**
 * A logout job failed for the last time (its retries used up): record in the audit, for each user
 * of its sessions, that their relying parties may not have been told, with the job and the
 * action. The error is recorded as a code only.
 */
export async function auditSessionEndLogoutFailed(
  env: Env,
  job: { id: string; tenant_id: string; config: string | null },
  error: unknown,
  log: Logger = defaultLog
): Promise<void> {
  let config: SessionEndLogoutJobConfig | null = null;
  try {
    config = parseJobConfig(job.config);
  } catch {
    // Recorded below without the sessions.
  }
  const message = error instanceof Error ? error.message : '';
  const errorCode = LOGOUT_JOB_ERROR_CODE.test(message) ? message : 'unexpected';
  const sessionCounts = new Map<string, number>();
  for (const { userId } of config?.sessions ?? []) {
    const auditUserId = config ? auditUserIdOf(config.trigger, userId) : userId;
    sessionCounts.set(auditUserId, (sessionCounts.get(auditUserId) ?? 0) + 1);
  }
  const entries = sessionCounts.size > 0 ? [...sessionCounts] : [['system', 0] as const];
  await Promise.all(
    entries.map(([userId, sessionCount]) =>
      createAuditLog(env, {
        tenantId: job.tenant_id,
        userId,
        action: 'user.downstream_logout_failed',
        resource: 'user',
        resourceId: userId,
        ipAddress: '',
        userAgent: '',
        metadata: JSON.stringify({
          ...(config ? triggerMetadata(config.trigger) : {}),
          job_id: job.id,
          session_count: sessionCount,
          error_code: errorCode,
        }),
        severity: 'warning',
      }).catch((auditError) => {
        log.error(
          'Failed to create audit log for a failed downstream logout',
          { action: 'audit_log' },
          auditError as Error
        );
      })
    )
  );
}

function parseJobConfig(raw: string | null): SessionEndLogoutJobConfig {
  const config = JSON.parse(raw ?? 'null') as Partial<SessionEndLogoutJobConfig> | null;
  if (
    !config?.trigger ||
    !ADMIN_SESSION_END_ACTIONS.has(config.trigger.action) ||
    (config.trigger.auditUserId !== undefined &&
      (typeof config.trigger.auditUserId !== 'string' ||
        config.trigger.auditUserId.length === 0)) ||
    !Array.isArray(config.sessions) ||
    config.sessions.length > SESSIONS_PER_LOGOUT_JOB ||
    !config.sessions.every(
      (session) =>
        typeof session?.userId === 'string' &&
        session.userId.length > 0 &&
        typeof session.sessionId === 'string' &&
        session.sessionId.length > 0
    )
  ) {
    throw new Error('session_end_logout_job_config_invalid');
  }
  return config as SessionEndLogoutJobConfig;
}

/** The admin job processor: one job's downstream logout. */
export async function processSessionEndLogoutJob(
  env: Env,
  _stores: unknown,
  job: { tenant_id: string; config: string | null }
): Promise<{
  status: 'completed';
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
}> {
  const config = parseJobConfig(job.config);
  const summary = await sendAdminSessionEndLogout(env, {
    tenantId: job.tenant_id,
    sessions: config.sessions,
    trigger: config.trigger,
  });
  const total = config.sessions.length;
  return {
    status: 'completed',
    progress: { total, processed: total, succeeded: total, failed: 0, stage: 'completed' },
    result: {
      summary: {
        sessions: total,
        notified: (summary.backchannel?.succeeded ?? 0) + (summary.webhook?.succeeded ?? 0),
        // Each one is in the logout failure list.
        failed_notifications: (summary.backchannel?.failed ?? 0) + (summary.webhook?.failed ?? 0),
      },
      trigger_action: config.trigger.action,
    },
  };
}
