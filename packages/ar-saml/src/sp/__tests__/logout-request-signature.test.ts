import { describe, expect, it, vi } from 'vitest';
import type { SAMLIdPConfig } from '@authrim/ar-lib-core';
import { NAMEID_FORMATS, SIGNATURE_ALGORITHMS } from '../../common/constants';
import type { ParsedLogoutRequest } from '../../common/slo-messages';
import {
  SAMLIdPLogoutRequestSignatureValidationError,
  validateSAMLIdPLogoutRequestSignature,
} from '../logout-request-signature';

describe('validateSAMLIdPLogoutRequestSignature', () => {
  const logoutRequest: ParsedLogoutRequest = {
    id: '_logout123',
    issueInstant: new Date().toISOString(),
    issuer: 'https://idp.example.com',
    nameId: 'user@example.com',
  };

  const baseIdPConfig: SAMLIdPConfig = {
    entityId: 'https://idp.example.com',
    ssoUrl: 'https://idp.example.com/sso',
    sloUrl: 'https://idp.example.com/slo',
    certificate: 'idp-certificate',
    nameIdFormat: NAMEID_FORMATS.EMAIL,
    attributeMapping: {},
    allowedBindings: ['post', 'redirect'],
  };

  it('requires signed LogoutRequest by default', async () => {
    await expect(
      validateSAMLIdPLogoutRequestSignature(
        {
          logoutRequest,
          idpConfig: baseIdPConfig,
          binding: 'post',
          xml: '<LogoutRequest />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).rejects.toMatchObject({
      failureKind: 'idp_logout_request_signature_required',
    } satisfies Partial<SAMLIdPLogoutRequestSignatureValidationError>);
  });

  it('allows unsigned LogoutRequest only when policy is optional', async () => {
    await expect(
      validateSAMLIdPLogoutRequestSignature(
        {
          logoutRequest,
          idpConfig: { ...baseIdPConfig, logoutRequestSignaturePolicy: 'optional' },
          binding: 'post',
          xml: '<LogoutRequest />',
        },
        {
          hasSignature: () => false,
        }
      )
    ).resolves.toBeUndefined();
  });

  it('verifies signed POST LogoutRequest with IdP certificate and expected request ID', async () => {
    const verifyXmlSignature = vi.fn(() => true);

    await validateSAMLIdPLogoutRequestSignature(
      {
        logoutRequest,
        idpConfig: baseIdPConfig,
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
        certificateOrKey: 'idp-certificate',
        expectedId: '_logout123',
        strictXswProtection: true,
      }
    );
  });

  it('returns authenticated references for signed IdP POST LogoutRequest processing', async () => {
    const references = [{ uri: '#_logout123', xml: '<LogoutRequest ID="_logout123" />' }];
    await expect(
      validateSAMLIdPLogoutRequestSignature(
        {
          logoutRequest,
          idpConfig: baseIdPConfig,
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

  it('verifies signed Redirect LogoutRequest over raw query parameter values', async () => {
    const verifyRedirectBindingSignature = vi.fn(async () => true);

    await validateSAMLIdPLogoutRequestSignature(
      {
        logoutRequest,
        idpConfig: baseIdPConfig,
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
      'idp-certificate'
    );
  });
});
