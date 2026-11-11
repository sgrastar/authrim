import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  assertControlPlaneRecordIsSecretFree,
  getTenantIdFromContext,
  hasGlobalPlatformAuthority,
  type AdminAuthContext,
  type ControlServiceSiteBindingRequest,
  type ControlServiceSiteBindingState,
  type ControlServiceSiteBindingStatusView,
  type Env,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

type AdminContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const SAFE_IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
// Cloudflare Worker script names; the Control Worker validates the same shape.
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/u;
const STATES = new Set<ControlServiceSiteBindingState>([
  'none',
  'pending',
  'settings_patched',
  'rollback_required',
  'succeeded',
  'rolled_back',
  'blocked',
]);
const STATUS_KEYS = [
  'environmentId',
  'bindingName',
  'desiredState',
  'desiredWorkerName',
  'attachedWorkerName',
  'state',
  'operationId',
  'lastErrorCode',
  'updatedAt',
];

export const serviceSiteRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

serviceSiteRouter.use('*', adminAuthMiddleware());

function auth(c: AdminContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

// The router Worker is shared by every tenant of the environment, so attaching a service site
// changes the platform. The authority has to come from a global assignment; a machine token needs
// the control plane permission of the operation for every tenant.
function hasPlatformAuthority(
  value: AdminAuthContext,
  permission:
    | typeof ADMIN_PERMISSIONS.CONTROL_PLANE_READ
    | typeof ADMIN_PERMISSIONS.CONTROL_PLANE_PROVISION
): boolean {
  return hasGlobalPlatformAuthority(value, permission);
}

function error(c: AdminContext, status: 400 | 403 | 409 | 503, code: string): Response {
  return c.json({ error: code, error_description: code }, status);
}

function nullableString(value: unknown, pattern: RegExp): boolean {
  return value === null || (typeof value === 'string' && pattern.test(value));
}

function parseStatus(
  value: unknown,
  expectedEnvironmentId: string
): ControlServiceSiteBindingStatusView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('service_site_control_status_invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== STATUS_KEYS.length ||
    keys.some((key) => !STATUS_KEYS.includes(key)) ||
    record.environmentId !== expectedEnvironmentId ||
    !nullableString(record.bindingName, BINDING_NAME) ||
    (record.desiredState !== 'attached' && record.desiredState !== 'detached') ||
    !nullableString(record.desiredWorkerName, WORKER_NAME) ||
    !nullableString(record.attachedWorkerName, WORKER_NAME) ||
    typeof record.state !== 'string' ||
    !STATES.has(record.state as ControlServiceSiteBindingState) ||
    !nullableString(record.operationId, SAFE_ID) ||
    !(record.lastErrorCode === null || typeof record.lastErrorCode === 'string') ||
    !(record.updatedAt === null || Number.isSafeInteger(record.updatedAt))
  ) {
    throw new Error('service_site_control_status_invalid');
  }
  assertControlPlaneRecordIsSecretFree(record);
  return record as unknown as ControlServiceSiteBindingStatusView;
}

function environmentId(env: Env): string {
  const value = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!value || !SAFE_ID.test(value)) throw new Error('service_site_environment_invalid');
  return value;
}

async function fallbackEnabled(c: AdminContext): Promise<boolean> {
  const tenantId = getTenantIdFromContext(c);
  if (!tenantId || !c.env.SETTINGS) return false;
  try {
    const raw = await c.env.SETTINGS.get(`settings:tenant:${tenantId}:service-site`);
    const record = raw ? (JSON.parse(raw) as unknown) : null;
    return (
      !!record &&
      typeof record === 'object' &&
      (record as Record<string, unknown>)['service-site.fallback_enabled'] === true
    );
  } catch {
    return false;
  }
}

async function view(c: AdminContext, status: ControlServiceSiteBindingStatusView) {
  return {
    // The Worker the router binding points at, as last verified. It is still set while a detach
    // is running and cleared when the detach has been verified.
    attached: status.attachedWorkerName !== null,
    worker_name: status.attachedWorkerName,
    state: status.state,
    desired_state: status.desiredState,
    desired_worker_name: status.desiredWorkerName,
    binding_name: status.bindingName,
    last_error: status.lastErrorCode,
    operation_id: status.operationId,
    updated_at: status.updatedAt,
    fallback_enabled: await fallbackEnabled(c),
  };
}

function controlCapabilities(env: Env) {
  const control = env.CONTROL;
  if (
    !control ||
    typeof control.getServiceSiteBindingStatus !== 'function' ||
    typeof control.requestServiceSiteBinding !== 'function'
  ) {
    return null;
  }
  return {
    status: () => control.getServiceSiteBindingStatus!(),
    request: (input: ControlServiceSiteBindingRequest) => control.requestServiceSiteBinding!(input),
  };
}

async function parsePutBody(c: AdminContext): Promise<string | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'worker_name') return null;
  return typeof record.worker_name === 'string' && WORKER_NAME.test(record.worker_name)
    ? record.worker_name
    : null;
}

function mapRequestError(c: AdminContext, caught: unknown): Response {
  const code = caught instanceof Error ? caught.message : '';
  switch (code) {
    case 'invalid_service_site_binding_request':
      return error(c, 400, 'SERVICE_SITE_INVALID_REQUEST');
    case 'service_site_worker_reserved':
      return error(c, 400, 'SERVICE_SITE_WORKER_RESERVED');
    case 'service_site_change_in_progress':
      return error(c, 409, 'SERVICE_SITE_CHANGE_IN_PROGRESS');
    case 'service_site_idempotency_conflict':
      return error(c, 409, 'SERVICE_SITE_IDEMPOTENCY_CONFLICT');
    case 'service_site_environment_not_active':
      return error(c, 409, 'SERVICE_SITE_ENVIRONMENT_NOT_ACTIVE');
    case 'service_site_router_not_in_inventory':
      return error(c, 409, 'SERVICE_SITE_ROUTER_UNAVAILABLE');
    default:
      return error(c, 503, 'SERVICE_SITE_UPDATE_UNAVAILABLE');
  }
}

async function requestChange(
  c: AdminContext,
  change: { desiredState: 'attached' | 'detached'; workerName: string | null }
): Promise<Response> {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor, ADMIN_PERMISSIONS.CONTROL_PLANE_PROVISION)) {
    return error(c, 403, 'SERVICE_SITE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'SERVICE_SITE_HUMAN_ACTOR_REQUIRED');
  }
  const control = controlCapabilities(c.env);
  if (!control) return error(c, 503, 'SERVICE_SITE_CONTROL_UNAVAILABLE');
  const header = c.req.header('Idempotency-Key');
  if (header !== undefined && !SAFE_IDEMPOTENCY_KEY.test(header)) {
    return error(c, 400, 'SERVICE_SITE_INVALID_REQUEST');
  }
  // Without a key the request is still idempotent for the same target (Control ignores a request
  // that matches the settled state); the key only protects against replays of an older request.
  const idempotencyKey = header ?? `service-site:${crypto.randomUUID()}`;

  try {
    const expectedEnvironment = environmentId(c.env);
    const before = parseStatus(await control.status(), expectedEnvironment);
    const auditId = await writeAdminAuditLog(c, {
      action:
        change.desiredState === 'attached'
          ? 'service_site.attach.requested'
          : 'service_site.detach.requested',
      resourceType: 'service_site_binding',
      resourceId: expectedEnvironment,
      result: 'success',
      before: {
        state: before.state,
        attached_worker_name: before.attachedWorkerName,
        operation_id: before.operationId,
      },
      after: {
        desired_state: change.desiredState,
        desired_worker_name: change.workerName,
        idempotency_key: idempotencyKey,
      },
      metadata: { execution: 'control_service_binding' },
    });
    if (!auditId) return error(c, 503, 'SERVICE_SITE_AUDIT_UNAVAILABLE');

    const status = parseStatus(
      await control.request({
        desiredState: change.desiredState,
        workerName: change.workerName,
        idempotencyKey,
        requestedById: actor.userId,
      }),
      expectedEnvironment
    );
    return c.json(
      { service_site: await view(c, status), audit_id: auditId },
      status.state === 'succeeded' ? 200 : 202
    );
  } catch (caught) {
    return mapRequestError(c, caught);
  }
}

serviceSiteRouter.get('/', async (c) => {
  if (!hasPlatformAuthority(auth(c), ADMIN_PERMISSIONS.CONTROL_PLANE_READ)) {
    return error(c, 403, 'SERVICE_SITE_PLATFORM_AUTHORITY_REQUIRED');
  }
  const control = controlCapabilities(c.env);
  if (!control) return error(c, 503, 'SERVICE_SITE_CONTROL_UNAVAILABLE');
  try {
    const status = parseStatus(await control.status(), environmentId(c.env));
    return c.json({ service_site: await view(c, status) });
  } catch {
    return error(c, 503, 'SERVICE_SITE_STATUS_UNAVAILABLE');
  }
});

serviceSiteRouter.put('/', async (c) => {
  const workerName = await parsePutBody(c);
  if (workerName === null) {
    // Authority is checked first so a caller without it learns nothing from the validation.
    if (!hasPlatformAuthority(auth(c), ADMIN_PERMISSIONS.CONTROL_PLANE_PROVISION)) {
      return error(c, 403, 'SERVICE_SITE_PLATFORM_AUTHORITY_REQUIRED');
    }
    return error(c, 400, 'SERVICE_SITE_INVALID_REQUEST');
  }
  return requestChange(c, { desiredState: 'attached', workerName });
});

serviceSiteRouter.delete('/', (c) =>
  requestChange(c, { desiredState: 'detached', workerName: null })
);
