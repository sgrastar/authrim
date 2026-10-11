import type { SAMLAuthnRequest } from '@authrim/ar-lib-core';
import { STATUS_CODES } from '../common/constants';
import type { SAMLPolicyFailureKind } from './audit';

export interface SAMLAuthenticatedSessionInfo {
  userId: string;
  sessionId: string;
  /**
   * When the session last recorded a proof of authentication (milliseconds): the latest of its
   * proof time (`proven_at`) and the proof time of a later re-authentication (`reauth_proven_at`).
   * A session without one cannot be shown to be a new sign-in.
   */
  provenAt?: number;
}

export interface SAMLAuthnInteractionOptions {
  /**
   * The person was already sent to sign in again for this request's ForceAuthn, at this time
   * (milliseconds): a session proven at or after it is that sign-in.
   */
  reauthentication?: { issuedAt: number };
  /**
   * The person was already sent to sign in for this request (a ForceAuthn sign-in or a step-up to
   * a higher AAL) and comes back: without a session they are not sent again.
   */
  returnedFromSignIn?: boolean;
}

export type SAMLAuthnInteractionDecision =
  | {
      action: 'use_session';
      session: SAMLAuthenticatedSessionInfo;
    }
  | {
      action: 'interactive_login';
      forceReauthentication: boolean;
    }
  | {
      action: 'protocol_error';
      statusCode: string;
      secondLevelStatusCode: string;
      statusMessage: string;
      failureKind: SAMLPolicyFailureKind;
      policyDetails: Record<string, unknown>;
    };

export function resolveSAMLAuthnInteraction(
  authnRequest: SAMLAuthnRequest,
  authenticatedSession: SAMLAuthenticatedSessionInfo | null,
  options: SAMLAuthnInteractionOptions = {}
): SAMLAuthnInteractionDecision {
  if (authnRequest.isPassive && (!authenticatedSession || authnRequest.forceAuthn)) {
    return {
      action: 'protocol_error',
      statusCode: STATUS_CODES.RESPONDER,
      secondLevelStatusCode: STATUS_CODES.NO_PASSIVE,
      statusMessage: 'Passive authentication could not be completed',
      failureKind: 'authn_request_no_passive',
      policyDetails: {
        is_passive: true,
        force_authn: Boolean(authnRequest.forceAuthn),
        has_authenticated_session: Boolean(authenticatedSession),
      },
    };
  }

  if (!authenticatedSession && options.returnedFromSignIn) {
    // Sent to sign in and back with no session (cookies refused, the sign-in abandoned): sending
    // them again would only repeat until the request expires.
    return {
      action: 'protocol_error',
      statusCode: STATUS_CODES.RESPONDER,
      secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED,
      statusMessage: 'The requested authentication could not be completed',
      failureKind: 'authn_request_force_authn_unmet',
      policyDetails: { force_authn: Boolean(authnRequest.forceAuthn), no_session: true },
    };
  }

  if (authnRequest.forceAuthn) {
    const sentToSignIn = options.reauthentication;
    if (!sentToSignIn || !authenticatedSession) {
      return {
        action: 'interactive_login',
        forceReauthentication: true,
      };
    }
    // The person came back from the sign-in this request's ForceAuthn asked for: the session is
    // that sign-in only if it was proven after the person was sent, and then it is answered from.
    // One that cannot be shown to be is not sent again (it would come back the same way,
    // endlessly): the sign-in the request requires did not happen.
    if (
      authenticatedSession.provenAt !== undefined &&
      authenticatedSession.provenAt >= sentToSignIn.issuedAt
    ) {
      return { action: 'use_session', session: authenticatedSession };
    }
    return {
      action: 'protocol_error',
      statusCode: STATUS_CODES.RESPONDER,
      secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED,
      statusMessage: 'The requested authentication could not be completed',
      failureKind: 'authn_request_force_authn_unmet',
      policyDetails: { force_authn: true },
    };
  }

  if (!authenticatedSession) {
    return {
      action: 'interactive_login',
      forceReauthentication: false,
    };
  }

  return {
    action: 'use_session',
    session: authenticatedSession,
  };
}
