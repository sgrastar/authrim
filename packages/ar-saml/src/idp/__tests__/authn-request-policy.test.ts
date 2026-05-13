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
});

function authnRequest(overrides: Partial<SAMLAuthnRequest> = {}): SAMLAuthnRequest {
  return {
    id: '_request123',
    issueInstant: '2024-01-15T10:30:00Z',
    issuer: 'https://sp.example.com',
    ...overrides,
  };
}
