/**
 * The notice for a tenant that widened which second factors satisfy L2 when the administrator
 * making the change could not give L2 for it (they had no second factor that counts, so the
 * change was authorised with a fresh passkey alone). Every other administrator of the tenant hears about it by email, so a
 * change they did not expect can be undone. Best effort: it never fails the change that already
 * took effect, and the change is also in the audit log.
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  AdminNoticeRepository,
  isNotificationDeliveryAvailable,
  produceNotificationDelivery,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { tenantAdminContacts } from '../admin-management/second-factor-recovery-notice';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

/** How long the in-console notice stays for the tenant's administrators. */
const CONSOLE_NOTICE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The console side: a notice every administrator who may read admins sees, kept in the Admin
 * database whether or not email can be sent (a tenant with no mail setup still hears about it).
 */
export async function showSecondFactorKindsWidenedInConsole(
  env: Env,
  input: {
    tenantId: string;
    actor: { id: string; email?: string };
    kinds: readonly string[];
    now: number;
  }
): Promise<void> {
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'admin-second-factor-policy-notice');
  const who = input.actor.email || 'An administrator';
  await new AdminNoticeRepository(adapter).create(
    {
      scope_type: 'tenant',
      tenant_id: input.tenantId,
      severity: 'high',
      source: 'system',
      category: 'second_factor_policy',
      message_key: 'second_factor_policy_widened',
      params: { email: who, kinds: input.kinds.join(', ') },
      title: `${who} widened the allowed second-factor kinds`,
      link: '/admin/settings/team',
      required_permission: 'admin:admin_users:read',
      source_ref: input.actor.id,
      deduplication_key: `sfp:${input.tenantId}:${input.actor.id}:${input.now}`,
      expires_at: input.now + CONSOLE_NOTICE_TTL_MS,
    },
    input.now
  );
}

export async function noticeSecondFactorKindsWidened(
  env: Env,
  input: {
    tenantId: string;
    actor: { id: string; email?: string };
    kinds: readonly string[];
    now: number;
  }
): Promise<void> {
  if (
    !(await isNotificationDeliveryAvailable(env, { owner: 'tenant', tenantId: input.tenantId }))
  ) {
    return;
  }
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'admin-second-factor-policy-notice');
  const admins = await tenantAdminContacts(adapter, input.tenantId);
  if (!admins) return;

  const who = input.actor.email || 'An administrator';
  const lines = [
    `${who} changed which second factors satisfy sensitive operations in this tenant. Now allowed: ${input.kinds.join(', ')}.`,
    'The administrator who made it had no second factor that could approve it, so it was made with a fresh passkey only.',
    'If this was not expected, review the setting "Admin Second Factor Kinds" in the Admin console and check the account.',
  ];
  const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">${lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')}</body></html>`;

  for (const admin of admins) {
    const key = `admin-second-factor-kinds-widened:${input.tenantId}:${input.actor.id}:${input.now}:${admin.id}`;
    try {
      await produceNotificationDelivery(env, {
        owner: { owner: 'tenant', tenantId: input.tenantId },
        intentId: key,
        outboxId: `notification:${key}`,
        notificationKind: 'admin.second-factor-policy-widened',
        idempotencyKey: key,
        expiresAt: Math.floor(input.now / 1000) + 24 * 60 * 60,
        payload: {
          channel: 'email',
          to: admin.email,
          from: env.EMAIL_FROM || 'noreply@authrim.dev',
          subject: 'Authrim: the allowed second-factor kinds were widened',
          body: html,
          metadata: { textBody: lines.join('\n\n') },
        },
      });
    } catch {
      // Best effort: the change stands, and it is in the audit log.
    }
  }
}
