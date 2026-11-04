/**
 * Admin notice delivery: each admin's email choices, and the Slack channels notices are posted to.
 *
 * Endpoints:
 * - GET  /api/admin/me/notice-preferences            - The signed-in admin's email choices
 * - PUT  /api/admin/me/notice-preferences            - Change them
 * - GET  /api/admin/notice-channels                  - The tenant's (and, for a platform admin,
 *                                                       the platform's) Slack channels
 * - POST /api/admin/notice-channels                  - Register one
 * - PATCH  /api/admin/notice-channels/:id            - Rename, minimum severity, on/off
 * - PUT    /api/admin/notice-channels/:id/webhook-url - Replace the webhook URL
 * - DELETE /api/admin/notice-channels/:id            - Remove one
 * - POST   /api/admin/notice-channels/:id/test       - Post a test message now
 *
 * The webhook URL is the secret: it is encrypted at rest and never returned, only a hint. Channel
 * reads need settings read and writes settings write (route access rules); platform channels need
 * a platform admin.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminNoticeChannelSecret,
  AdminNoticeSeverity,
  DatabaseAdapter,
  Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_NOTICE_SEVERITIES,
  AR_ERROR_CODES,
  AdminNoticeDeliveryRepository,
  adminAuthMiddleware,
  createErrorResponse,
  decryptValue,
  encryptValue,
  getLogger,
  getTenantIdFromContext,
  hasGlobalPlatformAuthority,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { isSlackWebhookUrl } from '../../admin-notice-delivery';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type Router = Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

export const myNoticePreferencesRouter: Router = new Hono();
export const adminNoticeChannelsRouter: Router = new Hono();
myNoticePreferencesRouter.use('*', adminAuthMiddleware({}));
adminNoticeChannelsRouter.use('*', adminAuthMiddleware({}));

const NAME_MAX = 80;

function deliveryLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-NOTICE-DELIVERY');
}

function adminAdapter(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

const invalid = (c: AdminContext, field: string, description: string) =>
  c.json({ error: 'invalid_request', error_description: description, field }, 400);

const notFound = (c: AdminContext) =>
  c.json({ error: 'not_found', error_description: 'Channel not found' }, 404);

const isSeverity = (value: unknown): value is AdminNoticeSeverity =>
  typeof value === 'string' && ADMIN_NOTICE_SEVERITIES.includes(value as AdminNoticeSeverity);

async function jsonBody(c: AdminContext): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function failure(c: AdminContext, action: string, error: unknown) {
  deliveryLog(c).error('Admin notice delivery request failed', {
    action,
    errorType: error instanceof Error ? error.name : 'Unknown',
  });
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
}

// ---------------------------------------------------------------------------------------------
// The signed-in admin's email choices

myNoticePreferencesRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth || !isAdminStepUpHumanSession(auth)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  try {
    const preferences = await new AdminNoticeDeliveryRepository(adminAdapter(c)).getPreferences(
      auth.userId
    );
    return c.json({ preferences });
  } catch (error) {
    return failure(c, 'admin_notice_preferences_get', error);
  }
});

myNoticePreferencesRouter.put('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth || !isAdminStepUpHumanSession(auth)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const body = await jsonBody(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  if (typeof body.email_enabled !== 'boolean') {
    return invalid(c, 'email_enabled', 'email_enabled must be true or false');
  }
  if (!isSeverity(body.email_min_severity)) {
    return invalid(c, 'email_min_severity', 'email_min_severity must be a notice severity');
  }
  try {
    const preferences = await new AdminNoticeDeliveryRepository(adminAdapter(c)).setPreferences(
      auth.userId,
      { email_enabled: body.email_enabled, email_min_severity: body.email_min_severity }
    );
    return c.json({ preferences });
  } catch (error) {
    return failure(c, 'admin_notice_preferences_put', error);
  }
});

// ---------------------------------------------------------------------------------------------
// Slack channels

const isPlatformAdmin = (auth: AdminAuthContext) => hasGlobalPlatformAuthority(auth, 'admin:*');

/** Whether this admin may see and change the channel: its tenant, or a platform admin. */
function mayManage(c: AdminContext, auth: AdminAuthContext, channel: AdminNoticeChannelSecret) {
  return channel.scope_type === 'platform'
    ? isPlatformAdmin(auth)
    : channel.tenant_id === getTenantIdFromContext(c);
}

/** The URL to keep, encrypted, and the part that may be shown back. */
async function sealWebhookUrl(
  env: Env,
  value: unknown
): Promise<{ encrypted: string; hint: string } | 'invalid' | 'unavailable'> {
  if (typeof value !== 'string' || !isSlackWebhookUrl(value.trim())) return 'invalid';
  if (!env.PII_ENCRYPTION_KEY) return 'unavailable';
  const url = new URL(value.trim());
  const team = url.pathname.split('/')[2] ?? '';
  const sealed = await encryptValue(url.toString(), env.PII_ENCRYPTION_KEY, 'AES-256-GCM', 1);
  return { encrypted: sealed.encrypted, hint: `hooks.slack.com/services/${team}/…` };
}

const encryptionUnavailable = (c: AdminContext) =>
  c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The webhook URL cannot be stored: encryption is not configured',
    },
    503
  );

adminNoticeChannelsRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const items = await new AdminNoticeDeliveryRepository(adminAdapter(c)).listChannels({
      tenantId: getTenantIdFromContext(c),
      platform: isPlatformAdmin(auth),
    });
    return c.json({ items });
  } catch (error) {
    return failure(c, 'admin_notice_channels_list', error);
  }
});

adminNoticeChannelsRouter.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const body = await jsonBody(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  const scope = body.scope_type ?? 'tenant';
  if (scope !== 'platform' && scope !== 'tenant') {
    return invalid(c, 'scope_type', 'scope_type must be platform or tenant');
  }
  if (scope === 'platform' && !isPlatformAdmin(auth)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) {
    return invalid(c, 'name', `name is required (at most ${NAME_MAX} characters)`);
  }
  const minSeverity = body.min_severity ?? 'high';
  if (!isSeverity(minSeverity)) {
    return invalid(c, 'min_severity', 'min_severity must be a notice severity');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return invalid(c, 'enabled', 'enabled must be true or false');
  }
  try {
    const sealed = await sealWebhookUrl(c.env, body.webhook_url);
    if (sealed === 'invalid') {
      return invalid(c, 'webhook_url', 'webhook_url must be a Slack Incoming Webhook URL');
    }
    if (sealed === 'unavailable') return encryptionUnavailable(c);
    const channel = await new AdminNoticeDeliveryRepository(adminAdapter(c)).createChannel({
      scope_type: scope,
      tenant_id: scope === 'platform' ? null : getTenantIdFromContext(c),
      name,
      webhook_url_encrypted: sealed.encrypted,
      webhook_url_hint: sealed.hint,
      min_severity: minSeverity,
      enabled: body.enabled !== false,
      created_by: auth.userId,
    });
    await writeAdminAuditLog(c, {
      action: 'admin.notice_channel.created',
      resourceType: 'admin_notice_channel',
      resourceId: channel.id,
      result: 'success',
      metadata: { scope_type: channel.scope_type, tenant_id: channel.tenant_id },
    });
    return c.json({ channel }, 201);
  } catch (error) {
    return failure(c, 'admin_notice_channel_create', error);
  }
});

/** Load a channel the admin may manage, or answer 404 (another tenant's is not revealed). */
async function managedChannel(c: AdminContext, auth: AdminAuthContext) {
  const repository = new AdminNoticeDeliveryRepository(adminAdapter(c));
  const channel = await repository.findChannel(c.req.param('id') ?? '');
  return { repository, channel: channel && mayManage(c, auth, channel) ? channel : null };
}

adminNoticeChannelsRouter.patch('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const body = await jsonBody(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  const changes: { name?: string; min_severity?: AdminNoticeSeverity; enabled?: boolean } = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) {
      return invalid(c, 'name', `name must be 1 to ${NAME_MAX} characters`);
    }
    changes.name = name;
  }
  if (body.min_severity !== undefined) {
    if (!isSeverity(body.min_severity)) {
      return invalid(c, 'min_severity', 'min_severity must be a notice severity');
    }
    changes.min_severity = body.min_severity;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return invalid(c, 'enabled', 'enabled must be true or false');
    }
    changes.enabled = body.enabled;
  }
  try {
    const { repository, channel } = await managedChannel(c, auth);
    if (!channel) return notFound(c);
    const updated = await repository.updateChannel(channel.id, changes);
    if (!updated) return notFound(c);
    await writeAdminAuditLog(c, {
      action: 'admin.notice_channel.updated',
      resourceType: 'admin_notice_channel',
      resourceId: channel.id,
      result: 'success',
      metadata: { fields: Object.keys(changes) },
    });
    return c.json({ channel: updated });
  } catch (error) {
    return failure(c, 'admin_notice_channel_update', error);
  }
});

adminNoticeChannelsRouter.put('/:id/webhook-url', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const body = await jsonBody(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  try {
    const { repository, channel } = await managedChannel(c, auth);
    if (!channel) return notFound(c);
    const sealed = await sealWebhookUrl(c.env, body.webhook_url);
    if (sealed === 'invalid') {
      return invalid(c, 'webhook_url', 'webhook_url must be a Slack Incoming Webhook URL');
    }
    if (sealed === 'unavailable') return encryptionUnavailable(c);
    // Whoever points the channel somewhere answers for what is posted there: notices behind a
    // permission go to it only while this admin sees them.
    const updated = await repository.updateChannel(channel.id, {
      webhook_url_encrypted: sealed.encrypted,
      webhook_url_hint: sealed.hint,
      created_by: auth.userId,
    });
    await writeAdminAuditLog(c, {
      action: 'admin.notice_channel.webhook_replaced',
      resourceType: 'admin_notice_channel',
      resourceId: channel.id,
      result: 'success',
    });
    return c.json({ channel: updated });
  } catch (error) {
    return failure(c, 'admin_notice_channel_webhook', error);
  }
});

adminNoticeChannelsRouter.delete('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const { repository, channel } = await managedChannel(c, auth);
    if (!channel || !(await repository.deleteChannel(channel.id))) return notFound(c);
    await writeAdminAuditLog(c, {
      action: 'admin.notice_channel.deleted',
      resourceType: 'admin_notice_channel',
      resourceId: channel.id,
      result: 'success',
      metadata: { scope_type: channel.scope_type, tenant_id: channel.tenant_id },
    });
    return c.json({ deleted: true });
  } catch (error) {
    return failure(c, 'admin_notice_channel_delete', error);
  }
});

adminNoticeChannelsRouter.post('/:id/test', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const { channel } = await managedChannel(c, auth);
    if (!channel) return notFound(c);
    if (!c.env.PII_ENCRYPTION_KEY) return encryptionUnavailable(c);
    const decrypted = await decryptValue(channel.webhook_url_encrypted, c.env.PII_ENCRYPTION_KEY);
    if (!decrypted.wasEncrypted || !isSlackWebhookUrl(decrypted.decrypted)) {
      return c.json({ delivered: false, error: 'webhook_url_invalid' });
    }
    let status = 0;
    try {
      const response = await fetch(decrypted.decrypted, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Authrim: this channel will receive admin console notices.',
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
    } catch {
      return c.json({ delivered: false, error: 'network_error' });
    }
    return c.json(
      status >= 200 && status < 300
        ? { delivered: true }
        : { delivered: false, error: `slack_http_${status}` }
    );
  } catch (error) {
    return failure(c, 'admin_notice_channel_test', error);
  }
});
