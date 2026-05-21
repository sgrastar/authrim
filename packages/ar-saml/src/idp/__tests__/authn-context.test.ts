import { describe, expect, it } from 'vitest';
import type { SAMLAuthnRequest } from '@authrim/ar-lib-core';
import { AUTHN_CONTEXT, SAML_NAMESPACES } from '../../common/constants';
import { findElement, parseXml } from '../../common/xml-utils';
import {
  parseRequestedAuthnContext,
  resolveSAMLAuthnContextClassRef,
  SAMLAuthnContextPolicyError,
} from '../authn-context';

describe('SAML AuthnContext handling', () => {
  it('parses RequestedAuthnContext from AuthnRequest XML', () => {
    const request = parseRequestElement(`
      <samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}">
        <samlp:RequestedAuthnContext Comparison="exact">
          <saml:AuthnContextClassRef>${AUTHN_CONTEXT.PASSWORD_PROTECTED_TRANSPORT}</saml:AuthnContextClassRef>
        </samlp:RequestedAuthnContext>
      </samlp:AuthnRequest>
    `);

    expect(parseRequestedAuthnContext(request)).toEqual({
      comparison: 'exact',
      authnContextClassRef: [AUTHN_CONTEXT.PASSWORD_PROTECTED_TRANSPORT],
    });
  });

  it('ignores nested RequestedAuthnContext outside the direct AuthnRequest children', () => {
    const request = parseRequestElement(`
      <samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}">
        <wrapper>
          <samlp:RequestedAuthnContext Comparison="exact">
            <saml:AuthnContextClassRef>${AUTHN_CONTEXT.PASSWORD}</saml:AuthnContextClassRef>
          </samlp:RequestedAuthnContext>
        </wrapper>
      </samlp:AuthnRequest>
    `);

    expect(parseRequestedAuthnContext(request)).toBeUndefined();
  });

  it('uses PasswordProtectedTransport when no AuthnContext is requested', () => {
    expect(resolveSAMLAuthnContextClassRef(authnRequest())).toBe(
      AUTHN_CONTEXT.PASSWORD_PROTECTED_TRANSPORT
    );
  });

  it('uses session-aware passkey context only when enabled for the SP', () => {
    expect(
      resolveSAMLAuthnContextClassRef(authnRequest(), {
        spConfig: { authnContextClassRefMode: 'session' },
        session: { amr: ['passkey'] },
      })
    ).toBe(AUTHN_CONTEXT.AUTHRIM_PHISHING_RESISTANT);
  });

  it('keeps legacy static context for passkey sessions unless opted in', () => {
    expect(
      resolveSAMLAuthnContextClassRef(authnRequest(), {
        session: { amr: ['passkey'] },
      })
    ).toBe(AUTHN_CONTEXT.PASSWORD_PROTECTED_TRANSPORT);
  });

  it('selects a supported requested AuthnContext', () => {
    expect(
      resolveSAMLAuthnContextClassRef(
        authnRequest({
          requestedAuthnContext: {
            comparison: 'exact',
            authnContextClassRef: [AUTHN_CONTEXT.PASSWORD],
          },
        })
      )
    ).toBe(AUTHN_CONTEXT.PASSWORD);
  });

  it('rejects unsupported requested AuthnContext classes', () => {
    expect(() =>
      resolveSAMLAuthnContextClassRef(
        authnRequest({
          requestedAuthnContext: {
            comparison: 'exact',
            authnContextClassRef: ['urn:example:unsupported'],
          },
        })
      )
    ).toThrow(SAMLAuthnContextPolicyError);
  });
});

function parseRequestElement(xml: string) {
  const doc = parseXml(xml);
  const request = findElement(doc, SAML_NAMESPACES.SAML2P, 'AuthnRequest');
  if (!request) {
    throw new Error('Missing AuthnRequest in test XML');
  }
  return request;
}

function authnRequest(overrides: Partial<SAMLAuthnRequest> = {}): SAMLAuthnRequest {
  return {
    id: '_request123',
    issueInstant: '2024-01-15T10:30:00Z',
    issuer: 'https://sp.example.com',
    ...overrides,
  };
}
