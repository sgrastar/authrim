/**
 * PII-free investigation: an operator looks at the status of one end user's account without
 * personal data (ADM-20 / ADM-21).
 *
 * GET /api/admin/investigations/subjects/:handle/status
 *
 * The route is gated by `admin:users:status:read`. The handle names the subject through an entry
 * point, and each entry point decides who may use it: the internal user ID (`user:<id>`) only
 * callers who may read the user anyway (`admin:users:read`). Investigation IDs, inquiry numbers
 * and lookups are later entry points that resolve to the same subject.
 *
 * The status is read from the account's Core database alone. Nothing here resolves a PII adapter,
 * the PII destination of an account route, or a runtime user projection.
 */
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  createAuthContextFromHono,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  getTenantMetadataContextFromHono,
  hasAdminPermission,
  isValidPersistedUserId,
  resolveAccountCoreDataContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { isInactiveAccountRouteError } from './account-route-errors';
import { getAdminAuth } from './admin-tenant-access';
import { scheduleAdminAuditLog } from './admin-shared';
import { readCoreSubjectStatus } from './investigation-subject-status';
import { accountStoreHolding } from './rbac-account-stores';
import { usesRoutedAccountStorage } from './tenant-routed-storage';

/** How the operator reached the subject. Recorded with every read. */
export type InvestigationEntryPoint = 'user_id';

export interface InvestigationSubject {
  tenantId: string;
  userId: string;
  entryPoint: InvestigationEntryPoint;
}

const USER_HANDLE_PREFIX = 'user:';

export type InvestigationHandle = { kind: 'user_id'; userId: string };

/**
 * The entry point and value a handle names; null for a handle of no known form. A value that is
 * not of its entry point's form (an email address typed as a user ID, say) is refused here, before
 * it is read with or recorded in the audit log.
 */
export function parseInvestigationHandle(handle: string): InvestigationHandle | null {
  if (handle.startsWith(USER_HANDLE_PREFIX)) {
    const userId = handle.slice(USER_HANDLE_PREFIX.length);
    return isValidPersistedUserId(userId) ? { kind: 'user_id', userId } : null;
  }
  return null;
}

type SubjectResolution =
  | { ok: true; subject: InvestigationSubject }
  | { ok: false; status: 403 | 404 };

/**
 * The subject a handle names, if the caller may use that entry point. Decided before anything is
 * read, so a caller who may not use an entry point learns nothing about the subjects behind it.
 */
export function resolveInvestigationSubject(
  c: Context<{ Bindings: Env }>,
  handle: InvestigationHandle | null
): SubjectResolution {
  if (!handle) return { ok: false, status: 404 };
  const permissions = getAdminAuth(c)?.permissions ?? [];
  switch (handle.kind) {
    case 'user_id':
      if (!hasAdminPermission(permissions, ADMIN_PERMISSIONS.USERS_READ)) {
        return { ok: false, status: 403 };
      }
      return {
        ok: true,
        subject: {
          tenantId: getTenantIdFromContext(c),
          userId: handle.userId,
          entryPoint: 'user_id',
        },
      };
  }
}

/**
 * The Core database holding the subject's account: the tenant's database, or for routed storage
 * the account's own. An account route reaches only an active account, so a suspended or locked
 * one (the usual subject of an investigation) is found among the tenant's Core databases. Only
 * Core destinations are resolved. null when the tenant has no such account.
 */
async function subjectCoreAdapter(
  c: Context<{ Bindings: Env }>,
  subject: InvestigationSubject
): Promise<DatabaseAdapter | null> {
  if (!usesRoutedAccountStorage(getTenantMetadataContextFromHono(c))) {
    return createAuthContextFromHono(c, subject.tenantId).coreAdapter;
  }
  try {
    const account = await resolveAccountCoreDataContext(c.env, {
      tenantId: subject.tenantId,
      accountId: subject.userId,
    });
    return ensureDatabaseAdapter(account.coreDb, 'investigation-account-core');
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') return null;
    if (!isInactiveAccountRouteError(error)) throw error;
    return accountStoreHolding(c.env, subject.tenantId, subject.userId);
  }
}

function errorResponse(c: Context<{ Bindings: Env }>, status: 403 | 404 | 500) {
  const body =
    status === 403
      ? {
          error: 'insufficient_permissions',
          error_description: 'You do not have the required permissions for this operation.',
        }
      : status === 404
        ? { error: 'not_found', error_description: 'The requested resource was not found' }
        : { error: 'server_error', error_description: 'Failed to retrieve subject status' };
  return c.json(body, status, { 'Cache-Control': 'no-store' });
}

export async function adminInvestigationSubjectStatusHandler(c: Context<{ Bindings: Env }>) {
  const resolution = resolveInvestigationSubject(
    c,
    parseInvestigationHandle(c.req.param('handle') ?? '')
  );
  if (!resolution.ok) return errorResponse(c, resolution.status);
  const { subject } = resolution;
  const audit = (result: 'success' | 'failure', reason?: 'not_found' | 'read_failed') =>
    scheduleAdminAuditLog(c, 'investigation.subject_status.read', subject.userId, result, {
      entry_point: subject.entryPoint,
      ...(reason ? { reason } : {}),
    });

  try {
    const core = await subjectCoreAdapter(c, subject);
    const status = core
      ? await readCoreSubjectStatus(core, subject.tenantId, subject.userId)
      : null;
    if (!status) {
      audit('failure', 'not_found');
      return errorResponse(c, 404);
    }
    audit('success');
    return c.json(
      { subject: { entry_point: subject.entryPoint }, source: 'core', ...status },
      200,
      { 'Cache-Control': 'no-store' }
    );
  } catch (error) {
    // A database error can quote what it was given: only the error's type is logged, and the
    // attempt is recorded with a fixed reason, never the error's text.
    getLogger(c)
      .module('ADMIN-INVESTIGATION')
      .error('Subject status read failed', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
    try {
      audit('failure', 'read_failed');
    } catch {
      // A failed audit write must not replace the response.
    }
    return errorResponse(c, 500);
  }
}
