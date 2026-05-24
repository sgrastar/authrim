import type { ParsedLogoutRequest } from '../common/slo-messages';
import type { SAMLBinding, SAMLSPConfig } from '@authrim/ar-lib-core';
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

export interface SAMLLogoutRequestSignatureValidationInput {
  logoutRequest: ParsedLogoutRequest;
  spConfig: SAMLSPConfig;
  binding: SAMLBinding;
  xml: string;
  redirectSignature?: SAMLRedirectSignatureInput;
}

export interface SAMLLogoutRequestSignatureVerifiers {
  hasSignature?: (xml: string) => boolean;
  verifyXmlSignature?: typeof verifyXmlSignature;
  verifyRedirectBindingSignature?: typeof verifyRedirectBindingSignature;
}

export type SAMLLogoutRequestSignatureFailureKind =
  | 'logout_request_signature_required'
  | 'logout_request_certificate_missing'
  | 'logout_request_unsupported_signature_algorithm'
  | 'logout_request_unsupported_digest_algorithm'
  | 'logout_request_incomplete_redirect_signature'
  | 'logout_request_invalid_signature';

export class SAMLLogoutRequestSignatureValidationError extends Error {
  constructor(
    readonly failureKind: SAMLLogoutRequestSignatureFailureKind,
    message: string,
    readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'SAMLLogoutRequestSignatureValidationError';
  }
}

export async function validateSAMLLogoutRequestSignature(
  input: SAMLLogoutRequestSignatureValidationInput,
  verifiers: SAMLLogoutRequestSignatureVerifiers = {}
): Promise<void> {
  const policy = input.spConfig.logoutRequestSignaturePolicy ?? 'required';

  if (policy === 'disabled') {
    return;
  }

  const requestIsSigned = isLogoutRequestSigned(input, verifiers.hasSignature ?? hasSignature);
  if (!requestIsSigned) {
    if (policy === 'required') {
      throw new SAMLLogoutRequestSignatureValidationError(
        'logout_request_signature_required',
        'Signed LogoutRequest is required for this Service Provider'
      );
    }
    return;
  }

  const certificates = getSPVerificationCertificates(input.spConfig);
  if (certificates.length === 0) {
    throw new SAMLLogoutRequestSignatureValidationError(
      'logout_request_certificate_missing',
      'SP certificate is required to verify signed LogoutRequest'
    );
  }

  if (input.binding === 'redirect') {
    validateRedirectSignatureAlgorithm(input.redirectSignature?.sigAlg, input.spConfig);
    await verifyRedirectLogoutRequestSignature(
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
          expectedId: input.logoutRequest.id,
          strictXswProtection: true,
          ...(shouldAllowSha1XmlSignature(input.spConfig)
            ? { allowSha1SignatureAlgorithm: true }
            : {}),
          ...(shouldAllowSha1XmlDigest(input.spConfig) ? { allowSha1DigestAlgorithm: true } : {}),
        })
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new SAMLLogoutRequestSignatureValidationError(
    'logout_request_invalid_signature',
    'Invalid LogoutRequest XML signature',
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
    throw new SAMLLogoutRequestSignatureValidationError(
      'logout_request_unsupported_signature_algorithm',
      `Unsupported LogoutRequest signature algorithm: ${sigAlg}`,
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
      throw new SAMLLogoutRequestSignatureValidationError(
        'logout_request_unsupported_signature_algorithm',
        `Unsupported LogoutRequest signature algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }

  const digestMethods = doc.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'DigestMethod');
  for (let i = 0; i < digestMethods.length; i++) {
    const algorithm = getAttribute(digestMethods[i], 'Algorithm');
    if (algorithm && !allowedDigestAlgorithms.includes(algorithm)) {
      throw new SAMLLogoutRequestSignatureValidationError(
        'logout_request_unsupported_digest_algorithm',
        `Unsupported LogoutRequest digest algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }
}

function isLogoutRequestSigned(
  input: SAMLLogoutRequestSignatureValidationInput,
  xmlHasSignature: (xml: string) => boolean
): boolean {
  if (input.binding === 'redirect') {
    const redirectSignature = input.redirectSignature;
    return Boolean(redirectSignature?.signature || redirectSignature?.sigAlg);
  }

  return xmlHasSignature(input.xml);
}

async function verifyRedirectLogoutRequestSignature(
  input: SAMLLogoutRequestSignatureValidationInput,
  certificates: string[],
  verifier: typeof verifyRedirectBindingSignature
): Promise<void> {
  const redirectSignature = input.redirectSignature;

  if (
    !redirectSignature?.samlMessage ||
    !redirectSignature.signature ||
    !redirectSignature.sigAlg
  ) {
    throw new SAMLLogoutRequestSignatureValidationError(
      'logout_request_incomplete_redirect_signature',
      'Incomplete HTTP-Redirect LogoutRequest signature parameters'
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
            'SAMLRequest',
            redirectSignature.samlMessage,
            redirectSignature.relayState,
            redirectSignature.signature,
            redirectSignature.sigAlg,
            certificate,
            { acceptedSignatureAlgorithms }
          )
        : await verifier(
            'SAMLRequest',
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

  throw new SAMLLogoutRequestSignatureValidationError(
    'logout_request_invalid_signature',
    'Invalid HTTP-Redirect LogoutRequest signature',
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

function shouldAllowSha1XmlDigest(spConfig: SAMLSPConfig): boolean {
  return (
    spConfig.authnRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
    (spConfig.acceptedAuthnRequestDigestAlgorithms ?? []).includes(DIGEST_ALGORITHMS.SHA1)
  );
}

function getSignatureFailureDetails(error: unknown): Record<string, string> {
  return error instanceof Error ? { cause: error.message } : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
