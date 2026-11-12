/**
 * A sign-in Flow that guides an address without an account (`unregistered_signin: guide`) instead
 * of signing it up: the email code send answers 404 `account_not_found`, creating nothing and
 * sending nothing. It applies to a sign-in only, bound to a live interaction of a `login` Flow.
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  getLogger,
  loadInteractionFlowProfileRefs,
  loadTenantRegistrationPolicy,
  resolveEffectiveSettings,
  type Env,
} from '@authrim/ar-lib-core';

type AuthContext = Context<{ Bindings: Env }>;

const INTERACTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

/** Whether the interaction is a live one of a sign-in Flow that guides unregistered addresses. */
export async function interactionGuidesUnregistered(
  c: AuthContext,
  tenantId: string,
  interactionId: string | undefined
): Promise<boolean> {
  if (!interactionId || !INTERACTION_ID.test(interactionId)) return false;
  const refs = await loadInteractionFlowProfileRefs(
    createAuthContextFromHono(c, tenantId).coreAdapter,
    tenantId,
    interactionId
  );
  return Boolean(
    refs && refs.live && refs.flowKind === 'login' && refs.signIn.unregistered === 'guide'
  );
}

/**
 * Whether the person can be pointed at a sign-up: the tenant has a published, enabled
 * tenant-level registration Flow, and shows the link between sign-in and sign-up
 * (`login-ui.auth_switch_link_enabled`). Any failure to tell is false.
 */
export async function signUpAvailableForGuide(c: AuthContext, tenantId: string): Promise<boolean> {
  try {
    const policy = await loadTenantRegistrationPolicy(
      createAuthContextFromHono(c, tenantId).coreAdapter,
      tenantId
    );
    if (!policy) return false;
    const settings = await resolveEffectiveSettings(c.env, 'login-ui', { tenantId });
    return settings['login-ui.auth_switch_link_enabled'] === true;
  } catch (error) {
    getLogger(c)
      .module('DIRECT-AUTH')
      .warn('Could not tell whether sign-up is available for an unregistered address', {
        action: 'unregistered_signin_guide',
        errorType: error instanceof Error ? error.name : 'unknown',
      });
    return false;
  }
}

/** The answer for an address without an account under a `guide` sign-in Flow. */
export function accountNotFoundResponse(c: AuthContext, signUpAvailable: boolean): Response {
  return c.json(
    {
      error: 'account_not_found',
      error_description: 'No account uses this address',
      sign_up_available: signUpAvailable,
    },
    404
  );
}
