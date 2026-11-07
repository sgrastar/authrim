/**
 * A sign-up's attributes checked against the screen they were entered on.
 *
 * The sign-up routes (Direct Auth passkey sign-up and email code send, the authenticator-app
 * sign-up, the older passkey and email code routes) are told the Flow interaction a sign-up
 * belongs to by the Login UI: in the `X-Authrim-Interaction-Id` header, or (an email code send)
 * the interaction its body already carries, the header then not read. The server then resolves the screen itself
 * (`resolveSignUpScreen`) and checks the attributes against it (`readSignUpScreenFields`): only
 * the parts it shows and stores to the profile, the choices it offers, its required parts. The
 * Identity Schema checks the values afterwards, as for any sign-up.
 *
 * A sign-up that names no interaction (an app with its own form, through the SDK) is checked
 * against the Identity Schema alone, unless the tenant accepts sign-ups only through a Flow
 * (`authentication-methods.signup.flow_required`, off by default): then it is refused, as is one
 * naming an interaction that is not live or not at a step a person signs up on. Without that
 * setting a client could leave the interaction out to skip the screen's check; with it, the
 * check binds every sign-up.
 */
import type { Context } from 'hono';
import {
  AR_ERROR_CODES,
  SIGN_IN_ATTEMPT_INTERACTION_HEADER,
  createErrorResponse,
  getLogger,
  resolveEffectiveSettings,
  type Env,
} from '@authrim/ar-lib-core';
import { resolveSignUpScreen } from './login-runtime-flow';
import { isFixedRegistrationFieldKey } from './registration-field-utils';
import { readSignUpScreenFields, type RuntimeScreenAnswerProblem } from './runtime-screen-answers';

type AuthContext = Context<{ Bindings: Env }>;

/** An interaction id as the sign-up routes accept it (the runtime's own ids fit). */
const INTERACTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

export type SignUpScreenRefusal =
  /** The tenant accepts sign-ups only through a Flow, and this one names no interaction. */
  | 'flow_required'
  /** The interaction named is not live, or the id does not read as one. */
  | 'interaction_not_found'
  /** The interaction is not at (and did not pass) a step a person signs up on. */
  | 'not_a_sign_up_step'
  | RuntimeScreenAnswerProblem;

export type SignUpScreenCheck =
  | { ok: true }
  | { ok: false; reason: SignUpScreenRefusal; field: string | null };

async function signUpFlowRequired(c: AuthContext, tenantId: string): Promise<boolean> {
  const settings = await resolveEffectiveSettings(c.env, 'authentication-methods', { tenantId });
  return settings['authentication-methods.signup.flow_required'] === true;
}

/**
 * Checks a sign-up's `custom_fields` against the screen of the Flow interaction it names (the
 * header, or the route's own body), for the tenant the account is made in.
 */
export async function checkSignUpScreen(
  c: AuthContext,
  tenantId: string,
  input: {
    customFields: unknown;
    /**
     * The interaction a route takes from its own body (an email code send): then the header is
     * not read, the body alone naming it, as for the rest of that route.
     */
    interactionId?: string | null;
  }
): Promise<SignUpScreenCheck> {
  const named =
    input.interactionId !== undefined
      ? input.interactionId
      : (c.req.header(SIGN_IN_ATTEMPT_INTERACTION_HEADER) ?? null);
  if (named === null || named === '') {
    return (await signUpFlowRequired(c, tenantId))
      ? { ok: false, reason: 'flow_required', field: null }
      : { ok: true };
  }
  if (!INTERACTION_ID.test(named)) {
    return { ok: false, reason: 'interaction_not_found', field: null };
  }
  const resolved = await resolveSignUpScreen(c, tenantId, named);
  if (resolved.kind === 'invalid') return { ok: false, reason: resolved.reason, field: null };
  if (resolved.kind === 'built_in') return { ok: true };
  const read = readSignUpScreenFields(
    resolved.screen,
    input.customFields,
    isFixedRegistrationFieldKey
  );
  return read.ok ? { ok: true } : { ok: false, reason: read.problem, field: read.field };
}

/** The answer a refused sign-up gets: the refusal, and the part it is about (never its value). */
export async function signUpScreenRefusalResponse(
  c: AuthContext,
  refusal: Extract<SignUpScreenCheck, { ok: false }>
): Promise<Response> {
  getLogger(c).module('SIGN-UP').info('Sign-up refused by its Flow screen', {
    action: 'signup_screen_refused',
    reason: refusal.reason,
  });
  if (refusal.reason === 'flow_required') {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED, {
      extensions: { reason: 'signup_flow_required' },
    });
  }
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
    variables: { field: refusal.field ?? 'custom_fields', reason: refusal.reason },
    extensions: {
      reason: `signup_screen_${refusal.reason}`,
      ...(refusal.field ? { field: refusal.field } : {}),
    },
  });
}
