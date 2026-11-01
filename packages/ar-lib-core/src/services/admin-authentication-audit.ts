import { AdminAuditLogRepository } from '../repositories/admin/admin-audit-log';
import type { Env } from '../types/env';
import { createLogger } from '../utils/logger';
import { requireAdminDatabaseAdapter } from './admin-database-adapter';

const log = createLogger().module('ADMIN-AUTH-AUDIT');

/**
 * Admin sign-in and sign-out events recorded in the Admin audit log.
 *
 * `admin.login_failed` is only written once the credential is known to belong to an
 * administrator, so a probe with an unknown credential leaves no Admin audit row.
 */
export type AdminAuthenticationAuditAction = 'admin.login' | 'admin.login_failed' | 'admin.logout';

export interface AdminAuthenticationAuditRequest {
  header(name: string): string | undefined;
}

export interface AdminAuthenticationAuditInput {
  tenantId: string;
  action: AdminAuthenticationAuditAction;
  /** Method used to authenticate, for example `passkey`. Not set for sign-out. */
  method?: string;
  adminUserId?: string;
  /** Raw Admin session ID; only its digest is written to the audit. */
  sessionId?: string;
  /** Machine-readable failure reason; only for `admin.login_failed`. */
  reason?: string;
  /** Request ID of the runtime log; falls back to the proxy headers, then `CF-Ray`. */
  requestId?: string;
  /** Extra non-PII context merged into the entry metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * The session ID is the value of the `authrim_admin_session` cookie, and the audit
 * overview is stored unencrypted, so only a one-way digest is recorded. Login and logout
 * of one session carry the same digest, which keeps them correlatable.
 */
async function sessionDigest(sessionId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`authrim:admin-session-audit:${sessionId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function clientIp(request: AdminAuthenticationAuditRequest): string {
  return (
    request.header('CF-Connecting-IP') ||
    request.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    request.header('X-Real-IP') ||
    'unknown'
  );
}

/**
 * Record an Admin sign-in or sign-out in the Admin audit log.
 *
 * Best effort: the Admin session is already created or removed when this runs, so a
 * logging outage is reported to the runtime log and never fails the request. Returns
 * whether the row was accepted.
 */
export async function writeAdminAuthenticationAudit(
  env: Env,
  request: AdminAuthenticationAuditRequest,
  input: AdminAuthenticationAuditInput
): Promise<boolean> {
  try {
    const repository = new AdminAuditLogRepository(
      requireAdminDatabaseAdapter(env, 'admin-authentication-audit'),
      env
    );
    const failed = input.action === 'admin.login_failed';
    const session = input.sessionId ? await sessionDigest(input.sessionId) : undefined;
    await repository.createAuditLog({
      tenant_id: input.tenantId,
      admin_user_id: input.adminUserId,
      action: input.action,
      resource_type: 'admin_session',
      resource_id: session,
      result: failed ? 'failure' : 'success',
      error_code: failed ? input.reason : undefined,
      severity: failed ? 'warn' : 'info',
      ip_address: clientIp(request),
      user_agent: request.header('User-Agent') || 'unknown',
      request_id:
        input.requestId ||
        request.header('X-Request-Id') ||
        request.header('X-Correlation-Id') ||
        request.header('CF-Ray') ||
        undefined,
      session_id: session,
      metadata: {
        ...(input.method ? { method: input.method } : {}),
        ...(input.metadata ?? {}),
      },
    });
    return true;
  } catch (error) {
    log.error(
      'Failed to write Admin authentication audit',
      { action: input.action },
      error as Error
    );
    return false;
  }
}

/** The parts of a Hono context needed to write the audit after the response is sent. */
export interface AdminAuthenticationAuditContext {
  env: Env;
  req: AdminAuthenticationAuditRequest;
  /** Hono's context getter; `requestId` is set by the request context middleware. */
  get?(key: 'requestId'): unknown;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Write the audit row after the response is sent, so sign-in latency does not depend on
 * the log store. Without an execution context (tests, local tools) the write still starts
 * immediately; it never rejects.
 */
export function scheduleAdminAuthenticationAudit(
  c: AdminAuthenticationAuditContext,
  input: AdminAuthenticationAuditInput
): void {
  const contextRequestId = c.get?.('requestId');
  const written = writeAdminAuthenticationAudit(c.env, c.req, {
    ...input,
    requestId:
      input.requestId ||
      (typeof contextRequestId === 'string' && contextRequestId ? contextRequestId : undefined),
  });
  try {
    c.executionCtx.waitUntil(written);
  } catch {
    // Hono throws when there is no execution context; the promise is already running.
  }
}
