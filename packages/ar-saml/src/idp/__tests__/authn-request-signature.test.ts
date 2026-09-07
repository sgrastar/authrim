import type { SAMLAuthnRequest, SAMLSPConfig } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { DIGEST_ALGORITHMS, NAMEID_FORMATS, SIGNATURE_ALGORITHMS } from '../../common/constants';
import {
  SAMLAuthnRequestSignatureValidationError,
  validateSAMLAuthnRequestSignature,
} from '../authn-request-signature';

describe('validateSAMLAuthnRequestSignature', () => {
  const authnRequest: SAMLAuthnRequest = {
    id: '_request123',
    issueInstant: new Date().toISOString(),
    issuer: 'https://sp.example.com/saml',
  };

  const baseSpConfig: SAMLSPConfig = {
    entityId: 'https://sp.example.com/saml',
    acsUrl: 'https://sp.example.com/acs',
    certificate: 'sp-certificate',
    nameIdFormat: NAMEID_FORMATS.EMAIL,
    attributeMapping: {},
    signAssertions: false,
    signResponses: true,
    allowedBindings: ['post'],
  };

  it('allows unsigned AuthnRequest when policy is optional', async () => {
    await expect(
      validateSAMLAuthnRequestSignature(
        {
          authnRequest,
          spConfig: { ...baseSpConfig, authnRequestSignaturePolicy: 'optional' },
          binding: 'post',
          xml: '<AuthnRequest />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).resolves.toBeUndefined();
  });

  it('rejects unsigned AuthnRequest when policy is required', async () => {
    await expect(
      validateSAMLAuthnRequestSignature(
        {
          authnRequest,
          spConfig: { ...baseSpConfig, authnRequestSignaturePolicy: 'required' },
          binding: 'post',
          xml: '<AuthnRequest />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).rejects.toThrow('Signed AuthnRequest is required');
  });

  it('classifies signature policy failures for audit', async () => {
    await expect(
      validateSAMLAuthnRequestSignature({
        authnRequest,
        spConfig: { ...baseSpConfig, authnRequestSignaturePolicy: 'required' },
        binding: 'post',
        xml: '<AuthnRequest />',
      })
    ).rejects.toMatchObject({
      failureKind: 'authn_request_signature_required',
    } satisfies Partial<SAMLAuthnRequestSignatureValidationError>);
  });

  it('verifies signed POST AuthnRequest with SP certificate and expected request ID', async () => {
    const verifyXmlSignature = vi.fn(() => true);

    await validateSAMLAuthnRequestSignature(
      {
        authnRequest,
        spConfig: { ...baseSpConfig, authnRequestSignaturePolicy: 'required' },
        binding: 'post',
        xml: '<AuthnRequest><Signature /></AuthnRequest>',
      },
      {
        hasSignature: () => true,
        verifyXmlSignature,
      }
    );

    expect(verifyXmlSignature).toHaveBeenCalledWith('<AuthnRequest><Signature /></AuthnRequest>', {
      certificateOrKey: 'sp-certificate',
      expectedId: '_request123',
      strictXswProtection: true,
    });
  });

  it('returns authenticated references for signed POST AuthnRequest processing', async () => {
    const references = [{ uri: '#_request123', xml: '<AuthnRequest ID="_request123" />' }];
    await expect(
      validateSAMLAuthnRequestSignature(
        {
          authnRequest,
          spConfig: { ...baseSpConfig, authnRequestSignaturePolicy: 'required' },
          binding: 'post',
          xml: '<AuthnRequest><Signature /></AuthnRequest>',
        },
        {
          hasSignature: () => true,
          verifyXmlSignatureAndGetReferences: vi.fn(() => references),
        }
      )
    ).resolves.toEqual(references);
  });

  it('tries rollover certificates when verifying signed POST AuthnRequest', async () => {
    const verifyXmlSignature = vi.fn((_xml, options) => options.certificateOrKey === 'sp-next');

    await validateSAMLAuthnRequestSignature(
      {
        authnRequest,
        spConfig: {
          ...baseSpConfig,
          certificate: 'sp-active',
          certificates: ['sp-active', 'sp-next'],
          authnRequestSignaturePolicy: 'required',
        },
        binding: 'post',
        xml: '<AuthnRequest><Signature /></AuthnRequest>',
      },
      {
        hasSignature: () => true,
        verifyXmlSignature,
      }
    );

    expect(verifyXmlSignature).toHaveBeenCalledTimes(2);
    expect(verifyXmlSignature).toHaveBeenLastCalledWith(
      '<AuthnRequest><Signature /></AuthnRequest>',
      {
        certificateOrKey: 'sp-next',
        expectedId: '_request123',
        strictXswProtection: true,
      }
    );
  });

  it('verifies signed Redirect AuthnRequest over raw query parameter values', async () => {
    const verifyRedirectBindingSignature = vi.fn(async () => true);

    await validateSAMLAuthnRequestSignature(
      {
        authnRequest,
        spConfig: { ...baseSpConfig, authnRequestSignaturePolicy: 'required' },
        binding: 'redirect',
        xml: '<AuthnRequest />',
        redirectSignature: {
          samlMessage: 'abc%2B123',
          relayState: 'state%201',
          signature: 'signature',
          sigAlg: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        },
      },
      {
        verifyRedirectBindingSignature,
      }
    );

    expect(verifyRedirectBindingSignature).toHaveBeenCalledWith(
      'SAMLRequest',
      'abc%2B123',
      'state%201',
      'signature',
      'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      'sp-certificate'
    );
  });

  it('tries rollover certificates when verifying signed Redirect AuthnRequest', async () => {
    const verifyRedirectBindingSignature = vi.fn(
      async (_messageType, _samlRequest, _relayState, _signature, _sigAlg, certificate) =>
        certificate === 'sp-next'
    );

    await validateSAMLAuthnRequestSignature(
      {
        authnRequest,
        spConfig: {
          ...baseSpConfig,
          certificate: 'sp-active',
          certificates: ['sp-active', 'sp-next'],
          authnRequestSignaturePolicy: 'required',
        },
        binding: 'redirect',
        xml: '<AuthnRequest />',
        redirectSignature: {
          samlMessage: 'abc%2B123',
          relayState: 'state%201',
          signature: 'signature',
          sigAlg: SIGNATURE_ALGORITHMS.RSA_SHA256,
        },
      },
      {
        verifyRedirectBindingSignature,
      }
    );

    expect(verifyRedirectBindingSignature).toHaveBeenCalledTimes(2);
  });

  it('rejects signed AuthnRequest when SP certificate is missing', async () => {
    await expect(
      validateSAMLAuthnRequestSignature(
        {
          authnRequest,
          spConfig: {
            ...baseSpConfig,
            certificate: undefined,
            certificates: undefined,
            authnRequestSignaturePolicy: 'required',
          },
          binding: 'post',
          xml: '<AuthnRequest><Signature /></AuthnRequest>',
        },
        {
          hasSignature: () => true,
        }
      )
    ).rejects.toThrow('SP certificate is required');
  });

  it('rejects Redirect AuthnRequest with a disallowed signature algorithm', async () => {
    await expect(
      validateSAMLAuthnRequestSignature({
        authnRequest,
        spConfig: {
          ...baseSpConfig,
          authnRequestSignaturePolicy: 'required',
          acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
        },
        binding: 'redirect',
        xml: '<AuthnRequest />',
        redirectSignature: {
          samlMessage: 'abc',
          signature: 'signature',
          sigAlg: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
        },
      })
    ).rejects.toThrow('Unsupported AuthnRequest signature algorithm');
  });

  it('allows SHA-1 Redirect AuthnRequest only with explicit legacy opt-in', async () => {
    const verifyRedirectBindingSignature = vi.fn(async () => true);

    await expect(
      validateSAMLAuthnRequestSignature(
        {
          authnRequest,
          spConfig: {
            ...baseSpConfig,
            authnRequestSignaturePolicy: 'required',
            authnRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
            acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
          },
          binding: 'redirect',
          xml: '<AuthnRequest />',
          redirectSignature: {
            samlMessage: 'abc',
            signature: 'signature',
            sigAlg: SIGNATURE_ALGORITHMS.RSA_SHA1,
          },
        },
        {
          verifyRedirectBindingSignature,
        }
      )
    ).resolves.toBeUndefined();
    expect(verifyRedirectBindingSignature).toHaveBeenCalled();
  });

  it('rejects POST AuthnRequest with a disallowed XML digest algorithm', async () => {
    await expect(
      validateSAMLAuthnRequestSignature(
        {
          authnRequest,
          spConfig: {
            ...baseSpConfig,
            authnRequestSignaturePolicy: 'required',
            acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
            acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
          },
          binding: 'post',
          xml: `
            <samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
              xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="_request123">
              <ds:Signature>
                <ds:SignedInfo>
                  <ds:SignatureMethod Algorithm="${SIGNATURE_ALGORITHMS.RSA_SHA256}" />
                  <ds:Reference URI="#_request123">
                    <ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1" />
                  </ds:Reference>
                </ds:SignedInfo>
              </ds:Signature>
            </samlp:AuthnRequest>
          `,
        },
        {
          hasSignature: () => true,
        }
      )
    ).rejects.toThrow('Unsupported AuthnRequest digest algorithm');
  });

  it('skips signature checks when policy is disabled', async () => {
    const verifyXmlSignature = vi.fn(() => {
      throw new Error('should not verify');
    });

    await expect(
      validateSAMLAuthnRequestSignature(
        {
          authnRequest,
          spConfig: { ...baseSpConfig, authnRequestSignaturePolicy: 'disabled' },
          binding: 'post',
          xml: '<AuthnRequest><Signature /></AuthnRequest>',
        },
        {
          hasSignature: () => true,
          verifyXmlSignature,
        }
      )
    ).resolves.toBeUndefined();
    expect(verifyXmlSignature).not.toHaveBeenCalled();
  });
});
