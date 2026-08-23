import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { DIGEST_ALGORITHMS, NAMEID_FORMATS, SIGNATURE_ALGORITHMS } from '../../common/constants';
import type { ParsedLogoutRequest } from '../../common/slo-messages';
import {
  SAMLLogoutRequestSignatureValidationError,
  validateSAMLLogoutRequestSignature,
} from '../logout-request-signature';

describe('validateSAMLLogoutRequestSignature', () => {
  const logoutRequest: ParsedLogoutRequest = {
    id: '_logout123',
    issueInstant: new Date().toISOString(),
    issuer: 'https://sp.example.com/saml',
    nameId: 'user@example.com',
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

  it('allows unsigned LogoutRequest when policy is optional', async () => {
    await expect(
      validateSAMLLogoutRequestSignature(
        {
          logoutRequest,
          spConfig: { ...baseSpConfig, logoutRequestSignaturePolicy: 'optional' },
          binding: 'post',
          xml: '<LogoutRequest />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).resolves.toBeUndefined();
  });

  it('rejects unsigned LogoutRequest when policy is required', async () => {
    await expect(
      validateSAMLLogoutRequestSignature(
        {
          logoutRequest,
          spConfig: { ...baseSpConfig, logoutRequestSignaturePolicy: 'required' },
          binding: 'post',
          xml: '<LogoutRequest />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).rejects.toMatchObject({
      failureKind: 'logout_request_signature_required',
    } satisfies Partial<SAMLLogoutRequestSignatureValidationError>);
  });

  it('verifies signed POST LogoutRequest with SP certificate and expected request ID', async () => {
    const verifyXmlSignature = vi.fn(() => true);

    await validateSAMLLogoutRequestSignature(
      {
        logoutRequest,
        spConfig: { ...baseSpConfig, logoutRequestSignaturePolicy: 'required' },
        binding: 'post',
        xml: '<LogoutRequest><Signature /></LogoutRequest>',
      },
      {
        hasSignature: () => true,
        verifyXmlSignature,
      }
    );

    expect(verifyXmlSignature).toHaveBeenCalledWith(
      '<LogoutRequest><Signature /></LogoutRequest>',
      {
        certificateOrKey: 'sp-certificate',
        expectedId: '_logout123',
        strictXswProtection: true,
      }
    );
  });

  it('returns authenticated references for signed POST LogoutRequest processing', async () => {
    const references = [{ uri: '#_logout123', xml: '<LogoutRequest ID="_logout123" />' }];
    await expect(
      validateSAMLLogoutRequestSignature(
        {
          logoutRequest,
          spConfig: { ...baseSpConfig, logoutRequestSignaturePolicy: 'required' },
          binding: 'post',
          xml: '<LogoutRequest><Signature /></LogoutRequest>',
        },
        {
          hasSignature: () => true,
          verifyXmlSignatureAndGetReferences: vi.fn(() => references),
        }
      )
    ).resolves.toEqual(references);
  });

  it('tries rollover certificates when verifying signed POST LogoutRequest', async () => {
    const verifyXmlSignature = vi.fn((_xml, options) => options.certificateOrKey === 'sp-next');

    await validateSAMLLogoutRequestSignature(
      {
        logoutRequest,
        spConfig: {
          ...baseSpConfig,
          certificate: 'sp-active',
          certificates: ['sp-active', 'sp-next'],
          logoutRequestSignaturePolicy: 'required',
        },
        binding: 'post',
        xml: '<LogoutRequest><Signature /></LogoutRequest>',
      },
      {
        hasSignature: () => true,
        verifyXmlSignature,
      }
    );

    expect(verifyXmlSignature).toHaveBeenCalledTimes(2);
  });

  it('verifies signed Redirect LogoutRequest over raw query parameter values', async () => {
    const verifyRedirectBindingSignature = vi.fn(async () => true);

    await validateSAMLLogoutRequestSignature(
      {
        logoutRequest,
        spConfig: { ...baseSpConfig, logoutRequestSignaturePolicy: 'required' },
        binding: 'redirect',
        xml: '<LogoutRequest />',
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

    expect(verifyRedirectBindingSignature).toHaveBeenCalledWith(
      'SAMLRequest',
      'abc%2B123',
      'state%201',
      'signature',
      SIGNATURE_ALGORITHMS.RSA_SHA256,
      'sp-certificate'
    );
  });

  it('rejects signed LogoutRequest when SP certificate is missing', async () => {
    await expect(
      validateSAMLLogoutRequestSignature(
        {
          logoutRequest,
          spConfig: {
            ...baseSpConfig,
            certificate: undefined,
            certificates: undefined,
            logoutRequestSignaturePolicy: 'required',
          },
          binding: 'post',
          xml: '<LogoutRequest><Signature /></LogoutRequest>',
        },
        {
          hasSignature: () => true,
        }
      )
    ).rejects.toThrow('SP certificate is required');
  });

  it('rejects POST LogoutRequest with a disallowed XML digest algorithm', async () => {
    await expect(
      validateSAMLLogoutRequestSignature(
        {
          logoutRequest,
          spConfig: {
            ...baseSpConfig,
            logoutRequestSignaturePolicy: 'required',
            acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
            acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
          },
          binding: 'post',
          xml: `
            <samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
              xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="_logout123">
              <ds:Signature>
                <ds:SignedInfo>
                  <ds:SignatureMethod Algorithm="${SIGNATURE_ALGORITHMS.RSA_SHA256}" />
                  <ds:Reference URI="#_logout123">
                    <ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1" />
                  </ds:Reference>
                </ds:SignedInfo>
              </ds:Signature>
            </samlp:LogoutRequest>
          `,
        },
        {
          hasSignature: () => true,
        }
      )
    ).rejects.toThrow('Unsupported LogoutRequest digest algorithm');
  });
});
