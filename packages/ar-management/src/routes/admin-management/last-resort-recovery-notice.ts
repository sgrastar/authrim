/**
 * Notices for the last-resort second-factor recovery.
 *
 * The recovery runs on Cloudflare authority alone, with no other administrator able to stop it,
 * so everyone who could notice a misuse has to hear about it: the admin whose factors were
 * revoked and every active administrator of the whole system (by email), and the console
 * (notices to the platform and to the admin's tenant). The recovery has already taken effect when
 * these are sent: each is best effort, and the result says which went out.
 */

import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AdminNoticeRepository,
  isNotificationDeliveryAvailable,
  produceNotificationDelivery,
} from '@authrim/ar-lib-core';

/** Above this many administrators the email is not sent and reports failure. */
export const LAST_RESORT_NOTICE_MAX_RECIPIENTS = 200;

/** How long the console notices stay up unless an administrator clears them. */
const CONSOLE_NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LastResortNoticeInput {
  /** The audit record's id, or a fresh one: what ties the emails and notices together. */
  eventId: string;
  target: { id: string; email: string; tenantId: string };
  reenrollUntil: number;
  revokedFactors: number;
  now: number;
}

export interface LastResortNoticeResult {
  /** Whether every email was accepted for delivery (false when delivery is not configured). */
  emailed: boolean;
  recipients: number;
  /** Whether the console notices were written. */
  consoleNotice: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

/** Every active administrator of the system, or null when there are more than the email reaches. */
async function allAdminContacts(
  adapter: DatabaseAdapter
): Promise<Array<{ id: string; email: string }> | null> {
  const rows = await adapter.query<{ id: string; email: string }>(
    `SELECT id, email FROM admin_users
      WHERE is_active = 1 AND status = 'active'
      ORDER BY id LIMIT ?`,
    [LAST_RESORT_NOTICE_MAX_RECIPIENTS + 1]
  );
  if (rows.length > LAST_RESORT_NOTICE_MAX_RECIPIENTS) return null;
  return rows.filter((row) => typeof row.email === 'string' && row.email.length > 0);
}

function content(input: LastResortNoticeInput): { subject: string; lines: string[] } {
  const until = new Date(input.reenrollUntil).toISOString();
  return {
    subject:
      'Authrim: an administrator’s step-up security keys were reset by the environment owner',
    lines: [
      `The step-up security keys of ${input.target.email} were all revoked with the last-resort recovery, run from the setup tool with Cloudflare access to this environment.`,
      `Their sessions were ended. Until ${until} they can register a new security key or Keyring credential with a passkey sign-in alone.`,
      'If this was not expected, someone with Cloudflare access to the environment ran it: check who did, and review the account and the audit log.',
    ],
  };
}

async function sendEmails(
  env: Env,
  adapter: DatabaseAdapter,
  input: LastResortNoticeInput
): Promise<{ emailed: boolean; recipients: number }> {
  const owner = { owner: 'platform' } as const;
  if (!(await isNotificationDeliveryAvailable(env, owner)))
    return { emailed: false, recipients: 0 };
  const admins = await allAdminContacts(adapter);
  if (!admins) return { emailed: false, recipients: 0 };
  const recipients = new Map<string, string>([[input.target.id, input.target.email]]);
  for (const admin of admins) recipients.set(admin.id, admin.email);

  const { subject, lines } = content(input);
  const text = lines.join('\n\n');
  const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">${lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')}</body></html>`;

  let allAccepted = true;
  for (const [recipientId, email] of recipients) {
    const key = `admin-second-factor-last-resort:${input.eventId}:${recipientId}`;
    try {
      const delivery = await produceNotificationDelivery(env, {
        owner,
        intentId: key,
        outboxId: `notification:${key}`,
        notificationKind: 'admin.second-factor-last-resort',
        idempotencyKey: key,
        expiresAt: Math.floor(input.now / 1000) + 24 * 60 * 60,
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
  return { emailed: allAccepted, recipients: recipients.size };
}

async function showInConsole(
  adapter: DatabaseAdapter,
  input: LastResortNoticeInput
): Promise<boolean> {
  const notices = new AdminNoticeRepository(adapter);
  const common = {
    severity: 'critical' as const,
    source: 'system' as const,
    category: 'second_factor_recovery',
    message_key: 'second_factor_last_resort_recovery',
    params: { email: input.target.email, reenroll_until: input.reenrollUntil },
    title: `The step-up security keys of ${input.target.email} were reset by the environment owner`,
    link: '/admin/me',
    required_permission: 'admin:admin_users:read',
    source_ref: input.eventId,
    expires_at: input.now + CONSOLE_NOTICE_TTL_MS,
  };
  try {
    await notices.create({
      ...common,
      scope_type: 'platform',
      deduplication_key: `sflr:platform:${input.eventId}`,
    });
    await notices.create({
      ...common,
      scope_type: 'tenant',
      tenant_id: input.target.tenantId,
      deduplication_key: `sflr:tenant:${input.eventId}`,
    });
    return true;
  } catch {
    return false;
  }
}

/** Send the emails and write the console notices. Never throws. */
export async function sendLastResortNotices(
  env: Env,
  adapter: DatabaseAdapter,
  input: LastResortNoticeInput
): Promise<LastResortNoticeResult> {
  const consoleNotice = await showInConsole(adapter, input);
  let email = { emailed: false, recipients: 0 };
  try {
    email = await sendEmails(env, adapter, input);
  } catch {
    // Reported as not emailed.
  }
  return { ...email, consoleNotice };
}
