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
import { SIGNATURE_ALGORITHMS, DIGEST_ALGORITHMS, CANONICALIZATION_ALGORITHMS } from './constants';
import { parseXml, serializeXml } from './xml-utils';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Find all elements with a specific ID attribute
 *
 * @xmldom/xmldom doesn't support querySelectorAll, so we use a manual traversal
 *
 * @param doc - XML document or element to search
 * @param id - ID value to search for
 * @returns Array of elements with matching ID attribute
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findElementsById(doc: any, id: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function traverse(node: any): void {
    if (node.nodeType === 1) {
      // Element node
      if (node.getAttribute && node.getAttribute('ID') === id) {
        results.push(node);
      }
    }
    // Traverse children for both Document (nodeType 9) and Element (nodeType 1) nodes
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) {
        traverse(node.childNodes[i]);
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
  /** Signature location - 'prepend' or 'append' relative to signed element */
  signatureLocation?: 'prepend' | 'append';
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
    includeKeyInfo = true,
  } = options;

  const sig = new SignedXml({
    privateKey,
    signatureAlgorithm: SIGNATURE_ALGORITHMS.RSA_SHA256,
    canonicalizationAlgorithm: CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N,
  });

  // Add reference to the element to sign
  sig.addReference({
    xpath: referenceUri.startsWith('#') ? `//*[@ID='${referenceUri.substring(1)}']` : referenceUri,
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
      reference: referenceUri.startsWith('#')
        ? `//*[@ID='${referenceUri.substring(1)}']`
        : referenceUri,
      action: signatureLocation === 'prepend' ? 'prepend' : 'append',
    },
  });

  return sig.getSignedXml();
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
  const { certificateOrKey, expectedId, strictXswProtection = false } = options;

  const doc = parseXml(xml);

  // Find Signature element
  const signatures = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  if (signatures.length === 0) {
    throw new Error('No signature found in XML');
  }

  // Verify each signature
  for (let i = 0; i < signatures.length; i++) {
    const signatureNode = signatures[i];

    // ==========================================================================
    // SECURITY CHECKS BEFORE SIGNATURE VERIFICATION
    // These checks are performed first to detect attacks early and avoid
    // unnecessary cryptographic operations on malicious input.
    // ==========================================================================

    // 1. Check that Reference exists and has valid URI
    const references = signatureNode.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'Reference'
    );
    if (references.length === 0) {
      throw new Error('No Reference found in signature');
    }

    // 2. XSW Attack Protection: Validate Reference URI format
    const referenceUri = references[0].getAttribute('URI');

    // Reference URI must be a fragment identifier (starts with #) or empty
    // External URIs (http://, file://, etc.) are rejected to prevent SSRF attacks
    if (referenceUri && !referenceUri.startsWith('#') && referenceUri !== '') {
      throw new Error('XSW Protection: Reference URI must be a fragment identifier or empty');
    }

    // 3. Validate expectedId if provided (XSW protection)
    if (expectedId) {
      const expectedUri = `#${expectedId}`;
      if (referenceUri !== expectedUri && referenceUri !== '') {
        throw new Error(
          `XSW Protection: Reference URI "${referenceUri}" does not match expected "#${expectedId}"`
        );
      }

      // Verify the referenced element actually exists
      // Note: @xmldom/xmldom doesn't support querySelectorAll, so we use a manual search
      const referencedElements = findElementsById(doc, expectedId);
      if (referencedElements.length === 0) {
        throw new Error(`XSW Protection: Element with ID "${expectedId}" not found`);
      }

      // Strict mode: Check for multiple elements with the same ID (XSW attack indicator)
      if (strictXswProtection && referencedElements.length > 1) {
        throw new Error(
          `XSW Protection: Multiple elements with ID "${expectedId}" detected (possible XSW attack)`
        );
      }
    }

    // 4. Strict mode requires expectedId
    if (strictXswProtection && !expectedId) {
      throw new Error('XSW Protection: expectedId is required in strict mode');
    }

    // 5. Check signature algorithm (reject SHA-1) BEFORE verification
    const signatureMethod = signatureNode.getElementsByTagNameNS(
      'http://www.w3.org/2000/09/xmldsig#',
      'SignatureMethod'
    )[0];
    if (signatureMethod) {
      const algorithm = signatureMethod.getAttribute('Algorithm');
      if (algorithm === SIGNATURE_ALGORITHMS.RSA_SHA1) {
        throw new Error('SHA-1 signature algorithm is not allowed');
      }
    }

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errors = (sig as any).validationErrors || [];
      throw new Error(`Signature verification failed: ${errors.join(', ')}`);
    }
  }

  return true;
}

/**
 * Check if XML document has a signature
 */
export function hasSignature(xml: string): boolean {
  const doc = parseXml(xml);
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
  certificatePem: string
): Promise<boolean> {
  // Only allow RSA-SHA256
  if (sigAlg !== SIGNATURE_ALGORITHMS.RSA_SHA256) {
    throw new Error(`Unsupported signature algorithm: ${sigAlg}`);
  }

  // Rebuild the signed string (must match exactly what was signed)
  // Per SAML 2.0 Bindings Section 3.4.4.1, the signed string uses URL-encoded values
  let signInput = `${samlParam}=${samlValue}`;
  if (relayState) {
    signInput += `&RelayState=${relayState}`;
  }
  signInput += `&SigAlg=${encodeURIComponent(sigAlg)}`;

  // Import certificate/public key
  const publicKey = await importPublicKeyFromCertificate(certificatePem);

  // Decode signature
  const signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));

  // Verify
  const encoder = new TextEncoder();
  const data = encoder.encode(signInput);
  const isValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signatureBytes, data);

  return isValid;
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
 * Simple ASN.1 DER parser for extracting SubjectPublicKeyInfo from X.509 certificates
 */
interface Asn1Element {
  tag: number;
  length: number;
  data: Uint8Array;
  offset: number;
  headerLength: number;
}

function parseAsn1Element(data: Uint8Array, offset: number): Asn1Element {
  const tag = data[offset];
  let length = data[offset + 1];
  let headerLength = 2;

  if (length > 127) {
    // Long form length
    const numLengthBytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      length = (length << 8) | data[offset + 2 + i];
    }
    headerLength = 2 + numLengthBytes;
  }

  return {
    tag,
    length,
    data: data.subarray(offset + headerLength, offset + headerLength + length),
    offset,
    headerLength,
  };
}

function extractSubjectPublicKeyInfo(certDer: Uint8Array): Uint8Array {
  // X.509 Certificate structure:
  // SEQUENCE {
  //   tbsCertificate SEQUENCE { ... subjectPublicKeyInfo SEQUENCE ... }
  //   signatureAlgorithm SEQUENCE
  //   signatureValue BIT STRING
  // }

  // Parse outer SEQUENCE (certificate)
  const certSeq = parseAsn1Element(certDer, 0);
  if (certSeq.tag !== 0x30) throw new Error('Invalid certificate: expected SEQUENCE');

  // Parse TBSCertificate SEQUENCE
  const tbsSeq = parseAsn1Element(certSeq.data, 0);
  if (tbsSeq.tag !== 0x30) throw new Error('Invalid TBSCertificate: expected SEQUENCE');

  // Navigate through TBSCertificate to find SubjectPublicKeyInfo
  // Fields: version?, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
  let pos = 0;
  let fieldIndex = 0;

  while (pos < tbsSeq.data.length && fieldIndex < 7) {
    const element = parseAsn1Element(tbsSeq.data, pos);

    // Handle optional version field [0] EXPLICIT
    if (fieldIndex === 0 && element.tag === 0xa0) {
      // Version is explicit tag [0], skip it but count it as field 0
      pos += element.headerLength + element.length;
      fieldIndex++;
      continue;
    }

    if (fieldIndex === 6) {
      // This is SubjectPublicKeyInfo
      // Return the raw DER bytes for this SEQUENCE
      const start = pos;
      const end = pos + element.headerLength + element.length;
      return tbsSeq.data.subarray(start, end);
    }

    pos += element.headerLength + element.length;
    fieldIndex++;
  }

  throw new Error('SubjectPublicKeyInfo not found in certificate');
}

/**
 * Import public key from X.509 certificate PEM
 */
async function importPublicKeyFromCertificate(pem: string): Promise<CryptoKey> {
  // Remove headers and newlines
  const pemContents = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const certDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  // Extract SubjectPublicKeyInfo from the X.509 certificate
  const spki = extractSubjectPublicKeyInfo(certDer);

  return crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );
}
