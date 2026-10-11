/**
 * The AAL gate of the SAML IdP SSO endpoint: checks the sign-in against the AAL the request
 * requires (see authn-assurance.ts) and, when it falls short, either sends the person to
 * authenticate again or answers the SP, with the audit record and log line for each.
 *
 * It returns the response to send, or the check when the request goes on to be answered.
 */

import type { Context } from 'hono';
import type { Env, SAMLAuthnRequest, SAMLRequestContext, SAMLSPConfig } from '@authrim/ar-lib-core';
import { STATUS_CODES } from '../common/constants';
import { scheduleSAMLPolicyFailureAudit, type SAMLPolicyFailureKind } from './audit';
import {
  checkSAMLAuthnAssurance,
  type SAMLAssuranceSession,
  type SAMLAuthnAssuranceCheck,
} from './authn-assurance';
import { carrySAMLRequestContext, redirectToSAMLLogin } from './sso-stored-request';

interface GateLog {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

export type SAMLAuthnAssuranceGateResult =
  | { response: Response }
  | { check: Extract<SAMLAuthnAssuranceCheck, { outcome: 'not_required' | 'met' }> };

export async function gateSAMLAuthnAssurance(
  c: Context<{ Bindings: Env }>,
  input: {
    env: Env;
    tenantId: string;
    authnRequest: SAMLAuthnRequest;
    spConfig: SAMLSPConfig;
    session: SAMLAssuranceSession;
    relayState?: string;
    requestContext?: SAMLRequestContext;
    log: GateLog;
    /** Answer the SP with an error response (Responder status; the second-level code, if any). */
    refuse(answer: {
      secondLevelStatusCode?: string;
      statusMessage: string;
      failureKind: SAMLPolicyFailureKind;
    }): Promise<Response>;
  }
): Promise<SAMLAuthnAssuranceGateResult> {
  const { env, tenantId, authnRequest, spConfig, log } = input;
  const logContext = { tenantId, spEntityId: spConfig.entityId, authnRequestId: authnRequest.id };
  const audit = (failureKind: SAMLPolicyFailureKind, policyDetails: Record<string, unknown>) =>
    scheduleSAMLPolicyFailureAudit(c, {
      tenantId,
      spEntityId: spConfig.entityId,
      authnRequestId: authnRequest.id,
      failureKind,
      policyDetails,
    });

  const check = await checkSAMLAuthnAssurance({
    env,
    tenantId,
    authnRequest,
    spConfig,
    session: input.session,
    requestContext: input.requestContext,
    onUnrecorded: () => log.warn('The step-up could not be recorded in the session', logContext),
  });

  switch (check.outcome) {
    case 'not_required':
    case 'met':
      return { check };

    case 'step_up':
      audit('authn_assurance_insufficient', {
        required_aal: check.requiredAal,
        actual_aal: check.actual,
        step_up: true,
      });
      // A new sign-in, combined with this session's factors when the person comes back.
      return {
        response: await redirectToSAMLLogin(c, {
          env,
          tenantId,
          authnRequest,
          relayState: input.relayState,
          forceReauthentication: true,
          requiredAal: check.requiredAal,
          context: {
            ...carrySAMLRequestContext(input.requestContext),
            assuranceStepUp: {
              issuedAt: Date.now(),
              priorSessionId: check.priorSessionId,
              requiredAal: check.requiredAal,
            },
          },
        }),
      };

    case 'unavailable':
      log.error(
        'Failed to read assurance settings',
        logContext,
        check.error instanceof Error ? check.error : new Error(String(check.error))
      );
      audit('authn_assurance_unavailable', {});
      return {
        response: await input.refuse({
          statusMessage: 'The request could not be processed right now',
          failureKind: 'authn_assurance_unavailable',
        }),
      };

    case 'no_passive':
    case 'insufficient': {
      log.info('SAML sign-in refused: authentication assurance level not met', logContext);
      const passive = check.outcome === 'no_passive';
      const failureKind = passive ? 'authn_request_no_passive' : 'authn_assurance_insufficient';
      audit(failureKind, {
        required_aal: check.requiredAal,
        ...(check.actual ? { actual_aal: check.actual } : {}),
        ...(check.outcome === 'insufficient' ? { reason: check.reason } : { is_passive: true }),
      });
      // The answer says neither the level reached nor the one required.
      return {
        response: await input.refuse({
          secondLevelStatusCode: passive ? STATUS_CODES.NO_PASSIVE : STATUS_CODES.NO_AUTHN_CONTEXT,
          statusMessage: passive
            ? 'Passive authentication could not be completed'
            : 'Requested authentication context could not be satisfied',
          failureKind,
        }),
      };
    }
  }
}
