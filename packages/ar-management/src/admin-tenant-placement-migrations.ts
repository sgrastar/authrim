import type { Context } from 'hono';
import {
  assertControlPlaneRecordIsSecretFree,
  createAuditLog,
  ensureDatabaseAdapter,
  requireAdminDatabaseAdapter,
  type AdminAuthContext,
  type ControlTenantPlacementMigrationView,
  type Env,
} from '@authrim/ar-lib-core';
import {
  TENANT_PLACEMENT_MIGRATION_STEPS,
  TenantPlacementMigrationJobRepository,
  type TenantPlacementMigrationJobView,
} from './tenant-placement-migration-job';
import { processNextTenantPlacementMigration } from './tenant-placement-migration-scheduled';

type AdminContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

function environmentId(env: Env): string {
  const value = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!value || !SAFE_ID.test(value)) throw new Error('environment_invalid');
  return value;
}

function auditActor(c: AdminContext): string {
  const auth = c.get('adminAuth');
  return auth?.actorId ?? auth?.userId ?? 'admin-ui';
}

function error(c: AdminContext, status: 400 | 404 | 409 | 503, code: string): Response {
  return c.json({ error: code, error_description: code }, status);
}

function requestKey(c: AdminContext): string | null {
  const value = c.req.header('Idempotency-Key');
  return value && SAFE_ID.test(value) ? value : null;
}

function pathId(c: AdminContext, name: string): string | null {
  const value = c.req.param(name);
  return value && SAFE_ID.test(value) ? value : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function controlActorId(c: AdminContext): Promise<string> {
  const value = auditActor(c);
  return SAFE_ID.test(value) ? value : `admin:${await sha256Hex(value)}`;
}

function repository(c: AdminContext): TenantPlacementMigrationJobRepository {
  return new TenantPlacementMigrationJobRepository(
    requireAdminDatabaseAdapter(c.env, 'tenant-placement-migration-admin-api')
  );
}

function formatJob(job: TenantPlacementMigrationJobView) {
  const currentIndex = TENANT_PLACEMENT_MIGRATION_STEPS.indexOf(job.currentStep);
  return {
    operation_id: job.operationId,
    tenant_id: job.tenantId,
    target_isolation_policy: job.targetIsolationPolicy,
    status: job.status,
    current_step: job.currentStep,
    attempt_count: job.attemptCount,
    next_attempt_at: job.nextAttemptAt,
    last_error_code: job.lastErrorCode,
    lookup_progress: {
      prepared_rows: job.lookupPreparedRowCount,
      activated_rows: job.lookupActivatedRowCount,
      verified_rows: job.lookupVerifiedRowCount,
    },
    steps: TENANT_PLACEMENT_MIGRATION_STEPS.map((step, index) => ({
      step,
      status:
        job.status === 'succeeded' || index < currentIndex
          ? 'completed'
          : index > currentIndex
            ? 'pending'
            : job.status === 'blocked'
              ? 'blocked'
              : job.status === 'canceled'
                ? 'canceled'
                : job.status === 'waiting_retry'
                  ? 'waiting_retry'
                  : 'running',
    })),
    created_at: job.createdAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    updated_at: job.updatedAt,
  };
}

async function controlView(
  c: AdminContext,
  job: TenantPlacementMigrationJobView
): Promise<ControlTenantPlacementMigrationView | null> {
  if (!c.env.CONTROL?.getTenantPlacementMigration) return null;
  const value = await c.env.CONTROL.getTenantPlacementMigration(job.controlOperationId);
  if (!value) return null;
  assertControlPlaneRecordIsSecretFree(value);
  if (value.operationId !== job.controlOperationId || value.tenantId !== job.tenantId) {
    throw new Error('control_response_invalid');
  }
  return value;
}

async function response(c: AdminContext, job: TenantPlacementMigrationJobView, status = 200) {
  let control: ControlTenantPlacementMigrationView | null = null;
  try {
    control = await controlView(c, job);
  } catch {
    // Management-owned progress remains observable during a transient Control RPC failure.
  }
  return c.json(
    {
      ...formatJob(job),
      control_status: control ? 'available' : 'unavailable',
      control,
    },
    status as 200 | 202
  );
}

export async function adminTenantPlacementMigrationStartHandler(
  c: AdminContext
): Promise<Response> {
  const tenantId = pathId(c, 'id');
  const idempotencyKey = requestKey(c);
  if (!tenantId || !idempotencyKey) {
    return error(c, 400, 'TENANT_PLACEMENT_MIGRATION_REQUEST_INVALID');
  }
  try {
    const environment = environmentId(c.env);
    const jobs = repository(c);
    const requestHash = await sha256Hex(`${environment}\0${tenantId}\0tenant_exclusive`);
    const existing = await jobs.getByIdempotencyKey(idempotencyKey, environment);
    if (existing) {
      if (existing.tenantId !== tenantId || existing.requestHash !== requestHash) {
        return error(c, 409, 'TENANT_PLACEMENT_MIGRATION_IDEMPOTENCY_CONFLICT');
      }
      return response(c, existing, existing.status === 'succeeded' ? 200 : 202);
    }

    const platform = ensureDatabaseAdapter(c.env.DB, 'tenant-placement-migration-platform-api');
    const tenant = await platform.queryOne<{ isolation_policy: string; lifecycle_state: string }>(
      'SELECT isolation_policy, lifecycle_state FROM tenants WHERE id = ?',
      [tenantId]
    );
    if (!tenant) return error(c, 404, 'TENANT_NOT_FOUND');
    if (tenant.lifecycle_state !== 'active' || tenant.isolation_policy !== 'shared_pool') {
      return error(c, 409, 'TENANT_PLACEMENT_MIGRATION_SOURCE_INVALID');
    }
    if (!c.env.CONTROL?.startTenantPlacementMigration) {
      return error(c, 503, 'TENANT_PLACEMENT_MIGRATION_CONTROL_UNAVAILABLE');
    }
    const requestedBy = auditActor(c);
    const controlRequestedBy = await controlActorId(c);
    const control = await c.env.CONTROL.startTenantPlacementMigration({
      tenantId,
      targetIsolationPolicy: 'tenant_exclusive',
      idempotencyKey,
      requestedById: controlRequestedBy,
    });
    assertControlPlaneRecordIsSecretFree(control);
    if (control.tenantId !== tenantId || control.targetIsolationPolicy !== 'tenant_exclusive') {
      throw new Error('control_response_invalid');
    }
    let job: TenantPlacementMigrationJobView;
    try {
      job = await jobs.create({
        operationId: control.operationId,
        environmentId: environment,
        tenantId,
        controlOperationId: control.operationId,
        requestHash,
        idempotencyKey,
        requestedBy: controlRequestedBy,
        now: Math.floor(Date.now() / 1000),
      });
    } catch {
      const adopted = await jobs.getByIdempotencyKey(idempotencyKey, environment);
      if (
        !adopted ||
        adopted.operationId !== control.operationId ||
        adopted.tenantId !== tenantId ||
        adopted.requestHash !== requestHash
      ) {
        throw new Error('tenant_placement_migration_job_adoption_conflict');
      }
      job = adopted;
    }
    c.executionCtx?.waitUntil(processNextTenantPlacementMigration(c.env));
    await createAuditLog(c.env, {
      tenantId,
      userId: requestedBy,
      action: 'tenant.placement_migration_requested',
      resource: 'tenant',
      resourceId: tenantId,
      ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
      userAgent: c.req.header('User-Agent') ?? 'unknown',
      metadata: JSON.stringify({ operation_id: job.operationId, target: 'tenant_exclusive' }),
      severity: 'warning',
    });
    return response(c, job, 202);
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : '';
    if (code.includes('source_invalid') || code.includes('conflict')) {
      return error(c, 409, 'TENANT_PLACEMENT_MIGRATION_CONFLICT');
    }
    return error(c, 503, 'TENANT_PLACEMENT_MIGRATION_START_FAILED');
  }
}

export async function adminTenantPlacementMigrationLatestHandler(
  c: AdminContext
): Promise<Response> {
  const tenantId = pathId(c, 'id');
  if (!tenantId) return error(c, 400, 'TENANT_PLACEMENT_MIGRATION_REQUEST_INVALID');
  try {
    const job = await repository(c).getLatestByTenant(tenantId, environmentId(c.env));
    return job ? response(c, job) : error(c, 404, 'TENANT_PLACEMENT_MIGRATION_NOT_FOUND');
  } catch {
    return error(c, 503, 'TENANT_PLACEMENT_MIGRATION_STATUS_FAILED');
  }
}

export async function adminTenantPlacementMigrationGetHandler(c: AdminContext): Promise<Response> {
  const tenantId = pathId(c, 'id');
  const operationId = pathId(c, 'operationId');
  if (!tenantId || !operationId) {
    return error(c, 400, 'TENANT_PLACEMENT_MIGRATION_REQUEST_INVALID');
  }
  try {
    const job = await repository(c).get(operationId, environmentId(c.env));
    if (!job || job.tenantId !== tenantId) {
      return error(c, 404, 'TENANT_PLACEMENT_MIGRATION_NOT_FOUND');
    }
    return response(c, job);
  } catch {
    return error(c, 503, 'TENANT_PLACEMENT_MIGRATION_STATUS_FAILED');
  }
}

export async function adminTenantPlacementMigrationCancelHandler(
  c: AdminContext
): Promise<Response> {
  return mutate(c, 'cancel');
}

export async function adminTenantPlacementMigrationApprovePurgeHandler(
  c: AdminContext
): Promise<Response> {
  return mutate(c, 'approve_purge');
}

async function mutate(c: AdminContext, action: 'cancel' | 'approve_purge'): Promise<Response> {
  const tenantId = pathId(c, 'id');
  const operationId = pathId(c, 'operationId');
  const idempotencyKey = requestKey(c);
  if (!tenantId || !operationId || !idempotencyKey) {
    return error(c, 400, 'TENANT_PLACEMENT_MIGRATION_REQUEST_INVALID');
  }
  try {
    const environment = environmentId(c.env);
    const jobs = repository(c);
    let job = await jobs.get(operationId, environment);
    if (!job || job.tenantId !== tenantId) {
      return error(c, 404, 'TENANT_PLACEMENT_MIGRATION_NOT_FOUND');
    }
    const control = await controlView(c, job);
    if (!control) return error(c, 503, 'TENANT_PLACEMENT_MIGRATION_CONTROL_UNAVAILABLE');
    const requestedBy = auditActor(c);
    const controlRequestedBy = await controlActorId(c);
    if (action === 'cancel') {
      if (control.state === 'canceled' && job.status === 'canceled') {
        return response(c, job);
      }
      if (!control.canCancel || control.routeCutoverStarted) {
        return error(c, 409, 'TENANT_PLACEMENT_MIGRATION_CANCEL_NOT_ALLOWED');
      }
      if (!c.env.CONTROL?.cancelTenantPlacementMigration) {
        return error(c, 503, 'TENANT_PLACEMENT_MIGRATION_CONTROL_UNAVAILABLE');
      }
      const canceled = await c.env.CONTROL.cancelTenantPlacementMigration({
        operationId,
        requestedById: controlRequestedBy,
        idempotencyKey,
      });
      if (canceled.state !== 'canceled') throw new Error('control_response_invalid');
      job = await jobs.cancel(operationId, environment, Math.floor(Date.now() / 1000));
    } else {
      if (control.state === 'purge_pending' || control.state === 'complete') {
        return response(c, job);
      }
      if (!control.canApprovePurge || !c.env.CONTROL?.approveTenantPlacementMigrationPurge) {
        return error(c, 409, 'TENANT_PLACEMENT_MIGRATION_PURGE_NOT_ALLOWED');
      }
      const approved = await c.env.CONTROL.approveTenantPlacementMigrationPurge({
        operationId,
        requestedById: controlRequestedBy,
        idempotencyKey,
      });
      if (approved.state !== 'purge_pending') throw new Error('control_response_invalid');
    }
    await createAuditLog(c.env, {
      tenantId,
      userId: requestedBy,
      action:
        action === 'cancel'
          ? 'tenant.placement_migration_canceled'
          : 'tenant.placement_migration_purge_approved',
      resource: 'tenant',
      resourceId: tenantId,
      ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
      userAgent: c.req.header('User-Agent') ?? 'unknown',
      metadata: JSON.stringify({ operation_id: operationId }),
      severity: 'warning',
    });
    return response(c, job);
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : '';
    if (code.includes('conflict') || code.includes('not_allowed')) {
      return error(c, 409, 'TENANT_PLACEMENT_MIGRATION_CONFLICT');
    }
    return error(c, 503, 'TENANT_PLACEMENT_MIGRATION_MUTATION_FAILED');
  }
}
