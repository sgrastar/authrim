/**
 * Tenant switch for DID sign-in (`authentication-methods.did.login_enabled`), shared by the DID
 * login handlers (did-auth.ts) and the DID link handlers (did-link.ts).
 */

import type { Context } from 'hono';
import { createErrorResponse, AR_ERROR_CODES, type Env } from '@authrim/ar-lib-core';
import { isDidLoginEnabled } from './authentication-method-settings';

/**
 * DID login is off unless the tenant turned it on (`authentication-methods.did.login_enabled`).
 * Decided before anything else is done: a tenant that has it off never resolves a DID, stores or
 * consumes a challenge, looks an account up or opens a session, and the answer does not depend on
 * the DID or on whether it is linked. Settings that cannot be read refuse too (503): an unreadable
 * switch must not read as "on".
 *
 * Linking a DID (register challenge / verify) is gated by the same switch: a DID that cannot be
 * used to sign in is not collected either. Listing and unlinking are not gated, so a user can
 * always remove a DID.
 */
export async function rejectIfDidLoginDisabled(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<Response | null> {
  let enabled: boolean;
  try {
    enabled = await isDidLoginEnabled(c.env, tenantId, { strict: true });
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
    extensions: { authentication_method: 'did', usage: 'login' },
  });
}
