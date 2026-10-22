/**
 * Starting the downstream logout from an admin request that ended sessions: the sessions are kept
 * as admin jobs before the response, the admin audit records which action started them, and the
 * first job is sent right after the response (the scheduled run sends the rest, and retries any
 * job not run to its end).
 */
import type { Context } from 'hono';
import { createLogger, type Env, type Logger } from '@authrim/ar-lib-core';
import { processGenericAdminJobNow } from './admin-job-executor';
import { scheduleAdminAuditLog } from './admin-shared';
import {
  auditSessionEndLogoutStarted,
  auditUserIdOf,
  enqueueSessionEndLogout,
  sendAdminSessionEndLogout,
  type AdminSessionEndTrigger,
  type EndedSession,
} from './session-end-logout';

/** Any admin route's context (routers add their own variables). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminContext = Context<any, any, any>;

const defaultLog = createLogger().module('ADMIN-SESSION-END-LOGOUT');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The admin acting in this request, for the audit records of the fan-out. */
export function adminActorIdFromContext(c: AdminContext): string | undefined {
  try {
    const adminAuth = (c as unknown as { get?: (key: string) => unknown }).get?.('adminAuth') as
      | { actorId?: string; userId?: string }
      | undefined;
    return adminAuth?.actorId ?? adminAuth?.userId ?? undefined;
  } catch {
    return undefined;
  }
}

function requestWaitUntil(c: AdminContext): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const executionCtx = (
      c as unknown as { executionCtx?: { waitUntil(promise: Promise<unknown>): void } }
    ).executionCtx;
    return executionCtx ? (promise) => executionCtx.waitUntil(promise) : undefined;
  } catch {
    // Hono throws when the request has no execution context.
    return undefined;
  }
}

interface SessionEndLogoutParams {
  tenantId: string;
  trigger: AdminSessionEndTrigger;
  log?: Logger;
  /**
   * Where the start is recorded: the admin audit (an admin's request, the default), or the tenant
   * audit for each user (a request with no admin, such as SCIM's).
   */
  audit?: 'admin' | 'tenant';
}

/**
 * After an admin request ended these sessions: keep their downstream logout as admin jobs, record
 * in the audit that it was started and by which action, and send the first job after the
 * response. Never throws: the sessions have ended whatever happens here.
 */
export async function startAdminSessionEndLogout(
  c: AdminContext,
  params: SessionEndLogoutParams & { sessions: EndedSession[] }
): Promise<void> {
  const log = params.log ?? defaultLog;
  const { tenantId, sessions, trigger } = params;
  if (sessions.length === 0) return;
  const env = c.env as Env;
  try {
    let jobIds: string[] = [];
    try {
      jobIds = await enqueueSessionEndLogout(env, { tenantId, sessions, trigger });
    } catch (error) {
      log.error('Downstream logout could not be kept as admin jobs', {
        action: trigger.action,
        error: errorMessage(error),
      });
    }

    const waitUntil = requestWaitUntil(c);
    if (params.audit === 'tenant') {
      const audit = auditSessionEndLogoutStarted(env, { tenantId, sessions, trigger, jobIds, log });
      if (waitUntil) waitUntil(audit);
      else await audit;
    } else {
      const userIds = [...new Set(sessions.map((session) => session.userId))];
      scheduleAdminAuditLog(
        c,
        'user.downstream_logout',
        userIds.length === 1 ? auditUserIdOf(trigger, userIds[0]) : null,
        jobIds.length > 0 ? 'success' : 'failure',
        {
          trigger_action: trigger.action,
          ...(trigger.operationId ? { operation_id: trigger.operationId } : {}),
          user_count: userIds.length,
          session_count: sessions.length,
          job_ids: jobIds,
        }
      );
    }

    if (!waitUntil) {
      // The scheduled run sends the jobs.
      if (jobIds.length === 0) {
        log.error('Downstream logout not sent: no job and no execution context', {
          action: trigger.action,
        });
      }
      return;
    }
    const startedAt = Date.now();
    waitUntil(
      (jobIds.length > 0
        ? processGenericAdminJobNow(env, log, tenantId, jobIds[0])
        : // Not kept: send once, as best it can be.
          sendAdminSessionEndLogout(env, { tenantId, sessions, trigger, startedAt, log })
      ).catch((error) => {
        log.error('Downstream logout after the admin response failed', {
          action: trigger.action,
          error: errorMessage(error),
        });
      })
    );
  } catch (error) {
    log.error('Downstream logout not started', {
      action: trigger.action,
      error: errorMessage(error),
    });
  }
}

/**
 * Run work that ends sessions (collecting them in the list it is given), then start their
 * downstream logout as `startAdminSessionEndLogout` does, also when the work then fails: the
 * sessions it ended have ended all the same.
 */
export async function withAdminSessionEndLogout<T>(
  c: AdminContext,
  params: SessionEndLogoutParams,
  work: (ended: EndedSession[]) => Promise<T>
): Promise<T> {
  const ended: EndedSession[] = [];
  try {
    return await work(ended);
  } finally {
    await startAdminSessionEndLogout(c, { ...params, sessions: ended });
  }
}
