/**
 * Email notices for admin second-factor recovery.
 *
 * The waiting period only protects an admin if someone hears about the request: the requester
 * (whose account it may not be) and every other administrator of the tenant, who can cancel it. A
 * request is accepted only when email delivery is available and every notice was accepted for
 * delivery; completion and cancellation notices are sent on a best-effort basis.
 */

import type { AdminSecondFactorRecovery, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AdminNoticeRepository,
  isNotificationDeliveryAvailable,
  produceNotificationDelivery,
} from '@authrim/ar-lib-core';

export type RecoveryNoticeEvent = 'requested' | 'completed' | 'cancelled';

/** Above this many administrators in the tenant the notice is not sent and reports failure. */
export const RECOVERY_NOTICE_MAX_RECIPIENTS = 200;

/**
 * Every active administrator of the tenant, whatever their role: anyone who may be able to cancel
 * the request has to hear about it. Null when there are more than the notice can reach.
 */
async function tenantAdminContacts(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<Array<{ id: string; email: string }> | null> {
  const rows = await adapter.query<{ id: string; email: string }>(
    `SELECT id, email FROM admin_users
      WHERE tenant_id = ? AND is_active = 1 AND status = 'active'
      ORDER BY id LIMIT ?`,
    [tenantId, RECOVERY_NOTICE_MAX_RECIPIENTS + 1]
  );
  if (rows.length > RECOVERY_NOTICE_MAX_RECIPIENTS) return null;
  return rows.filter((row) => typeof row.email === 'string' && row.email.length > 0);
}

export function recoveryNoticeAvailable(env: Env, tenantId: string): Promise<boolean> {
  return isNotificationDeliveryAvailable(env, { owner: 'tenant', tenantId });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return replacements[character] ?? character;
  });
}

function content(
  event: RecoveryNoticeEvent,
  recovery: AdminSecondFactorRecovery,
  requesterEmail: string
): { subject: string; lines: string[] } {
  const notBefore = new Date(recovery.not_before).toISOString();
  switch (event) {
    case 'requested':
      return {
        subject: 'Authrim: an administrator asked to replace their step-up security keys',
        lines: [
          `${requesterEmail} asked to replace all of their step-up security keys with a new one.`,
          `It can be completed after ${notBefore}. Until then the administrator or another administrator of the tenant can cancel it in the Admin console.`,
          'If this was not expected, cancel the request and check the account.',
        ],
      };
    case 'completed':
      return {
        subject: 'Authrim: an administrator replaced their step-up security keys',
        lines: [
          `${requesterEmail} completed the replacement of their step-up security keys.`,
          'Their previous security keys were revoked and their other sessions were ended.',
        ],
      };
    case 'cancelled':
      return {
        subject: 'Authrim: a security key replacement request was cancelled',
        lines: [
          `The request by ${requesterEmail} to replace their step-up security keys was cancelled.`,
        ],
      };
  }
}

/**
 * After a completion or cancellation is committed: send its notice, never failing the request
 * that already took effect.
 */
export async function sendRecoveryNoticeAfterCommit(
  env: Env,
  adapter: DatabaseAdapter,
  input: Parameters<typeof sendRecoveryNotice>[2]
): Promise<boolean> {
  await showRecoveryInConsole(adapter, input.event, input.recovery, input.requester.email);
  try {
    return await sendRecoveryNotice(env, adapter, input);
  } catch {
    return false;
  }
}

/**
 * The console side of the notices: an open request is a notice to the tenant's administrators
 * until it is completed or cancelled. Best effort; email is what the request depends on.
 */
export async function showRecoveryInConsole(
  adapter: DatabaseAdapter,
  event: RecoveryNoticeEvent,
  recovery: AdminSecondFactorRecovery,
  requesterEmail: string
): Promise<void> {
  try {
    const notices = new AdminNoticeRepository(adapter);
    if (event !== 'requested') {
      await notices.resolveBySourceRefs([recovery.id]);
      return;
    }
    await notices.create({
      scope_type: 'tenant',
      tenant_id: recovery.tenant_id,
      severity: 'high',
      source: 'system',
      category: 'second_factor_recovery',
      message_key: 'second_factor_recovery_requested',
      params: { email: requesterEmail, not_before: recovery.not_before },
      title: `${requesterEmail} asked to replace their step-up security keys`,
      link: '/admin/me',
      required_permission: 'admin:admin_users:read',
      source_ref: recovery.id,
      deduplication_key: `sfr:${recovery.id}`,
      expires_at: recovery.expires_at,
    });
  } catch {
    // The request and its emails stand on their own.
  }
}

/**
 * Send the notice for one event to the requester and the tenant's administrators.
 *
 * @returns Whether every notice was accepted for delivery
 */
export async function sendRecoveryNotice(
  env: Env,
  adapter: DatabaseAdapter,
  input: {
    event: RecoveryNoticeEvent;
    recovery: AdminSecondFactorRecovery;
    requester: { id: string; email: string };
    now: number;
  }
): Promise<boolean> {
  const { event, recovery, requester, now } = input;
  const admins = await tenantAdminContacts(adapter, recovery.tenant_id);
  if (!admins) return false;
  const recipients = new Map<string, string>([[requester.id, requester.email]]);
  for (const admin of admins) recipients.set(admin.id, admin.email);

  const { subject, lines } = content(event, recovery, requester.email);
  const text = lines.join('\n\n');
  const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">${lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')}</body></html>`;

  let allAccepted = true;
  for (const [recipientId, email] of recipients) {
    const key = `admin-second-factor-recovery:${recovery.id}:${event}:${recipientId}`;
    try {
      const delivery = await produceNotificationDelivery(env, {
        owner: { owner: 'tenant', tenantId: recovery.tenant_id },
        intentId: key,
        outboxId: `notification:${key}`,
        notificationKind: 'admin.second-factor-recovery',
        idempotencyKey: key,
        expiresAt: Math.floor(now / 1000) + 24 * 60 * 60,
        payload: {
          channel: 'email',
          to: email,
          from: env.EMAIL_FROM || 'noreply@authrim.dev',
          subject,
          body: html,
          metadata: { textBody: text },
        },
      });
      if (delivery.delivery === 'permanent_failure') allAccepted = false;
    } catch {
      allAccepted = false;
    }
  }
  return allAccepted;
}
