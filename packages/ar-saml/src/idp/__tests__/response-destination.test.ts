import type { SAMLAuthnRequest, SAMLSPConfig } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  InvalidSAMLResponseDestinationError,
  resolveSAMLResponseDestination,
  UnsupportedSAMLResponseBindingError,
  validateSAMLResponseProtocolBinding,
} from '../response-destination';
import { BINDING_URIS } from '../../common/constants';

describe('resolveSAMLResponseDestination', () => {
  const spConfig: SAMLSPConfig = {
    entityId: 'https://sp.example.com/saml',
    acsUrl: 'https://sp.example.com/saml/acs/default',
    acsUrls: [
      'https://sp.example.com/saml/acs/default',
      'https://sp.example.com/saml/acs/secondary',
    ],
    acsServices: [
      {
        index: 0,
        binding: 'post',
        location: 'https://sp.example.com/saml/acs/default',
        isDefault: true,
      },
      {
        index: 1,
        binding: 'post',
        location: 'https://sp.example.com/saml/acs/secondary',
      },
    ],
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    attributeMapping: {},
    signAssertions: false,
    signResponses: true,
    allowedBindings: ['post'],
  };

  it('uses the registered default ACS URL when AuthnRequest does not specify one', () => {
    expect(resolveSAMLResponseDestination(authnRequest(), spConfig)).toBe(
      'https://sp.example.com/saml/acs/default'
    );
  });

  it('allows an AuthnRequest ACS URL when it is registered for the SP', () => {
    expect(
      resolveSAMLResponseDestination(
        authnRequest('https://sp.example.com/saml/acs/secondary'),
        spConfig
      )
    ).toBe('https://sp.example.com/saml/acs/secondary');
  });

  it('uses indexed ACS metadata when AuthnRequest specifies AssertionConsumerServiceIndex', () => {
    expect(resolveSAMLResponseDestination(authnRequest(undefined, 1), spConfig)).toBe(
      'https://sp.example.com/saml/acs/secondary'
    );
  });

  it('rejects an unknown AuthnRequest AssertionConsumerServiceIndex', () => {
    expect(() => resolveSAMLResponseDestination(authnRequest(undefined, 99), spConfig)).toThrow(
      InvalidSAMLResponseDestinationError
    );
  });

  it('rejects an AuthnRequest ACS URL that is not registered for the SP', () => {
    expect(() =>
      resolveSAMLResponseDestination(authnRequest('https://attacker.example.com/acs'), spConfig)
    ).toThrow(InvalidSAMLResponseDestinationError);
  });

  it('allows the default HTTP-POST response ProtocolBinding', () => {
    expect(() =>
      validateSAMLResponseProtocolBinding({
        ...authnRequest(),
        protocolBinding: BINDING_URIS.HTTP_POST,
      })
    ).not.toThrow();
  });

  it('rejects unsupported response ProtocolBinding values', () => {
    expect(() =>
      validateSAMLResponseProtocolBinding({
        ...authnRequest(),
        protocolBinding: BINDING_URIS.HTTP_ARTIFACT,
      })
    ).toThrow(UnsupportedSAMLResponseBindingError);
  });
});

function authnRequest(
  assertionConsumerServiceURL?: string,
  assertionConsumerServiceIndex?: number
): SAMLAuthnRequest {
  return {
    id: '_request123',
    issueInstant: new Date().toISOString(),
    issuer: 'https://sp.example.com/saml',
    assertionConsumerServiceURL,
    assertionConsumerServiceIndex,
  };
}
