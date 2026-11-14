/**
 * POST /api/admin/tenants/:id/deletion/cancel
 *
 * Cancels a FAILED tenant deletion: the route (quarantining or quarantined) goes back to active
 * with the function disaster recovery uses, the failed job is marked cancelled, and the tenant
 * stays `suspended` (bringing it back to `active` is the existing `resume` operation).
 *
 * The point of no return is the lookup disable inside the deletion job: everything before it only
 * changes route state and generations. It is decided from persisted state, never from the job's
 * `progress` (a retry overwrites that): Control has not finalised the deletion, and no lookup row
 * of the tenant is disabled. Anything that cannot be read refuses (fail closed).
 */

import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  createD1Adapter,
  createErrorResponse,
  deleteTenantExistsCache,
  getDefaultTenantId,
  getLogger,
  getPrimaryTenantId,
  requireDedicatedAdminDatabaseAdapter,
  type ControlTenantDeletionInventory,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { requireAdminStepUp } from './admin-step-up-gate';
import { writeAdminAuditLog } from './admin-shared';
import { getAdminAuth, requireTenantProvisioningAuthority } from './admin-tenant-access';
import { ensureSupportedTenantId } from './single-tenant-guard';
import { getTenantDeletionInventory } from './tenant-deletion-control-inventory';
import {
  activeTenantDeleteJobGuard,
  TENANT_DELETION_CANCEL_LEASE_SECONDS,
  TENANT_DELETION_CANCELLED_ERROR,
} from './tenant-deletion-job-predicate';
import { tenantLookupIdentifierDisableEvidence } from './tenant-deletion-lookup-cleanup';
import {
  readTenantDeleteJobs,
  tenantDeleteJobCancelStage,
  tenantDeleteJobCancellingAt,
  tenantDeleteJobChainId,
  tenantDeleteJobDestructiveStarted,
  tenantDeleteJobMarkerAware,
  tenantDeleteJobOwnsChain,
} from './tenant-deletion-reactivation-guard';
import { readTenantRouteStateReading } from './tenant-route-state-reading';
import { publishTenantRuntimeRegistryReactivation } from './tenant-runtime-registry-route-state';
import { z } from './zod';

const CancelTenantDeletionSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

const POLICY_UNAVAILABLE = 'control_tenant_deletion_policy_unavailable';

type Ctx = Context<{ Bindings: Env }>;

function refusal(
  c: Ctx,
  status: 409 | 503 | 400,
  error: string,
  description: string,
  extra: Record<string, unknown> = {}
): Response {
  return c.json({ error, error_description: description, ...extra }, status);
}

function pastPointOfNoReturn(c: Ctx, stage: string): Response {
  return refusal(
    c,
    409,
    'tenant_deletion_past_point_of_no_return',
    'The deletion has already passed the point where it can be undone; let it finish',
    { stage }
  );
}

function notFailed(c: Ctx): Response {
  return refusal(
    c,
    409,
    'tenant_deletion_not_failed',
    'The tenant has no failed deletion to cancel'
  );
}

function inProgress(c: Ctx): Response {
  return refusal(
    c,
    409,
    'tenant_deletion_in_progress',
    'The tenant has a deletion in progress; wait for it to fail before cancelling it'
  );
}

function stateChanged(c: Ctx): Response {
  return refusal(
    c,
    409,
    'tenant_state_changed',
    'The tenant or its deletion changed while the cancellation was being processed; nothing was cancelled'
  );
}

/** Whether Control says the deletion is finalised (or has no placement policy any more). */
async function controlInventoryOrPassed(
  env: Env,
  tenantId: string,
  chainId: string
): Promise<{ passed: true } | { passed: false; inventory: ControlTenantDeletionInventory }> {
  try {
    const inventory = await getTenantDeletionInventory(env, tenantId, chainId);
    return inventory.state === 'finalized' ? { passed: true } : { passed: false, inventory };
  } catch (error) {
    if (error instanceof Error && error.message.includes(POLICY_UNAVAILABLE)) {
      return { passed: true };
    }
    throw error;
  }
}

export async function cancelTenantDeletion(c: Ctx): Promise<Response> {
  const platformError = await requireTenantProvisioningAuthority(
    c,
    ADMIN_PERMISSIONS.TENANT_DELETE
  );
  if (platformError) return platformError;

  const id = c.req.param('id');
  if (!id) throw new Error('tenant_path_parameter_missing:id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) return blocked;

  if (id === getPrimaryTenantId(c.env)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'id', reason: 'Cannot cancel the deletion of the primary tenant' },
    });
  }
  if (id === getDefaultTenantId(c.env)) {
    return c.json(
      {
        error: 'default_tenant_protected',
        error_description: 'The deployment default tenant is never deleted',
      },
      409
    );
  }

  let reason: string;
  try {
    const parsed = CancelTenantDeletionSchema.safeParse(await c.req.json<unknown>());
    if (!parsed.success) {
      return refusal(
        c,
        400,
        'invalid_request',
        parsed.error.issues.map((issue) => issue.message).join(', ')
      );
    }
    reason = parsed.data.reason;
  } catch {
    return refusal(c, 400, 'invalid_request', 'A JSON body with a reason is required');
  }

  const log = getLogger(c).module('ADMIN-TENANTS');
  try {
    const adapter: DatabaseAdapter = createD1Adapter(c.env.DB, 'tenant-inventory');

    const tenant = await adapter.queryOne<{
      id: string;
      is_default: number;
      lifecycle_state: string;
      updated_at: number;
    }>('SELECT id, is_default, lifecycle_state, updated_at FROM tenants WHERE id = ?', [id]);

    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }
    if (tenant.is_default === 1) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Cannot cancel the deletion of the default tenant' },
      });
    }
    if (tenant.lifecycle_state === 'deleting') return inProgress(c);
    if (tenant.lifecycle_state !== 'suspended') return notFailed(c);

    const activeJob = activeTenantDeleteJobGuard(id);
    const active = await adapter.queryOne(`SELECT 1 AS found WHERE EXISTS (${activeJob.sql})`, [
      ...activeJob.params,
    ]);
    if (active) return inProgress(c);

    // The cancel works on the tenant's deletion jobs as a SET (a chain can have several failed
    // jobs: a failed deletion, its failed continuations, a failed unrelated attempt).
    const jobs = await readTenantDeleteJobs(adapter, id);
    const latest = jobs[0];
    if (!latest || latest.status !== 'failed') return notFailed(c);
    const failedJobs = jobs.filter((job) => job.status === 'failed');
    const unmarked = failedJobs.filter((job) => tenantDeleteJobCancelStage(job) === null);
    const cancelling = failedJobs.filter((job) => tenantDeleteJobCancelStage(job) === 'cancelling');
    const incomplete = cancelling.length > 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    // A cancel mark inside its lease belongs to a request that may still be publishing the route.
    if (
      cancelling.some(
        (job) =>
          (tenantDeleteJobCancellingAt(job) ?? 0) >
          nowSeconds - TENANT_DELETION_CANCEL_LEASE_SECONDS
      )
    ) {
      return refusal(
        c,
        409,
        'tenant_deletion_cancel_in_progress',
        'Another cancellation of this deletion is in progress; repeat the request after it has finished or its lease has passed'
      );
    }

    // The route lives in DB_ADMIN. Unreadable: refuse, nothing changed.
    let route: Awaited<ReturnType<typeof readTenantRouteStateReading>>;
    try {
      route = await readTenantRouteStateReading(
        requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-deletion-chain'),
        id
      );
    } catch (error) {
      log.error('Tenant route state unreadable for a deletion cancel', { id }, error as Error);
      return refusal(
        c,
        503,
        'tenant_route_state_unavailable',
        'The tenant route state could not be read; nothing was changed'
      );
    }
    const routeStatus = route?.routeStatus ?? 'active';

    if (unmarked.length === 0 && !incomplete) {
      // Every failed job is cancelled: an idempotent repeat while the route is active.
      if (routeStatus !== 'active' || tenantDeleteJobCancelStage(latest) !== 'cancelled') {
        return notFailed(c);
      }
      return c.json({
        tenant_id: id,
        lifecycle_state: 'suspended',
        cancelled_job_id: latest.id,
        operation_id: tenantDeleteJobChainId(latest),
        route_status_before: routeStatus,
        route_reactivated: false,
        already_cancelled: true,
      });
    }

    if (routeStatus === 'disabled') return pastPointOfNoReturn(c, 'route_disabled');
    const quarantined = routeStatus === 'quarantining' || routeStatus === 'quarantined';
    // The chain is decided from the ROUTE, not from the latest job: a quarantine is cancellable
    // only when a failed (unmarked, or `cancelling` for a repeat) deletion job of this tenant
    // owns its operation id. Anything else (disaster recovery, another tenant operation) is not
    // touched. With no quarantine to undo the latest job names the chain for the response.
    const pending = [...unmarked, ...cancelling];
    let chainId: string;
    let chainJobs: typeof pending;
    if (quarantined) {
      const routeOperationId = route?.operationId ?? null;
      chainJobs = routeOperationId
        ? pending.filter((job) => tenantDeleteJobOwnsChain(job, routeOperationId))
        : [];
      if (!routeOperationId || chainJobs.length === 0) {
        return refusal(
          c,
          409,
          'tenant_route_owned_by_other_operation',
          'The tenant route is held by another operation (for example a disaster recovery); it is not touched'
        );
      }
      chainId = routeOperationId;
    } else {
      // A repeat of an incomplete cancel decides the chain from the route even when it reads
      // `active`: if its operation id is owned by a `cancelling` deletion job of this tenant,
      // that is the chain (its publication has to be confirmed), whatever the latest job is.
      // On a FIRST request an active route needs no publication: a cancel always marks its jobs
      // before it touches the route, so an active route with no `cancelling` mark means no
      // cancel of ours changed it, and the deletion itself only ever left it quarantining or
      // quarantined (or never touched it).
      const routeOperationId = route?.operationId ?? null;
      const routeOwners = routeOperationId
        ? cancelling.filter((job) => tenantDeleteJobOwnsChain(job, routeOperationId))
        : [];
      if (incomplete && routeOperationId && routeOwners.length > 0) {
        chainId = routeOperationId;
        chainJobs = pending.filter((job) => tenantDeleteJobOwnsChain(job, chainId));
      } else {
        chainId = tenantDeleteJobChainId(pending[0] ?? latest);
        chainJobs = pending.filter((job) => tenantDeleteJobOwnsChain(job, chainId));
      }
    }
    // An incomplete cancel whose route is already active under this chain: the database change
    // was made but the signed snapshot may not have been published. The reactivation is replayed
    // (it accepts "already active under this operation id") to publish and read it back.
    const republish =
      incomplete &&
      routeStatus === 'active' &&
      route !== null &&
      route.operationId === chainId &&
      route.quarantineDenyGeneration >= 1;

    // The point of no return, from persisted state only; every error refuses (fail closed).
    // 1. The durable marker the deletion job writes right before the lookup disable.
    if (chainJobs.some((job) => tenantDeleteJobDestructiveStarted(job))) {
      return pastPointOfNoReturn(c, 'destructive_started');
    }
    if (quarantined) {
      try {
        // 2. Control: finalised (or no placement policy any more).
        const control = await controlInventoryOrPassed(c.env, id, chainId);
        if (control.passed) return pastPointOfNoReturn(c, 'control_finalized');
        // 3. A job that predates the marker may have crossed the line unrecorded. The identifier
        //    table is the one unambiguous evidence; no rows at all is no evidence, so refused.
        if (chainJobs.some((job) => !tenantDeleteJobMarkerAware(job))) {
          const evidence = await tenantLookupIdentifierDisableEvidence(
            c.env,
            control.inventory.lookupShards,
            id
          );
          if (evidence.disabledIdentifierRows > 0) return pastPointOfNoReturn(c, 'lookup_disabled');
          if (evidence.identifierRows === 0) return pastPointOfNoReturn(c, 'legacy_unverifiable');
        }
      } catch (error) {
        log.error('Tenant deletion point of no return not verifiable', { id }, error as Error);
        return refusal(
          c,
          503,
          'tenant_deletion_state_unverifiable',
          'Whether the deletion passed its point of no return could not be verified; nothing was changed'
        );
      }
    }

    // Every read-only check has passed; the receipt is spent here, before the first write.
    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: 'tenant.delete',
      targetTenantId: id,
      targetIds: [id],
    });
    if (stepUpRefused) return stepUpRefused;

    // Audit first, fail closed (the order disaster recovery uses): no audit, NO write at all.
    const adminAuth = getAdminAuth(c);
    const actor = adminAuth?.actorId ?? adminAuth?.userId ?? 'unknown';
    const auditId = await writeAdminAuditLog(c, {
      action: 'tenant.delete_cancelled',
      resourceType: 'tenant',
      resourceId: id,
      result: 'success',
      before: { lifecycle_state: 'suspended', route_status: routeStatus },
      after: { lifecycle_state: 'suspended', route_status: 'active' },
      metadata: {
        tenant_id: id,
        job_id: chainJobs[0]?.id ?? latest.id,
        job_ids: pending.map((job) => job.id),
        operation_id: chainId,
        route_status_before: routeStatus,
        completes_incomplete_cancel: incomplete,
        reason,
      },
    });
    if (!auditId) {
      return refusal(
        c,
        503,
        'audit_unavailable',
        'The audit entry could not be written; nothing was cancelled'
      );
    }

    // ONE atomic guarded write in the platform database (it holds both `tenants` and the
    // deletion jobs). Every failed, unmarked deletion job of the tenant is marked `cancelling`
    // with this request's `cancelling_at`; a `cancelling` mark whose lease has run out is taken
    // over (same stamp). The tenant version is bumped in the same batch. Guards: the tenant is
    // still `suspended` at the version read, no deletion is active. A DELETE queued meanwhile
    // makes this fail; a cancel committed first makes the DELETE's own guard fail.
    const nowTs = Math.max(Math.floor(Date.now() / 1000), tenant.updated_at + 1);
    const lease = nowTs - TENANT_DELETION_CANCEL_LEASE_SECONDS;
    const activeGuard = activeTenantDeleteJobGuard(id, nowTs);
    const markedProgress = JSON.stringify({
      stage: 'cancelling',
      cancelling_at: nowTs,
      cancelled_by: actor,
    });
    const tenantStillSuspended =
      "EXISTS (SELECT 1 FROM tenants WHERE id = ? AND lifecycle_state = 'suspended' AND updated_at = ?)";
    const ownJobs = "job_type = 'tenants/delete' AND json_extract(config, '$.tenant_id') = ?";
    const [markFresh, takeOver, bumpTenant] = await adapter.batch([
      {
        sql: `UPDATE admin_jobs SET error_message = ?, progress = ?, updated_at = ?
               WHERE ${ownJobs} AND status = 'failed'
                 AND (error_message IS NULL OR error_message <> ?)
                 AND ${tenantStillSuspended}
                 AND NOT EXISTS (${activeGuard.sql})`,
        params: [
          TENANT_DELETION_CANCELLED_ERROR,
          markedProgress,
          nowTs,
          id,
          TENANT_DELETION_CANCELLED_ERROR,
          id,
          tenant.updated_at,
          ...activeGuard.params,
        ],
      },
      {
        sql: `UPDATE admin_jobs SET progress = ?, updated_at = ?
               WHERE ${ownJobs} AND status = 'failed' AND error_message = ?
                 AND COALESCE(json_extract(progress, '$.stage'), '') <> 'cancelled'
                 AND COALESCE(json_extract(progress, '$.cancelling_at'), 0) <= ?
                 AND COALESCE(json_extract(progress, '$.cancelling_at'), 0) <> ?
                 AND ${tenantStillSuspended}
                 AND NOT EXISTS (${activeGuard.sql})`,
        params: [
          markedProgress,
          nowTs,
          id,
          TENANT_DELETION_CANCELLED_ERROR,
          lease,
          nowTs,
          id,
          tenant.updated_at,
          ...activeGuard.params,
        ],
      },
      {
        sql: `UPDATE tenants SET updated_at = ?
               WHERE id = ? AND lifecycle_state = 'suspended' AND updated_at = ?
                 AND EXISTS (SELECT 1 FROM admin_jobs WHERE ${ownJobs} AND error_message = ?
                               AND json_extract(progress, '$.cancelling_at') = ?)
                 AND NOT EXISTS (SELECT 1 FROM admin_jobs WHERE ${ownJobs} AND error_message = ?
                               AND COALESCE(json_extract(progress, '$.stage'), '') <> 'cancelled'
                               AND COALESCE(json_extract(progress, '$.cancelling_at'), 0) <> ?)`,
        params: [
          nowTs,
          id,
          tenant.updated_at,
          id,
          TENANT_DELETION_CANCELLED_ERROR,
          nowTs,
          id,
          TENANT_DELETION_CANCELLED_ERROR,
          nowTs,
        ],
      },
    ]);
    const markedCount = Number(markFresh?.rowsAffected ?? 0) + Number(takeOver?.rowsAffected ?? 0);
    if (markedCount < 1 || bumpTenant?.rowsAffected !== 1) return stateChanged(c);

    const reactivate = quarantined;
    if (reactivate || republish) {
      try {
        await publishTenantRuntimeRegistryReactivation(c.env, {
          tenantId: id,
          operationId: chainId,
          actorId: actor,
          expectedQuarantineDenyGeneration: route?.quarantineDenyGeneration ?? 0,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        log.error('Tenant deletion cancel could not reactivate the route', { id }, error as Error);
        if (
          message === 'runtime_registry_route_state_reactivation_not_allowed' ||
          message === 'runtime_registry_route_state_reactivation_conflict'
        ) {
          return stateChanged(c);
        }
        // The jobs stay `cancelling`: a repeat (after the lease) completes them, and resume stays
        // refused meanwhile.
        return refusal(
          c,
          503,
          'tenant_route_reactivation_failed',
          'The tenant route could not be reactivated and published; repeat the cancellation to complete it'
        );
      }
    }

    // Only now, the route confirmed: every job of the set is `cancelled` together. Guarded by
    // the `cancelling_at` this request wrote, so a request that lost its lease finalises nothing.
    const doneAt = Math.floor(Date.now() / 1000);
    const finished = await adapter.execute(
      `UPDATE admin_jobs
          SET progress = json_set(COALESCE(progress, '{}'), '$.stage', 'cancelled', '$.cancelled_at', ?),
              updated_at = ?
        WHERE ${ownJobs} AND status = 'failed' AND error_message = ?
          AND json_extract(progress, '$.stage') = 'cancelling'
          AND json_extract(progress, '$.cancelling_at') = ?`,
      [doneAt, doneAt, id, TENANT_DELETION_CANCELLED_ERROR, nowTs]
    );
    if (finished.rowsAffected !== markedCount) return stateChanged(c);

    // Suspended: the same cache state the lifecycle code keeps for it (no positive entry).
    await deleteTenantExistsCache(c.env.AUTHRIM_CONFIG, id).catch(() => undefined);

    return c.json({
      tenant_id: id,
      lifecycle_state: 'suspended',
      cancelled_job_id: chainJobs[0]?.id ?? latest.id,
      operation_id: chainId,
      route_status_before: routeStatus,
      route_reactivated: reactivate || republish,
    });
  } catch (error) {
    log.error('Failed to cancel tenant deletion', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
