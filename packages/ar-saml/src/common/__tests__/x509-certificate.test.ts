/**
 * X.509 helpers: validity extraction, current-validity assertion and SubjectPublicKeyInfo lookup.
 *
 * Fixtures are OpenSSL-generated self-signed certificates (see admin/__fixtures__/certificates.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractCertificateValidity,
  assertCertificateCurrentlyValid,
  extractSubjectPublicKeyInfo,
} from '../x509';
import {
  RSA_2048_SHA256_PEM,
  RSA_2048_V1_PEM,
  RSA_2048_LONG_VALIDITY_PEM,
  EC_P256_PEM,
} from '../../admin/__fixtures__/certificates';

const pemBody = (pem: string) =>
  pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
const pemToDer = (pem: string) => Uint8Array.from(atob(pemBody(pem)), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
/** WebCrypto wants a Uint8Array backed by a plain ArrayBuffer */
const asBuffer = (bytes: Uint8Array) => Uint8Array.from(bytes);

const NOT_BEFORE = Date.parse('2026-11-18T07:28:14.000Z');
const NOT_AFTER = Date.parse('2036-11-15T07:28:14.000Z');

/** Minimal DER builder for malformed-input cases */
const seq = (...children: number[][]) => {
  const content = children.flat();
  return [0x30, content.length, ...content];
};
const int = (v: number) => [0x02, 0x01, v];
const utcTime = (text: string) => [
  0x17,
  text.length,
  ...Array.from(new TextEncoder().encode(text)),
];
const genTime = (text: string) => [
  0x18,
  text.length,
  ...Array.from(new TextEncoder().encode(text)),
];
/** SEQUENCE { TBS { version[0], serial, sigAlg, issuer, validity } } with the given validity children */
const certWithValidity = (...validity: number[][]) =>
  Uint8Array.from(seq(seq([0xa0, 0x03, ...int(2)], int(1), seq(), seq(), seq(...validity)), seq()));

describe('extractCertificateValidity', () => {
  it('should read UTCTime validity from a v3 certificate', () => {
    expect(extractCertificateValidity(pemToDer(RSA_2048_SHA256_PEM))).toEqual({
      notBefore: NOT_BEFORE,
      notAfter: NOT_AFTER,
    });
  });

  it('should read the same validity from a v1 certificate (no version field)', () => {
    expect(extractCertificateValidity(pemToDer(RSA_2048_V1_PEM))).toEqual({
      notBefore: NOT_BEFORE,
      notAfter: NOT_AFTER,
    });
  });

  it('should read a GeneralizedTime notAfter', () => {
    expect(extractCertificateValidity(pemToDer(RSA_2048_LONG_VALIDITY_PEM))).toEqual({
      notBefore: NOT_BEFORE,
      notAfter: Date.parse('2059-09-26T07:28:14.000Z'),
    });
  });

  it('should treat two-digit years below 50 as 20xx and from 50 as 19xx', () => {
    expect(
      extractCertificateValidity(
        certWithValidity(utcTime('490101000000Z'), utcTime('500101000000Z'))
      )
    ).toEqual({
      notBefore: Date.UTC(2049, 0, 1),
      notAfter: Date.UTC(1950, 0, 1),
    });
  });

  it('should default missing seconds to zero', () => {
    expect(
      extractCertificateValidity(certWithValidity(utcTime('2601010000Z'), genTime('202601010000Z')))
    ).toEqual({ notBefore: Date.UTC(2026, 0, 1), notAfter: Date.UTC(2026, 0, 1) });
  });

  it.each([
    [
      'outer element is not a SEQUENCE',
      Uint8Array.from([0x02, 0x01, 0x01]),
      'Invalid certificate: expected SEQUENCE',
    ],
    [
      'trailing bytes after the certificate',
      Uint8Array.from([...seq(seq()), 0xff]),
      'Invalid certificate: expected SEQUENCE',
    ],
    [
      'TBSCertificate is not a SEQUENCE',
      Uint8Array.from(seq(int(1))),
      'Invalid TBSCertificate: expected SEQUENCE',
    ],
    [
      'Validity is not a SEQUENCE',
      Uint8Array.from(seq(seq(int(1), seq(), seq(), int(5)), seq())),
      'Invalid certificate: expected Validity SEQUENCE',
    ],
    [
      'Validity has trailing content',
      certWithValidity(utcTime('260101000000Z'), utcTime('270101000000Z'), int(1)),
      'Invalid certificate: malformed Validity SEQUENCE',
    ],
    [
      'a time element has the wrong tag',
      certWithValidity(int(1), utcTime('270101000000Z')),
      'Invalid X.509 validity time',
    ],
    [
      'a time string is not in the expected format',
      certWithValidity(utcTime('2026-01-01'), utcTime('270101000000Z')),
      'Invalid X.509 validity time',
    ],
    [
      'a UTCTime has four-digit years',
      certWithValidity(utcTime('20260101000000Z'), utcTime('270101000000Z')),
      'Invalid X.509 validity time',
    ],
    [
      'a GeneralizedTime has two-digit years',
      certWithValidity(genTime('260101000000Z'), genTime('270101000000Z')),
      'Invalid X.509 validity time',
    ],
    [
      'the date does not exist (February 30th)',
      certWithValidity(utcTime('260230000000Z'), utcTime('270101000000Z')),
      'Invalid X.509 validity time',
    ],
    [
      'the time does not exist (hour 24)',
      certWithValidity(utcTime('260101240000Z'), utcTime('270101000000Z')),
      'Invalid X.509 validity time',
    ],
    ['the input is too short', Uint8Array.from([0x30]), 'Invalid DER certificate structure'],
    [
      'a length runs past the input',
      Uint8Array.from([0x30, 0x05, 0x02, 0x01]),
      'Invalid DER certificate length',
    ],
    [
      'a long-form length is indefinite',
      Uint8Array.from([0x30, 0x80, 0x00]),
      'Invalid DER certificate length',
    ],
    [
      'a long-form length has more than four bytes',
      Uint8Array.from([0x30, 0x85, 0, 0, 0, 0, 1, 0]),
      'Invalid DER certificate length',
    ],
    [
      'a long-form length is truncated',
      Uint8Array.from([0x30, 0x82, 0x01]),
      'Invalid DER certificate length',
    ],
  ])('should reject DER where %s', (_label, der, message) => {
    expect(() => extractCertificateValidity(der)).toThrow(new Error(message));
  });

  it('should accept a long-form (two byte) length', () => {
    // Real certificates use long-form lengths for the outer SEQUENCE
    expect(() => extractCertificateValidity(pemToDer(EC_P256_PEM))).not.toThrow();
  });
});

describe('assertCertificateCurrentlyValid', () => {
  it('should ignore values that are not PEM certificates (e.g. a bare public key)', () => {
    expect(() =>
      assertCertificateCurrentlyValid('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----')
    ).not.toThrow();
    expect(() => assertCertificateCurrentlyValid('')).not.toThrow();
  });

  it('should accept a certificate inside its validity window, including both boundaries', () => {
    expect(() => assertCertificateCurrentlyValid(RSA_2048_SHA256_PEM, NOT_BEFORE)).not.toThrow();
    expect(() => assertCertificateCurrentlyValid(RSA_2048_SHA256_PEM, NOT_AFTER)).not.toThrow();
    expect(() =>
      assertCertificateCurrentlyValid(RSA_2048_SHA256_PEM, NOT_BEFORE + 1)
    ).not.toThrow();
  });

  it('should default to the current time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(NOT_BEFORE + 1000));
      expect(() => assertCertificateCurrentlyValid(RSA_2048_SHA256_PEM)).not.toThrow();
      vi.setSystemTime(new Date(NOT_AFTER + 1000));
      expect(() => assertCertificateCurrentlyValid(RSA_2048_SHA256_PEM)).toThrow(
        new Error('SAML signing certificate has expired')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('should reject a certificate that is not valid yet', () => {
    expect(() => assertCertificateCurrentlyValid(RSA_2048_SHA256_PEM, NOT_BEFORE - 1)).toThrow(
      new Error('SAML signing certificate is not valid yet')
    );
  });

  it('should reject an expired certificate', () => {
    expect(() => assertCertificateCurrentlyValid(RSA_2048_SHA256_PEM, NOT_AFTER + 1)).toThrow(
      new Error('SAML signing certificate has expired')
    );
  });

  it.each([
    ['an empty PEM body', '-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----'],
    ['non-base64 characters', '-----BEGIN CERTIFICATE-----\nnot*base64\n-----END CERTIFICATE-----'],
    ['a missing END marker', '-----BEGIN CERTIFICATE-----\nMIIB\n'],
    ['base64 that cannot be decoded', '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----'],
  ])('should reject %s as an invalid encoding', (_label, pem) => {
    expect(() => assertCertificateCurrentlyValid(pem, NOT_BEFORE + 1)).toThrow(
      new Error('Invalid certificate encoding')
    );
  });

  it('should tolerate whitespace and line breaks inside the PEM body', () => {
    const body = pemBody(RSA_2048_SHA256_PEM).replace(/(.{20})/g, '$1 \n');
    expect(() =>
      assertCertificateCurrentlyValid(
        `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`,
        NOT_BEFORE + 1
      )
    ).not.toThrow();
  });
});

describe('extractSubjectPublicKeyInfo', () => {
  it('should return the SubjectPublicKeyInfo of a v3 certificate as WebCrypto SPKI', async () => {
    const spki = extractSubjectPublicKeyInfo(pemToDer(RSA_2048_SHA256_PEM));
    expect(spki.length).toBe(294); // RSA-2048 SPKI
    expect(toBase64(spki).startsWith('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC')).toBe(true);
    const key = await crypto.subtle.importKey(
      'spki',
      asBuffer(spki),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify']
    );
    expect(key.type).toBe('public');
  });

  it('should find the same SubjectPublicKeyInfo in the v1 encoding of the certificate', () => {
    expect(toBase64(extractSubjectPublicKeyInfo(pemToDer(RSA_2048_V1_PEM)))).toBe(
      toBase64(extractSubjectPublicKeyInfo(pemToDer(RSA_2048_SHA256_PEM)))
    );
  });

  it('should return an EC SubjectPublicKeyInfo', async () => {
    const spki = extractSubjectPublicKeyInfo(pemToDer(EC_P256_PEM));
    const key = await crypto.subtle.importKey(
      'spki',
      asBuffer(spki),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );
    expect(key.type).toBe('public');
  });

  it.each([
    [
      'outer element is not a SEQUENCE',
      Uint8Array.from([0x02, 0x01, 0x01]),
      'Invalid certificate: expected SEQUENCE',
    ],
    [
      'TBSCertificate is not a SEQUENCE',
      Uint8Array.from(seq(int(1))),
      'Invalid TBSCertificate: expected SEQUENCE',
    ],
    [
      'the TBSCertificate ends before SubjectPublicKeyInfo (v1 layout)',
      Uint8Array.from(seq(seq(int(1), seq(), seq(), seq(), seq()), seq())),
      'SubjectPublicKeyInfo not found in certificate',
    ],
    [
      'the TBSCertificate ends before SubjectPublicKeyInfo (v3 layout)',
      Uint8Array.from(seq(seq([0xa0, 0x03, ...int(2)], int(1), seq(), seq(), seq(), seq()), seq())),
      'SubjectPublicKeyInfo not found in certificate',
    ],
    [
      'the TBSCertificate is empty',
      Uint8Array.from(seq(seq(), seq())),
      'SubjectPublicKeyInfo not found in certificate',
    ],
  ])('should reject DER where %s', (_label, der, message) => {
    expect(() => extractSubjectPublicKeyInfo(der)).toThrow(new Error(message));
  });

  it('should return the sixth field for a v1 layout and the seventh for a v3 layout', () => {
    const spkiLike = [0x30, 0x02, 0x05, 0x00];
    const v1 = Uint8Array.from(seq(seq(int(1), seq(), seq(), seq(), seq(), spkiLike), seq()));
    const v3 = Uint8Array.from(
      seq(seq([0xa0, 0x03, ...int(2)], int(1), seq(), seq(), seq(), seq(), spkiLike), seq())
    );
    expect(Array.from(extractSubjectPublicKeyInfo(v1))).toEqual(spkiLike);
    expect(Array.from(extractSubjectPublicKeyInfo(v3))).toEqual(spkiLike);
  });
});
