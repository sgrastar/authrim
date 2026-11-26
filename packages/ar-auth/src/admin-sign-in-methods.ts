/**
 * Which ways an administrator can sign in to the console, as the platform set them
 * (`security.admin_sign_in_methods`): a passkey always, a wallet presentation of the admin
 * credential only when the platform turned it on.
 *
 * - GET /api/admin/auth/methods -> { methods: { passkey, vc } }, read by the console's sign-in
 *   page before anyone is signed in, so it shows only the ways that work. The sign-in endpoints
 *   check the same list themselves: hiding a button is not a refusal.
 */

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  ADMIN_SIGN_IN_METHODS_KEY,
  getTenantIdFromContext,
  resolveAdminSignInMethods,
  resolveEffectiveSettings,
  type AdminSignInMethod,
} from '@authrim/ar-lib-core';

/**
 * The methods the platform allows for this deployment. Not from the per-isolate cache: this
 * decides whether a sign-in may go ahead, so turning the wallet off applies to the next request,
 * not a minute later. Reading the settings is never a reason to open a way in: on a failure the
 * default (passkey only) applies.
 */
export async function readAdminSignInMethods(
  env: Env,
  tenantId: string
): Promise<ReadonlySet<AdminSignInMethod>> {
  try {
    const settings = await resolveEffectiveSettings(env, 'security', { tenantId, fresh: true });
    return resolveAdminSignInMethods(settings[ADMIN_SIGN_IN_METHODS_KEY]);
  } catch {
    return resolveAdminSignInMethods(undefined);
  }
}

export const adminSignInMethodsApp = new Hono<{ Bindings: Env }>();

adminSignInMethodsApp.get('/api/admin/auth/methods', async (c) => {
  const methods = await readAdminSignInMethods(c.env, getTenantIdFromContext(c));
  c.header('Cache-Control', 'no-store');
  return c.json({
    methods: { passkey: methods.has('passkey'), vc: methods.has('vc') },
  });
});
