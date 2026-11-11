/**
 * A sign-up held to the policy of the registration Flow it belongs to (ar-lib-core
 * `registration-policy.ts`): who may sign up, what an address already registered gets, how long
 * its email code lasts.
 *
 * The policy is read from the interaction a sign-up names (the `X-Authrim-Interaction-Id`
 * header, or the interaction an email code send carries in its body). A sign-up that names none
 * (an app with its own form) is held to the tenant's own registration Flow, so leaving the Flow
 * out does not skip its policy. One whose interaction runs no registration Flow, or a tenant with
 * no such Flow, keeps the tenant's behaviour as it was (`LEGACY_REGISTRATION_POLICY`).
 */
import type { Context } from 'hono';
import {
  AR_ERROR_CODES,
  LEGACY_REGISTRATION_POLICY,
  SIGN_IN_ATTEMPT_INTERACTION_HEADER,
  createAuthContextFromHono,
  createErrorResponse,
  emailDomainAllowed,
  getLogger,
  loadInteractionRegistrationPolicy,
  loadTenantRegistrationPolicy,
  produceNotificationDelivery,
  resolveRegistrationCompletionRedirectUrl,
  type Env,
  type RegistrationPolicy,
} from '@authrim/ar-lib-core';
import { getAccountExistsHtml, getAccountExistsText } from './utils/email/templates';
import { profileAllowsHandle, readAuthenticationProfile } from './authentication-profile';

type AuthContext = Context<{ Bindings: Env }>;

const INTERACTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

/** Why a sign-up is not taken, before anything is made for it. */
export type RegistrationRefusal =
  | 'invitation_required'
  | 'email_domain_not_allowed'
  | 'account_exists';

/** The policy a sign-up is held to, and whether one of a registration Flow applies at all. */
export interface SignUpPolicy {
  policy: RegistrationPolicy;
  /** A registration Flow's own policy (not the tenant's behaviour as it was). */
  fromFlow: boolean;
  /**
   * Where it came from: the registration interaction the request names, the tenant's own
   * registration Flow (a request that names none), or neither.
   */
  source: 'interaction' | 'tenant' | 'none';
  /** The authentication method profile the Flow signs people up with (`default`: the tenant's). */
  profileRef: string;
}

/** A sign-up held to no registration Flow: the tenant's behaviour as it was. */
export const NO_POLICY: SignUpPolicy = {
  policy: LEGACY_REGISTRATION_POLICY,
  fromFlow: false,
  source: 'none',
  profileRef: 'default',
};

/**
 * Whether the Flow's authentication method profile lets this method sign people up (the tenant's
 * own switch is checked by the route as before; the profile only narrows it).
 */
export async function profileAllowsSignUp(
  c: AuthContext,
  tenantId: string,
  signUp: SignUpPolicy,
  handle: 'passkey' | 'mail_otp' | 'totp'
): Promise<boolean> {
  if (signUp.source === 'none' || signUp.profileRef === 'default') return true;
  const profile = await readAuthenticationProfile(c.env, tenantId, signUp.profileRef);
  return profileAllowsHandle(profile, handle, 'signup');
}

/**
 * The policy of the registration Flow the sign-up names (the header, or `interactionId` when a
 * route takes the interaction from its own body: then the header is not read).
 */
export async function signUpPolicyFor(
  c: AuthContext,
  tenantId: string,
  interactionId?: string | null
): Promise<SignUpPolicy> {
  const named =
    interactionId !== undefined
      ? interactionId
      : (c.req.header(SIGN_IN_ATTEMPT_INTERACTION_HEADER) ?? null);
  // A read that fails is not a sign-up without a policy: it is thrown, and the route answers it
  // as an error (the sign-up is not taken), never as one the limits do not apply to.
  const db = createAuthContextFromHono(c, tenantId).coreAdapter;
  const read =
    named && INTERACTION_ID.test(named)
      ? await loadInteractionRegistrationPolicy(db, tenantId, named)
      : null;
  if (read && read.live) {
    return {
      policy: read.policy,
      fromFlow: read.policy !== LEGACY_REGISTRATION_POLICY,
      source: 'interaction',
      profileRef: read.profileRef,
    };
  }
  // No registration interaction (none named, or one of a sign-in Flow, or one no longer live):
  // the tenant's own registration Flow, so naming another interaction does not skip it.
  const tenantFlow = await loadTenantRegistrationPolicy(db, tenantId);
  if (tenantFlow) {
    return {
      policy: tenantFlow.policy,
      fromFlow: tenantFlow.policy !== LEGACY_REGISTRATION_POLICY,
      source: 'tenant',
      profileRef: tenantFlow.profileRef,
    };
  }
  return NO_POLICY;
}

/**
 * Who may sign up: an invitation where one is required, an address of an allowed domain where
 * the Flow lists them. Null when the sign-up may go on.
 */
export function eligibilityRefusal(
  policy: RegistrationPolicy,
  input: { email: string | null; hasInvitation: boolean }
): RegistrationRefusal | null {
  if (policy.eligibility === 'invite' && !input.hasInvitation) return 'invitation_required';
  if (policy.eligibility === 'domain') {
    if (!input.email || !emailDomainAllowed(input.email, policy.allowed_domains)) {
      return 'email_domain_not_allowed';
    }
  }
  return null;
}

/** What a refused sign-up is told: the reason, or (by the Flow's policy) one for every refusal. */
export async function registrationRefusalResponse(
  c: AuthContext,
  policy: RegistrationPolicy,
  refusal: RegistrationRefusal
): Promise<Response> {
  getLogger(c).module('SIGN-UP').info('Sign-up refused by its registration policy', {
    action: 'signup_policy_refused',
    reason: refusal,
  });
  if (policy.denied_response === 'generic') {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS, {
      extensions: { reason: 'signup_not_allowed' },
    });
  }
  if (refusal === 'account_exists') {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
      extensions: { reason: 'account_exists' },
    });
  }
  return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS, {
    extensions: { reason: refusal },
  });
}

/**
 * The email code lifetime of a sign-up: the Flow's own when it sets one, never longer than the
 * lifetime the send would otherwise have (the tenant's, capped by the challenge it continues).
 */
export function signUpCodeTtlSeconds(policy: RegistrationPolicy, otherwise: number): number {
  return policy.code_ttl_seconds === null
    ? otherwise
    : Math.min(policy.code_ttl_seconds, otherwise);
}

/**
 * A sign-up for an address that already has an account, under a Flow that answers as for a new
 * one (`duplicate: mail`): its owner is told by email that someone tried, and how to sign in;
 * nothing is made, and no code is sent. A delivery that fails is only logged: the answer stays
 * the same either way.
 */
export async function notifyExistingAccountSignUp(
  c: AuthContext,
  input: { tenantId: string; userId: string; email: string }
): Promise<void> {
  // One notice per address an hour, however often someone tries: the delivery's idempotency key
  // is the address's (hashed) and the hour's, so a repeat is the same delivery, not another mail.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${input.tenantId}:${input.email.toLowerCase()}`)
  );
  const addressKey = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const attemptId = `${addressKey}:${Math.floor(Date.now() / 3_600_000)}`;
  const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';
  try {
    const delivery = await produceNotificationDelivery(c.env, {
      owner: { owner: 'tenant', tenantId: input.tenantId },
      intentId: `signup-account-exists:${attemptId}`,
      outboxId: `notification:signup-account-exists:${attemptId}`,
      notificationKind: 'auth.signup-account-exists',
      accountId: input.userId,
      idempotencyKey: `signup-account-exists:${attemptId}`,
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      payload: {
        channel: 'email',
        to: input.email,
        from: fromEmail,
        subject: 'You already have an account',
        body: getAccountExistsHtml({ email: input.email, appName: 'Authrim' }),
        metadata: { textBody: getAccountExistsText({ email: input.email, appName: 'Authrim' }) },
      },
    });
    if (delivery.delivery === 'permanent_failure') {
      throw new Error('notification_delivery_permanent_failure');
    }
  } catch (error) {
    getLogger(c)
      .module('SIGN-UP')
      .error('Failed to tell an account owner of a sign-up for their address', {
        action: 'signup_account_exists_notice',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
  }
}

/**
 * Where a person goes once a session is made within a registration Flow that sets its own
 * destination (`completion`); null otherwise (the tenant's post-sign-in destination holds). Only
 * a live interaction of the tenant counts, and the destination is checked as the tenant's is.
 */
export async function registrationCompletionRedirect(
  c: AuthContext,
  tenantId: string,
  interactionId: string | null | undefined
): Promise<string | null> {
  if (!interactionId) return null;
  const signUp = await signUpPolicyFor(c, tenantId, interactionId);
  const completion = signUp.source === 'interaction' ? signUp.policy.completion : null;
  if (!completion) return null;
  return (await resolveRegistrationCompletionRedirectUrl(c.env, tenantId, completion)).redirectUrl;
}
