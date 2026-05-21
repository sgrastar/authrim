import type { SAMLAuthnRequest, SAMLBinding, SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  hasSignature,
  verifyRedirectBindingSignature,
  verifyXmlSignature,
} from '../common/signature';
import { DIGEST_ALGORITHMS, SAML_NAMESPACES, SIGNATURE_ALGORITHMS } from '../common/constants';
import { getAttribute, parseXml } from '../common/xml-utils';

export const DEFAULT_AUTHN_REQUEST_SIGNATURE_ALGORITHMS = [SIGNATURE_ALGORITHMS.RSA_SHA256];
export const DEFAULT_AUTHN_REQUEST_DIGEST_ALGORITHMS = [DIGEST_ALGORITHMS.SHA256];

export interface SAMLRedirectSignatureInput {
  samlMessage: string;
  relayState?: string;
  signature?: string;
  sigAlg?: string;
}

export interface SAMLAuthnRequestSignatureValidationInput {
  authnRequest: SAMLAuthnRequest;
  spConfig: SAMLSPConfig;
  binding: SAMLBinding;
  xml: string;
  redirectSignature?: SAMLRedirectSignatureInput;
}

export interface SAMLAuthnRequestSignatureVerifiers {
  hasSignature?: (xml: string) => boolean;
  verifyXmlSignature?: typeof verifyXmlSignature;
  verifyRedirectBindingSignature?: typeof verifyRedirectBindingSignature;
}

export type SAMLAuthnRequestSignatureFailureKind =
  | 'authn_request_signature_required'
  | 'authn_request_certificate_missing'
  | 'authn_request_unsupported_signature_algorithm'
  | 'authn_request_unsupported_digest_algorithm'
  | 'authn_request_incomplete_redirect_signature'
  | 'authn_request_invalid_signature';

export class SAMLAuthnRequestSignatureValidationError extends Error {
  constructor(
    readonly failureKind: SAMLAuthnRequestSignatureFailureKind,
    message: string,
    readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'SAMLAuthnRequestSignatureValidationError';
  }
}

export async function validateSAMLAuthnRequestSignature(
  input: SAMLAuthnRequestSignatureValidationInput,
  verifiers: SAMLAuthnRequestSignatureVerifiers = {}
): Promise<void> {
  const policy = input.spConfig.authnRequestSignaturePolicy ?? 'optional';

  if (policy === 'disabled') {
    return;
  }

  const requestIsSigned = isAuthnRequestSigned(input, verifiers.hasSignature ?? hasSignature);

  if (!requestIsSigned) {
    if (policy === 'required') {
      throw new SAMLAuthnRequestSignatureValidationError(
        'authn_request_signature_required',
        'Signed AuthnRequest is required for this Service Provider'
      );
    }
    return;
  }

  const certificates = getSPVerificationCertificates(input.spConfig);
  if (certificates.length === 0) {
    throw new SAMLAuthnRequestSignatureValidationError(
      'authn_request_certificate_missing',
      'SP certificate is required to verify signed AuthnRequest'
    );
  }

  if (input.binding === 'redirect') {
    validateRedirectSignatureAlgorithm(input.redirectSignature?.sigAlg, input.spConfig);
    await verifyRedirectAuthnRequestSignature(
      input,
      certificates,
      verifiers.verifyRedirectBindingSignature ?? verifyRedirectBindingSignature
    );
    return;
  }

  validateXmlSignatureAlgorithms(input.xml, input.spConfig);

  const allowSha1SignatureAlgorithm =
    input.spConfig.authnRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
    (input.spConfig.acceptedAuthnRequestSignatureAlgorithms ?? []).includes(
      SIGNATURE_ALGORITHMS.RSA_SHA1
    );
  const allowSha1DigestAlgorithm =
    input.spConfig.authnRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
    (input.spConfig.acceptedAuthnRequestDigestAlgorithms ?? []).includes(DIGEST_ALGORITHMS.SHA1);
  const verifier = verifiers.verifyXmlSignature ?? verifyXmlSignature;
  let lastError: unknown;
  for (const certificate of certificates) {
    const verifyOptions: Parameters<typeof verifyXmlSignature>[1] = {
      certificateOrKey: certificate,
      expectedId: input.authnRequest.id,
      strictXswProtection: true,
    };
    if (allowSha1SignatureAlgorithm) {
      verifyOptions.allowSha1SignatureAlgorithm = true;
    }
    if (allowSha1DigestAlgorithm) {
      verifyOptions.allowSha1DigestAlgorithm = true;
    }

    try {
      if (verifier(input.xml, verifyOptions)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new SAMLAuthnRequestSignatureValidationError(
    'authn_request_invalid_signature',
    'Invalid AuthnRequest XML signature',
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
    throw new SAMLAuthnRequestSignatureValidationError(
      'authn_request_unsupported_signature_algorithm',
      `Unsupported AuthnRequest signature algorithm: ${sigAlg}`,
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
      throw new SAMLAuthnRequestSignatureValidationError(
        'authn_request_unsupported_signature_algorithm',
        `Unsupported AuthnRequest signature algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }

  const digestMethods = doc.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'DigestMethod');
  for (let i = 0; i < digestMethods.length; i++) {
    const algorithm = getAttribute(digestMethods[i], 'Algorithm');
    if (algorithm && !allowedDigestAlgorithms.includes(algorithm)) {
      throw new SAMLAuthnRequestSignatureValidationError(
        'authn_request_unsupported_digest_algorithm',
        `Unsupported AuthnRequest digest algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }
}

function isAuthnRequestSigned(
  input: SAMLAuthnRequestSignatureValidationInput,
  xmlHasSignature: (xml: string) => boolean
): boolean {
  if (input.binding === 'redirect') {
    const redirectSignature = input.redirectSignature;
    return Boolean(redirectSignature?.signature || redirectSignature?.sigAlg);
  }

  return xmlHasSignature(input.xml);
}

async function verifyRedirectAuthnRequestSignature(
  input: SAMLAuthnRequestSignatureValidationInput,
  certificates: string[],
  verifier: typeof verifyRedirectBindingSignature
): Promise<void> {
  const redirectSignature = input.redirectSignature;

  if (
    !redirectSignature?.samlMessage ||
    !redirectSignature.signature ||
    !redirectSignature.sigAlg
  ) {
    throw new SAMLAuthnRequestSignatureValidationError(
      'authn_request_incomplete_redirect_signature',
      'Incomplete HTTP-Redirect AuthnRequest signature parameters'
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

  throw new SAMLAuthnRequestSignatureValidationError(
    'authn_request_invalid_signature',
    'Invalid HTTP-Redirect AuthnRequest signature',
    getSignatureFailureDetails(lastError)
  );
}

function getSPVerificationCertificates(spConfig: SAMLSPConfig): string[] {
  return Array.from(
    new Set([spConfig.certificate, ...(spConfig.certificates ?? [])].filter(isString))
  );
}

function getSignatureFailureDetails(error: unknown): Record<string, string> {
  return error instanceof Error ? { cause: error.message } : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
