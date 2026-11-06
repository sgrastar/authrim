/**
 * The notices of an admin account's email change: to the old address (so an owner who did not
 * make the change hears about it while they still read that mailbox) and to the new one. Sent
 * after the change took effect, on a best-effort basis: the change is protected by L2, the notice
 * is how a change made with a stolen session is noticed.
 */

import type { Env } from '@authrim/ar-lib-core';
import { isNotificationDeliveryAvailable, produceNotificationDelivery } from '@authrim/ar-lib-core';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * @returns How many notices were accepted for delivery (0 to 2)
 */
export async function sendAdminEmailChangeNotices(
  env: Env,
  input: {
    tenantId: string;
    adminUserId: string;
    previousEmail: string;
    newEmail: string;
    changedBy: string;
    now?: number;
  }
): Promise<number> {
  if (
    !(await isNotificationDeliveryAvailable(env, { owner: 'tenant', tenantId: input.tenantId }))
  ) {
    return 0;
  }
  const now = input.now ?? Date.now();
  const changedBySelf = input.changedBy === input.adminUserId;
  const who = changedBySelf ? 'from this account' : 'by another administrator';
  const letters = [
    {
      to: input.previousEmail,
      role: 'previous',
      subject: 'The email address of your admin account was changed',
      lines: [
        `The email address of your admin account was changed ${who} to ${input.newEmail}.`,
        'Notices about this account now go to the new address. If you did not make or expect this change, contact the other administrators of your tenant at once.',
      ],
    },
    {
      to: input.newEmail,
      role: 'new',
      subject: 'This address now receives notices for an admin account',
      lines: [
        `This address replaced ${input.previousEmail} on an admin account (changed ${who}).`,
        'If you did not expect this, contact the administrators of your tenant.',
      ],
    },
  ];
  let accepted = 0;
  for (const letter of letters) {
    const key = `admin-email-change:${input.adminUserId}:${now}:${letter.role}`;
    try {
      const delivery = await produceNotificationDelivery(env, {
        owner: { owner: 'tenant', tenantId: input.tenantId },
        intentId: key,
        outboxId: `notification:${key}`,
        notificationKind: 'admin.email-change',
        idempotencyKey: key,
        expiresAt: Math.floor(now / 1000) + 24 * 60 * 60,
        payload: {
          channel: 'email',
          to: letter.to,
          from: env.EMAIL_FROM || 'noreply@authrim.dev',
          subject: letter.subject,
          body: `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">${letter.lines
            .map((line) => `<p>${escapeHtml(line)}</p>`)
            .join('')}</body></html>`,
          metadata: { textBody: letter.lines.join('\n\n') },
        },
      });
      if (delivery.delivery !== 'permanent_failure') accepted += 1;
    } catch {
      // The other address is still tried.
    }
  }
  return accepted;
}
