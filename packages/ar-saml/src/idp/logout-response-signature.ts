import type { SAMLBinding, SAMLSPConfig } from '@authrim/ar-lib-core';
import type { ParsedLogoutResponse } from '../common/slo-messages';
import {
  hasSignature,
  verifyRedirectBindingSignature,
  verifyXmlSignature,
} from '../common/signature';
import { DIGEST_ALGORITHMS, SAML_NAMESPACES, SIGNATURE_ALGORITHMS } from '../common/constants';
import { getAttribute, parseXml } from '../common/xml-utils';
import {
  DEFAULT_AUTHN_REQUEST_DIGEST_ALGORITHMS,
  DEFAULT_AUTHN_REQUEST_SIGNATURE_ALGORITHMS,
  type SAMLRedirectSignatureInput,
} from './authn-request-signature';

export interface SAMLLogoutResponseSignatureValidationInput {
  logoutResponse: ParsedLogoutResponse;
  spConfig: SAMLSPConfig;
  binding: SAMLBinding;
  xml: string;
  redirectSignature?: SAMLRedirectSignatureInput;
}

export interface SAMLLogoutResponseSignatureVerifiers {
  hasSignature?: (xml: string) => boolean;
  verifyXmlSignature?: typeof verifyXmlSignature;
  verifyRedirectBindingSignature?: typeof verifyRedirectBindingSignature;
}

export type SAMLLogoutResponseSignatureFailureKind =
  | 'logout_response_signature_required'
  | 'logout_response_certificate_missing'
  | 'logout_response_unsupported_signature_algorithm'
  | 'logout_response_unsupported_digest_algorithm'
  | 'logout_response_incomplete_redirect_signature'
  | 'logout_response_invalid_signature';

export class SAMLLogoutResponseSignatureValidationError extends Error {
  constructor(
    readonly failureKind: SAMLLogoutResponseSignatureFailureKind,
    message: string,
    readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'SAMLLogoutResponseSignatureValidationError';
  }
}

export async function validateSAMLLogoutResponseSignature(
  input: SAMLLogoutResponseSignatureValidationInput,
  verifiers: SAMLLogoutResponseSignatureVerifiers = {}
): Promise<void> {
  const policy = input.spConfig.logoutResponseSignaturePolicy ?? 'optional';

  if (policy === 'disabled') {
    return;
  }

  const responseIsSigned = isLogoutResponseSigned(input, verifiers.hasSignature ?? hasSignature);
  if (!responseIsSigned) {
    if (policy === 'required') {
      throw new SAMLLogoutResponseSignatureValidationError(
        'logout_response_signature_required',
        'Signed LogoutResponse is required for this Service Provider'
      );
    }
    return;
  }

  const certificates = getSPVerificationCertificates(input.spConfig);
  if (certificates.length === 0) {
    throw new SAMLLogoutResponseSignatureValidationError(
      'logout_response_certificate_missing',
      'SP certificate is required to verify signed LogoutResponse'
    );
  }

  if (input.binding === 'redirect') {
    validateRedirectSignatureAlgorithm(input.redirectSignature?.sigAlg, input.spConfig);
    await verifyRedirectLogoutResponseSignature(
      input,
      certificates,
      verifiers.verifyRedirectBindingSignature ?? verifyRedirectBindingSignature
    );
    return;
  }

  validateXmlSignatureAlgorithms(input.xml, input.spConfig);

  const verifier = verifiers.verifyXmlSignature ?? verifyXmlSignature;
  let lastError: unknown;
  for (const certificate of certificates) {
    try {
      if (
        verifier(input.xml, {
          certificateOrKey: certificate,
          expectedId: input.logoutResponse.id,
          strictXswProtection: true,
          ...(shouldAllowSha1XmlSignature(input.spConfig)
            ? { allowSha1SignatureAlgorithm: true }
            : {}),
        })
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new SAMLLogoutResponseSignatureValidationError(
    'logout_response_invalid_signature',
    'Invalid LogoutResponse XML signature',
    getSignatureFailureDetails(lastError)
  );
}

function validateRedirectSignatureAlgorithm(
  sigAlg: string | undefined,
  spConfig: SAMLSPConfig
): void {
  if (!sigAlg) {
    return;
  }

  const allowedAlgorithms =
    spConfig.acceptedAuthnRequestSignatureAlgorithms ?? DEFAULT_AUTHN_REQUEST_SIGNATURE_ALGORITHMS;
  if (!allowedAlgorithms.includes(sigAlg)) {
    throw new SAMLLogoutResponseSignatureValidationError(
      'logout_response_unsupported_signature_algorithm',
      `Unsupported LogoutResponse signature algorithm: ${sigAlg}`,
      { algorithm: sigAlg }
    );
  }
}

function validateXmlSignatureAlgorithms(xml: string, spConfig: SAMLSPConfig): void {
  const doc = parseXml(xml);
  const allowedSignatureAlgorithms =
    spConfig.acceptedAuthnRequestSignatureAlgorithms ?? DEFAULT_AUTHN_REQUEST_SIGNATURE_ALGORITHMS;
  const allowedDigestAlgorithms =
    spConfig.acceptedAuthnRequestDigestAlgorithms ?? DEFAULT_AUTHN_REQUEST_DIGEST_ALGORITHMS;

  const signatureMethods = doc.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'SignatureMethod');
  for (let i = 0; i < signatureMethods.length; i++) {
    const algorithm = getAttribute(signatureMethods[i], 'Algorithm');
    if (algorithm && !allowedSignatureAlgorithms.includes(algorithm)) {
      throw new SAMLLogoutResponseSignatureValidationError(
        'logout_response_unsupported_signature_algorithm',
        `Unsupported LogoutResponse signature algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }

  const digestMethods = doc.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'DigestMethod');
  for (let i = 0; i < digestMethods.length; i++) {
    const algorithm = getAttribute(digestMethods[i], 'Algorithm');
    if (algorithm && !allowedDigestAlgorithms.includes(algorithm)) {
      throw new SAMLLogoutResponseSignatureValidationError(
        'logout_response_unsupported_digest_algorithm',
        `Unsupported LogoutResponse digest algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }
}

function isLogoutResponseSigned(
  input: SAMLLogoutResponseSignatureValidationInput,
  xmlHasSignature: (xml: string) => boolean
): boolean {
  if (input.binding === 'redirect') {
    const redirectSignature = input.redirectSignature;
    return Boolean(redirectSignature?.signature || redirectSignature?.sigAlg);
  }

  return xmlHasSignature(input.xml);
}

async function verifyRedirectLogoutResponseSignature(
  input: SAMLLogoutResponseSignatureValidationInput,
  certificates: string[],
  verifier: typeof verifyRedirectBindingSignature
): Promise<void> {
  const redirectSignature = input.redirectSignature;

  if (
    !redirectSignature?.samlMessage ||
    !redirectSignature.signature ||
    !redirectSignature.sigAlg
  ) {
    throw new SAMLLogoutResponseSignatureValidationError(
      'logout_response_incomplete_redirect_signature',
      'Incomplete HTTP-Redirect LogoutResponse signature parameters'
    );
  }

  const acceptedSignatureAlgorithms =
    input.spConfig.authnRequestLegacyAlgorithmPolicy === 'explicit_opt_in'
      ? input.spConfig.acceptedAuthnRequestSignatureAlgorithms
      : undefined;

  let lastError: unknown;
  for (const certificate of certificates) {
    try {
      const verified = acceptedSignatureAlgorithms
        ? await verifier(
            'SAMLResponse',
            redirectSignature.samlMessage,
            redirectSignature.relayState,
            redirectSignature.signature,
            redirectSignature.sigAlg,
            certificate,
            { acceptedSignatureAlgorithms }
          )
        : await verifier(
            'SAMLResponse',
            redirectSignature.samlMessage,
            redirectSignature.relayState,
            redirectSignature.signature,
            redirectSignature.sigAlg,
            certificate
          );

      if (verified) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new SAMLLogoutResponseSignatureValidationError(
    'logout_response_invalid_signature',
    'Invalid HTTP-Redirect LogoutResponse signature',
    getSignatureFailureDetails(lastError)
  );
}

function getSPVerificationCertificates(spConfig: SAMLSPConfig): string[] {
  return Array.from(
    new Set([spConfig.certificate, ...(spConfig.certificates ?? [])].filter(isString))
  );
}

function shouldAllowSha1XmlSignature(spConfig: SAMLSPConfig): boolean {
  return (
    spConfig.authnRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
    (spConfig.acceptedAuthnRequestSignatureAlgorithms ?? []).includes(SIGNATURE_ALGORITHMS.RSA_SHA1)
  );
}

function getSignatureFailureDetails(error: unknown): Record<string, string> {
  return error instanceof Error ? { cause: error.message } : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
