import { describe, expect, it } from 'vitest';
import type { SAMLAuthnRequest } from '@authrim/ar-lib-core';
import { STATUS_CODES } from '../../common/constants';
import { resolveSAMLAuthnInteraction } from '../authn-request-policy';

describe('resolveSAMLAuthnInteraction', () => {
  const session = { userId: 'user_123', sessionId: 'sess_123' };

  it('uses an existing session when no interaction flags are requested', () => {
    expect(resolveSAMLAuthnInteraction(authnRequest(), session)).toEqual({
      action: 'use_session',
      session,
    });
  });

  it('requires interactive login when there is no session', () => {
    expect(resolveSAMLAuthnInteraction(authnRequest(), null)).toEqual({
      action: 'interactive_login',
      forceReauthentication: false,
    });
  });

  it('requires reauthentication when ForceAuthn is requested', () => {
    expect(resolveSAMLAuthnInteraction(authnRequest({ forceAuthn: true }), session)).toEqual({
      action: 'interactive_login',
      forceReauthentication: true,
    });
  });

  it('returns NoPassive when passive auth is requested without a session', () => {
    expect(resolveSAMLAuthnInteraction(authnRequest({ isPassive: true }), null)).toMatchObject({
      action: 'protocol_error',
      statusCode: STATUS_CODES.RESPONDER,
      secondLevelStatusCode: STATUS_CODES.NO_PASSIVE,
      failureKind: 'authn_request_no_passive',
    });
  });

  it('returns NoPassive when passive auth conflicts with ForceAuthn', () => {
    expect(
      resolveSAMLAuthnInteraction(authnRequest({ forceAuthn: true, isPassive: true }), session)
    ).toMatchObject({
      action: 'protocol_error',
      statusCode: STATUS_CODES.RESPONDER,
      secondLevelStatusCode: STATUS_CODES.NO_PASSIVE,
      failureKind: 'authn_request_no_passive',
    });
  });

  describe('after the person was sent to sign in again for ForceAuthn', () => {
    const forced = authnRequest({ forceAuthn: true });
    const sentAt = 10_000;

    it('answers from a session proven at or after it sent the person', () => {
      for (const provenAt of [sentAt, sentAt + 1]) {
        const fresh = { ...session, provenAt };
        expect(
          resolveSAMLAuthnInteraction(forced, fresh, { reauthentication: { issuedAt: sentAt } })
        ).toEqual({ action: 'use_session', session: fresh });
      }
    });

    it.each([
      ['proven before it', sentAt - 1],
      ['recording no proof time', undefined],
    ])('does not send a session %s round again: the sign-in did not happen', (_name, provenAt) => {
      expect(
        resolveSAMLAuthnInteraction(
          forced,
          { ...session, provenAt },
          { reauthentication: { issuedAt: sentAt } }
        )
      ).toMatchObject({
        action: 'protocol_error',
        statusCode: STATUS_CODES.RESPONDER,
        secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED,
        failureKind: 'authn_request_force_authn_unmet',
      });
    });

    it('does not send a person who comes back with no session to sign in again', () => {
      expect(
        resolveSAMLAuthnInteraction(forced, null, {
          reauthentication: { issuedAt: sentAt },
          returnedFromSignIn: true,
        })
      ).toMatchObject({
        action: 'protocol_error',
        secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED,
        failureKind: 'authn_request_force_authn_unmet',
      });
    });

    it('does not send a person who comes back from a step-up with no session either', () => {
      expect(
        resolveSAMLAuthnInteraction(authnRequest(), null, { returnedFromSignIn: true })
      ).toMatchObject({
        action: 'protocol_error',
        secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED,
      });
    });

    it('still sends a first request with no session, ForceAuthn or not, to sign in', () => {
      expect(resolveSAMLAuthnInteraction(authnRequest(), null, {})).toEqual({
        action: 'interactive_login',
        forceReauthentication: false,
      });
      expect(resolveSAMLAuthnInteraction(forced, null, {})).toEqual({
        action: 'interactive_login',
        forceReauthentication: true,
      });
    });

    it('still sends a first ForceAuthn request to sign in, whatever the session records', () => {
      expect(resolveSAMLAuthnInteraction(forced, { ...session, provenAt: sentAt + 5 })).toEqual({
        action: 'interactive_login',
        forceReauthentication: true,
      });
    });

    it('does not ask a request without ForceAuthn for a new sign-in', () => {
      const plain = { ...session, provenAt: undefined };
      expect(
        resolveSAMLAuthnInteraction(authnRequest(), plain, {
          reauthentication: { issuedAt: sentAt },
        })
      ).toEqual({ action: 'use_session', session: plain });
    });
  });
});

function authnRequest(overrides: Partial<SAMLAuthnRequest> = {}): SAMLAuthnRequest {
  return {
    id: '_request123',
    issueInstant: '2024-01-15T10:30:00Z',
    issuer: 'https://sp.example.com',
    ...overrides,
  };
}
