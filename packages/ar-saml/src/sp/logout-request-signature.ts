import type { SAMLBinding, SAMLIdPConfig } from '@authrim/ar-lib-core';
import type { ParsedLogoutRequest } from '../common/slo-messages';
import {
  hasSignature,
  verifyRedirectBindingSignature,
  verifyXmlSignature,
} from '../common/signature';
import { DIGEST_ALGORITHMS, SAML_NAMESPACES, SIGNATURE_ALGORITHMS } from '../common/constants';
import { getAttribute, parseXml } from '../common/xml-utils';
import type { SAMLRedirectSignatureInput } from '../idp/authn-request-signature';

export interface SAMLIdPLogoutRequestSignatureValidationInput {
  logoutRequest: ParsedLogoutRequest;
  idpConfig: SAMLIdPConfig;
  binding: SAMLBinding;
  xml: string;
  redirectSignature?: SAMLRedirectSignatureInput;
}

export interface SAMLIdPLogoutRequestSignatureVerifiers {
  hasSignature?: (xml: string) => boolean;
  verifyXmlSignature?: typeof verifyXmlSignature;
  verifyRedirectBindingSignature?: typeof verifyRedirectBindingSignature;
}

export type SAMLIdPLogoutRequestSignatureFailureKind =
  | 'idp_logout_request_signature_required'
  | 'idp_logout_request_certificate_missing'
  | 'idp_logout_request_unsupported_signature_algorithm'
  | 'idp_logout_request_unsupported_digest_algorithm'
  | 'idp_logout_request_incomplete_redirect_signature'
  | 'idp_logout_request_invalid_signature';

export class SAMLIdPLogoutRequestSignatureValidationError extends Error {
  constructor(
    readonly failureKind: SAMLIdPLogoutRequestSignatureFailureKind,
    message: string,
    readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'SAMLIdPLogoutRequestSignatureValidationError';
  }
}

export async function validateSAMLIdPLogoutRequestSignature(
  input: SAMLIdPLogoutRequestSignatureValidationInput,
  verifiers: SAMLIdPLogoutRequestSignatureVerifiers = {}
): Promise<void> {
  const policy = resolveLogoutRequestSignaturePolicy(input.idpConfig);

  if (policy === 'disabled') {
    return;
  }

  const requestIsSigned = isLogoutRequestSigned(input, verifiers.hasSignature ?? hasSignature);
  if (!requestIsSigned) {
    if (policy === 'required') {
      throw new SAMLIdPLogoutRequestSignatureValidationError(
        'idp_logout_request_signature_required',
        'Signed IdP LogoutRequest is required'
      );
    }
    return;
  }

  const certificates = getIdPVerificationCertificates(input.idpConfig);
  if (certificates.length === 0) {
    throw new SAMLIdPLogoutRequestSignatureValidationError(
      'idp_logout_request_certificate_missing',
      'IdP certificate is required to verify signed LogoutRequest'
    );
  }

  if (input.binding === 'redirect') {
    validateRedirectSignatureAlgorithm(input.redirectSignature?.sigAlg, input.idpConfig);
    await verifyRedirectLogoutRequestSignature(
      input,
      certificates,
      verifiers.verifyRedirectBindingSignature ?? verifyRedirectBindingSignature
    );
    return;
  }

  validateXmlSignatureAlgorithms(input.xml, input.idpConfig);

  const verifier = verifiers.verifyXmlSignature ?? verifyXmlSignature;
  let lastError: unknown;
  for (const certificate of certificates) {
    try {
      if (
        verifier(input.xml, {
          certificateOrKey: certificate,
          expectedId: input.logoutRequest.id,
          strictXswProtection: true,
          ...(shouldAllowSha1XmlSignature(input.idpConfig)
            ? { allowSha1SignatureAlgorithm: true }
            : {}),
          ...(shouldAllowSha1XmlDigest(input.idpConfig) ? { allowSha1DigestAlgorithm: true } : {}),
        })
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new SAMLIdPLogoutRequestSignatureValidationError(
    'idp_logout_request_invalid_signature',
    'Invalid IdP LogoutRequest XML signature',
    getSignatureFailureDetails(lastError)
  );
}

function resolveLogoutRequestSignaturePolicy(
  idpConfig: SAMLIdPConfig
): NonNullable<SAMLIdPConfig['logoutRequestSignaturePolicy']> {
  return idpConfig.logoutRequestSignaturePolicy ?? 'required';
}

function validateRedirectSignatureAlgorithm(
  sigAlg: string | undefined,
  idpConfig: SAMLIdPConfig
): void {
  if (!sigAlg) {
    return;
  }

  const allowedAlgorithms = getAcceptedSignatureAlgorithms(idpConfig);
  if (!allowedAlgorithms.includes(sigAlg)) {
    throw new SAMLIdPLogoutRequestSignatureValidationError(
      'idp_logout_request_unsupported_signature_algorithm',
      `Unsupported IdP LogoutRequest signature algorithm: ${sigAlg}`,
      { algorithm: sigAlg }
    );
  }
}

function validateXmlSignatureAlgorithms(xml: string, idpConfig: SAMLIdPConfig): void {
  const doc = parseXml(xml);
  const allowedSignatureAlgorithms = getAcceptedSignatureAlgorithms(idpConfig);
  const allowedDigestAlgorithms = getAcceptedDigestAlgorithms(idpConfig);

  const signatureMethods = doc.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'SignatureMethod');
  for (let i = 0; i < signatureMethods.length; i++) {
    const algorithm = getAttribute(signatureMethods[i], 'Algorithm');
    if (algorithm && !allowedSignatureAlgorithms.includes(algorithm)) {
      throw new SAMLIdPLogoutRequestSignatureValidationError(
        'idp_logout_request_unsupported_signature_algorithm',
        `Unsupported IdP LogoutRequest signature algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }

  const digestMethods = doc.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'DigestMethod');
  for (let i = 0; i < digestMethods.length; i++) {
    const algorithm = getAttribute(digestMethods[i], 'Algorithm');
    if (algorithm && !allowedDigestAlgorithms.includes(algorithm)) {
      throw new SAMLIdPLogoutRequestSignatureValidationError(
        'idp_logout_request_unsupported_digest_algorithm',
        `Unsupported IdP LogoutRequest digest algorithm: ${algorithm}`,
        { algorithm }
      );
    }
  }
}

function isLogoutRequestSigned(
  input: SAMLIdPLogoutRequestSignatureValidationInput,
  xmlHasSignature: (xml: string) => boolean
): boolean {
  if (input.binding === 'redirect') {
    const redirectSignature = input.redirectSignature;
    return Boolean(redirectSignature?.signature || redirectSignature?.sigAlg);
  }

  return xmlHasSignature(input.xml);
}

async function verifyRedirectLogoutRequestSignature(
  input: SAMLIdPLogoutRequestSignatureValidationInput,
  certificates: string[],
  verifier: typeof verifyRedirectBindingSignature
): Promise<void> {
  const redirectSignature = input.redirectSignature;

  if (
    !redirectSignature?.samlMessage ||
    !redirectSignature.signature ||
    !redirectSignature.sigAlg
  ) {
    throw new SAMLIdPLogoutRequestSignatureValidationError(
      'idp_logout_request_incomplete_redirect_signature',
      'Incomplete HTTP-Redirect IdP LogoutRequest signature parameters'
    );
  }

  const acceptedSignatureAlgorithms =
    input.idpConfig.logoutRequestLegacyAlgorithmPolicy === 'explicit_opt_in'
      ? input.idpConfig.acceptedLogoutRequestSignatureAlgorithms
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

  throw new SAMLIdPLogoutRequestSignatureValidationError(
    'idp_logout_request_invalid_signature',
    'Invalid HTTP-Redirect IdP LogoutRequest signature',
    getSignatureFailureDetails(lastError)
  );
}

function getIdPVerificationCertificates(idpConfig: SAMLIdPConfig): string[] {
  return Array.from(
    new Set([idpConfig.certificate, ...(idpConfig.certificates ?? [])].filter(isString))
  );
}

function getAcceptedSignatureAlgorithms(idpConfig: SAMLIdPConfig): string[] {
  return idpConfig.acceptedLogoutRequestSignatureAlgorithms ?? [SIGNATURE_ALGORITHMS.RSA_SHA256];
}

function getAcceptedDigestAlgorithms(idpConfig: SAMLIdPConfig): string[] {
  return idpConfig.acceptedLogoutRequestDigestAlgorithms ?? [DIGEST_ALGORITHMS.SHA256];
}

function shouldAllowSha1XmlSignature(idpConfig: SAMLIdPConfig): boolean {
  return (
    idpConfig.logoutRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
    (idpConfig.acceptedLogoutRequestSignatureAlgorithms ?? []).includes(
      SIGNATURE_ALGORITHMS.RSA_SHA1
    )
  );
}

function shouldAllowSha1XmlDigest(idpConfig: SAMLIdPConfig): boolean {
  return (
    idpConfig.logoutRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
    (idpConfig.acceptedLogoutRequestDigestAlgorithms ?? []).includes(DIGEST_ALGORITHMS.SHA1)
  );
}

function getSignatureFailureDetails(error: unknown): Record<string, string> {
  return error instanceof Error ? { cause: error.message } : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
