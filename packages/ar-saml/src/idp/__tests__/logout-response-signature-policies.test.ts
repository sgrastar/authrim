/**
 * SP-issued LogoutResponse signature policy (IdP side): disabled policy, certificate sets,
 * algorithm allow-lists, legacy SHA-1 opt-in and failure details.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { DIGEST_ALGORITHMS, NAMEID_FORMATS, SIGNATURE_ALGORITHMS } from '../../common/constants';
import type { ParsedLogoutResponse } from '../../common/slo-messages';
import {
  SAMLLogoutResponseSignatureValidationError,
  validateSAMLLogoutResponseSignature,
} from '../logout-response-signature';

const logoutResponse: ParsedLogoutResponse = {
  id: '_logout123',
  issueInstant: '2026-11-18T12:00:00Z',
  issuer: 'https://sp.example.com',
  statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
};
const idp = (overrides: Partial<SAMLSPConfig> = {}): SAMLSPConfig => ({
  entityId: 'https://sp.example.com',
  acsUrl: 'https://sp.example.com/acs',
  certificate: 'cert-a',
  signAssertions: false,
  signResponses: true,
  nameIdFormat: NAMEID_FORMATS.EMAIL,
  attributeMapping: {},
  allowedBindings: ['post', 'redirect'],
  ...overrides,
});
const signedXml = (
  signatureAlgorithm: string = SIGNATURE_ALGORITHMS.RSA_SHA256,
  digestAlgorithm: string = DIGEST_ALGORITHMS.SHA256
) =>
  `<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_logout123"><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:SignatureMethod Algorithm="${signatureAlgorithm}"/><ds:Reference URI="#_logout123"><ds:DigestMethod Algorithm="${digestAlgorithm}"/></ds:Reference></ds:SignedInfo></ds:Signature></samlp:LogoutResponse>`;
const redirect = (overrides: Record<string, string | undefined> = {}) => ({
  samlMessage: 'msg',
  relayState: 'rs',
  signature: 'sig',
  sigAlg: SIGNATURE_ALGORITHMS.RSA_SHA256,
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SAMLLogoutResponseSignatureValidationError);
  return error as SAMLLogoutResponseSignatureValidationError;
};

describe('validateSAMLLogoutResponseSignature policies', () => {
  it('should skip every check when the policy is disabled', async () => {
    const hasSignature = vi.fn(() => true);
    await expect(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: idp({ logoutResponseSignaturePolicy: 'disabled' }),
          binding: 'post',
          xml: '<x/>',
        },
        { hasSignature }
      )
    ).resolves.toBeUndefined();
    expect(hasSignature).not.toHaveBeenCalled();
  });

  it('should treat a Redirect request as signed when either Signature or SigAlg is present', async () => {
    const verify = vi.fn(async () => true);
    for (const redirectSignature of [
      redirect({ sigAlg: undefined }),
      redirect({ signature: undefined }),
    ]) {
      await expect(
        validateSAMLLogoutResponseSignature(
          { logoutResponse, spConfig: idp(), binding: 'redirect', xml: '<x/>', redirectSignature },
          { verifyRedirectBindingSignature: verify }
        )
      ).rejects.toMatchObject({ failureKind: 'logout_response_incomplete_redirect_signature' });
    }
    expect(verify).not.toHaveBeenCalled();
    // Neither present: unsigned, so the policy decides (default for responses: optional)
    await expect(
      validateSAMLLogoutResponseSignature({
        logoutResponse,
        spConfig: idp(),
        binding: 'redirect',
        xml: '<x/>',
      })
    ).resolves.toBeUndefined();
    await expect(
      validateSAMLLogoutResponseSignature({
        logoutResponse,
        spConfig: idp({ logoutResponseSignaturePolicy: 'required' }),
        binding: 'redirect',
        xml: '<x/>',
      })
    ).rejects.toMatchObject({ failureKind: 'logout_response_signature_required' });
  });

  it('should require a certificate once the request is signed', async () => {
    const error = await failure(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: idp({ certificate: '', certificates: ['', ''] }),
          binding: 'post',
          xml: signedXml(),
        },
        { hasSignature: () => true }
      )
    );
    expect(error.failureKind).toBe('logout_response_certificate_missing');
    expect(error.message).toBe('SP certificate is required to verify signed LogoutResponse');
    expect(error.details).toEqual({});
  });

  it('should try the primary and rollover certificates (de-duplicated) until one verifies', async () => {
    const verifyXmlSignature = vi.fn((_xml: string, options: { certificateOrKey: string }) => {
      if (options.certificateOrKey !== 'cert-c')
        throw new Error(`rejected ${options.certificateOrKey}`);
      return true;
    });
    await expect(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: idp({ certificates: ['cert-a', 'cert-b', 'cert-c'] }),
          binding: 'post',
          xml: signedXml(),
        },
        { hasSignature: () => true, verifyXmlSignature }
      )
    ).resolves.toBeUndefined();
    expect(verifyXmlSignature.mock.calls.map(([, o]) => o.certificateOrKey)).toEqual([
      'cert-a',
      'cert-b',
      'cert-c',
    ]);
  });

  it('should report the last verification error as the failure cause', async () => {
    const verifyXmlSignature = vi.fn((_xml: string, options: { certificateOrKey: string }) => {
      throw new Error(`bad ${options.certificateOrKey}`);
    });
    const error = await failure(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: idp({ certificates: ['cert-b'] }),
          binding: 'post',
          xml: signedXml(),
        },
        { hasSignature: () => true, verifyXmlSignature }
      )
    );
    expect(error.failureKind).toBe('logout_response_invalid_signature');
    expect(error.message).toBe('Invalid LogoutResponse XML signature');
    expect(error.details).toEqual({ cause: 'bad cert-b' });
  });

  it('should fail without details when the verifier returns false or throws a non-Error', async () => {
    const falsy = await failure(
      validateSAMLLogoutResponseSignature(
        { logoutResponse, spConfig: idp(), binding: 'post', xml: signedXml() },
        { hasSignature: () => true, verifyXmlSignature: () => false }
      )
    );
    expect(falsy.details).toEqual({});
    const thrown = await failure(
      validateSAMLLogoutResponseSignature(
        { logoutResponse, spConfig: idp(), binding: 'post', xml: signedXml() },
        {
          hasSignature: () => true,
          verifyXmlSignature: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- non-Error rejection path
            throw 'boom';
          },
        }
      )
    );
    expect(thrown.details).toEqual({});
  });

  it('should prefer the reference-returning verifier and fall back to the boolean one', async () => {
    const references = [{ uri: '#_logout123', xml: '<x/>' }];
    const refs = vi.fn(() => references);
    const bool = vi.fn(() => true);
    await expect(
      validateSAMLLogoutResponseSignature(
        { logoutResponse, spConfig: idp(), binding: 'post', xml: signedXml() },
        {
          hasSignature: () => true,
          verifyXmlSignature: bool,
          verifyXmlSignatureAndGetReferences: refs,
        }
      )
    ).resolves.toEqual(references);
    expect(bool).not.toHaveBeenCalled();
  });

  it('should reject a POST request whose XML signature algorithm is not accepted', async () => {
    const verify = vi.fn(() => true);
    const error = await failure(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: idp(),
          binding: 'post',
          xml: signedXml(SIGNATURE_ALGORITHMS.RSA_SHA1),
        },
        { hasSignature: () => true, verifyXmlSignature: verify }
      )
    );
    expect(error.failureKind).toBe('logout_response_unsupported_signature_algorithm');
    expect(error.message).toBe(
      `Unsupported LogoutResponse signature algorithm: ${SIGNATURE_ALGORITHMS.RSA_SHA1}`
    );
    expect(error.details).toEqual({ algorithm: SIGNATURE_ALGORITHMS.RSA_SHA1 });
    expect(verify).not.toHaveBeenCalled();
  });

  it('should reject a POST request whose digest algorithm is not accepted', async () => {
    const error = await failure(
      validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: idp(),
          binding: 'post',
          xml: signedXml(SIGNATURE_ALGORITHMS.RSA_SHA256, DIGEST_ALGORITHMS.SHA1),
        },
        { hasSignature: () => true, verifyXmlSignature: () => true }
      )
    );
    expect(error.failureKind).toBe('logout_response_unsupported_digest_algorithm');
    expect(error.details).toEqual({ algorithm: DIGEST_ALGORITHMS.SHA1 });
  });

  it('should ignore SignatureMethod/DigestMethod elements without an Algorithm attribute', async () => {
    const xml = `<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_logout123"><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:SignatureMethod/><ds:Reference><ds:DigestMethod/></ds:Reference></ds:SignedInfo></ds:Signature></samlp:LogoutResponse>`;
    await expect(
      validateSAMLLogoutResponseSignature(
        { logoutResponse, spConfig: idp(), binding: 'post', xml },
        { hasSignature: () => true, verifyXmlSignature: () => true }
      )
    ).resolves.toBeUndefined();
  });

  it('should pass SHA-1 allowances to the verifier only with an explicit legacy opt-in', async () => {
    const verify = vi.fn((_xml: string, _options: object) => true);
    const legacy = idp({
      authnRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
      acceptedAuthnRequestSignatureAlgorithms: [
        SIGNATURE_ALGORITHMS.RSA_SHA256,
        SIGNATURE_ALGORITHMS.RSA_SHA1,
      ],
      acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256, DIGEST_ALGORITHMS.SHA1],
    });
    await validateSAMLLogoutResponseSignature(
      {
        logoutResponse,
        spConfig: legacy,
        binding: 'post',
        xml: signedXml(SIGNATURE_ALGORITHMS.RSA_SHA1, DIGEST_ALGORITHMS.SHA1),
      },
      { hasSignature: () => true, verifyXmlSignature: verify }
    );
    expect(verify).toHaveBeenCalledWith(expect.any(String), {
      certificateOrKey: 'cert-a',
      expectedId: '_logout123',
      strictXswProtection: true,
      allowSha1SignatureAlgorithm: true,
      allowSha1DigestAlgorithm: true,
    });

    // Accepted lists without the opt-in do not relax the verifier
    verify.mockClear();
    const listedOnly = idp({
      acceptedAuthnRequestSignatureAlgorithms: [
        SIGNATURE_ALGORITHMS.RSA_SHA256,
        SIGNATURE_ALGORITHMS.RSA_SHA1,
      ],
      acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256, DIGEST_ALGORITHMS.SHA1],
    });
    await validateSAMLLogoutResponseSignature(
      {
        logoutResponse,
        spConfig: listedOnly,
        binding: 'post',
        xml: signedXml(SIGNATURE_ALGORITHMS.RSA_SHA1, DIGEST_ALGORITHMS.SHA1),
      },
      { hasSignature: () => true, verifyXmlSignature: verify }
    );
    expect(verify).toHaveBeenCalledWith(expect.any(String), {
      certificateOrKey: 'cert-a',
      expectedId: '_logout123',
      strictXswProtection: true,
    });

    // Opt-in without SHA-1 in the lists does not relax it either
    verify.mockClear();
    await validateSAMLLogoutResponseSignature(
      {
        logoutResponse,
        spConfig: idp({ authnRequestLegacyAlgorithmPolicy: 'explicit_opt_in' }),
        binding: 'post',
        xml: signedXml(),
      },
      { hasSignature: () => true, verifyXmlSignature: verify }
    );
    expect(verify.mock.calls[0][1]).not.toHaveProperty('allowSha1SignatureAlgorithm');
  });

  describe('HTTP-Redirect binding', () => {
    it('should reject a SigAlg that is not accepted before verifying', async () => {
      const verify = vi.fn(async () => true);
      const error = await failure(
        validateSAMLLogoutResponseSignature(
          {
            logoutResponse,
            spConfig: idp(),
            binding: 'redirect',
            xml: '<x/>',
            redirectSignature: redirect({ sigAlg: SIGNATURE_ALGORITHMS.RSA_SHA1 }),
          },
          { verifyRedirectBindingSignature: verify }
        )
      );
      expect(error.failureKind).toBe('logout_response_unsupported_signature_algorithm');
      expect(error.details).toEqual({ algorithm: SIGNATURE_ALGORITHMS.RSA_SHA1 });
      expect(verify).not.toHaveBeenCalled();
    });

    it('should reject incomplete parameters (missing SAMLRequest, Signature or SigAlg)', async () => {
      for (const redirectSignature of [
        redirect({ samlMessage: '' }),
        redirect({ signature: '' }),
        redirect({ sigAlg: '' }),
      ]) {
        // signature/sigAlg empty but the other present -> counts as signed, then incomplete
        const error = await failure(
          validateSAMLLogoutResponseSignature(
            {
              logoutResponse,
              spConfig: idp(),
              binding: 'redirect',
              xml: '<x/>',
              redirectSignature,
            },
            { verifyRedirectBindingSignature: async () => true }
          )
        );
        expect(error.failureKind).toBe('logout_response_incomplete_redirect_signature');
        expect(error.message).toBe('Incomplete HTTP-Redirect LogoutResponse signature parameters');
      }
    });

    it('should pass the accepted algorithms to the verifier only under the explicit legacy opt-in', async () => {
      const verify = vi.fn(async () => true);
      const legacy = idp({
        authnRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
        acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
      });
      await validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: legacy,
          binding: 'redirect',
          xml: '<x/>',
          redirectSignature: redirect({ sigAlg: SIGNATURE_ALGORITHMS.RSA_SHA1 }),
        },
        { verifyRedirectBindingSignature: verify }
      );
      expect(verify).toHaveBeenCalledWith(
        'SAMLResponse',
        'msg',
        'rs',
        'sig',
        SIGNATURE_ALGORITHMS.RSA_SHA1,
        'cert-a',
        {
          acceptedSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
        }
      );

      verify.mockClear();
      await validateSAMLLogoutResponseSignature(
        {
          logoutResponse,
          spConfig: idp(),
          binding: 'redirect',
          xml: '<x/>',
          redirectSignature: redirect(),
        },
        { verifyRedirectBindingSignature: verify }
      );
      expect(verify).toHaveBeenCalledWith(
        'SAMLResponse',
        'msg',
        'rs',
        'sig',
        SIGNATURE_ALGORITHMS.RSA_SHA256,
        'cert-a'
      );
      expect(verify.mock.calls[0]).toHaveLength(6);
    });

    it('should try every certificate and report the last cause on failure', async () => {
      const verify = vi.fn(async (...args: unknown[]) => {
        if (args[5] === 'cert-b') throw new Error('bad b');
        return false;
      });
      const error = await failure(
        validateSAMLLogoutResponseSignature(
          {
            logoutResponse,
            spConfig: idp({ certificates: ['cert-b'] }),
            binding: 'redirect',
            xml: '<x/>',
            redirectSignature: redirect(),
          },
          { verifyRedirectBindingSignature: verify }
        )
      );
      expect(verify.mock.calls.map((c) => c[5])).toEqual(['cert-a', 'cert-b']);
      expect(error.failureKind).toBe('logout_response_invalid_signature');
      expect(error.message).toBe('Invalid HTTP-Redirect LogoutResponse signature');
      expect(error.details).toEqual({ cause: 'bad b' });
    });

    it('should succeed with a rollover certificate and return no references', async () => {
      const verify = vi.fn(async (...args: unknown[]) => args[5] === 'cert-b');
      await expect(
        validateSAMLLogoutResponseSignature(
          {
            logoutResponse,
            spConfig: idp({ certificates: ['cert-b'] }),
            binding: 'redirect',
            xml: '<x/>',
            redirectSignature: redirect(),
          },
          { verifyRedirectBindingSignature: verify }
        )
      ).resolves.toBeUndefined();
    });
  });
});
