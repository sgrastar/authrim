/**
 * Taking access away from an end user: removing a role assignment, removing an organization
 * membership, suspending an account. The Admin API endpoints and access reviews both use these,
 * so every removal has the same effects: the row goes from the store that holds it, the user's
 * cached RBAC claims and user cache are dropped (so tokens issued from now on no longer carry it),
 * and the removal is audited.
 *
 * Each step can be done again: running a removal again after a failure part way finishes what is
 * left (a row already gone is not an error, the caches are dropped and the audit is written again,
 * under the same `auditId` so it is recorded once).
 *
 * Callers pass the store the row lives in (an account's shard for routed tenants) and how to
 * audit (the request's context, so the entry carries who did it and from where).
 */
import {
  invalidateSubjectRBACCache,
  invalidateUserCache,
  type DatabaseAdapter,
  type Env,
  type Logger,
} from '@authrim/ar-lib-core';
import { getCanonicalAccountStatus, transitionAccountLifecycle } from './account-status';

/**
 * Records one removal (action, resource, resource id, details). A retried removal passes the same
 * id and time, so the entry and its copies (archive, forwarding) are the ones first recorded.
 */
export type RevocationAudit = (
  action: string,
  resource: string,
  resourceId: string,
  details: Record<string, unknown>,
  stable?: { id: string; at: number }
) => Promise<void>;

export interface RevocationContext {
  env: Env;
  tenantId: string;
  /** The store holding the user's account, role assignments and memberships. */
  adapter: DatabaseAdapter;
  audit: RevocationAudit;
  log: Logger;
  /**
   * When the caches cannot be dropped: 'throw' fails the removal so it is done again (access
   * reviews); 'warn' logs it, the caches expiring on their own (an Admin API request, whose
   * removal is done and answered).
   */
  onCacheFailure: 'throw' | 'warn';
}

export class AccessCacheInvalidationError extends Error {
  constructor() {
    super('access_cache_invalidation_failed');
  }
}

/** Drops what is cached about the user's access. */
async function dropAccessCaches(context: RevocationContext, userId: string): Promise<void> {
  const { env, tenantId, log } = context;
  const results = await Promise.allSettled([
    env.REBAC_CACHE
      ? invalidateSubjectRBACCache(env.REBAC_CACHE, tenantId, userId)
      : Promise.resolve(),
    invalidateUserCache(env, tenantId, userId, {
      throwOnFailure: context.onCacheFailure === 'throw',
    }),
  ]);
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length === 0) return;
  log.warn('Access cache could not be dropped', {
    tenantId,
    errorType:
      failed[0]!.status === 'rejected' && failed[0]!.reason instanceof Error
        ? failed[0]!.reason.name
        : 'Unknown',
  });
  if (context.onCacheFailure === 'throw') throw new AccessCacheInvalidationError();
}

/** Removes one of the user's role assignments (already gone: the rest is still done). */
export async function removeRoleAssignment(
  context: RevocationContext,
  input: {
    userId: string;
    assignmentId: string;
    details?: Record<string, unknown>;
    audit?: { id: string; at: number };
  }
): Promise<'removed' | 'already_removed'> {
  const result = await context.adapter.execute(
    'DELETE FROM role_assignments WHERE tenant_id = ? AND id = ? AND subject_id = ?',
    [context.tenantId, input.assignmentId, input.userId]
  );
  const outcome = (result.rowsAffected ?? 0) > 0 ? 'removed' : 'already_removed';
  await dropAccessCaches(context, input.userId);
  await context.audit(
    'role_assignment.removed',
    'role_assignment',
    input.assignmentId,
    {
      user_id: input.userId,
      ...(outcome === 'already_removed' ? { already_removed: true } : {}),
      ...input.details,
    },
    input.audit
  );
  return outcome;
}

/** Removes the user from an organization (already gone: the rest is still done). */
export async function removeOrganizationMembership(
  context: RevocationContext,
  input: {
    userId: string;
    orgId: string;
    details?: Record<string, unknown>;
    audit?: { id: string; at: number };
  }
): Promise<'removed' | 'already_removed'> {
  const result = await context.adapter.execute(
    'DELETE FROM subject_org_membership WHERE tenant_id = ? AND org_id = ? AND subject_id = ?',
    [context.tenantId, input.orgId, input.userId]
  );
  const outcome = (result.rowsAffected ?? 0) > 0 ? 'removed' : 'already_removed';
  await dropAccessCaches(context, input.userId);
  await context.audit(
    'organization_membership.removed',
    'organization',
    input.orgId,
    {
      user_id: input.userId,
      ...(outcome === 'already_removed' ? { already_removed: true } : {}),
      ...input.details,
    },
    input.audit
  );
  return outcome;
}

export class AccountLifecycleSupersededError extends Error {
  constructor() {
    super('account_lifecycle_superseded');
  }
}

/**
 * Suspends an active account as transition `operationId` of version `versionMs`: sign-in is
 * refused and its sessions are revoked first (the account's authentication state), then the
 * account and its subject are marked suspended together. The same transition can be done again
 * (an interrupted one is finished); another transition that came after it wins (superseded).
 *
 * already_suspended: suspended by another transition, so there is no access left to take.
 * not_active: deleted, locked or otherwise not active.
 */
export async function suspendAccount(
  context: RevocationContext,
  input: {
    userId: string;
    operationId: string;
    versionMs: number;
    reasonCode: string;
    details?: Record<string, unknown>;
    audit?: { id: string; at: number };
    /**
     * An earlier attempt of this operation may have suspended it already (its caches or audit
     * left undone): when another transition has replaced it since, those are still finished.
     */
    started?: boolean;
  }
): Promise<'suspended' | 'already_suspended' | 'not_found' | 'not_active'> {
  const { env, tenantId, adapter } = context;
  const account = await getCanonicalAccountStatus(adapter, tenantId, input.userId);
  if (!account) return 'not_found';
  const ours = account.lifecycle_operation_id === input.operationId;
  // What a started suspension left undone, when another transition has replaced it since: the
  // newer state stays.
  const finishReplaced = async () => {
    await dropAccessCaches(context, input.userId);
    await context.audit(
      'user.suspend',
      'user',
      input.userId,
      { reason_code: input.reasonCode, superseded: true, ...input.details },
      input.audit
    );
  };
  // Suspended, locked or deleted by another transition: no access left to take.
  if (!ours && account.lifecycle_state !== 'active') {
    if (input.started) await finishReplaced();
    return account.lifecycle_state === 'suspended' ? 'already_suspended' : 'not_active';
  }

  const transition = await transitionAccountLifecycle(env, adapter, {
    tenantId,
    userId: input.userId,
    lifecycle: 'suspended',
    status: 'suspended',
    metadataPatch: { suspended_at: Math.floor(input.versionMs / 1000), suspended_until: null },
    versionMs: input.versionMs,
    operationId: input.operationId,
    revokeSessions: true,
  });
  if (transition === 'superseded') {
    // Replaced after it was read: a started one is still finished, one not started is refused.
    if (input.started) {
      await finishReplaced();
      return 'not_active';
    }
    throw new AccountLifecycleSupersededError();
  }
  await dropAccessCaches(context, input.userId);
  await context.audit(
    'user.suspend',
    'user',
    input.userId,
    {
      reason_code: input.reasonCode,
      previous_status: ours ? 'active' : account.status,
      ...input.details,
    },
    input.audit
  );
  return 'suspended';
}
