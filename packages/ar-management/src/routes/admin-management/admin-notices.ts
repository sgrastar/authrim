/**
 * Admin notices (the admin console's header)
 *
 * Every admin reads the notices addressed to them: to the platform when they are a platform admin,
 * to the selected tenant, to its clients when they may read clients, and to themselves. A system
 * notice may also need a permission of its own (an operational event's area).
 *
 * Information is put away by each admin for themselves. Everything else is resolved once and then
 * leaves everyone's list; resolving a notice raised by an operational event also closes the event.
 * Announcements are written with the settings write permission, for the platform only by a
 * platform admin.
 *
 * Endpoints:
 * - GET  /api/admin/notices             - The signed-in admin's open notices
 * - POST /api/admin/notices             - Write an announcement
 * - GET  /api/admin/notices/:id         - One notice
 * - GET  /api/admin/notices/:id/deliveries - Where it was emailed and posted (settings read)
 * - POST /api/admin/notices/:id/dismiss - Put information away (for the signed-in admin)
 * - POST /api/admin/notices/:id/resolve - Resolve a notice for everyone
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminNotice,
  AdminNoticeScope,
  AdminNoticeSeverity,
  AdminNoticeViewer,
  DatabaseAdapter,
  Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_NOTICE_SCOPES,
  ADMIN_NOTICE_SEVERITIES,
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  AdminNoticeDeliveryRepository,
  AdminNoticeRepository,
  adminAuthMiddleware,
  createAuthContextFromHono,
  createErrorResponse,
  getClient,
  getLogger,
  getTenantIdFromContext,
  hasAdminPermission,
  hasGlobalPlatformAuthority,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

export const adminNoticesRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Reading needs a session only; writing announcements is gated by the route access rules
// (settings write), the rest is checked here against the notice's audience.
adminNoticesRouter.use('*', adminAuthMiddleware({}));

const TITLE_MAX = 200;
const BODY_MAX = 2000;
const LINK_MAX = 500;
/** An announcement may stay up for a year at most. */
const EXPIRY_MAX_MS = 366 * 24 * 60 * 60 * 1000;

function noticesLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-NOTICES');
}

function adminAdapter(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

const holds = (auth: AdminAuthContext, permission: string) =>
  hasAdminPermission(auth.permissions || [], permission);

// Platform notices reach every platform admin, so the authority comes from a global assignment.
const isPlatformAdmin = (auth: AdminAuthContext) => hasGlobalPlatformAuthority(auth, 'admin:*');

function viewerOf(c: AdminContext, auth: AdminAuthContext): AdminNoticeViewer {
  return {
    adminUserId: auth.userId,
    tenantId: getTenantIdFromContext(c),
    platform: isPlatformAdmin(auth),
    canReadClients: holds(auth, ADMIN_PERMISSIONS.CLIENTS_READ),
    holds: (permission) => holds(auth, permission),
  };
}

/** Whether the viewer is in the notice's audience (open or not). */
function canSee(notice: AdminNotice, viewer: AdminNoticeViewer): boolean {
  if (notice.required_permission && !viewer.holds(notice.required_permission)) return false;
  switch (notice.scope_type) {
    case 'admin_user':
      return notice.admin_user_id === viewer.adminUserId;
    case 'platform':
      return viewer.platform;
    case 'tenant':
      return notice.tenant_id === viewer.tenantId;
    case 'client':
      return notice.tenant_id === viewer.tenantId && viewer.canReadClients;
  }
}

/** Who may resolve a notice for everyone: its addressee, or an admin who runs its audience. */
function canResolve(notice: AdminNotice, auth: AdminAuthContext): boolean {
  if (notice.scope_type === 'platform') return isPlatformAdmin(auth);
  if (notice.scope_type === 'admin_user' && notice.admin_user_id === auth.userId) return true;
  return holds(auth, ADMIN_PERMISSIONS.SETTINGS_WRITE);
}

export function presentNotice(notice: AdminNotice) {
  return {
    id: notice.id,
    scope_type: notice.scope_type,
    tenant_id: notice.tenant_id,
    client_id: notice.client_id,
    admin_user_id: notice.admin_user_id,
    severity: notice.severity,
    source: notice.source,
    category: notice.category,
    message_key: notice.message_key,
    params: notice.params,
    title: notice.title,
    body: notice.body,
    link: notice.link,
    created_by: notice.created_by,
    created_at: notice.created_at,
    expires_at: notice.expires_at,
    resolved_at: notice.resolved_at,
    resolved_by: notice.resolved_by,
    dismissible: notice.severity === 'info',
  };
}

const notFound = (c: AdminContext) =>
  c.json({ error: 'not_found', error_description: 'Notice not found' }, 404);

const invalid = (c: AdminContext, field: string, description: string) =>
  c.json({ error: 'invalid_request', error_description: description, field }, 400);

/** Load a notice the signed-in admin can see, or answer 404. */
async function visibleNotice(
  c: AdminContext,
  auth: AdminAuthContext,
  repo: AdminNoticeRepository
): Promise<AdminNotice | null> {
  const notice = await repo.findById(c.req.param('id') ?? '');
  return notice && canSee(notice, viewerOf(c, auth)) ? notice : null;
}

/**
 * GET /api/admin/notices
 */
adminNoticesRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const notices = await new AdminNoticeRepository(adminAdapter(c)).listOpenFor(
      viewerOf(c, auth),
      Date.now()
    );
    return c.json({ items: notices.map(presentNotice) });
  } catch (error) {
    noticesLog(c).error('Failed to list admin notices', {
      action: 'admin_notice_list',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/notices/:id
 */
adminNoticesRouter.get('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const notice = await visibleNotice(c, auth, new AdminNoticeRepository(adminAdapter(c)));
    return notice ? c.json({ notice: presentNotice(notice) }) : notFound(c);
  } catch (error) {
    noticesLog(c).error('Failed to read an admin notice', {
      action: 'admin_notice_get',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/notices/:id/deliveries
 */
adminNoticesRouter.get('/:id/deliveries', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  // Who was emailed is for the admins who run the audience, not for every reader.
  if (!holds(auth, ADMIN_PERMISSIONS.SETTINGS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  try {
    const adapter = adminAdapter(c);
    const notice = await visibleNotice(c, auth, new AdminNoticeRepository(adapter));
    if (!notice) return notFound(c);
    const repository = new AdminNoticeDeliveryRepository(adapter);
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const page = await repository.listForNotice(notice.id, {
      after: c.req.query('after') || null,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    const deliveries = page.items;
    // An admin of another tenant (a platform admin, say) is not named to this tenant's admins.
    const hidden = new Set<string>();
    if (!isPlatformAdmin(auth)) {
      const tenantId = getTenantIdFromContext(c);
      const emailed = [
        ...new Set(deliveries.filter((d) => d.channel === 'email').map((d) => d.target_id)),
      ];
      const members = new Set<string>();
      for (let offset = 0; offset < emailed.length; offset += 50) {
        const ids = emailed.slice(offset, offset + 50);
        const rows = await adapter.query<{ id: string }>(
          `SELECT id FROM admin_users WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
          [tenantId, ...ids]
        );
        for (const row of rows) members.add(row.id);
      }
      for (const id of emailed) if (!members.has(id)) hidden.add(id);
    }
    return c.json({
      summary: await repository.summaryForNotice(notice.id),
      next_cursor: page.next,
      items: deliveries.map((delivery) => ({
        id: delivery.id,
        channel: delivery.channel,
        target_id:
          delivery.channel === 'email' && hidden.has(delivery.target_id)
            ? null
            : delivery.target_id,
        status: delivery.status,
        attempts: delivery.attempts,
        next_attempt_at: delivery.status === 'failed' ? delivery.next_attempt_at : null,
        last_error: delivery.last_error,
        updated_at: delivery.updated_at,
      })),
    });
  } catch (error) {
    noticesLog(c).error('Failed to list admin notice deliveries', {
      action: 'admin_notice_deliveries',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/notices/:id/dismiss
 */
adminNoticesRouter.post('/:id/dismiss', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const repo = new AdminNoticeRepository(adminAdapter(c));
    const notice = await visibleNotice(c, auth, repo);
    if (!notice) return notFound(c);
    // What an admin put away is kept per admin; a machine token has nothing to keep it under.
    if (!isAdminStepUpHumanSession(auth)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (notice.severity !== 'info') {
      return c.json(
        {
          error: 'notice_not_dismissible',
          error_description: 'Only information can be dismissed; resolve the others',
        },
        409
      );
    }
    await repo.dismiss(notice.id, auth.userId);
    return c.json({ dismissed: true });
  } catch (error) {
    noticesLog(c).error('Failed to dismiss an admin notice', {
      action: 'admin_notice_dismiss',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/notices/:id/resolve
 */
adminNoticesRouter.post('/:id/resolve', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const adapter = adminAdapter(c);
    const repo = new AdminNoticeRepository(adapter);
    const notice = await visibleNotice(c, auth, repo);
    if (!notice) return notFound(c);
    if (!canResolve(notice, auth)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    // Information is put away by each admin; resolving it would take it from everyone.
    if (notice.severity === 'info') {
      return c.json(
        {
          error: 'notice_not_resolvable',
          error_description: 'Information is dismissed by each admin, not resolved',
        },
        409
      );
    }
    // A notice raised by an operational event closes the event too, as resolving it there would.
    const eventId =
      notice.source === 'system' && notice.deduplication_key?.startsWith('ine:')
        ? notice.source_ref
        : null;
    const result = eventId
      ? await repo.resolveWithEvent(notice.id, eventId, auth.userId)
      : await repo.resolve(notice.id, auth.userId);
    if (!result.resolved) {
      return result.reason === 'not_found'
        ? notFound(c)
        : c.json({ error: 'notice_resolved', error_description: 'Already resolved' }, 409);
    }
    await writeAdminAuditLog(c, {
      action: 'admin.notice.resolved',
      resourceType: 'admin_notice',
      resourceId: notice.id,
      result: 'success',
      metadata: {
        scope_type: notice.scope_type,
        tenant_id: notice.tenant_id,
        category: notice.category,
        severity: notice.severity,
      },
    });
    return c.json({ notice: presentNotice(result.notice) });
  } catch (error) {
    noticesLog(c).error('Failed to resolve an admin notice', {
      action: 'admin_notice_resolve',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

interface AnnouncementInput {
  scope_type: AdminNoticeScope;
  client_id: string | null;
  admin_user_id: string | null;
  severity: AdminNoticeSeverity;
  title: string;
  body: string | null;
  link: string | null;
  expires_at: number | null;
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseAnnouncement(
  body: Record<string, unknown>,
  now: number
): AnnouncementInput | { field: string; description: string } {
  const scope = body.scope_type;
  if (typeof scope !== 'string' || !ADMIN_NOTICE_SCOPES.includes(scope as AdminNoticeScope)) {
    return {
      field: 'scope_type',
      description: 'scope_type must be platform, tenant, client or admin_user',
    };
  }
  const severity = body.severity;
  if (
    typeof severity !== 'string' ||
    !ADMIN_NOTICE_SEVERITIES.includes(severity as AdminNoticeSeverity)
  ) {
    return { field: 'severity', description: 'severity must be critical, high, caution or info' };
  }
  const title = optionalText(body.title);
  if (!title || title.length > TITLE_MAX) {
    return { field: 'title', description: `title is required (at most ${TITLE_MAX} characters)` };
  }
  const text = optionalText(body.body);
  if (text === undefined || (text && text.length > BODY_MAX)) {
    return { field: 'body', description: `body must be text of at most ${BODY_MAX} characters` };
  }
  const link = optionalText(body.link);
  if (
    link === undefined ||
    (link && (link.length > LINK_MAX || !link.startsWith('/admin/') || link.startsWith('//')))
  ) {
    return { field: 'link', description: 'link must be a console path under /admin/' };
  }
  const clientId = optionalText(body.client_id);
  if (scope === 'client' && !clientId) {
    return { field: 'client_id', description: 'client_id is required for a client notice' };
  }
  const adminUserId = optionalText(body.admin_user_id);
  if (scope === 'admin_user' && !adminUserId) {
    return { field: 'admin_user_id', description: 'admin_user_id is required for an admin notice' };
  }
  const expiresAt = body.expires_at;
  if (
    expiresAt !== undefined &&
    expiresAt !== null &&
    (typeof expiresAt !== 'number' ||
      !Number.isInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + EXPIRY_MAX_MS)
  ) {
    return { field: 'expires_at', description: 'expires_at must be a future time within a year' };
  }
  return {
    scope_type: scope as AdminNoticeScope,
    client_id: scope === 'client' ? (clientId ?? null) : null,
    admin_user_id: scope === 'admin_user' ? (adminUserId ?? null) : null,
    severity: severity as AdminNoticeSeverity,
    title,
    body: text ?? null,
    link: link ?? null,
    expires_at: typeof expiresAt === 'number' ? expiresAt : null,
  };
}

/**
 * POST /api/admin/notices
 */
adminNoticesRouter.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return invalid(c, 'body', 'The body must be a JSON object');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid(c, 'body', 'The body must be a JSON object');
  }
  const now = Date.now();
  const input = parseAnnouncement(raw as Record<string, unknown>, now);
  if ('field' in input) return invalid(c, input.field, input.description);

  const platformAdmin = isPlatformAdmin(auth);
  if (input.scope_type === 'platform' && !platformAdmin) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = adminAdapter(c);
    const requestTenantId = getTenantIdFromContext(c);
    let tenantId: string | null = input.scope_type === 'platform' ? null : requestTenantId;
    if (input.scope_type === 'client') {
      // Only an app the tenant has: a notice about anything else would reach nobody it concerns.
      const { coreAdapter } = createAuthContextFromHono(
        c as unknown as Context<{ Bindings: Env }>,
        requestTenantId
      );
      if (!(await getClient(c.env, requestTenantId, input.client_id ?? '', coreAdapter))) {
        return invalid(c, 'client_id', 'No such client in this tenant');
      }
    }
    if (input.scope_type === 'admin_user') {
      // The addressee's home tenant; outside the selected tenant only for a platform admin.
      const addressee = await adapter.queryOne<{ tenant_id: string }>(
        `SELECT tenant_id FROM admin_users WHERE id = ? AND is_active = 1`,
        [input.admin_user_id]
      );
      if (!addressee || (addressee.tenant_id !== requestTenantId && !platformAdmin)) {
        return invalid(c, 'admin_user_id', 'No such admin in this tenant');
      }
      tenantId = addressee.tenant_id;
    }
    const notice = await new AdminNoticeRepository(adapter).create(
      {
        scope_type: input.scope_type,
        tenant_id: tenantId,
        client_id: input.client_id,
        admin_user_id: input.admin_user_id,
        severity: input.severity,
        source: 'announcement',
        category: 'announcement',
        title: input.title,
        body: input.body,
        link: input.link,
        created_by: auth.userId,
        expires_at: input.expires_at,
      },
      now
    );
    await writeAdminAuditLog(c, {
      action: 'admin.notice.published',
      resourceType: 'admin_notice',
      resourceId: notice.id,
      result: 'success',
      metadata: {
        scope_type: notice.scope_type,
        tenant_id: notice.tenant_id,
        client_id: notice.client_id,
        admin_user_id: notice.admin_user_id,
        severity: notice.severity,
      },
    });
    return c.json({ notice: presentNotice(notice) }, 201);
  } catch (error) {
    noticesLog(c).error('Failed to publish an admin notice', {
      action: 'admin_notice_publish',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});
