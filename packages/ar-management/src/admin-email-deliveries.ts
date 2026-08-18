import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  decryptValue,
  ensureDatabaseAdapter,
  getTenantIdFromContext,
  hasAdminPermission,
  resolveNotificationIntentTarget,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { getAdminAuth } from './admin-tenant-access';
import { writeAdminAuditLog } from './admin-shared';

const SAFE_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._:-]{0,255}$/u;
const PRIVILEGED_ROLES = new Set([
  'super_admin',
  'system_admin',
  'distributor_admin',
  'tenant_admin',
  'admin',
]);
const FILTER_STATUSES = new Set([
  'requested',
  'retrying',
  'provider_accepted',
  'delivered',
  'deferred',
  'bounced',
  'failed',
  'rejected',
  'complained',
  'unknown',
  'expired',
  'canceled',
]);

type RecipientVisibility = 'full' | 'masked' | 'none';

interface DeliveryRow {
  intent_id: string;
  account_id: string | null;
  notification_kind: string;
  recipient_masked: string | null;
  recipient_encrypted: string | null;
  plugin_installation_id: string;
  active_plugin_installation_id: string | null;
  provider_message_id: string | null;
  state: string;
  delivery_status: string;
  attempt_count: number | string;
  last_error_code: string | null;
  outbox_status: string | null;
  effective_status: string;
  requested_at: number | string;
  provider_accepted_at: number | string | null;
  delivery_status_updated_at: number | string | null;
}

export function resolveEmailDeliveryRecipientVisibility(
  auth: Pick<AdminAuthContext, 'roles' | 'permissions'> | undefined
): RecipientVisibility {
  const permissions = auth?.permissions ?? [];
  if (
    auth?.roles.some((role) => PRIVILEGED_ROLES.has(role)) ||
    hasAdminPermission(permissions, ADMIN_PERMISSIONS.EMAIL_DELIVERIES_RECIPIENT_FULL_READ)
  ) {
    return 'full';
  }
  if (hasAdminPermission(permissions, ADMIN_PERMISSIONS.EMAIL_DELIVERIES_RECIPIENT_MASKED_READ)) {
    return 'masked';
  }
  return 'none';
}

function integer(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function status(row: DeliveryRow): string {
  return row.effective_status;
}

export async function listAdminEmailDeliveries(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    accountId?: string;
    status?: string;
    limit?: number;
    visibility: RecipientVisibility;
    piiEncryptionKey?: string;
  }
) {
  if (
    !SAFE_ID.test(input.tenantId) ||
    (input.accountId !== undefined && !SAFE_ID.test(input.accountId)) ||
    (input.status !== undefined && !FILTER_STATUSES.has(input.status))
  ) {
    throw new Error('email_delivery_history_input_invalid');
  }
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('email_delivery_history_limit_invalid');
  }
  const params: unknown[] = [input.tenantId];
  const conditions = ['i.tenant_id = ?', "i.channel = 'email'"];
  if (input.accountId) {
    conditions.push('i.account_id = ?');
    params.push(input.accountId);
  }
  const statusCondition = input.status ? 'WHERE history.effective_status = ?' : '';
  const rows = await adapter.query<DeliveryRow>(
    `WITH history AS (
       SELECT i.intent_id, i.account_id, i.notification_kind, i.recipient_masked,
              i.recipient_encrypted, i.plugin_installation_id,
              json_extract(i.provider_installation_ids_json,
                '$[' || i.active_provider_index || ']') AS active_plugin_installation_id,
              i.provider_message_id, i.state, i.delivery_status, i.attempt_count,
              i.last_error_code, o.status AS outbox_status, i.created_at AS requested_at,
              i.provider_accepted_at, i.delivery_status_updated_at,
              CASE
                WHEN i.state = 'dead_letter' THEN 'failed'
                WHEN i.state = 'expired' THEN 'expired'
                WHEN i.state = 'canceled' THEN 'canceled'
                WHEN i.state = 'pending' AND o.status = 'waiting_retry' THEN 'retrying'
                WHEN i.state = 'pending' THEN 'requested'
                WHEN i.delivery_status = 'requested' THEN 'provider_accepted'
                ELSE i.delivery_status
              END AS effective_status
         FROM notification_delivery_intents i
         LEFT JOIN plugin_hook_outbox o
           ON o.tenant_id = i.tenant_id
          AND json_extract(o.payload_json, '$.intentId') = i.intent_id
        WHERE ${conditions.join(' AND ')}
     )
     SELECT * FROM history
      ${statusCondition}
      ORDER BY requested_at DESC, intent_id DESC
      LIMIT ?`,
    [...params, ...(input.status ? [input.status] : []), limit],
    { consistencyClass: 'primary_required' }
  );
  const items = await Promise.all(
    rows.map(async (row) => {
      const effectiveStatus = status(row);
      let recipient: string | null = null;
      if (input.visibility === 'masked') recipient = row.recipient_masked;
      if (input.visibility === 'full') {
        recipient = row.recipient_masked;
        if (row.recipient_encrypted && input.piiEncryptionKey) {
          try {
            recipient = (await decryptValue(row.recipient_encrypted, input.piiEncryptionKey))
              .decrypted;
          } catch {
            // Preserve the masked fallback if a retired key cannot be resolved.
          }
        }
      }
      return {
        intent_id: row.intent_id,
        account_id: row.account_id,
        notification_kind: row.notification_kind,
        recipient,
        recipient_visibility: input.visibility,
        api_status: 'recorded',
        provider_installation_id: row.active_plugin_installation_id ?? row.plugin_installation_id,
        provider_message_id: row.provider_message_id,
        status: effectiveStatus,
        final_delivery_tracked:
          row.state === 'delivered' &&
          !['requested', 'provider_accepted', 'unknown'].includes(row.delivery_status),
        attempts: integer(row.attempt_count) ?? 0,
        last_error_code: row.last_error_code,
        requested_at: integer(row.requested_at),
        provider_accepted_at: integer(row.provider_accepted_at),
        status_updated_at: integer(row.delivery_status_updated_at),
      };
    })
  );
  return items;
}

async function handler(c: Context<{ Bindings: Env }>, accountId?: string) {
  const tenantId = getTenantIdFromContext(c);
  const auth = getAdminAuth(c);
  const visibility = resolveEmailDeliveryRecipientVisibility(auth);
  const target = await resolveNotificationIntentTarget(c.env, { owner: 'tenant', tenantId });
  const adapter = ensureDatabaseAdapter(target.db, 'admin-email-delivery-history');
  const rawLimit = Number.parseInt(c.req.query('limit') ?? (accountId ? '20' : '50'), 10);
  try {
    const items = await listAdminEmailDeliveries(adapter, {
      tenantId,
      accountId,
      status: c.req.query('status') || undefined,
      limit: rawLimit,
      visibility,
      piiEncryptionKey: c.env.PII_ENCRYPTION_KEY,
    });
    if (visibility === 'full') {
      await writeAdminAuditLog(c as never, {
        action: 'email_delivery.recipient_full_read',
        resourceType: 'email_delivery_history',
        resourceId: accountId ?? null,
        result: 'success',
        severity: 'info',
        metadata: { count: items.length, account_scoped: !!accountId },
      }).catch(() => undefined);
    }
    return c.json({ items, recipient_visibility: visibility });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('email_delivery_history_')) {
      return c.json(
        { error: 'invalid_request', error_description: 'Invalid delivery history query.' },
        400
      );
    }
    return c.json(
      { error: 'server_error', error_description: 'Email delivery history is unavailable.' },
      500
    );
  }
}

export const adminEmailDeliveriesListHandler = (c: Context<{ Bindings: Env }>) => handler(c);

export const adminUserEmailDeliveriesHandler = (c: Context<{ Bindings: Env }>) => {
  const accountId = c.req.param('id');
  if (!accountId || !SAFE_ID.test(accountId)) {
    return c.json({ error: 'invalid_request', error_description: 'Invalid account ID.' }, 400);
  }
  return handler(c, accountId);
};
