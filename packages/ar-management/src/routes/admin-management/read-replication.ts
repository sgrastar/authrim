import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  assertControlPlaneRecordIsSecretFree,
  hasAdminPermission,
  type AdminAuthContext,
  type ControlReadReplicationStartRequest,
  type ControlReadReplicationStatusView,
  type Env,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

type AdminContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const SAFE_IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const STATUS_KEYS = new Set([
  'environmentId',
  'desiredMode',
  'aggregateStatus',
  'operationId',
  'operationStatus',
  'eligiblePolicyCount',
  'convergedPolicyCount',
  'failedPolicyCount',
  'targetCount',
  'convergedTargetCount',
  'pendingTargetCount',
  'failedTargetCount',
  'updatedAt',
]);
const AGGREGATE_STATUSES = new Set(['off', 'on', 'updating', 'attention_required']);
const OPERATION_STATUSES = new Set([
  'queued',
  'applying',
  'verifying',
  'attention_required',
  'succeeded',
  'blocked',
]);

export const readReplicationRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

readReplicationRouter.use('*', adminAuthMiddleware());

function auth(c: AdminContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function hasPlatformAuthority(value: AdminAuthContext): boolean {
  return (
    hasAdminPermission(value.permissions ?? [], ADMIN_PERMISSIONS.ALL) ||
    value.roles.includes('super_admin') ||
    value.roles.includes('system_admin') ||
    value.tenantScope?.includes('*') === true
  );
}

function error(c: AdminContext, status: 400 | 403 | 409 | 503, code: string): Response {
  return c.json({ error: code, error_description: code }, status);
}

function controlStatusCapability(env: Env) {
  const control = env.CONTROL;
  if (!control || typeof control.getReadReplicationStatus !== 'function') return null;
  return () => control.getReadReplicationStatus!();
}

function controlStartCapability(env: Env) {
  const control = env.CONTROL;
  if (!control || typeof control.startReadReplicationRollout !== 'function') return null;
  return (input: ControlReadReplicationStartRequest) => control.startReadReplicationRollout!(input);
}

function parseStatus(
  value: unknown,
  expectedEnvironmentId: string
): ControlReadReplicationStatusView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('read_replication_control_status_invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const counters = [
    record.eligiblePolicyCount,
    record.convergedPolicyCount,
    record.failedPolicyCount,
    record.targetCount,
    record.convergedTargetCount,
    record.pendingTargetCount,
    record.failedTargetCount,
    record.updatedAt,
  ];
  if (
    keys.length !== STATUS_KEYS.size ||
    keys.some((key) => !STATUS_KEYS.has(key)) ||
    record.environmentId !== expectedEnvironmentId ||
    (record.desiredMode !== 'enabled' && record.desiredMode !== 'disabled') ||
    typeof record.aggregateStatus !== 'string' ||
    !AGGREGATE_STATUSES.has(record.aggregateStatus) ||
    (record.operationId !== null &&
      (typeof record.operationId !== 'string' || !SAFE_IDEMPOTENCY_KEY.test(record.operationId))) ||
    (record.operationStatus !== null &&
      (typeof record.operationStatus !== 'string' ||
        !OPERATION_STATUSES.has(record.operationStatus))) ||
    counters.some((counter) => !Number.isSafeInteger(counter) || (counter as number) < 0) ||
    (record.convergedPolicyCount as number) + (record.failedPolicyCount as number) >
      (record.eligiblePolicyCount as number) ||
    (record.convergedTargetCount as number) +
      (record.pendingTargetCount as number) +
      (record.failedTargetCount as number) !==
      (record.targetCount as number)
  ) {
    throw new Error('read_replication_control_status_invalid');
  }
  assertControlPlaneRecordIsSecretFree(record);
  return record as unknown as ControlReadReplicationStatusView;
}

async function getValidatedStatus(
  env: Env,
  getStatus: () => Promise<ControlReadReplicationStatusView>
): Promise<ControlReadReplicationStatusView> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_IDEMPOTENCY_KEY.test(environmentId)) {
    throw new Error('read_replication_environment_invalid');
  }
  return parseStatus(await getStatus(), environmentId);
}

function parseRequest(value: unknown): { enabled: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    Object.keys(record).some((key) => key !== 'enabled') ||
    typeof record.enabled !== 'boolean'
  ) {
    return null;
  }
  return { enabled: record.enabled };
}

function statusResponse(c: AdminContext, status: ControlReadReplicationStatusView): Response {
  return c.json({ readReplication: status });
}

readReplicationRouter.get('/', async (c) => {
  if (!hasPlatformAuthority(auth(c))) {
    return error(c, 403, 'READ_REPLICATION_PLATFORM_AUTHORITY_REQUIRED');
  }
  const getStatus = controlStatusCapability(c.env);
  if (!getStatus) return error(c, 503, 'READ_REPLICATION_CONTROL_UNAVAILABLE');
  try {
    return statusResponse(c, await getValidatedStatus(c.env, getStatus));
  } catch {
    return error(c, 503, 'READ_REPLICATION_STATUS_UNAVAILABLE');
  }
});

readReplicationRouter.put('/', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'READ_REPLICATION_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'READ_REPLICATION_HUMAN_ACTOR_REQUIRED');
  }
  const getStatus = controlStatusCapability(c.env);
  const start = controlStartCapability(c.env);
  if (!getStatus || !start) return error(c, 503, 'READ_REPLICATION_CONTROL_UNAVAILABLE');

  let request: ReturnType<typeof parseRequest>;
  try {
    request = parseRequest(await c.req.json());
  } catch {
    request = null;
  }
  if (!request) return error(c, 400, 'READ_REPLICATION_INVALID_REQUEST');
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey || !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return error(c, 400, 'READ_REPLICATION_INVALID_REQUEST');
  }

  try {
    const before = await getValidatedStatus(c.env, getStatus);
    const auditId = await writeAdminAuditLog(c, {
      action: 'read_replication.rollout.requested',
      resourceType: 'read_replication_policy',
      resourceId: before.environmentId,
      result: 'success',
      before: {
        desired_mode: before.desiredMode,
        aggregate_status: before.aggregateStatus,
        operation_id: before.operationId,
      },
      after: {
        desired_mode: request.enabled ? 'enabled' : 'disabled',
        idempotency_key: idempotencyKey,
      },
      metadata: { execution: 'control_service_binding' },
    });
    if (!auditId) return error(c, 503, 'READ_REPLICATION_AUDIT_UNAVAILABLE');

    const result = parseStatus(
      await start({
        desiredMode: request.enabled ? 'enabled' : 'disabled',
        idempotencyKey,
        requestedById: actor.userId,
      }),
      before.environmentId
    );
    return c.json({ readReplication: result, auditId }, 202);
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : '';
    if (code === 'read_replication_rollout_in_progress') {
      return error(c, 409, 'READ_REPLICATION_ROLLOUT_IN_PROGRESS');
    }
    if (code === 'read_replication_rollout_idempotency_conflict') {
      return error(c, 409, 'READ_REPLICATION_IDEMPOTENCY_CONFLICT');
    }
    if (code === 'read_replication_environment_not_active') {
      return error(c, 409, 'READ_REPLICATION_ENVIRONMENT_NOT_ACTIVE');
    }
    if (code === 'read_replication_no_eligible_policies') {
      return error(c, 409, 'READ_REPLICATION_NO_ELIGIBLE_POLICIES');
    }
    if (code === 'invalid_read_replication_rollout_request') {
      return error(c, 400, 'READ_REPLICATION_INVALID_REQUEST');
    }
    return error(c, 503, 'READ_REPLICATION_UPDATE_UNAVAILABLE');
  }
});
