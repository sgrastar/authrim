/**
 * Boundary and validation cases of the X.509 helpers (validity times, DER length forms,
 * PEM decoding and SubjectPublicKeyInfo lookup) that the fixture-based tests do not pin.
 */

import { describe, expect, it } from 'vitest';
import {
  assertCertificateCurrentlyValid,
  extractCertificateValidity,
  extractSubjectPublicKeyInfo,
} from '../x509';

const ascii = (text: string): number[] => Array.from(new TextEncoder().encode(text));
const tlv = (tag: number, content: number[]): number[] => {
  if (content.length < 0x80) {
    return [tag, content.length, ...content];
  }
  return [tag, 0x82, content.length >> 8, content.length & 0xff, ...content];
};
const seq = (...children: number[][]): number[] => tlv(0x30, children.flat());
const int = (value: number): number[] => tlv(0x02, [value]);
const utcTime = (text: string): number[] => tlv(0x17, ascii(text));
const genTime = (text: string): number[] => tlv(0x18, ascii(text));

/** SEQUENCE { TBS { [0] version, serial, sigAlg, issuer, validity } } */
function certWithValidity(notBefore: number[], notAfter: number[]): Uint8Array {
  const tbs = seq(tlv(0xa0, int(2)), int(1), seq(), seq(), seq(notBefore, notAfter));
  return Uint8Array.from(seq(tbs, seq()));
}

function validityOf(notBefore: number[], notAfter: number[]) {
  return extractCertificateValidity(certWithValidity(notBefore, notAfter));
}

const GOOD_AFTER = genTime('20400101000000Z');

describe('extractCertificateValidity: time decoding', () => {
  it('maps two-digit UTCTime years 50-99 to 19xx and 00-49 to 20xx', () => {
    expect(validityOf(utcTime('500101000000Z'), GOOD_AFTER).notBefore).toBe(
      Date.UTC(1950, 0, 1, 0, 0, 0)
    );
    expect(validityOf(utcTime('491231235959Z'), GOOD_AFTER).notBefore).toBe(
      Date.UTC(2049, 11, 31, 23, 59, 59)
    );
  });

  it('treats a UTCTime without seconds as second zero', () => {
    expect(validityOf(utcTime('2501021304Z'), GOOD_AFTER).notBefore).toBe(
      Date.UTC(2025, 0, 2, 13, 4, 0)
    );
  });

  it('decodes GeneralizedTime with a four-digit year and with seconds', () => {
    expect(validityOf(genTime('20250102130405Z'), GOOD_AFTER).notBefore).toBe(
      Date.UTC(2025, 0, 2, 13, 4, 5)
    );
    expect(validityOf(genTime('203001020304Z'), GOOD_AFTER).notBefore).toBe(
      Date.UTC(2030, 0, 2, 3, 4, 0)
    );
  });

  it('rejects time elements that are neither UTCTime nor GeneralizedTime', () => {
    // An OCTET STRING whose text would otherwise be a valid GeneralizedTime.
    expect(() => validityOf(tlv(0x04, ascii('20300101000000Z')), GOOD_AFTER)).toThrow(
      'Invalid X.509 validity time'
    );
    expect(() => validityOf(utcTime('250101000000Z'), tlv(0x04, ascii('20300101000000Z')))).toThrow(
      'Invalid X.509 validity time'
    );
  });

  it.each([
    ['a prefix before a UTCTime', utcTime('X250101000000Z')],
    ['trailing text after a UTCTime', utcTime('250101000000Zjunk')],
    ['a prefix before a GeneralizedTime', genTime('X20250101000000Z')],
    ['trailing text after a GeneralizedTime', genTime('20250101000000Zjunk')],
    ['a missing Z terminator', utcTime('250101000000')],
    ['a GeneralizedTime value inside a UTCTime tag', utcTime('20250101000000Z')],
  ])('rejects %s', (_label, element) => {
    expect(() => validityOf(element, GOOD_AFTER)).toThrow('Invalid X.509 validity time');
  });

  it.each([
    ['month 13', '20251301000000Z'],
    ['February 29 in a non-leap year', '20230229000000Z'],
    ['day 31 of a 30-day month', '20250431000000Z'],
    ['hour 24', '20250101240000Z'],
    ['minute 60', '20250101006000Z'],
    ['second 60', '20250101000060Z'],
  ])('rejects an impossible calendar value: %s', (_label, text) => {
    expect(() => validityOf(genTime(text), GOOD_AFTER)).toThrow('Invalid X.509 validity time');
  });

  it('accepts February 29 in a leap year', () => {
    expect(validityOf(genTime('20240229000000Z'), GOOD_AFTER).notBefore).toBe(
      Date.UTC(2024, 1, 29)
    );
  });
});

describe('extractCertificateValidity: DER length forms', () => {
  it('accepts a four-byte long-form length', () => {
    const tbs = seq(
      tlv(0xa0, int(2)),
      int(1),
      seq(),
      seq(),
      seq(utcTime('250101000000Z'), GOOD_AFTER)
    );
    const body = [...tbs, ...seq()];
    const cert = Uint8Array.from([
      0x30,
      0x84,
      (body.length >>> 24) & 0xff,
      (body.length >>> 16) & 0xff,
      (body.length >>> 8) & 0xff,
      body.length & 0xff,
      ...body,
    ]);

    expect(extractCertificateValidity(cert).notBefore).toBe(Date.UTC(2025, 0, 1));
  });

  it('rejects a five-byte length-of-length', () => {
    const cert = Uint8Array.from([0x30, 0x85, 0, 0, 0, 0, 3, 0x30, 0x01, 0x00]);
    expect(() => extractCertificateValidity(cert)).toThrow('Invalid DER certificate length');
  });

  it('rejects an indefinite length (0x80)', () => {
    expect(() => extractCertificateValidity(Uint8Array.from([0x30, 0x80, 0x00, 0x00]))).toThrow(
      'Invalid DER certificate length'
    );
  });

  it('rejects trailing bytes after the certificate SEQUENCE', () => {
    const cert = certWithValidity(utcTime('250101000000Z'), GOOD_AFTER);
    expect(() => extractCertificateValidity(Uint8Array.from([...cert, 0]))).toThrow(
      'Invalid certificate: expected SEQUENCE'
    );
  });
});

describe('assertCertificateCurrentlyValid: PEM decoding', () => {
  it('ignores values that are not PEM certificates', () => {
    expect(() => assertCertificateCurrentlyValid('not a certificate')).not.toThrow();
  });

  it('rejects a BEGIN marker without the matching END marker', () => {
    expect(() => assertCertificateCurrentlyValid('-----BEGIN CERTIFICATE-----\nQUJD')).toThrow(
      'Invalid certificate encoding'
    );
  });

  it('rejects an empty body', () => {
    expect(() =>
      assertCertificateCurrentlyValid('-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----')
    ).toThrow('Invalid certificate encoding');
  });

  it('rejects characters outside the base64 alphabet', () => {
    expect(() =>
      assertCertificateCurrentlyValid(
        '-----BEGIN CERTIFICATE-----\nAB!CD\n-----END CERTIFICATE-----'
      )
    ).toThrow('Invalid certificate encoding');
  });

  it('decodes a PEM body whose base64 is wrapped over several lines', () => {
    const der = certWithValidity(utcTime('250101000000Z'), GOOD_AFTER);
    const base64 = btoa(String.fromCharCode(...der));
    const wrapped = base64.match(/.{1,16}/g)?.join('\n') ?? base64;
    const pem = `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;

    expect(() => assertCertificateCurrentlyValid(pem, Date.UTC(2026, 0, 1))).not.toThrow();
    expect(() => assertCertificateCurrentlyValid(pem, Date.UTC(2024, 0, 1))).toThrow(
      'SAML signing certificate is not valid yet'
    );
    expect(() => assertCertificateCurrentlyValid(pem, Date.UTC(2041, 0, 1))).toThrow(
      'SAML signing certificate has expired'
    );
  });
});

describe('extractSubjectPublicKeyInfo: field positions', () => {
  const spki = seq(seq(tlv(0x06, [0x2a])), tlv(0x03, [0x00, 0x01]));

  it('finds the key at index 6 when an explicit version is present', () => {
    const tbs = seq(tlv(0xa0, int(2)), int(1), seq(), seq(), seq(), seq(), spki);
    expect(Array.from(extractSubjectPublicKeyInfo(Uint8Array.from(seq(tbs, seq()))))).toEqual(spki);
  });

  it('finds the key at index 5 for a version-less certificate', () => {
    const tbs = seq(int(1), seq(), seq(), seq(), seq(), spki);
    expect(Array.from(extractSubjectPublicKeyInfo(Uint8Array.from(seq(tbs, seq()))))).toEqual(spki);
  });

  it('only treats a context tag as the version at the first position', () => {
    // The second field happens to carry the [0] tag; it is a serial/algorithm slot, not a version.
    const tbs = seq(int(1), tlv(0xa0, int(2)), seq(), seq(), seq(), spki);
    expect(Array.from(extractSubjectPublicKeyInfo(Uint8Array.from(seq(tbs, seq()))))).toEqual(spki);
  });

  it('fails when the TBSCertificate ends before the key', () => {
    const tbs = seq(tlv(0xa0, int(2)), int(1), seq(), seq());
    expect(() => extractSubjectPublicKeyInfo(Uint8Array.from(seq(tbs, seq())))).toThrow(
      'SubjectPublicKeyInfo not found in certificate'
    );
  });
});
