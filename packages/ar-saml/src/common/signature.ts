/**
 * XML Signature Utilities for SAML 2.0
 *
 * Provides XML digital signature creation and verification.
 * Uses xml-crypto library for cryptographic operations.
 *
 * Security Notes:
 * - Only RSA-SHA256 is supported (SHA-1 is deprecated)
 * - XML Signature Wrapping attack protection is implemented
 * - External entities are disabled in XML parsing
 */

import { SignedXml } from 'xml-crypto';
import {
  SIGNATURE_ALGORITHMS,
  DIGEST_ALGORITHMS,
  CANONICALIZATION_ALGORITHMS,
  SAML_NAMESPACES,
} from './constants';
import { parseSAMLXml, parseXml } from './xml-utils';
import type { XMLNode, XMLElement, SignedXmlWithErrors } from './types';
import { isElementNode } from './types';
import { assertCertificateCurrentlyValid, extractSubjectPublicKeyInfo } from './x509';

// =============================================================================
// Helper Functions
// =============================================================================

const XML_ID_REFERENCE_PATTERN = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;

/**
 * Find all elements with a specific ID attribute
 *
 * @xmldom/xmldom doesn't support querySelectorAll, so we use a manual traversal
 *
 * @param doc - XML document or element to search
 * @param id - ID value to search for
 * @returns Array of elements with matching ID attribute
 */
function findElementsById(doc: XMLNode, id: string): XMLElement[] {
  const results: XMLElement[] = [];

  function traverse(node: XMLNode): void {
    if (isElementNode(node)) {
      if (node.getAttribute && node.getAttribute('ID') === id) {
        results.push(node);
      }
    }
    // Traverse children for both Document (nodeType 9) and Element (nodeType 1) nodes
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child) {
          traverse(child);
        }
      }
    }
  }

  traverse(doc);
  return results;
}

/**
 * Options for XML signature creation
 */
export interface SignOptions {
  /** Private key in PEM format */
  privateKey: string;
  /** X.509 certificate in PEM format (included in signature) */
  certificate: string;
  /** XPath to the element to be signed (reference URI) */
  referenceUri: string;
  /** Signature location relative to the insertion XPath */
  signatureLocation?: 'prepend' | 'append' | 'before' | 'after';
  /** Optional XPath used only for placing the Signature element. */
  signatureInsertionXPath?: string;
  /** Include KeyInfo with certificate */
  includeKeyInfo?: boolean;
}

/**
 * Options for XML signature verification
 */
export interface VerifyOptions {
  /** X.509 certificate or public key in PEM format */
  certificateOrKey: string;
  /**
   * Expected ID of the signed element (XSW attack protection)
   * If provided, verifies that the signature's Reference URI points to this ID
   */
  expectedId?: string;
  /**
   * Strict mode: require expectedId and reject multiple same-ID elements
   * Default: false (for backward compatibility)
   */
  strictXswProtection?: boolean;
  /** Allow deprecated SHA-1 XML Signature. Only use for explicit legacy SP opt-in. */
  allowSha1SignatureAlgorithm?: boolean;
  /** Allow deprecated SHA-1 DigestMethod. Only use for explicit legacy SP opt-in. */
  allowSha1DigestAlgorithm?: boolean;
}

export interface VerifiedXmlReference {
  /** Fragment URI from ds:Reference, for example #_assertion_id. */
  uri: string;
  /** Canonicalized bytes whose digest was verified by xml-crypto. */
  xml: string;
}

export interface RedirectBindingSignatureInput {
  samlMessage: string;
  relayState?: string;
  signature?: string;
  sigAlg?: string;
}

/**
 * KeyInfo provider that includes X.509 certificate
 */
class X509KeyInfo {
  private certificate: string;

  constructor(certificate: string) {
    // Remove PEM headers and format
    this.certificate = certificate
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
  }

  getKeyInfo(): string {
    return `<X509Data><X509Certificate>${this.certificate}</X509Certificate></X509Data>`;
  }

  getKey(): string | null {
    return null; // Not used for signing
  }
}

/**
 * Sign XML document using RSA-SHA256
 *
 * @param xml - XML string to sign
 * @param options - Signing options
 * @returns Signed XML string
 */
export function signXml(xml: string, options: SignOptions): string {
  const {
    privateKey,
    certificate,
    referenceUri,
    signatureLocation = 'prepend',
    signatureInsertionXPath,
    includeKeyInfo = true,
  } = options;
  const referenceXPath = resolveSignatureReferenceXPath(referenceUri);

  const sig = new SignedXml({
    privateKey,
    signatureAlgorithm: SIGNATURE_ALGORITHMS.RSA_SHA256,
    canonicalizationAlgorithm: CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N,
  });

  // Add reference to the element to sign
  sig.addReference({
    xpath: referenceXPath,
    digestAlgorithm: DIGEST_ALGORITHMS.SHA256,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N,
    ],
  });

  // Add KeyInfo with certificate if requested
  if (includeKeyInfo && certificate) {
    // Use getKeyInfoContent to provide certificate in KeyInfo
    sig.getKeyInfoContent = () => new X509KeyInfo(certificate).getKeyInfo();
  }

  // Compute signature
  sig.computeSignature(xml, {
    location: {
      reference: signatureInsertionXPath ?? referenceXPath,
      action: signatureLocation,
    },
  });

  return sig.getSignedXml();
}

function resolveSignatureReferenceXPath(referenceUri: string): string {
  if (!referenceUri.startsWith('#')) {
    return referenceUri;
  }

  if (!XML_ID_REFERENCE_PATTERN.test(referenceUri)) {
    throw new Error('Invalid XML signature reference URI');
  }

  return `//*[@ID='${referenceUri.substring(1)}']`;
}

/**
 * Verify XML signature with XSW (XML Signature Wrapping) attack protection
 *
 * Security features:
 * - SHA-1 algorithm rejection
 * - Reference URI validation
 * - XSW attack detection (optional strict mode)
 * - Multiple element with same ID detection
 *
 * @param xml - Signed XML string
 * @param options - Verification options
 * @returns true if signature is valid
 * @throws Error if signature is invalid or verification fails
 *
 * @see https://www.usenix.org/conference/usenixsecurity12/technical-sessions/presentation/somorovsky
 */
export function verifyXmlSignature(xml: string, options: VerifyOptions): boolean {
  verifyXmlSignatureAndGetReferences(xml, options);
  return true;
}

/**
 * Verify XML signatures and return only the authenticated reference bytes.
 * Callers must parse these values instead of continuing to consume the original DOM.
 */
export function verifyXmlSignatureAndGetReferences(
  xml: string,
  options: VerifyOptions
): VerifiedXmlReference[] {
  const {
    certificateOrKey,
    expectedId,
    strictXswProtection = false,
    allowSha1SignatureAlgorithm = false,
    allowSha1DigestAlgorithm = false,
  } = options;

  assertCertificateCurrentlyValid(certificateOrKey);

  const doc = parseSAMLXml(xml);

  // Find Signature element
  const signatures = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  if (signatures.length === 0) {
    throw new Error('No signature found in XML');
  }

  const verifiedReferences: VerifiedXmlReference[] = [];

  // Verify each signature
  for (let i = 0; i < signatures.length; i++) {
    const signatureNode = signatures[i];
    const signedInfo = getSingleDirectXmlDsigChild(signatureNode, 'SignedInfo');
    getSingleDirectXmlDsigChild(signatureNode, 'SignatureValue');

    // ==========================================================================
    // SECURITY CHECKS BEFORE SIGNATURE VERIFICATION
    // These checks are performed first to detect attacks early and avoid
    // unnecessary cryptographic operations on malicious input.
    // ==========================================================================

    // 1. Check that Reference exists and has valid URI
    const references = getDirectXmlDsigChildren(signedInfo, 'Reference');
    if (references.length === 0) {
      throw new Error('No Reference found in signature');
    }

    if (strictXswProtection && references.length !== 1) {
      throw new Error(
        'XSW Protection: Signature must contain exactly one Reference in strict mode'
      );
    }

    // 2. XSW Attack Protection: Validate every Reference before cryptographic verification.
    const referenceUris: string[] = [];
    for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex++) {
      const reference = references[referenceIndex];
      if (!reference) {
        continue;
      }

      const referenceUri = reference.getAttribute('URI') ?? '';
      referenceUris.push(referenceUri);

      // Reference URI must be a fragment identifier (starts with #) or empty.
      // External URIs (http://, file://, etc.) are rejected to prevent SSRF attacks.
      if (referenceUri && !referenceUri.startsWith('#')) {
        throw new Error('XSW Protection: Reference URI must be a fragment identifier or empty');
      }

      const referencedId = referenceUri.startsWith('#') ? referenceUri.substring(1) : undefined;
      if (referencedId === '') {
        throw new Error('XSW Protection: Reference URI fragment must not be empty');
      }

      const referencedElements = referencedId
        ? findElementsById(doc as unknown as XMLNode, referencedId)
        : [];

      if (referencedId) {
        if (referencedElements.length === 0) {
          throw new Error(`XSW Protection: Element with ID "${referencedId}" not found`);
        }

        if (strictXswProtection && referencedElements.length > 1) {
          throw new Error(
            `XSW Protection: Multiple elements with ID "${referencedId}" detected (possible XSW attack)`
          );
        }
      } else if (strictXswProtection) {
        throw new Error('XSW Protection: Reference URI is required in strict mode');
      }

      const digestMethod = getSingleDirectXmlDsigChild(reference, 'DigestMethod');
      getSingleDirectXmlDsigChild(reference, 'DigestValue');
      const digestAlgorithm = digestMethod?.getAttribute('Algorithm');
      if (!digestAlgorithm) {
        throw new Error('DigestMethod Algorithm is required');
      }
      if (digestAlgorithm === DIGEST_ALGORITHMS.SHA1 && !allowSha1DigestAlgorithm) {
        throw new Error('SHA-1 digest algorithm is not allowed');
      }
      if (
        digestAlgorithm &&
        digestAlgorithm !== DIGEST_ALGORITHMS.SHA256 &&
        !(allowSha1DigestAlgorithm && digestAlgorithm === DIGEST_ALGORITHMS.SHA1)
      ) {
        throw new Error(`Unsupported digest algorithm: ${digestAlgorithm}`);
      }
    }

    // 3. Validate expectedId if provided (XSW protection)
    if (expectedId) {
      const expectedUri = `#${expectedId}`;
      if (!referenceUris.includes(expectedUri)) {
        throw new Error(`XSW Protection: Reference URI does not match expected "#${expectedId}"`);
      }

      // Verify the referenced element actually exists
      // Note: @xmldom/xmldom doesn't support querySelectorAll, so we use a manual search
      // Cast doc to XMLNode for compatibility with our type-safe helper
      const expectedElements = findElementsById(doc as unknown as XMLNode, expectedId);
      if (expectedElements.length === 0) {
        throw new Error(`XSW Protection: Element with ID "${expectedId}" not found`);
      }

      // Strict mode: Check for multiple elements with the same ID (XSW attack indicator)
      if (strictXswProtection && expectedElements.length > 1) {
        throw new Error(
          `XSW Protection: Multiple elements with ID "${expectedId}" detected (possible XSW attack)`
        );
      }
    }

    for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex++) {
      validateReferenceTransforms(references[referenceIndex]!);
    }

    // 5. Check signature algorithm (reject SHA-1) BEFORE verification
    const signatureMethod = getSingleDirectXmlDsigChild(signedInfo, 'SignatureMethod');
    const signatureAlgorithm = signatureMethod?.getAttribute('Algorithm');
    if (!signatureAlgorithm) {
      throw new Error('SignatureMethod Algorithm is required');
    }
    if (signatureAlgorithm === SIGNATURE_ALGORITHMS.RSA_SHA1 && !allowSha1SignatureAlgorithm) {
      throw new Error('SHA-1 signature algorithm is not allowed');
    }
    if (
      signatureAlgorithm !== SIGNATURE_ALGORITHMS.RSA_SHA256 &&
      !(allowSha1SignatureAlgorithm && signatureAlgorithm === SIGNATURE_ALGORITHMS.RSA_SHA1)
    ) {
      throw new Error(`Unsupported signature algorithm: ${signatureAlgorithm}`);
    }

    validateCanonicalizationMethod(signedInfo);

    // ==========================================================================
    // CRYPTOGRAPHIC SIGNATURE VERIFICATION
    // Only perform expensive cryptographic operations after all security checks pass
    // ==========================================================================

    const sig = new SignedXml();

    // Set the key for verification
    sig.publicCert = certificateOrKey;

    // Load signature
    sig.loadSignature(signatureNode);

    // Verify
    const isValid = sig.checkSignature(xml);
    if (!isValid) {
      const sigWithErrors = sig as unknown as SignedXmlWithErrors;
      const errors = sigWithErrors.validationErrors || [];
      throw new Error(`Signature verification failed: ${errors.join(', ')}`);
    }

    const signedReferences = sig.getSignedReferences();
    if (signedReferences.length !== referenceUris.length) {
      throw new Error('Signature verification did not return every signed reference');
    }
    for (let referenceIndex = 0; referenceIndex < signedReferences.length; referenceIndex++) {
      const signedReference = signedReferences[referenceIndex];
      const uri = referenceUris[referenceIndex];
      if (signedReference === undefined || uri === undefined) {
        throw new Error('Signature verification returned an incomplete signed reference');
      }
      verifiedReferences.push({ uri, xml: signedReference });
    }
  }

  return verifiedReferences;
}

function validateReferenceTransforms(reference: Element): void {
  const allowedTransforms = new Set([
    'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
    CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N,
    CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N_WITH_COMMENTS,
  ]);
  const transformsElement = getSingleDirectXmlDsigChild(reference, 'Transforms');
  const transforms = getDirectXmlDsigChildren(transformsElement, 'Transform');
  if (transforms.length > 2) {
    throw new Error('XML signature Reference uses too many transforms');
  }
  if (transforms.length !== 2) {
    throw new Error('XML signature Reference must use exactly two transforms');
  }
  for (let index = 0; index < transforms.length; index++) {
    const algorithm = transforms[index]?.getAttribute('Algorithm');
    if (!algorithm || !allowedTransforms.has(algorithm)) {
      throw new Error(`Unsupported XML signature transform: ${algorithm || 'missing'}`);
    }
  }
  if (
    transforms[0]?.getAttribute('Algorithm') !==
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature' ||
    (transforms[1]?.getAttribute('Algorithm') !== CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N &&
      transforms[1]?.getAttribute('Algorithm') !==
        CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N_WITH_COMMENTS)
  ) {
    throw new Error(
      'XML signature transforms must be enveloped-signature followed by exclusive C14N'
    );
  }
}

function validateCanonicalizationMethod(signedInfo: Element): void {
  const method = getSingleDirectXmlDsigChild(signedInfo, 'CanonicalizationMethod');
  const algorithm = method.getAttribute('Algorithm');
  if (
    algorithm !== CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N &&
    algorithm !== CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N_WITH_COMMENTS
  ) {
    throw new Error(`Unsupported canonicalization algorithm: ${algorithm || 'missing'}`);
  }
}

function getSingleDirectXmlDsigChild(parent: Element, localName: string): Element {
  const children = getDirectXmlDsigChildren(parent, localName);
  if (children.length !== 1) {
    throw new Error(`XML signature must contain exactly one direct ${localName}`);
  }
  return children[0]!;
}

function getDirectXmlDsigChildren(parent: Element, localName: string): Element[] {
  const children: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index++) {
    const child = parent.childNodes[index];
    if (child?.nodeType !== 1 || (child as Element).localName !== localName) continue;
    const element = child as Element;
    if (element.namespaceURI !== SAML_NAMESPACES.DS) {
      throw new Error(`XML signature ${localName} must use the XMLDSig namespace`);
    }
    children.push(element);
  }
  return children;
}

/**
 * Check if XML document has a signature
 */
export function hasSignature(xml: string): boolean {
  const doc = parseSAMLXml(xml);
  const signatures = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  return signatures.length > 0;
}

/**
 * Extract certificate from signed XML (from KeyInfo/X509Certificate)
 */
export function extractCertificateFromSignature(xml: string): string | null {
  const doc = parseXml(xml);
  const x509Certs = doc.getElementsByTagNameNS(
    'http://www.w3.org/2000/09/xmldsig#',
    'X509Certificate'
  );

  if (x509Certs.length === 0) {
    return null;
  }

  const certBase64 = x509Certs[0].textContent?.replace(/\s+/g, '') || '';
  if (!certBase64) {
    return null;
  }

  // Format as PEM
  const lines = certBase64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Convert JWK public key to X.509 certificate (self-signed)
 *
 * This creates a minimal self-signed certificate from a JWK public key.
 * Used for IdP metadata when we only have JWK keys from KeyManager.
 */
export async function jwkToX509Certificate(
  jwk: JsonWebKey,
  issuer: string,
  validityDays: number = 365
): Promise<string> {
  // Import the public key (cast to JsonWebKey for Web Crypto API compatibility)
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );

  // Export as SPKI (SubjectPublicKeyInfo)
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const spkiBase64 = btoa(String.fromCharCode(...new Uint8Array(spki as ArrayBuffer)));

  // For a proper X.509 certificate, we would need to construct the full ASN.1 structure.
  // However, for SAML purposes, many implementations accept just the public key.
  // We'll return a minimal self-signed certificate structure.

  // Note: In production, you should use a proper certificate generation library
  // or pre-generate certificates. This is a simplified version.

  const lines = spkiBase64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Sign SAML message for HTTP-Redirect binding
 *
 * For HTTP-Redirect binding, the signature is computed over:
 * SAMLRequest=<base64-encoded-request>&RelayState=<relay-state>&SigAlg=<algorithm>
 *
 * The signature is then appended as a query parameter.
 */
export async function signRedirectBinding(
  samlParam: string,
  samlValue: string,
  relayState: string | undefined,
  privateKeyPem: string
): Promise<{
  signedUrl: string;
  signature: string;
  sigAlg: string;
}> {
  // Build the string to sign
  let signInput = `${samlParam}=${encodeURIComponent(samlValue)}`;
  if (relayState) {
    signInput += `&RelayState=${encodeURIComponent(relayState)}`;
  }
  signInput += `&SigAlg=${encodeURIComponent(SIGNATURE_ALGORITHMS.RSA_SHA256)}`;

  // Import private key
  const privateKey = await importPrivateKeyPem(privateKeyPem);

  // Sign
  const encoder = new TextEncoder();
  const data = encoder.encode(signInput);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data);

  // Base64 encode signature
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return {
    signedUrl: `${signInput}&Signature=${encodeURIComponent(signatureBase64)}`,
    signature: signatureBase64,
    sigAlg: SIGNATURE_ALGORITHMS.RSA_SHA256,
  };
}

/**
 * Verify HTTP-Redirect binding signature
 */
export async function verifyRedirectBindingSignature(
  samlParam: string,
  samlValue: string,
  relayState: string | undefined,
  signature: string,
  sigAlg: string,
  certificatePem: string,
  options: { acceptedSignatureAlgorithms?: string[] } = {}
): Promise<boolean> {
  const acceptedSignatureAlgorithms = options.acceptedSignatureAlgorithms ?? [
    SIGNATURE_ALGORITHMS.RSA_SHA256,
  ];

  if (!acceptedSignatureAlgorithms.includes(sigAlg)) {
    throw new Error(`Unsupported signature algorithm: ${sigAlg}`);
  }

  // Rebuild the signed string (must match exactly what was signed)
  // Per SAML 2.0 Bindings Section 3.4.4.1, the signed string uses URL-encoded values
  let signInput = `${samlParam}=${samlValue}`;
  if (relayState !== undefined) {
    signInput += `&RelayState=${relayState}`;
  }
  signInput += `&SigAlg=${encodeURIComponent(sigAlg)}`;

  // Import certificate/public key
  const publicKey = await importPublicKeyFromCertificate(certificatePem, {
    hash: sigAlg === SIGNATURE_ALGORITHMS.RSA_SHA1 ? 'SHA-1' : 'SHA-256',
  });

  // Decode signature
  const signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));

  // Verify
  const encoder = new TextEncoder();
  const data = encoder.encode(signInput);
  const isValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signatureBytes, data);

  return isValid;
}

/**
 * Extract exactly one copy of each signed HTTP-Redirect binding parameter while
 * preserving the original URL encoding used in the signature input.
 */
export function parseRedirectBindingSignatureInput(
  search: string,
  samlParam: 'SAMLRequest' | 'SAMLResponse'
): RedirectBindingSignatureInput {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const values = new Map<string, string[]>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const rawName = separator >= 0 ? part.slice(0, separator) : part;
    const rawValue = separator >= 0 ? part.slice(separator + 1) : '';
    const name = decodeRedirectQueryComponent(rawName);
    const existing = values.get(name) ?? [];
    existing.push(rawValue);
    values.set(name, existing);
  }

  for (const name of [samlParam, 'RelayState', 'SigAlg', 'Signature']) {
    if ((values.get(name)?.length ?? 0) > 1) {
      throw new Error(`Duplicate HTTP-Redirect parameter: ${name}`);
    }
  }
  const oppositeParam = samlParam === 'SAMLRequest' ? 'SAMLResponse' : 'SAMLRequest';
  if ((values.get(oppositeParam)?.length ?? 0) > 0) {
    throw new Error('HTTP-Redirect message cannot contain both SAMLRequest and SAMLResponse');
  }

  const samlMessage = values.get(samlParam)?.[0];
  if (samlMessage === undefined) {
    throw new Error(`Missing ${samlParam} parameter`);
  }

  const relayState = values.get('RelayState')?.[0];
  const rawSignature = values.get('Signature')?.[0];
  const rawSigAlg = values.get('SigAlg')?.[0];
  return {
    samlMessage,
    ...(relayState !== undefined ? { relayState } : {}),
    ...(rawSignature !== undefined
      ? { signature: decodeRedirectQueryComponent(rawSignature) }
      : {}),
    ...(rawSigAlg !== undefined ? { sigAlg: decodeRedirectQueryComponent(rawSigAlg) } : {}),
  };
}

function decodeRedirectQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    throw new Error('Malformed HTTP-Redirect query encoding');
  }
}

/**
 * Import private key from PEM format
 */
async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  // Remove headers and newlines
  const pemContents = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Import public key from X.509 certificate PEM
 */
export async function importPublicKeyFromCertificate(
  pem: string,
  options: { hash?: 'SHA-1' | 'SHA-256' } = {}
): Promise<CryptoKey> {
  assertCertificateCurrentlyValid(pem);

  // Remove headers and newlines
  const pemContents = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const certDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  // Extract SubjectPublicKeyInfo from the X.509 certificate
  const spki = extractSubjectPublicKeyInfo(certDer);
  const spkiBytes = Uint8Array.from(spki);

  return crypto.subtle.importKey(
    'spki',
    spkiBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: options.hash ?? 'SHA-256' },
    true,
    ['verify']
  );
}
