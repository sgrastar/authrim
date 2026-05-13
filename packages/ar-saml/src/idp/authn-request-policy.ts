import type { SAMLAuthnRequest } from '@authrim/ar-lib-core';
import { STATUS_CODES } from '../common/constants';
import type { SAMLPolicyFailureKind } from './audit';

export interface SAMLAuthenticatedSessionInfo {
  userId: string;
  sessionId: string;
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
  authenticatedSession: SAMLAuthenticatedSessionInfo | null
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

  if (authnRequest.forceAuthn) {
    return {
      action: 'interactive_login',
      forceReauthentication: true,
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
