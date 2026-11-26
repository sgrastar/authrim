/**
 * Trust certificate preview over hand-built DER: every field the parser reads, the weak-key and
 * validity warnings, and each way a malformed certificate is refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeCertificateBytes, previewTrustCertificate } from '../certificate-preview';

const NOW = Date.parse('2030-01-01T00:00:00Z');

// --- DER builders -----------------------------------------------------------------------------

function len(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
const tlv = (tag: number, content: number[]): number[] => [tag, ...len(content.length), ...content];
const seq = (...c: number[][]) => tlv(0x30, c.flat());
const set = (...c: number[][]) => tlv(0x31, c.flat());
const int = (bytes: number[]) => tlv(0x02, bytes);
const nul = () => [0x05, 0x00];
const text = (value: string) => Array.from(new TextEncoder().encode(value));

function oid(dotted: string): number[] {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = part >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, out);
}

const RSA = '1.2.840.113549.1.1.1';
const SHA256_RSA = '1.2.840.113549.1.1.11';
const algId = (dotted: string, parameter: number[] = nul()) => seq(oid(dotted), parameter);
const utc = (value: string) => tlv(0x17, text(value));
const gen = (value: string) => tlv(0x18, text(value));

function name(...attributes: Array<[string, number[]]>): number[] {
  return seq(...attributes.map(([dotted, value]) => set(seq(oid(dotted), value))));
}
const utf8 = (value: string) => tlv(0x0c, text(value));
const CN = (value: string) => name(['2.5.4.3', utf8(value)]);

/** A modulus whose bit length is `bits` (top bit set at the bit length), as DER INTEGER bytes. */
function modulus(bits: number, leadingZeros = 0): number[] {
  const byteLength = Math.ceil(bits / 8);
  const top = 1 << ((bits - 1) % 8);
  const bytes = [top, ...Array.from({ length: byteLength - 1 }, () => 0xab)];
  return [...Array.from({ length: leadingZeros }, () => 0), ...bytes];
}

const rsaKey = (modulusBytes: number[]) =>
  seq(algId(RSA), tlv(0x03, [0x00, ...seq(int(modulusBytes), int([0x01, 0x00, 0x01]))]));

interface CertOptions {
  version?: number | null;
  serial?: number[];
  issuer?: number[];
  subject?: number[];
  notBefore?: number[];
  notAfter?: number[];
  signature?: string;
  spki?: number[];
  tbsOverride?: number[];
  outerSignatureAlgorithm?: number[];
}

function cert(options: CertOptions = {}): Uint8Array {
  const versionPart =
    options.version === null
      ? []
      : tlv(0xa0, int([options.version === undefined ? 2 : options.version]));
  const tbs =
    options.tbsOverride ??
    seq(
      versionPart,
      int(options.serial ?? [0x0b, 0xcd, 0x01]),
      algId(options.signature ?? SHA256_RSA),
      options.issuer ?? CN('issuer.example'),
      seq(options.notBefore ?? utc('260101000000Z'), options.notAfter ?? utc('360101000000Z')),
      options.subject ?? CN('subject.example'),
      options.spki ?? rsaKey(modulus(2048))
    );
  return Uint8Array.from(
    seq(
      tbs,
      options.outerSignatureAlgorithm ?? algId(options.signature ?? SHA256_RSA),
      tlv(0x03, [0, 1, 2, 3])
    )
  );
}

const preview = (der: Uint8Array) => previewTrustCertificate(der, 'der');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('certificate fields', () => {
  it('reads a complete certificate', async () => {
    const result = await preview(cert());

    expect(result).toMatchObject({
      source: 'der',
      subject: 'CN=subject.example',
      issuer: 'CN=issuer.example',
      serialNumber: '0B:CD:01',
      version: 'v3',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2036-01-01T00:00:00.000Z',
      signatureAlgorithm: 'SHA256 with RSA',
      publicKeyAlgorithm: 'RSA',
      publicKeySizeBits: 2048,
      warnings: [],
    });
    expect(result.fingerprintSha1).toMatch(/^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
    expect(result.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it.each([
    [null, 'v1'],
    [0, 'v1'],
    [1, 'v2'],
    [2, 'v3'],
  ])('reads certificate version %s as %s', async (version, expected) => {
    expect((await preview(cert({ version }))).version).toBe(expected);
  });

  it('formats a serial number as upper-case colon-separated bytes, in order', async () => {
    expect((await preview(cert({ serial: [0x00, 0xab, 0xcd, 0x0f] }))).serialNumber).toBe(
      '00:AB:CD:0F'
    );
  });

  it('joins attributes in order, labels known OIDs and prints unknown ones numerically', async () => {
    const subject = name(
      ['2.5.4.6', tlv(0x13, text('JP'))],
      ['2.5.4.8', utf8('Tokyo')],
      ['2.5.4.7', utf8('Chiyoda')],
      ['2.5.4.10', utf8('Org')],
      ['2.5.4.11', utf8('Unit')],
      ['2.5.4.3', utf8('cn')],
      ['2.5.4.5', tlv(0x13, text('42'))],
      ['1.2.840.113549.1.9.1', tlv(0x16, text('a@b'))],
      ['1.2.3.4.200', utf8('odd')]
    );

    expect((await preview(cert({ subject }))).subject).toBe(
      'C=JP, ST=Tokyo, L=Chiyoda, O=Org, OU=Unit, CN=cn, serialNumber=42, emailAddress=a@b, 1.2.3.4.200=odd'
    );
  });

  it('decodes a BMPString value and tolerates a trailing odd byte', async () => {
    const bmp = tlv(0x1e, [0x00, 0x41, 0x30, 0x42, 0x00]);

    expect((await preview(cert({ subject: name(['2.5.4.3', bmp]) }))).subject).toBe('CN=Aあ');
  });

  it('reads an empty name as an empty string', async () => {
    expect((await preview(cert({ subject: seq() }))).subject).toBe('');
  });

  it('keeps UTF-8 values intact', async () => {
    expect((await preview(cert({ subject: CN('日本語') }))).subject).toBe('CN=日本語');
  });
});

describe('validity times', () => {
  it.each([
    ['500101000000Z', '1950-01-01T00:00:00.000Z'],
    ['491231235959Z', '2049-12-31T23:59:59.000Z'],
    ['2601021304Z', '2026-01-02T13:04:00.000Z'],
    ['990615120000Z', '1999-06-15T12:00:00.000Z'],
  ])('reads UTCTime %s', async (value, expected) => {
    expect((await preview(cert({ notBefore: utc(value) }))).validFrom).toBe(expected);
  });

  it('reads GeneralizedTime with and without seconds', async () => {
    const withSeconds = await preview(cert({ notBefore: gen('20250102130405Z') }));
    const without = await preview(cert({ notBefore: gen('202501021304Z') }));

    expect(withSeconds.validFrom).toBe('2025-01-02T13:04:05.000Z');
    expect(without.validFrom).toBe('2025-01-02T13:04:00.000Z');
  });

  it.each([
    ['trailing text', utc('260101000000Zjunk')],
    ['a prefix', utc('x260101000000Z')],
    ['the wrong length', utc('20260101000000Z')],
    ['non-digits', gen('abcdefghijklmnZ')],
  ])('returns the raw text for %s and skips the validity warnings', async (_label, element) => {
    const result = await preview(cert({ notBefore: element, notAfter: element }));

    expect(result.validFrom).toBe(result.validTo);
  });

  it('refuses a validity entry that is not a time', async () => {
    await expect(preview(cert({ notBefore: tlv(0x04, text('260101000000Z')) }))).rejects.toThrow(
      'Invalid X.509 validity time'
    );
  });
});

describe('warnings', () => {
  it('warns about a certificate that is not valid yet and one that has expired, in that order of checks', async () => {
    vi.setSystemTime(Date.parse('2020-01-01T00:00:00Z'));
    expect((await preview(cert())).warnings).toEqual(['Certificate is not valid yet.']);

    vi.setSystemTime(Date.parse('2040-01-01T00:00:00Z'));
    expect((await preview(cert())).warnings).toEqual(['Certificate is expired.']);
  });

  it('is silent exactly at the validity boundaries', async () => {
    vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
    expect((await preview(cert())).warnings).toEqual([]);
    vi.setSystemTime(Date.parse('2036-01-01T00:00:00Z'));
    expect((await preview(cert())).warnings).toEqual([]);
  });

  it('warns about MD5 and SHA-1 signatures', async () => {
    const md5 = await preview(cert({ signature: '1.2.840.113549.1.1.4' }));
    const sha1 = await preview(cert({ signature: '1.2.840.113549.1.1.5' }));

    expect(md5.signatureAlgorithm).toBe('MD5 with RSA');
    expect(md5.warnings).toEqual([
      'Certificate signature uses MD5. Do not use this certificate in production.',
    ]);
    expect(sha1.signatureAlgorithm).toBe('SHA1 with RSA');
    expect(sha1.warnings).toEqual([
      'Certificate signature uses SHA-1. Accept only for an explicit legacy compatibility exception.',
    ]);
  });

  it.each([
    ['SHA384 with RSA', '1.2.840.113549.1.1.12'],
    ['SHA512 with RSA', '1.2.840.113549.1.1.13'],
  ])('does not warn about %s', async (label, dotted) => {
    const result = await preview(cert({ signature: dotted }));

    expect(result.signatureAlgorithm).toBe(label);
    expect(result.warnings).toEqual([]);
  });

  it('prints an unknown signature OID numerically', async () => {
    expect((await preview(cert({ signature: '1.2.3.4' }))).signatureAlgorithm).toBe('1.2.3.4');
  });

  it.each([
    [1024, true],
    [2047, true],
    [2048, false],
    [4096, false],
  ])('judges an RSA key of %i bits', async (bits, weak) => {
    const result = await preview(cert({ spki: rsaKey(modulus(bits)) }));

    expect(result.publicKeySizeBits).toBe(bits);
    expect(result.warnings).toEqual(
      weak ? [`RSA public key is ${bits} bits. Use RSA 2048 bits or stronger.`] : []
    );
  });

  it('measures the key without a leading zero byte of the INTEGER', async () => {
    expect((await preview(cert({ spki: rsaKey(modulus(2048, 1)) }))).publicKeySizeBits).toBe(2048);
    expect((await preview(cert({ spki: rsaKey(modulus(1024, 3)) }))).publicKeySizeBits).toBe(1024);
  });

  it('reads a zero modulus as a one-bit key', async () => {
    const result = await preview(cert({ spki: rsaKey([0, 0]) }));

    expect(result.publicKeySizeBits).toBe(1);
    expect(result.warnings).toEqual(['RSA public key is 1 bits. Use RSA 2048 bits or stronger.']);
  });

  it('describes an EC key with its curve and no size or key warning', async () => {
    const spki = seq(
      algId('1.2.840.10045.2.1', oid('1.2.840.10045.3.1.7')),
      tlv(0x03, [0, 4, 1, 2])
    );
    const result = await preview(cert({ spki, signature: '1.2.840.10045.4.3.2' }));

    expect(result.publicKeyAlgorithm).toBe('EC public key (P-256)');
    expect(result.publicKeySizeBits).toBeUndefined();
    expect(result.signatureAlgorithm).toBe('SHA256 with ECDSA');
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['a key that is not a BIT STRING', seq(algId(RSA), tlv(0x04, [0, 1, 2]))],
    [
      'a BIT STRING with unused bits',
      seq(algId(RSA), tlv(0x03, [0x01, ...seq(int([1]), int([3]))])),
    ],
    ['a BIT STRING that is too short', seq(algId(RSA), tlv(0x03, [0x00]))],
    ['a key that is not a SEQUENCE', seq(algId(RSA), tlv(0x03, [0x00, ...int([1])]))],
    ['a key without a modulus INTEGER', seq(algId(RSA), tlv(0x03, [0x00, ...seq(tlv(0x04, [1]))]))],
    ['a key without a BIT STRING at all', seq(algId(RSA))],
  ])('leaves the key size undefined for %s', async (_label, spki) => {
    const result = await preview(cert({ spki }));

    expect(result.publicKeySizeBits).toBeUndefined();
  });
});

describe('malformed certificates', () => {
  it('requires the SEQUENCE to span the whole input', async () => {
    const good = Array.from(cert());

    await expect(preview(Uint8Array.from([...good, 0x00]))).rejects.toThrow(
      'Input is not a DER encoded X.509 certificate'
    );
  });

  it('requires a TBSCertificate and a signature algorithm, both SEQUENCEs', async () => {
    await expect(preview(Uint8Array.from(seq(int([1]), algId(SHA256_RSA))))).rejects.toThrow(
      'Input is not a valid X.509 certificate'
    );
    await expect(preview(Uint8Array.from(seq(seq(), int([1]))))).rejects.toThrow(
      'Input is not a valid X.509 certificate'
    );
    await expect(preview(Uint8Array.from(seq(seq())))).rejects.toThrow(
      'Input is not a valid X.509 certificate'
    );
  });

  it('refuses truncated and overlong DER lengths', async () => {
    const good = Array.from(cert());

    await expect(preview(Uint8Array.from(good.slice(0, 10)))).rejects.toThrow(
      'Invalid DER certificate length'
    );
    await expect(preview(Uint8Array.from([0x30]))).rejects.toThrow();
    await expect(preview(Uint8Array.from([0x30, 0x80, 0, 0]))).rejects.toThrow(
      'Invalid DER certificate length'
    );
    await expect(preview(Uint8Array.from([0x30, 0x85, 0, 0, 0, 0, 0]))).rejects.toThrow(
      'Invalid DER certificate length'
    );
    await expect(preview(Uint8Array.from([0x30, 0x82, 0x01]))).rejects.toThrow(
      'Invalid DER certificate length'
    );
  });

  it('accepts a four-byte length form', async () => {
    const body = Array.from(cert()).slice(4);
    const total = body.length;
    const der = Uint8Array.from([
      0x30,
      0x84,
      (total >>> 24) & 0xff,
      (total >>> 16) & 0xff,
      (total >>> 8) & 0xff,
      total & 0xff,
      ...body,
    ]);

    expect((await preview(der)).subject).toBe('CN=subject.example');
  });

  it('refuses a version that is not an INTEGER', async () => {
    const tbs = seq(
      tlv(0xa0, tlv(0x04, [2])),
      int([1]),
      algId(SHA256_RSA),
      CN('i'),
      seq(utc('260101000000Z'), utc('360101000000Z')),
      CN('s'),
      rsaKey(modulus(2048))
    );

    await expect(preview(cert({ tbsOverride: tbs }))).rejects.toThrow('Invalid DER integer');
  });

  it('refuses a TBSCertificate with missing parts', async () => {
    const withoutSerial = seq(algId(SHA256_RSA));
    const withoutSubject = seq(
      int([1]),
      algId(SHA256_RSA),
      CN('i'),
      seq(utc('260101000000Z'), utc('360101000000Z'))
    );

    await expect(preview(cert({ tbsOverride: withoutSerial }))).rejects.toThrow();
    await expect(preview(cert({ tbsOverride: withoutSubject }))).rejects.toThrow(
      'Invalid X.509 name'
    );
  });

  it('refuses names, algorithm identifiers and OIDs of the wrong shape', async () => {
    await expect(preview(cert({ issuer: int([1]) }))).rejects.toThrow('Invalid X.509 name');
    await expect(preview(cert({ outerSignatureAlgorithm: int([1]) }))).rejects.toThrow(
      'Input is not a valid X.509 certificate'
    );
    await expect(preview(cert({ spki: seq(int([1]), tlv(0x03, [0, 1])) }))).rejects.toThrow(
      'Invalid X.509 algorithm identifier'
    );
    await expect(
      preview(cert({ spki: seq(seq(tlv(0x06, [])), tlv(0x03, [0, 1])) }))
    ).rejects.toThrow('Invalid OID');
    await expect(preview(cert({ spki: seq(seq(), tlv(0x03, [0, 1])) }))).rejects.toThrow();
  });
});

describe('encodings', () => {
  it('re-encodes the certificate as PEM with 64-character lines, for DER larger than one chunk', async () => {
    const big = cert({ subject: CN('x'.repeat(40_000)) });
    expect(big.length).toBeGreaterThan(0x8000);

    const result = await preview(big);

    const lines = result.certificate.split('\n');
    expect(lines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(lines.at(-1)).toBe('-----END CERTIFICATE-----');
    expect(lines.slice(1, -2).every((line) => line.length === 64)).toBe(true);
    const decoded = Uint8Array.from(atob(lines.slice(1, -1).join('')), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(big));
  });

  it('hashes only the certificate bytes of a view into a larger buffer', async () => {
    const der = cert();
    const padded = new Uint8Array(der.length + 20);
    padded.set(der, 10);

    const direct = await preview(der);
    const viewed = await preview(padded.subarray(10, 10 + der.length));

    expect(viewed.fingerprintSha256).toBe(direct.fingerprintSha256);
    expect(viewed.fingerprintSha1).toBe(direct.fingerprintSha1);
  });

  it('takes DER bytes as they are but decodes text bytes, whitespace included', () => {
    const der = cert();
    expect(decodeCertificateBytes(der)).toBe(der);

    const base64 = btoa(String.fromCharCode(...der));
    const text = new TextEncoder().encode(`  \r\n\t${base64}\n`);
    expect(Array.from(decodeCertificateBytes(text))).toEqual(Array.from(der));
  });
});
