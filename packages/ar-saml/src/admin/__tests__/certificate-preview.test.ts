/**
 * Trust certificate preview: decoding (PEM / base64 / DER), X.509 field extraction and warnings.
 *
 * Fixtures are self-signed certificates generated with OpenSSL; the expected fingerprints,
 * serials and validity dates below were read with `openssl x509 -noout -fingerprint/-serial/-dates`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  previewTrustCertificate,
  decodeCertificateBytes,
  decodeCertificateText,
} from '../certificate-preview';
import { SAMLMetadataValidationError } from '../errors';
import {
  RSA_2048_SHA256_PEM,
  RSA_1024_SHA1_PEM,
  EC_P256_PEM,
  RSA_2048_LONG_VALIDITY_PEM,
  RSA_2048_MD5_PEM,
} from '../__fixtures__/certificates';

// Inside the validity window of every fixture (2026-11-18 .. 2036-11-15)
const NOW = new Date('2030-01-01T00:00:00.000Z').getTime();
const pemBody = (pem: string) =>
  pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
const pemToDer = (pem: string) => Uint8Array.from(atob(pemBody(pem)), (c) => c.charCodeAt(0));

describe('previewTrustCertificate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should describe an RSA-2048 / SHA-256 certificate completely', async () => {
    const preview = await previewTrustCertificate(RSA_2048_SHA256_PEM, 'pem');
    expect(preview).toEqual({
      certificate: RSA_2048_SHA256_PEM,
      source: 'pem',
      subject: 'C=JP, ST=Tokyo, O=Authrim Test, OU=SAML, CN=rsa2048.example.test',
      issuer: 'C=JP, ST=Tokyo, O=Authrim Test, OU=SAML, CN=rsa2048.example.test',
      serialNumber: '0B:55:64:C7:6A:E0:A8:60:84:EB:06:3A:56:AC:FF:8D:2E:81:40:EF',
      version: 'v3',
      validFrom: '2026-11-18T07:28:14.000Z',
      validTo: '2036-11-15T07:28:14.000Z',
      signatureAlgorithm: 'SHA256 with RSA',
      publicKeyAlgorithm: 'RSA',
      publicKeySizeBits: 2048,
      fingerprintSha1: '60:42:B6:5D:7D:10:9B:7D:8D:9B:2B:3D:EB:D3:EB:75:05:23:6B:E6',
      fingerprintSha256:
        'E7:25:15:ED:BB:77:D5:F7:A5:DB:1B:BF:DF:62:F7:8F:79:D8:21:C8:B8:67:A6:3D:B4:0B:7C:64:18:C4:2B:87',
      warnings: [],
    });
  });

  it('should accept raw DER bytes, base64 text and PEM with surrounding whitespace alike', async () => {
    const fromPem = await previewTrustCertificate(RSA_2048_SHA256_PEM, 'pem');
    const fromDer = await previewTrustCertificate(pemToDer(RSA_2048_SHA256_PEM), 'url');
    const fromBase64 = await previewTrustCertificate(
      `\n  ${pemBody(RSA_2048_SHA256_PEM)}\n`,
      'der'
    );
    const fromPemBytes = await previewTrustCertificate(
      new TextEncoder().encode(`\n\t ${RSA_2048_SHA256_PEM}\n`),
      'url'
    );

    expect(fromDer).toEqual({ ...fromPem, source: 'url' });
    expect(fromBase64).toEqual({ ...fromPem, source: 'der' });
    expect(fromPemBytes).toEqual({ ...fromPem, source: 'url' });
    // The returned PEM is re-wrapped at 64 columns from the DER bytes
    expect(fromDer.certificate).toBe(RSA_2048_SHA256_PEM);
  });

  it('should warn about SHA-1 signatures and RSA keys below 2048 bits', async () => {
    const preview = await previewTrustCertificate(RSA_1024_SHA1_PEM, 'pem');
    expect(preview).toMatchObject({
      subject: 'CN=weak.example.test',
      signatureAlgorithm: 'SHA1 with RSA',
      publicKeyAlgorithm: 'RSA',
      publicKeySizeBits: 1024,
      serialNumber: '32:66:78:FE:9F:25:0B:01:FE:D5:E0:77:02:79:81:C1:77:A5:48:7E',
      fingerprintSha1: 'D8:36:54:59:64:0F:57:00:84:CD:6B:F2:A1:25:05:11:BE:2E:14:ED',
    });
    expect(preview.warnings).toEqual([
      'Certificate signature uses SHA-1. Accept only for an explicit legacy compatibility exception.',
      'RSA public key is 1024 bits. Use RSA 2048 bits or stronger.',
    ]);
  });

  it('should warn about MD5 signatures', async () => {
    const preview = await previewTrustCertificate(RSA_2048_MD5_PEM, 'pem');
    expect(preview.signatureAlgorithm).toBe('MD5 with RSA');
    expect(preview.warnings).toEqual([
      'Certificate signature uses MD5. Do not use this certificate in production.',
    ]);
  });

  it('should describe an EC certificate with its curve and no key size', async () => {
    const preview = await previewTrustCertificate(EC_P256_PEM, 'pem');
    expect(preview).toMatchObject({
      subject: 'CN=ec.example.test',
      signatureAlgorithm: 'SHA256 with ECDSA',
      publicKeyAlgorithm: 'EC public key (P-256)',
      fingerprintSha256:
        '5D:70:01:58:48:0A:9A:DB:3A:E6:9D:6B:18:7C:A4:A8:EE:E9:0F:57:7C:EA:D9:0F:44:25:17:77:B2:2A:2B:55',
      warnings: [],
    });
    expect(preview.publicKeySizeBits).toBeUndefined();
    expect('publicKeySizeBits' in preview).toBe(true);
  });

  it('should decode a GeneralizedTime notAfter (year 2050 and later)', async () => {
    const preview = await previewTrustCertificate(RSA_2048_LONG_VALIDITY_PEM, 'pem');
    expect(preview.validFrom).toBe('2026-11-18T07:28:14.000Z'); // UTCTime
    expect(preview.validTo).toBe('2059-09-26T07:28:14.000Z'); // GeneralizedTime
    expect(preview.warnings).toEqual([]);
  });

  it('should warn when the certificate is not valid yet', async () => {
    vi.setSystemTime(new Date('2026-11-18T07:28:13.000Z'));
    const preview = await previewTrustCertificate(RSA_2048_SHA256_PEM, 'pem');
    expect(preview.warnings).toEqual(['Certificate is not valid yet.']);
  });

  it('should warn when the certificate is expired', async () => {
    vi.setSystemTime(new Date('2036-11-15T07:28:15.000Z'));
    const preview = await previewTrustCertificate(RSA_2048_SHA256_PEM, 'pem');
    expect(preview.warnings).toEqual(['Certificate is expired.']);
  });

  it('should not warn at the exact validity boundaries', async () => {
    vi.setSystemTime(new Date('2026-11-18T07:28:14.000Z'));
    expect((await previewTrustCertificate(RSA_2048_SHA256_PEM, 'pem')).warnings).toEqual([]);
    vi.setSystemTime(new Date('2036-11-15T07:28:14.000Z'));
    expect((await previewTrustCertificate(RSA_2048_SHA256_PEM, 'pem')).warnings).toEqual([]);
  });

  it('should combine time and algorithm warnings in order', async () => {
    vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));
    const preview = await previewTrustCertificate(RSA_1024_SHA1_PEM, 'pem');
    expect(preview.warnings).toEqual([
      'Certificate is expired.',
      'Certificate signature uses SHA-1. Accept only for an explicit legacy compatibility exception.',
      'RSA public key is 1024 bits. Use RSA 2048 bits or stronger.',
    ]);
  });

  describe('rejections', () => {
    const expectRejection = async (input: Uint8Array | string, message: string) => {
      const promise = previewTrustCertificate(input, 'pem');
      await expect(promise).rejects.toBeInstanceOf(SAMLMetadataValidationError);
      await expect(promise).rejects.toThrow(new SAMLMetadataValidationError(message));
    };

    it.each([
      ['empty input', ''],
      ['whitespace only', '  \n '],
      ['an empty PEM body', '-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----'],
      ['text that is not base64', 'this is not a certificate!'],
      ['a private key PEM', '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'],
    ])('should reject %s as not PEM/base64', async (_label, input) => {
      await expectRejection(input, 'Input is not a PEM or base64 encoded certificate');
    });

    it('should reject base64 that cannot be decoded', async () => {
      await expectRejection('A', 'Input is not a valid certificate encoding');
    });

    it('should reject DER whose outer element is not a SEQUENCE', async () => {
      // base64 of INTEGER 1 (raw bytes not starting with 0x30 would be read as text instead)
      await expectRejection(btoa('\x02\x01\x01'), 'Input is not a DER encoded X.509 certificate');
    });

    it('should reject a SEQUENCE followed by trailing bytes', async () => {
      await expectRejection(
        new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01, 0xff]),
        'Input is not a DER encoded X.509 certificate'
      );
    });

    it('should reject a certificate whose TBS or signature algorithm is not a SEQUENCE', async () => {
      // SEQUENCE { INTEGER 1 }
      await expectRejection(
        new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]),
        'Input is not a valid X.509 certificate'
      );
      // SEQUENCE { SEQUENCE {}, INTEGER 1 }
      await expectRejection(
        new Uint8Array([0x30, 0x05, 0x30, 0x00, 0x02, 0x01, 0x01]),
        'Input is not a valid X.509 certificate'
      );
    });

    it('should reject truncated DER', async () => {
      const der = pemToDer(RSA_2048_SHA256_PEM);
      await expectRejection(der.slice(0, der.length - 10), 'Invalid DER certificate length');
      await expectRejection(new Uint8Array([0x30]), 'Invalid DER certificate');
    });

    it('should reject unsupported long-form lengths', async () => {
      // 0x80 = indefinite length, 0x85 = 5 length bytes
      await expectRejection(
        new Uint8Array([0x30, 0x80, 0x00, 0x00]),
        'Invalid DER certificate length'
      );
      await expectRejection(
        new Uint8Array([0x30, 0x85, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]),
        'Invalid DER certificate length'
      );
    });

    it('should reject a certificate with a malformed validity time', async () => {
      // Replace the first UTCTime tag (0x17) in the real certificate with a PrintableString tag (0x13)
      const der = pemToDer(RSA_2048_SHA256_PEM);
      const timeIndex = der.findIndex((b, i) => b === 0x17 && der[i + 1] === 0x0d);
      expect(timeIndex).toBeGreaterThan(0);
      const broken = Uint8Array.from(der);
      broken[timeIndex] = 0x13;
      await expectRejection(broken, 'Invalid X.509 validity time');
    });
  });
});

describe('decodeCertificateBytes / decodeCertificateText', () => {
  it('should pass DER bytes through untouched when the first content byte is a SEQUENCE tag', () => {
    const der = pemToDer(RSA_2048_SHA256_PEM);
    expect(decodeCertificateBytes(der)).toBe(der);
    const padded = new Uint8Array([0x20, 0x0a, ...der]);
    expect(decodeCertificateBytes(padded)).toBe(padded);
  });

  it('should decode PEM or base64 text given as bytes', () => {
    const der = pemToDer(RSA_2048_SHA256_PEM);
    expect(decodeCertificateBytes(new TextEncoder().encode(RSA_2048_SHA256_PEM))).toEqual(der);
    expect(decodeCertificateBytes(new TextEncoder().encode(pemBody(RSA_2048_SHA256_PEM)))).toEqual(
      der
    );
  });

  it('should strip the PEM armour and all whitespace from text', () => {
    const der = pemToDer(RSA_2048_SHA256_PEM);
    const spaced = pemBody(RSA_2048_SHA256_PEM).replace(/(.{10})/g, '$1 \t\n');
    expect(decodeCertificateText(spaced)).toEqual(der);
    expect(decodeCertificateText(`  ${RSA_2048_SHA256_PEM}  `)).toEqual(der);
  });
});
