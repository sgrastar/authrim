import { describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import {
  extractCertificateFromSignature,
  signXml,
  verifyXmlSignature,
  verifyXmlSignatureAndGetReferences,
} from '../signature';
import { CANONICALIZATION_ALGORITHMS, DIGEST_ALGORITHMS, SIGNATURE_ALGORITHMS } from '../constants';

// Test-only key material shared with signature-security.test.ts (CN=Test SAML IdP, valid until 2035).
const testPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC6GHFfTLe7OFyL
R7HdFE5ljqiUyCplJfyfJD0we+WnY7iZ77KnKjnXvZWUMNTC5PAzb9r6i8q7JD1n
c7NKofHSs8+QGtvwzTWLP4SWIcfGG9VV8qUY2xKNJ8TuOazbxg9SK5mmgyd0QwGh
gzIu0hvOKbcTZoKPc1IWyS82qU7xLJrABcti/hLnBg+sKXtesWAh+Xn0DPnCFQYt
Esw/X2ttIPW/4AXQana0FGsDNYYsKB1ufY7lV9allraI5jPHkE/ZfG0GOh56qDw0
AJNOgWrMOQ1LJDpbpDFvhM6eTbUKhPls1IFDgeJFlk032IIbkfuMWEni/M0tOoTe
Kof9dB5RAgMBAAECggEAAKsaVKMjdHoBYerlLEutb/zZAkM41GQ6w709zTPW6ic4
hdkuOJHFPiNVGJf8r/g5jXpXThYeK5Za+I16JhwklOntgUDhPgC7z1weFEbPQfwl
v4IbFmJlNV2rIQ2wwEG8jbEm9Fv1LA5P77mLnaqGbTLmmQptao7WbYKMNfEimob6
v5SouD1axF1filIuY3Wnj6vU6FOT6UZx91QbkIYlcy0/CDwK45sMpSXr1oddHe0K
hP5qaMquY4OewstHFWTEa6Mqlpwoo8fpgrxoEuPr0ldazBgVnkLgkSghlEYoRsiX
nUsHYlF/Yil24nlog+rC5IcGocX1KD+m4qlUxtkfAQKBgQD5Yvged8xotM+1lXsw
q7SFJ1f+XW+MwvNbIsDdWI/mLppej+Tb37Vwtxn1aWPyIZP73Bhy/4BjdshzNCyH
O1fb9IDP/JBhEIRIl33JkMhFylbotJLxUCTi5K2suEpFO84cXTCleI66D8tX5uDJ
BEoJDJVBMHIs19fVxbaLj8NHAQKBgQC/B83dPwEF+5a7JUpOxQNnWhy+zqNd2TU1
jY8rIAZsU5tb1F043p/lUmfbIivDhHx0FVBKnbiMAgupszk6tN5xRSVsDsYBHHu0
FDzYJXDqGZZUxT7q3zWggHud01uEykHkwh6AheACOokKEyGdxgfRVtx4INBDb55d
meMxblmnUQKBgDZNJHWN5EZQSIHjYIWCfbYYkQJj2ewubsrDUHdh10NplldMwapW
la1LUS2smwSX5x8KF5DCrXP64z6id6eidkkAfiPLfKyF6ifcRJllGxaHLlFRMEW3
C7ET1fUr05Arq39lkzgUfg9pbP9g2EUs1+oMgVtGbzXwcaCsgkj1LrIBAoGBAJJo
89IPOMSSF+tlYDdQ7hPnT8K58yG5mPtrfIAr8mBSD+9oqu4sSlZjOzALV4lpYE1E
DJ6zlT7RTokI0OL6vsYHne/cvssZPoI9RIjQ4WK6q6pa5qby3lIeRyAmXq0+qxQd
52zPrmlm3aM4GHqozVMXhLAZTiVxReotSKCZF+ORAoGACY9pYPmFI/2e18PN9xjo
Ht/ng/V8VLikEDl3tT8Zv9+r/83tcrjgmzDlf13tA9s0ac/KqJn2dlxa9oLb6iq0
oHPa1QEDdepuBOyiGmHNf8RHhBm3WsFxXOFKwBE5tGxgIQ529dcnehM6/o84C4eI
egw/OarojpPy6CaPG6w10G8=
-----END PRIVATE KEY-----`;

const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUEgn0BYLRk2hTRQbUKUKgmEofvuowDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNVGVzdCBTQU1MIElkUDAeFw0yNTEyMjAxMjE3MzJaFw0z
NTEyMTgxMjE3MzJaMBgxFjAUBgNVBAMMDVRlc3QgU0FNTCBJZFAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC6GHFfTLe7OFyLR7HdFE5ljqiUyCplJfyf
JD0we+WnY7iZ77KnKjnXvZWUMNTC5PAzb9r6i8q7JD1nc7NKofHSs8+QGtvwzTWL
P4SWIcfGG9VV8qUY2xKNJ8TuOazbxg9SK5mmgyd0QwGhgzIu0hvOKbcTZoKPc1IW
yS82qU7xLJrABcti/hLnBg+sKXtesWAh+Xn0DPnCFQYtEsw/X2ttIPW/4AXQana0
FGsDNYYsKB1ufY7lV9allraI5jPHkE/ZfG0GOh56qDw0AJNOgWrMOQ1LJDpbpDFv
hM6eTbUKhPls1IFDgeJFlk032IIbkfuMWEni/M0tOoTeKof9dB5RAgMBAAGjUzBR
MB0GA1UdDgQWBBTvFqiV3zmGR7gvZ4NHg0qBDcscpjAfBgNVHSMEGDAWgBTvFqiV
3zmGR7gvZ4NHg0qBDcscpjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQAtRXwrFZW8H5ycRuiGnmUVprbfv66GrSiknO/fMWvcfD6rYdtckTFN9l8K
REcWpgeNgRhSx4RibZfuH8b+temXXm3/wgEVb/bZHddB/pVVeoTRfcYgOALrklzb
TCRBe6wVyQyrW+EVw/mfuN0COKkYxoe7GTql3l+JA2pK+FoIGShMJg2zpJjscX8+
Cz7UiUaH27x8IE4LGzcxDeZgpqYZDs2Bp1H0jRa4igkvH0zSNRZm0ErgpErOgJbz
p1hSbc73BFCq2TO7acDmxkKKAbQ9nfZhO6cZEqoMgkfRpqV2BrBDC9GBhoK0yaUU
rXDP3Op15iM4yR/FO2uFs9ZPLoHu
-----END CERTIFICATE-----`;

function createResponse(id: string, assertionId = `${id}_assertion`): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${id}" Version="2.0" IssueInstant="2026-01-01T00:00:00Z">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="2026-01-01T00:00:00Z">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
  </saml:Assertion>
</samlp:Response>`;
}

function sign(xml: string, referenceUri: string, extra: Record<string, unknown> = {}): string {
  return signXml(xml, {
    privateKey: testPrivateKey,
    certificate: testCertificate,
    referenceUri,
    ...extra,
  });
}

/**
 * Sign with xml-crypto directly so the test can pick deprecated or unusual algorithms
 * that signXml never emits.
 */
function signWithAlgorithms(
  xml: string,
  id: string,
  options: {
    signatureAlgorithm?: string;
    digestAlgorithm?: string;
    canonicalizationAlgorithm?: string;
    transforms?: string[];
    references?: string[];
  } = {}
): string {
  const sig = new SignedXml({
    privateKey: testPrivateKey,
    signatureAlgorithm: options.signatureAlgorithm ?? SIGNATURE_ALGORITHMS.RSA_SHA256,
    canonicalizationAlgorithm:
      options.canonicalizationAlgorithm ?? CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N,
  });
  for (const referencedId of options.references ?? [id]) {
    sig.addReference({
      xpath: `//*[@ID='${referencedId}']`,
      digestAlgorithm: options.digestAlgorithm ?? DIGEST_ALGORITHMS.SHA256,
      transforms: options.transforms ?? [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N,
      ],
    });
  }
  sig.computeSignature(xml, {
    location: { reference: `//*[@ID='${id}']`, action: 'prepend' },
  });
  return sig.getSignedXml();
}

const verifyOptions = { certificateOrKey: testCertificate };

describe('verifyXmlSignatureAndGetReferences - SHA-1 opt-in', () => {
  it('accepts an RSA-SHA1 signature only when the caller opts in', () => {
    const signed = signWithAlgorithms(createResponse('_sha1_sig'), '_sha1_sig', {
      signatureAlgorithm: SIGNATURE_ALGORITHMS.RSA_SHA1,
    });

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'SHA-1 signature algorithm is not allowed'
    );
    const references = verifyXmlSignatureAndGetReferences(signed, {
      ...verifyOptions,
      allowSha1SignatureAlgorithm: true,
    });
    expect(references).toHaveLength(1);
    expect(references[0].uri).toBe('#_sha1_sig');
  });

  it('accepts a SHA-1 digest only when the caller opts in', () => {
    const signed = signWithAlgorithms(createResponse('_sha1_digest'), '_sha1_digest', {
      digestAlgorithm: DIGEST_ALGORITHMS.SHA1,
    });

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'SHA-1 digest algorithm is not allowed'
    );
    expect(verifyXmlSignature(signed, { ...verifyOptions, allowSha1DigestAlgorithm: true })).toBe(
      true
    );
  });

  it('still rejects other digest algorithms when SHA-1 is allowed', () => {
    const signed = signWithAlgorithms(createResponse('_sha512'), '_sha512', {
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha512',
    });

    expect(() =>
      verifyXmlSignature(signed, { ...verifyOptions, allowSha1DigestAlgorithm: true })
    ).toThrow('Unsupported digest algorithm: http://www.w3.org/2001/04/xmlenc#sha512');
  });

  it('still rejects other signature algorithms when SHA-1 is allowed', () => {
    const signed = signWithAlgorithms(createResponse('_sha512_sig'), '_sha512_sig', {
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
    });

    expect(() =>
      verifyXmlSignature(signed, { ...verifyOptions, allowSha1SignatureAlgorithm: true })
    ).toThrow('Unsupported signature algorithm: http://www.w3.org/2001/04/xmldsig-more#rsa-sha512');
  });
});

describe('verifyXmlSignatureAndGetReferences - references and IDs', () => {
  it('returns every verified reference of a two-reference signature outside strict mode', () => {
    const signed = signWithAlgorithms(createResponse('_multi', '_multi_assertion'), '_multi', {
      references: ['_multi', '_multi_assertion'],
    });

    const references = verifyXmlSignatureAndGetReferences(signed, verifyOptions);

    expect(references.map((reference) => reference.uri)).toEqual(['#_multi', '#_multi_assertion']);
    expect(references[1].xml).toContain('ID="_multi_assertion"');
  });

  it('matches expectedId against any reference of a multi-reference signature', () => {
    const signed = signWithAlgorithms(createResponse('_multi2', '_multi2_assertion'), '_multi2', {
      references: ['_multi2', '_multi2_assertion'],
    });

    expect(verifyXmlSignature(signed, { ...verifyOptions, expectedId: '_multi2_assertion' })).toBe(
      true
    );
    expect(() => verifyXmlSignature(signed, { ...verifyOptions, expectedId: '_other' })).toThrow(
      'XSW Protection: Reference URI does not match expected "#_other"'
    );
  });

  it('rejects a reference whose ID is not present in the document', () => {
    const signed = sign(createResponse('_missing'), '#_missing').replace(
      'URI="#_missing"',
      'URI="#_elsewhere"'
    );

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'XSW Protection: Element with ID "_elsewhere" not found'
    );
  });

  it('rejects duplicated referenced IDs in both modes, with the XSW reason in strict mode', () => {
    const signed = sign(createResponse('_dup', '_dup_assertion'), '#_dup').replace(
      'ID="_dup_assertion"',
      'ID="_dup"'
    );

    expect(() =>
      verifyXmlSignature(signed, { ...verifyOptions, strictXswProtection: true })
    ).toThrow('XSW Protection: Multiple elements with ID "_dup" detected (possible XSW attack)');
    // Without strict mode xml-crypto itself refuses documents with duplicated IDs.
    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      /multiple elements with the same value for the ID/
    );
  });

  it('rejects duplicated expectedId elements in strict mode even when the reference is intact', () => {
    const signed = sign(createResponse('_dup2', '_dup2_assertion'), '#_dup2_assertion').replace(
      'ID="_dup2"',
      'ID="_dup2_assertion"'
    );

    expect(() =>
      verifyXmlSignature(signed, {
        ...verifyOptions,
        expectedId: '_dup2_assertion',
        strictXswProtection: true,
      })
    ).toThrow('Multiple elements with ID "_dup2_assertion" detected');
  });

  it('rejects an empty Reference URI in strict mode without expectedId', () => {
    const signed = sign(createResponse('_empty_uri'), '#_empty_uri').replace(
      'URI="#_empty_uri"',
      'URI=""'
    );

    expect(() =>
      verifyXmlSignature(signed, { ...verifyOptions, strictXswProtection: true })
    ).toThrow('XSW Protection: Reference URI is required in strict mode');
  });

  it('rejects a bare "#" Reference URI', () => {
    const signed = sign(createResponse('_hash_only'), '#_hash_only').replace(
      'URI="#_hash_only"',
      'URI="#"'
    );

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'XSW Protection: Reference URI fragment must not be empty'
    );
  });
});

describe('verifyXmlSignatureAndGetReferences - structure', () => {
  it.each([
    ['SignedInfo', 'XML signature must contain exactly one direct SignedInfo'],
    ['SignatureValue', 'XML signature must contain exactly one direct SignatureValue'],
    ['SignatureMethod', 'XML signature must contain exactly one direct SignatureMethod'],
    [
      'CanonicalizationMethod',
      'XML signature must contain exactly one direct CanonicalizationMethod',
    ],
    ['DigestValue', 'XML signature must contain exactly one direct DigestValue'],
    ['Transforms', 'XML signature must contain exactly one direct Transforms'],
  ])('rejects a duplicated %s element', (localName, expectedError) => {
    const signed = sign(createResponse('_struct'), '#_struct');
    const pattern = new RegExp(
      `<${localName}(\\s[^>]*)?>[\\s\\S]*?</${localName}>|<${localName}(\\s[^>]*)?/>`
    );
    const match = signed.match(pattern)?.[0];
    expect(match).toBeDefined();
    if (!match) return;
    const duplicated = signed.replace(match, `${match}${match}`);

    expect(() => verifyXmlSignature(duplicated, verifyOptions)).toThrow(expectedError);
  });

  it('rejects a single transform', () => {
    const signed = signWithAlgorithms(createResponse('_one_transform'), '_one_transform', {
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    });

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'XML signature Reference must use exactly two transforms'
    );
  });

  it('rejects transforms in the wrong order', () => {
    const signed = signWithAlgorithms(createResponse('_order'), '_order', {
      transforms: [
        CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N,
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      ],
    });

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'XML signature transforms must be enveloped-signature followed by exclusive C14N'
    );
  });

  it('rejects a transform without an Algorithm attribute', () => {
    const signed = sign(createResponse('_no_alg'), '#_no_alg').replace(
      '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>',
      '<Transform/>'
    );

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'Unsupported XML signature transform: missing'
    );
  });

  it('accepts exclusive C14N with comments for transforms and canonicalization', () => {
    const signed = signWithAlgorithms(createResponse('_comments'), '_comments', {
      canonicalizationAlgorithm: CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N_WITH_COMMENTS,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N_WITH_COMMENTS,
      ],
    });

    expect(verifyXmlSignature(signed, verifyOptions)).toBe(true);
  });

  it('rejects a CanonicalizationMethod without an Algorithm attribute', () => {
    const signed = sign(createResponse('_c14n_missing'), '#_c14n_missing').replace(
      '<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>',
      '<CanonicalizationMethod/>'
    );

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'Unsupported canonicalization algorithm: missing'
    );
  });

  it('rejects a SignatureMethod without an Algorithm attribute', () => {
    const signed = sign(createResponse('_sigm_missing'), '#_sigm_missing').replace(
      /<SignatureMethod Algorithm="[^"]+"\/>/,
      '<SignatureMethod/>'
    );

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      'SignatureMethod Algorithm is required'
    );
  });

  it('rejects a corrupted signature value with the xml-crypto error', () => {
    const signed = sign(createResponse('_corrupt'), '#_corrupt').replace(
      /<SignatureValue>([A-Za-z0-9+/=\s]+)<\/SignatureValue>/,
      (_match, value: string) =>
        `<SignatureValue>${value.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}</SignatureValue>`
    );

    expect(() => verifyXmlSignature(signed, verifyOptions)).toThrow(
      /^invalid signature: the signature value .+ is incorrect$/
    );
  });

  it('rejects a document without any signature', () => {
    expect(() =>
      verifyXmlSignatureAndGetReferences(createResponse('_none'), verifyOptions)
    ).toThrow('No signature found in XML');
  });
});

describe('signXml', () => {
  it('accepts a raw XPath reference and places the signature at an explicit insertion point', () => {
    const signed = sign(
      createResponse('_xpath', '_xpath_assertion'),
      "//*[local-name()='Assertion']",
      {
        signatureInsertionXPath: "//*[local-name()='Assertion']",
        signatureLocation: 'append',
      }
    );

    expect(verifyXmlSignature(signed, { ...verifyOptions, expectedId: '_xpath_assertion' })).toBe(
      true
    );
    expect(signed.indexOf('<Signature')).toBeGreaterThan(signed.indexOf('ID="_xpath_assertion"'));
  });

  it('omits KeyInfo when includeKeyInfo is false', () => {
    const signed = sign(createResponse('_nokeyinfo'), '#_nokeyinfo', { includeKeyInfo: false });

    expect(signed).not.toContain('X509Certificate');
    expect(extractCertificateFromSignature(signed)).toBeNull();
  });

  it('places the signature before or after the referenced element on request', () => {
    const before = sign(createResponse('_before', '_before_assertion'), '#_before_assertion', {
      signatureLocation: 'before',
    });
    const after = sign(createResponse('_after', '_after_assertion'), '#_after_assertion', {
      signatureLocation: 'after',
    });

    expect(before.indexOf('<Signature')).toBeLessThan(before.indexOf('ID="_before_assertion"'));
    expect(after.indexOf('<Signature')).toBeGreaterThan(after.indexOf('</saml:Assertion>'));
    expect(verifyXmlSignature(before, { ...verifyOptions, expectedId: '_before_assertion' })).toBe(
      true
    );
    expect(verifyXmlSignature(after, { ...verifyOptions, expectedId: '_after_assertion' })).toBe(
      true
    );
  });
});

describe('extractCertificateFromSignature', () => {
  it('returns null for an empty X509Certificate element', () => {
    const signed = sign(createResponse('_empty_cert'), '#_empty_cert').replace(
      /<X509Certificate>[\s\S]*?<\/X509Certificate>/,
      '<X509Certificate>  </X509Certificate>'
    );

    expect(extractCertificateFromSignature(signed)).toBeNull();
  });

  it('re-wraps the embedded certificate as PEM with 64-character lines', () => {
    const signed = sign(createResponse('_cert'), '#_cert');

    const pem = extractCertificateFromSignature(signed) ?? '';

    expect(pem.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
    expect(pem.endsWith('\n-----END CERTIFICATE-----')).toBe(true);
    const body = pem.split('\n').slice(1, -1);
    expect(body.slice(0, -1).every((line) => line.length === 64)).toBe(true);
    expect(body.join('')).toBe(
      testCertificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
    );
  });
});
