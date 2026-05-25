import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { DIGEST_ALGORITHMS, NAMEID_FORMATS, SIGNATURE_ALGORITHMS } from '../../common/constants';
import type { ParsedLogoutResponse } from '../../common/slo-messages';
import {
  SAMLLogoutResponseSignatureValidationError,
  validateSAMLLogoutResponseSignature,
} from '../logout-response-signature';

describe('validateSAMLLogoutResponseSignature', () => {
  const logoutResponse: ParsedLogoutResponse = {
    id: '_logout_response123',
    issueInstant: new Date().toISOString(),
    issuer: 'https://sp.example.com/saml',
    inResponseTo: '_logout123',
    statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
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

  it('allows unsigned LogoutResponse when policy is optional', async () => {
    await expect(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: { ...baseSpConfig, logoutResponseSignaturePolicy: 'optional' },
          binding: 'post',
          xml: '<LogoutResponse />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).resolves.toBeUndefined();
  });

  it('rejects unsigned LogoutResponse when policy is required', async () => {
    await expect(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: { ...baseSpConfig, logoutResponseSignaturePolicy: 'required' },
          binding: 'post',
          xml: '<LogoutResponse />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).rejects.toMatchObject({
      failureKind: 'logout_response_signature_required',
    } satisfies Partial<SAMLLogoutResponseSignatureValidationError>);
  });

  it('verifies signed POST LogoutResponse with SP certificate and expected response ID', async () => {
    const verifyXmlSignature = vi.fn(() => true);

    await validateSAMLLogoutResponseSignature(
      {
        logoutResponse,
        spConfig: { ...baseSpConfig, logoutResponseSignaturePolicy: 'required' },
        binding: 'post',
        xml: '<LogoutResponse><Signature /></LogoutResponse>',
      },
      {
        hasSignature: () => true,
        verifyXmlSignature,
      }
    );

    expect(verifyXmlSignature).toHaveBeenCalledWith(
      '<LogoutResponse><Signature /></LogoutResponse>',
      {
        certificateOrKey: 'sp-certificate',
        expectedId: '_logout_response123',
        strictXswProtection: true,
      }
    );
  });

  it('verifies signed Redirect LogoutResponse over raw query parameter values', async () => {
    const verifyRedirectBindingSignature = vi.fn(async () => true);

    await validateSAMLLogoutResponseSignature(
      {
        logoutResponse,
        spConfig: { ...baseSpConfig, logoutResponseSignaturePolicy: 'required' },
        binding: 'redirect',
        xml: '<LogoutResponse />',
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
      'SAMLResponse',
      'abc%2B123',
      'state%201',
      'signature',
      SIGNATURE_ALGORITHMS.RSA_SHA256,
      'sp-certificate'
    );
  });

  it('rejects POST LogoutResponse with a disallowed XML digest algorithm', async () => {
    await expect(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: {
            ...baseSpConfig,
            logoutResponseSignaturePolicy: 'required',
            acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
            acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
          },
          binding: 'post',
          xml: `
            <samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
              xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="_logout_response123">
              <ds:Signature>
                <ds:SignedInfo>
                  <ds:SignatureMethod Algorithm="${SIGNATURE_ALGORITHMS.RSA_SHA256}" />
                  <ds:Reference URI="#_logout_response123">
                    <ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1" />
                  </ds:Reference>
                </ds:SignedInfo>
              </ds:Signature>
            </samlp:LogoutResponse>
          `,
        },
        {
          hasSignature: () => true,
        }
      )
    ).rejects.toThrow('Unsupported LogoutResponse digest algorithm');
  });
});
