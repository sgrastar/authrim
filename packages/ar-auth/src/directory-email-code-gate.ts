/**
 * Tenant switch for signing in with an emailed code (`authentication-methods.email_otp.login_enabled`),
 * applied to the Directory Password flow's email-code routes: the migration fallback
 * (`email_code_fallback`) and the directory-unavailable recovery (`recovery`). Both end in a
 * session proven by an emailed code, so the one switch that governs /api/auth/email-codes/* and
 * the Direct Auth email code governs them too. The campaign's `email_code_fallback_mode` stays
 * the admin's separate say on whether a campaign offers it.
 */

import type { Context } from 'hono';
import { createErrorResponse, AR_ERROR_CODES, getLogger, type Env } from '@authrim/ar-lib-core';
import { isAuthenticationMethodUsageEnabled } from './authentication-method-settings';

/**
 * For the send and verify routes: decided before anything else is done (before the transaction is
 * looked up, the rate limit counted, a code made or sent, a challenge or transaction consumed or a
 * session created), so the answer does not depend on the transaction or the user. Off (or never
 * turned on: email code is off by default) is 403; settings that cannot be read are 503, because an
 * unreadable switch must not read as "on".
 */
export async function rejectIfDirectoryEmailCodeDisabled(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<Response | null> {
  let enabled: boolean;
  try {
    enabled = await isAuthenticationMethodUsageEnabled(c.env, tenantId, 'email_otp', 'login', {
      strict: true,
    });
  } catch {
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Authentication settings are unavailable.',
      },
      503
    );
  }
  if (enabled) return null;
  return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS, {
    extensions: { authentication_method: 'email_otp', usage: 'login' },
  });
}

/**
 * For the offers (the migration response's `email_code_fallback` and the recovery response): a
 * tenant that has the email code off, or whose settings cannot be read, gets no offer and no
 * transaction. An offer that is left out only takes a choice away (the passkey migration, or the
 * "directory unavailable" answer, carries on), so unlike the send and verify routes this fails
 * closed quietly instead of turning the whole login into an error.
 */
export async function isDirectoryEmailCodeOfferable(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<boolean> {
  try {
    return await isAuthenticationMethodUsageEnabled(c.env, tenantId, 'email_otp', 'login', {
      strict: true,
    });
  } catch (error) {
    getLogger(c)
      .module('DIRECTORY_MIGRATION_EMAIL_CODE')
      .warn('Not offering a directory email code: authentication settings are unreadable', {
        action: 'directory_email_code_offer',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    return false;
  }
}
