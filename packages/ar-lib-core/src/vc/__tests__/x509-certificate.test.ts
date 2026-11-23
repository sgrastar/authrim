import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import type { JWK } from 'jose';
import {
  base64ToBytes,
  buildCertificate,
  bytesToBase64,
  decodeOid,
  derOid,
  ecdsaDerToRaw,
  ecdsaRawToDer,
  isCertificateHostName,
  keyIdentifier,
  p256PointFromJwk,
  parseCertificate,
  validateVcSigningChain,
  verifyCertificateSignature,
} from '../x509-certificate';

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function generateKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
  };
}

function signer(key: TestKey) {
  return async (tbs: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, tbs)
    );
}

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-22T00:00:00Z');
const HOST = 'issuer.example.com';

async function makePki(
  options: {
    leafHost?: string;
    leafNotAfter?: number;
    caNotAfter?: number;
    leafNames?: string[];
    caPathLength?: number;
    leafCommonName?: string;
    leafExtra?: { oid: string; critical: boolean; value: Uint8Array }[];
    leafKeyUsage?: number[];
    caKeyUsage?: number[];
    leafAki?: 'omit' | 'critical';
    leafSki?: 'omit' | 'critical';
    caAki?: 'omit' | 'critical';
    caSki?: 'omit' | 'critical';
  } = {}
) {
  const root = await generateKey();
  const ca = await generateKey();
  const leaf = await generateKey();
  const rootCert = await buildCertificate(
    {
      subject: { commonName: 'Test Root CA', organization: 'Test' },
      issuer: { commonName: 'Test Root CA', organization: 'Test' },
      subjectPublicKey: root.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(NOW - 1000 * HOUR),
      notAfter: new Date(NOW + 100_000 * HOUR),
      isCA: true,
      pathLength: 1,
    },
    signer(root)
  );
  const caCert = await buildCertificate(
    {
      subject: { commonName: 'Test Issuing CA', organization: 'Test' },
      issuer: { commonName: 'Test Root CA', organization: 'Test' },
      subjectPublicKey: ca.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(NOW - 500 * HOUR),
      notAfter: new Date(options.caNotAfter ?? NOW + 50_000 * HOUR),
      isCA: true,
      pathLength: options.caPathLength ?? 0,
      keyUsageBits: options.caKeyUsage,
      authorityKeyIdentifier: options.caAki,
      subjectKeyIdentifier: options.caSki,
    },
    signer(root)
  );
  const leafCert = await buildCertificate(
    {
      subject: { commonName: options.leafCommonName ?? options.leafHost ?? HOST },
      issuer: { commonName: 'Test Issuing CA', organization: 'Test' },
      subjectPublicKey: leaf.publicJwk,
      issuerPublicKey: ca.publicJwk,
      notBefore: new Date(NOW - 5 * 60_000),
      notAfter: new Date(options.leafNotAfter ?? NOW + 24 * HOUR),
      dnsNames: options.leafNames ?? [options.leafHost ?? HOST],
      isCA: false,
      extraExtensions: options.leafExtra,
      keyUsageBits: options.leafKeyUsage,
      authorityKeyIdentifier: options.leafAki,
      subjectKeyIdentifier: options.leafSki,
    },
    signer(ca)
  );
  return { root, ca, leaf, rootCert, caCert, leafCert };
}

describe('x509-certificate', () => {
  describe('encoding helpers', () => {
    it('converts ECDSA signatures between raw and DER forms', () => {
      const raw = new Uint8Array(64).map((_, index) =>
        index === 0 || index === 32 ? 0xff : index
      );
      const der = ecdsaRawToDer(raw);
      expect(der[0]).toBe(0x30);
      expect(ecdsaDerToRaw(der)).toEqual(raw);
      // Leading zeros are dropped in DER and restored on the way back.
      const small = new Uint8Array(64);
      small[31] = 1;
      small[63] = 2;
      expect(ecdsaDerToRaw(ecdsaRawToDer(small))).toEqual(small);
    });

    it('rejects malformed signatures', () => {
      expect(() => ecdsaRawToDer(new Uint8Array(63))).toThrow('invalid_ecdsa_signature');
      expect(() => ecdsaDerToRaw(new Uint8Array([0x30, 0x00]))).toThrow();
    });

    it('accepts only lower-case dotted host names without wildcards', () => {
      expect(isCertificateHostName('issuer.example.com')).toBe(true);
      expect(isCertificateHostName('localhost')).toBe(true);
      for (const bad of [
        '*.example.com',
        'Issuer.example.com',
        'a..b',
        'a.b.',
        '-a.com',
        '',
        'a b.com',
      ]) {
        expect(isCertificateHostName(bad)).toBe(false);
      }
    });

    it('decodes strict base64 only', () => {
      expect(bytesToBase64(base64ToBytes('AQID'))).toBe('AQID');
      expect(() => base64ToBytes('AQI')).toThrow('invalid_base64');
      expect(() => base64ToBytes('AQ-D')).toThrow('invalid_base64');
    });
  });

  describe('built certificates agree with node:crypto', () => {
    it('produces a chain that OpenSSL-backed X509Certificate accepts', async () => {
      const pki = await makePki();
      const root = new X509Certificate(pki.rootCert);
      const ca = new X509Certificate(pki.caCert);
      const leaf = new X509Certificate(pki.leafCert);

      expect(root.ca).toBe(true);
      expect(ca.ca).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.subjectAltName).toBe(`DNS:${HOST}`);
      expect(leaf.subject).toContain(`CN=${HOST}`);
      expect(leaf.issuer).toContain('CN=Test Issuing CA');
      expect(ca.issuer).toContain('CN=Test Root CA');

      expect(root.verify(root.publicKey)).toBe(true);
      expect(ca.verify(root.publicKey)).toBe(true);
      expect(leaf.verify(ca.publicKey)).toBe(true);
      expect(leaf.verify(root.publicKey)).toBe(false);
      expect(leaf.checkIssued(ca)).toBe(true);
      expect(ca.checkIssued(root)).toBe(true);

      expect(leaf.keyUsage).toBeUndefined(); // node reports extended key usage only
      expect(new Date(leaf.validTo).getTime()).toBe(Math.floor((NOW + 24 * HOUR) / 1000) * 1000);
      expect(leaf.publicKey.export({ format: 'jwk' })).toMatchObject({
        kty: 'EC',
        crv: 'P-256',
        x: pki.leaf.publicJwk.x,
        y: pki.leaf.publicJwk.y,
      });
    });

    it('uses an issuer key identifier given by the caller instead of deriving one', async () => {
      const root = await generateKey();
      const child = await generateKey();
      const recorded = new Uint8Array(20).fill(7);
      const der = await buildCertificate(
        {
          subject: { commonName: 'Child CA', organization: 'Test' },
          issuer: { commonName: 'Test Root CA', organization: 'Test' },
          subjectPublicKey: child.publicJwk,
          issuerPublicKey: root.publicJwk,
          issuerKeyIdentifier: recorded,
          notBefore: new Date(NOW - 1000),
          notAfter: new Date(NOW + 100_000),
          isCA: true,
          pathLength: 0,
        },
        signer(root)
      );
      expect(parseCertificate(der).authorityKeyIdentifier).toEqual(recorded);
    });

    it('carries subject and authority key identifiers that match', async () => {
      const pki = await makePki();
      const ca = parseCertificate(pki.caCert);
      const leaf = parseCertificate(pki.leafCert);
      expect(leaf.authorityKeyIdentifier).toEqual(ca.subjectKeyIdentifier);
      expect(leaf.subjectKeyIdentifier).toEqual(
        await keyIdentifier(p256PointFromJwk(pki.leaf.publicJwk))
      );
      expect(leaf.subjectKeyIdentifier).toHaveLength(20);
    });

    it('round-trips through the parser', async () => {
      const pki = await makePki();
      const leaf = parseCertificate(pki.leafCert);
      expect(leaf.isCA).toBe(false);
      expect(leaf.digitalSignature).toBe(true);
      expect(leaf.keyCertSign).toBe(false);
      expect(leaf.dnsNames).toEqual([HOST]);
      expect(leaf.publicPoint).toEqual(p256PointFromJwk(pki.leaf.publicJwk));
      expect(leaf.notAfter.getTime()).toBe(Math.floor((NOW + 24 * HOUR) / 1000) * 1000);

      const ca = parseCertificate(pki.caCert);
      expect(ca.isCA).toBe(true);
      expect(ca.keyCertSign).toBe(true);
      expect(ca.pathLength).toBe(0);
      expect(await verifyCertificateSignature(leaf, ca.publicPoint)).toBe(true);
      expect(
        await verifyCertificateSignature(leaf, parseCertificate(pki.rootCert).publicPoint)
      ).toBe(false);
    });

    it('handles names longer than 127 bytes (long-form DER lengths)', async () => {
      const root = await generateKey();
      const long = 'O'.repeat(300);
      const cert = await buildCertificate(
        {
          subject: { commonName: 'Long Name CA', organization: long },
          issuer: { commonName: 'Long Name CA', organization: long },
          subjectPublicKey: root.publicJwk,
          issuerPublicKey: root.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          isCA: true,
        },
        signer(root)
      );
      const parsed = parseCertificate(cert);
      expect(parsed.subjectName).toEqual(parsed.issuerName);
      expect(new X509Certificate(cert).subject).toContain('O'.repeat(300));
      expect(await verifyCertificateSignature(parsed, parsed.publicPoint)).toBe(true);
    });

    it('uses GeneralizedTime from the year 2050', async () => {
      const root = await generateKey();
      const cert = await buildCertificate(
        {
          subject: { commonName: 'Far CA' },
          issuer: { commonName: 'Far CA' },
          subjectPublicKey: root.publicJwk,
          issuerPublicKey: root.publicJwk,
          notBefore: new Date(NOW),
          notAfter: new Date(Date.UTC(2060, 0, 1)),
          isCA: true,
        },
        signer(root)
      );
      expect(parseCertificate(cert).notAfter.getUTCFullYear()).toBe(2060);
      expect(new X509Certificate(cert).validTo).toContain('2060');
    });
  });

  describe('build input checks', () => {
    it('refuses a leaf without a DNS name, a wildcard, or a path length', async () => {
      const key = await generateKey();
      const base = {
        subject: { commonName: HOST },
        issuer: { commonName: 'CA' },
        subjectPublicKey: key.publicJwk,
        issuerPublicKey: key.publicJwk,
        notBefore: new Date(NOW),
        notAfter: new Date(NOW + HOUR),
        isCA: false,
      };
      await expect(buildCertificate(base, signer(key))).rejects.toThrow('leaf_requires_dns_name');
      await expect(
        buildCertificate({ ...base, dnsNames: ['*.example.com'] }, signer(key))
      ).rejects.toThrow('invalid_dns_name');
      await expect(
        buildCertificate({ ...base, dnsNames: [HOST], pathLength: 0 }, signer(key))
      ).rejects.toThrow('path_length_requires_ca');
      await expect(
        buildCertificate({ ...base, dnsNames: [HOST], notAfter: new Date(NOW - HOUR) }, signer(key))
      ).rejects.toThrow('invalid_validity');
    });

    it('refuses public keys that are not P-256 public JWKs', async () => {
      expect(() => p256PointFromJwk({ kty: 'RSA' })).toThrow('unsupported_public_key');
      expect(() => p256PointFromJwk({ kty: 'EC', crv: 'P-384', x: 'AA', y: 'AA' })).toThrow();
      const key = await generateKey();
      expect(() => p256PointFromJwk({ ...key.publicJwk, d: 'AA' })).toThrow(
        'unsupported_public_key'
      );
    });
  });

  describe('parser strictness', () => {
    it('rejects trailing bytes, truncation and garbage', async () => {
      const pki = await makePki();
      expect(() => parseCertificate(new Uint8Array([...pki.leafCert, 0]))).toThrow();
      expect(() => parseCertificate(pki.leafCert.slice(0, pki.leafCert.length - 1))).toThrow();
      expect(() => parseCertificate(new Uint8Array([0x30, 0x80, 0x00, 0x00]))).toThrow(
        'invalid_der'
      );
      expect(() => parseCertificate(new Uint8Array())).toThrow();
    });

    it('rejects a different signature algorithm', async () => {
      const pki = await makePki();
      const tampered = Uint8Array.from(pki.leafCert);
      // ecdsa-with-SHA256 ends in 0x02; turn the final OID byte into ecdsa-with-SHA384 (0x03).
      const needle = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
      for (let i = 0; i + needle.length <= tampered.length; i += 1) {
        if (needle.every((value, offset) => tampered[i + offset] === value)) {
          tampered[i + needle.length - 1] = 0x03;
        }
      }
      expect(() => parseCertificate(tampered)).toThrow('unsupported_signature_algorithm');
    });
  });

  describe('strict DER reading', () => {
    const OID_EKU = '2.5.29.37';

    it('rejects signature integers that are negative, non-minimal or zero', () => {
      const raw = new Uint8Array(64).fill(1);
      expect(ecdsaDerToRaw(ecdsaRawToDer(raw))).toEqual(raw);
      const bad: Record<string, number[]> = {
        // r is the single octet 0x81: negative in DER, because the sign octet is missing.
        negative: [0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01],
        // r is 00 01: a redundant leading zero.
        padded: [0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01],
        // r is zero, which is not a valid ECDSA value.
        zero: [0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01],
        // An extra element after s.
        trailing: [0x30, 0x08, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x05, 0x00],
        // Only one INTEGER.
        single: [0x30, 0x03, 0x02, 0x01, 0x01],
      };
      for (const [label, bytes] of Object.entries(bad)) {
        expect(() => ecdsaDerToRaw(Uint8Array.from(bytes)), label).toThrow(
          'invalid_ecdsa_signature'
        );
      }
      // The same shapes with valid integers are accepted.
      expect(
        ecdsaDerToRaw(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]))[31]
      ).toBe(1);
    });

    it('reads a path length of 128 and more as written, not as one truncated byte', async () => {
      const key = await generateKey();
      for (const pathLength of [0, 1, 127, 128, 200]) {
        const cert = await buildCertificate(
          {
            subject: { commonName: 'CA' },
            issuer: { commonName: 'CA' },
            subjectPublicKey: key.publicJwk,
            issuerPublicKey: key.publicJwk,
            notBefore: new Date(NOW - HOUR),
            notAfter: new Date(NOW + HOUR),
            isCA: true,
            pathLength,
          },
          signer(key)
        );
        expect(parseCertificate(cert).pathLength).toBe(pathLength);
      }
    });

    it('refuses non-minimal length encodings', () => {
      expect(() => parseCertificate(Uint8Array.from([0x30, 0x81, 0x05, 1, 2, 3, 4, 5]))).toThrow(
        'invalid_der'
      );
      expect(() =>
        parseCertificate(Uint8Array.from([0x30, 0x82, 0x00, 0x05, 1, 2, 3, 4, 5]))
      ).toThrow('invalid_der');
    });

    async function certWith(extra: { oid: string; critical: boolean; value: Uint8Array }[]) {
      const key = await generateKey();
      return buildCertificate(
        {
          subject: { commonName: 'CA' },
          issuer: { commonName: 'CA' },
          subjectPublicKey: key.publicJwk,
          issuerPublicKey: key.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          isCA: true,
          extraExtensions: extra,
        },
        signer(key)
      );
    }

    it('refuses unknown critical extensions and ignores unknown non-critical ones', async () => {
      // extKeyUsage with an arbitrary purpose, as a stand-in for an extension we do not process.
      const value = Uint8Array.from([
        0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,
      ]);
      await expect(
        (async () => parseCertificate(await certWith([{ oid: OID_EKU, critical: true, value }])))()
      ).rejects.toThrow('unsupported_critical_extension');
      expect(
        parseCertificate(await certWith([{ oid: OID_EKU, critical: false, value }])).isCA
      ).toBe(true);
    });

    it('refuses a duplicated extension', async () => {
      const value = Uint8Array.from([0x30, 0x00]);
      await expect(
        (async () =>
          parseCertificate(await certWith([{ oid: '2.5.29.19', critical: true, value }])))()
      ).rejects.toThrow('duplicate_extension');
    });

    it('refuses dates that do not exist instead of rolling them over', async () => {
      const key = await generateKey();
      const cert = await buildCertificate(
        {
          subject: { commonName: 'CA' },
          issuer: { commonName: 'CA' },
          subjectPublicKey: key.publicJwk,
          issuerPublicKey: key.publicJwk,
          notBefore: new Date(Date.UTC(2027, 1, 1)),
          notAfter: new Date(Date.UTC(2027, 1, 28)),
          isCA: true,
        },
        signer(key)
      );
      expect(parseCertificate(cert).notAfter.toISOString()).toBe('2027-02-28T00:00:00.000Z');
      const bytes = Uint8Array.from(cert);
      const text = new TextEncoder().encode('270228000000Z');
      let patched = false;
      for (let i = 0; i + text.length <= bytes.length && !patched; i += 1) {
        if (text.every((value, offset) => bytes[i + offset] === value)) {
          bytes.set(new TextEncoder().encode('270230'), i); // 30 February 2027
          patched = true;
        }
      }
      expect(patched).toBe(true);
      expect(() => parseCertificate(bytes)).toThrow('invalid_der');
    });

    it('refuses invalid validity dates when building', async () => {
      const key = await generateKey();
      const base = {
        subject: { commonName: 'CA' },
        issuer: { commonName: 'CA' },
        subjectPublicKey: key.publicJwk,
        issuerPublicKey: key.publicJwk,
        isCA: true,
      };
      await expect(
        buildCertificate(
          { ...base, notBefore: new Date(NaN), notAfter: new Date(NOW) },
          signer(key)
        )
      ).rejects.toThrow('invalid_validity');
      await expect(
        buildCertificate(
          { ...base, notBefore: new Date(NOW), notAfter: new Date(NaN) },
          signer(key)
        )
      ).rejects.toThrow('invalid_validity');
    });

    it('keeps a caller-supplied serial number as given', async () => {
      const key = await generateKey();
      const make = (serial: Uint8Array) =>
        buildCertificate(
          {
            subject: { commonName: 'CA' },
            issuer: { commonName: 'CA' },
            subjectPublicKey: key.publicJwk,
            issuerPublicKey: key.publicJwk,
            notBefore: new Date(NOW - HOUR),
            notAfter: new Date(NOW + HOUR),
            isCA: true,
            serial,
          },
          signer(key)
        );
      expect(new X509Certificate(await make(Uint8Array.of(0x81))).serialNumber).toBe('81');
      expect(new X509Certificate(await make(Uint8Array.of(0x01))).serialNumber).toBe('01');
      expect(new X509Certificate(await make(Uint8Array.of(0x80))).serialNumber).toBe('80');
      await expect(make(Uint8Array.of(0, 0))).rejects.toThrow('invalid_serial');
      await expect(make(new Uint8Array(21).fill(1))).rejects.toThrow('invalid_serial');
      await expect(make(new Uint8Array(20).fill(0xff))).rejects.toThrow('invalid_serial');
      // 20 octets with the top bit clear is the largest allowed.
      await expect(make(new Uint8Array(20).fill(0x7f))).resolves.toBeDefined();
    });

    it('encodes and decodes object identifiers by X.690, not by this module alone', () => {
      // Known DER contents: 2.999.3 is the X.690 8.19.5 example, 1.2.840.113549 is the RSADSI arc.
      expect(Array.from(derOid('2.999.3'))).toEqual([0x06, 0x03, 0x88, 0x37, 0x03]);
      expect(decodeOid(Uint8Array.from([0x88, 0x37, 0x03]))).toBe('2.999.3');
      expect(Array.from(derOid('1.2.840.113549'))).toEqual([
        0x06, 0x06, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
      ]);
      expect(decodeOid(Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d]))).toBe(
        '1.2.840.113549'
      );
      expect(decodeOid(Uint8Array.from([0x55, 0x1d, 0x13]))).toBe('2.5.29.19');
      for (const dotted of [
        '0.9.1',
        '1.39.4',
        '2.80.1',
        '2.999.3',
        '2.5.29.19',
        '1.3.6.1.5.5.7.3.1',
      ]) {
        expect(decodeOid(derOid(dotted).slice(2))).toBe(dotted);
      }
      // Non-minimal sub-identifier, unterminated sub-identifier, and arcs the encoding cannot hold.
      expect(() => decodeOid(Uint8Array.from([0x2a, 0x80, 0x01]))).toThrow('invalid_der');
      expect(() => decodeOid(Uint8Array.from([0x2a, 0x86]))).toThrow('invalid_der');
      expect(() => derOid('3.1')).toThrow('invalid_oid');
      expect(() => derOid('1.40')).toThrow('invalid_oid');
    });

    it('reads a CA subject whose attributes use other string types', async () => {
      const pki = await makePki();
      const bytes = Uint8Array.from(pki.caCert);
      // Issuer and subject both carry the organization "Test" as a UTF8String (0c 04 54 65 ...).
      // The subject comes after the issuer and the validity: relabel the last one as a BMPString.
      let at = -1;
      for (let i = 0; i + 4 <= bytes.length; i += 1) {
        if (
          bytes[i] === 0x0c &&
          bytes[i + 1] === 0x04 &&
          bytes[i + 2] === 0x54 &&
          bytes[i + 3] === 0x65
        ) {
          at = i;
        }
      }
      expect(at).toBeGreaterThan(0);
      bytes[at] = 0x1e;
      const parsed = parseCertificate(bytes);
      expect(parsed.subjectHasOtherAttributes).toBe(true);
      expect(parsed.subjectCommonNames).toEqual(['Test Issuing CA']);
      // The relabelled attribute is in the subject, not the issuer.
      expect(Array.from(parsed.subjectName)).toContain(0x1e);
      expect(Array.from(parsed.issuerName)).not.toContain(0x1e);
    });

    it('keeps a byte order mark in a common name instead of dropping it', async () => {
      const pki = await makePki({ leafCommonName: `\uFEFF${HOST}` });
      expect(parseCertificate(pki.leafCert).subjectCommonNames).toEqual([`\uFEFF${HOST}`]);
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
          authrimProfile: true,
        })
      ).rejects.toThrow('leaf_subject_mismatch');
    });

    it('refuses a leaf that names its issuer by another key identifier', async () => {
      const pki = await makePki();
      const other = await buildCertificate(
        {
          subject: { commonName: HOST },
          issuer: { commonName: 'Test Issuing CA', organization: 'Test' },
          subjectPublicKey: pki.leaf.publicJwk,
          issuerPublicKey: pki.root.publicJwk, // AKI of the root, signature of the issuing CA
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          dnsNames: [HOST],
          isCA: false,
        },
        signer(pki.ca)
      );
      const chain = [bytesToBase64(other), bytesToBase64(pki.caCert)];
      const check = { publicKey: pki.leaf.publicJwk, issuerHost: HOST, now: NOW };
      await expect(
        validateVcSigningChain(chain, { ...check, authrimProfile: true })
      ).rejects.toThrow('authority_key_identifier_mismatch');
      // The signature is correct, so outside the profile it is a valid chain.
      await expect(validateVcSigningChain(chain, check)).resolves.toBeDefined();
    });

    it('refuses key usages other than digitalSignature on the leaf and certificate signing on the CA', async () => {
      const pki = await makePki();
      const tamper = (der: Uint8Array, from: number[], to: number[]) => {
        const bytes = Uint8Array.from(der);
        for (let i = 0; i + from.length <= bytes.length; i += 1) {
          if (from.every((value, offset) => bytes[i + offset] === value)) {
            bytes.set(to, i);
            return bytes;
          }
        }
        throw new Error('pattern not found');
      };
      const check = {
        publicKey: pki.leaf.publicJwk,
        issuerHost: HOST,
        now: NOW,
        authrimProfile: true,
      };
      // Leaf keyUsage 03 02 07 80 -> digitalSignature and keyCertSign: 03 02 02 84.
      const leaf = tamper(pki.leafCert, [0x03, 0x02, 0x07, 0x80], [0x03, 0x02, 0x02, 0x84]);
      await expect(
        validateVcSigningChain([bytesToBase64(leaf), bytesToBase64(pki.caCert)], check)
      ).rejects.toThrow('key_usage_invalid');
      // CA keyUsage 03 02 01 06 -> also digitalSignature: 03 02 01 86.
      const ca = tamper(pki.caCert, [0x03, 0x02, 0x01, 0x06], [0x03, 0x02, 0x01, 0x86]);
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(ca)], check)
      ).rejects.toThrow('key_usage_invalid');
    });

    it('refuses a leaf with an organization when building (the Authrim leaf is named by its host)', async () => {
      const key = await generateKey();
      await expect(
        buildCertificate(
          {
            subject: { commonName: HOST, organization: 'Org' },
            issuer: { commonName: 'CA' },
            subjectPublicKey: key.publicJwk,
            issuerPublicKey: key.publicJwk,
            notBefore: new Date(NOW - HOUR),
            notAfter: new Date(NOW + HOUR),
            dnsNames: [HOST],
            isCA: false,
          },
          signer(key)
        )
      ).rejects.toThrow('leaf_subject_must_be_common_name_only');
    });

    it('round-trips object identifiers with arcs beyond the safe integer range', () => {
      const uuidArc = '2.25.340282366920938463463374607431768211455'; // the UUID arc, 2^128 - 1
      expect(decodeOid(derOid(uuidArc).slice(2))).toBe(uuidArc);
      const huge = '1.2.9007199254740993'; // 2^53 + 1
      expect(decodeOid(derOid(huge).slice(2))).toBe(huge);
      expect(() => derOid('1.2.03')).toThrow('invalid_oid');
      expect(() => derOid('1.2.x')).toThrow('invalid_oid');
    });

    it('skips an unknown non-critical extension whose OID has a very large arc', async () => {
      const key = await generateKey();
      const cert = await buildCertificate(
        {
          subject: { commonName: 'CA' },
          issuer: { commonName: 'CA' },
          subjectPublicKey: key.publicJwk,
          issuerPublicKey: key.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          isCA: true,
          extraExtensions: [
            {
              oid: '2.25.340282366920938463463374607431768211455',
              critical: false,
              value: Uint8Array.from([0x05, 0x00]),
            },
          ],
        },
        signer(key)
      );
      expect(parseCertificate(cert).isCA).toBe(true);
    });

    it('requires the key usage bits to be exactly the profile, including further octets', async () => {
      const profile = { issuerHost: HOST, now: NOW, authrimProfile: true };
      // decipherOnly is bit 8, in a second octet: invisible to a check of the first octet only.
      const leafExtra = await makePki({ leafKeyUsage: [0, 8] });
      expect(parseCertificate(leafExtra.leafCert).keyUsageValue).toEqual(
        Uint8Array.of(0x07, 0x80, 0x80)
      );
      await expect(
        validateVcSigningChain(
          [bytesToBase64(leafExtra.leafCert), bytesToBase64(leafExtra.caCert)],
          {
            ...profile,
            publicKey: leafExtra.leaf.publicJwk,
          }
        )
      ).rejects.toThrow('key_usage_invalid');
      const caExtra = await makePki({ caKeyUsage: [5, 6, 8] });
      await expect(
        validateVcSigningChain([bytesToBase64(caExtra.leafCert), bytesToBase64(caExtra.caCert)], {
          ...profile,
          publicKey: caExtra.leaf.publicJwk,
        })
      ).rejects.toThrow('key_usage_invalid');
      // The leaf signing certificates is not a credential signer.
      const leafCaUsage = await makePki({ leafKeyUsage: [0, 5] });
      await expect(
        validateVcSigningChain(
          [bytesToBase64(leafCaUsage.leafCert), bytesToBase64(leafCaUsage.caCert)],
          {
            ...profile,
            publicKey: leafCaUsage.leaf.publicJwk,
          }
        )
      ).rejects.toThrow('key_usage_invalid');
    });

    it('requires present, non-critical key identifiers on both certificates', async () => {
      const profile = { issuerHost: HOST, now: NOW, authrimProfile: true };
      const cases: [string, Parameters<typeof makePki>[0], string][] = [
        ['critical leaf AKI', { leafAki: 'critical' }, 'key_identifier_critical'],
        ['critical leaf SKI', { leafSki: 'critical' }, 'key_identifier_critical'],
        ['critical CA SKI', { caSki: 'critical' }, 'key_identifier_critical'],
        ['critical CA AKI', { caAki: 'critical' }, 'key_identifier_critical'],
        ['missing CA AKI', { caAki: 'omit' }, 'key_identifier_missing'],
        ['missing CA SKI', { caSki: 'omit' }, 'key_identifier_missing'],
        ['missing leaf AKI', { leafAki: 'omit' }, 'key_identifier_missing'],
        ['missing leaf SKI', { leafSki: 'omit' }, 'key_identifier_missing'],
      ];
      for (const [label, options, error] of cases) {
        const pki = await makePki(options);
        await expect(
          validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)], {
            ...profile,
            publicKey: pki.leaf.publicJwk,
          }),
          label
        ).rejects.toThrow(error);
      }
    });

    it('compares the issuer host to the SAN without regard to ASCII case', async () => {
      const pki = await makePki();
      const bytes = Uint8Array.from(pki.leafCert);
      const needle = new TextEncoder().encode(HOST);
      let at = -1;
      for (let i = 0; i + needle.length <= bytes.length; i += 1) {
        if (needle.every((value, offset) => bytes[i + offset] === value)) at = i;
      }
      expect(at).toBeGreaterThan(0); // the last occurrence is the subjectAltName entry
      bytes[at] = 'I'.charCodeAt(0);
      expect(parseCertificate(bytes).dnsNames).toEqual([`I${HOST.slice(1)}`]);
      // The host check passes; the altered SAN then fails the signature, which is the next check.
      await expect(
        validateVcSigningChain([bytesToBase64(bytes), bytesToBase64(pki.caCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('invalid_certificate_signature');
    });

    it('limits the leaf commonName to 64 characters when building and in the profile', async () => {
      const key = await generateKey();
      const host = `${'a'.repeat(60)}.example.com`; // 72 characters, a valid DNS name
      expect(isCertificateHostName(host)).toBe(true);
      await expect(
        buildCertificate(
          {
            subject: { commonName: host },
            issuer: { commonName: 'CA' },
            subjectPublicKey: key.publicJwk,
            issuerPublicKey: key.publicJwk,
            notBefore: new Date(NOW - HOUR),
            notAfter: new Date(NOW + HOUR),
            dnsNames: [host],
            isCA: false,
          },
          signer(key)
        )
      ).rejects.toThrow('common_name_too_long');
      const pki = await makePki();
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: host,
          now: NOW,
          authrimProfile: true,
        })
      ).rejects.toThrow('common_name_too_long');
    });

    it('returns x5c in canonical base64 whatever spelling was supplied', async () => {
      // Find a certificate whose DER length is not a multiple of three, so that the last base64
      // character carries unused bits that a lenient decoder ignores.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const pki = await makePki();
        const entries = [bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)];
        const padded = entries.findIndex((entry) => entry.endsWith('='));
        if (padded < 0) continue;
        const entry = entries[padded];
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const lastIndex = entry.indexOf('=') - 1;
        const current = alphabet.indexOf(entry[lastIndex]);
        const variant = alphabet[current + 1] ?? alphabet[current - 1];
        const sloppy = entry.slice(0, lastIndex) + variant + entry.slice(lastIndex + 1);
        // Same bytes under a lenient decoder, a different spelling.
        const lenient = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        expect(lenient(sloppy)).toEqual(lenient(entry));
        expect(sloppy).not.toBe(entry);
        const chain = [...entries];
        chain[padded] = sloppy;
        const info = await validateVcSigningChain(chain, {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        });
        expect(info.x5c).toEqual(entries);
        return;
      }
      throw new Error('no padded certificate encoding found');
    });

    it('generates positive, non-zero random serial numbers within 20 octets', async () => {
      for (let i = 0; i < 30; i += 1) {
        const pki = await makePki();
        // Parsing refuses negative or non-minimal INTEGERs, so a parsed serial is positive.
        const serial = parseCertificate(pki.leafCert).serial;
        expect(serial.length).toBeGreaterThan(0);
        expect(serial.length).toBeLessThanOrEqual(16);
        expect(serial.some((byte) => byte !== 0)).toBe(true);
      }
    });

    it('applies the same 20-octet serial limit when building and when reading', async () => {
      const key = await generateKey();
      const make = (serial: Uint8Array) =>
        buildCertificate(
          {
            subject: { commonName: 'CA' },
            issuer: { commonName: 'CA' },
            subjectPublicKey: key.publicJwk,
            issuerPublicKey: key.publicJwk,
            notBefore: new Date(NOW - HOUR),
            notAfter: new Date(NOW + HOUR),
            isCA: true,
            serial,
          },
          signer(key)
        );
      // 19 octets with the top bit set: 20 octets with the sign octet, allowed on both sides.
      const edge = new Uint8Array(19).fill(0x81);
      const cert = await make(edge);
      expect(parseCertificate(cert).serial).toEqual(edge);
      // 20 octets with the top bit set would need 21: refused when building.
      await expect(make(new Uint8Array(20).fill(0x81))).rejects.toThrow('invalid_serial');
    });

    it('refuses a key usage whose unused bits are not zero', async () => {
      const pki = await makePki();
      const bytes = Uint8Array.from(pki.leafCert);
      // keyUsage extension value BIT STRING: 03 02 07 80 (digitalSignature, 7 unused bits).
      let patched = false;
      for (let i = 0; i + 4 <= bytes.length && !patched; i += 1) {
        if (
          bytes[i] === 0x03 &&
          bytes[i + 1] === 0x02 &&
          bytes[i + 2] === 0x07 &&
          bytes[i + 3] === 0x80
        ) {
          bytes[i + 3] = 0x81; // an unused bit set
          patched = true;
        }
      }
      expect(patched).toBe(true);
      expect(() => parseCertificate(bytes)).toThrow('invalid_certificate');
    });

    it('refuses an extended key usage in the Authrim profile, critical or not', async () => {
      const eku = Uint8Array.from([
        0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,
      ]);
      const pki = await makePki({ leafExtra: [{ oid: '2.5.29.37', critical: false, value: eku }] });
      expect(parseCertificate(pki.leafCert).hasExtendedKeyUsage).toBe(true);
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
          authrimProfile: true,
        })
      ).rejects.toThrow('extended_key_usage_not_allowed');
      // Outside the profile the same chain is a valid chain.
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).resolves.toBeDefined();
    });
  });

  describe('validateVcSigningChain', () => {
    async function chainOf(pki: Awaited<ReturnType<typeof makePki>>) {
      return [bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)];
    }

    it('accepts leaf plus issuing CA and returns the x5c entries', async () => {
      const pki = await makePki();
      const chain = await chainOf(pki);
      const info = await validateVcSigningChain(chain, {
        publicKey: pki.leaf.publicJwk,
        issuerHost: HOST,
        now: NOW,
      });
      expect(info.x5c).toEqual(chain);
      expect(info.leafNotAfter).toBe(Math.floor((NOW + 24 * HOUR) / 1000) * 1000);
    });

    it('is case-insensitive about the host the caller names', async () => {
      const pki = await makePki();
      await expect(
        validateVcSigningChain(await chainOf(pki), {
          publicKey: pki.leaf.publicJwk,
          issuerHost: 'Issuer.Example.com',
          now: NOW,
        })
      ).resolves.toBeDefined();
    });

    it('refuses a leaf that certifies another key', async () => {
      const pki = await makePki();
      const other = await generateKey();
      await expect(
        validateVcSigningChain(await chainOf(pki), {
          publicKey: other.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('leaf_key_mismatch');
    });

    it('refuses a leaf that names another host', async () => {
      const pki = await makePki({ leafHost: 'other.example.com' });
      await expect(
        validateVcSigningChain(await chainOf(pki), {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('leaf_host_mismatch');
    });

    it('refuses expired and not-yet-valid certificates', async () => {
      const pki = await makePki();
      const check = { publicKey: pki.leaf.publicJwk, issuerHost: HOST };
      await expect(
        validateVcSigningChain(await chainOf(pki), { ...check, now: NOW + 48 * HOUR })
      ).rejects.toThrow('certificate_not_valid_now');
      await expect(
        validateVcSigningChain(await chainOf(pki), { ...check, now: NOW - 24 * HOUR })
      ).rejects.toThrow('certificate_not_valid_now');
    });

    it('refuses a chain that contains the self-signed trust anchor', async () => {
      const pki = await makePki();
      const chain = [...(await chainOf(pki)), bytesToBase64(pki.rootCert)];
      await expect(
        validateVcSigningChain(chain, {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('self_signed_certificate_in_chain');
    });

    it('refuses a lone leaf, a self-signed leaf and an empty chain', async () => {
      const pki = await makePki();
      const check = { publicKey: pki.leaf.publicJwk, issuerHost: HOST, now: NOW };
      await expect(validateVcSigningChain([bytesToBase64(pki.leafCert)], check)).rejects.toThrow(
        'invalid_certificate_chain'
      );
      await expect(validateVcSigningChain([], check)).rejects.toThrow('invalid_certificate_chain');

      const selfSigned = await buildCertificate(
        {
          subject: { commonName: HOST },
          issuer: { commonName: HOST },
          subjectPublicKey: pki.leaf.publicJwk,
          issuerPublicKey: pki.leaf.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          dnsNames: [HOST],
          isCA: false,
        },
        signer(pki.leaf)
      );
      await expect(
        validateVcSigningChain([bytesToBase64(selfSigned), bytesToBase64(pki.caCert)], check)
      ).rejects.toThrow('self_signed_certificate_in_chain');
    });

    it('refuses an issuer that is not a CA and a leaf marked as a CA', async () => {
      const pki = await makePki();
      const check = { publicKey: pki.leaf.publicJwk, issuerHost: HOST, now: NOW };
      // The leaf placed in the issuer position.
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(pki.leafCert)], check)
      ).rejects.toThrow();
      // A CA certificate as the leaf.
      await expect(
        validateVcSigningChain([bytesToBase64(pki.caCert), bytesToBase64(pki.rootCert)], {
          ...check,
          publicKey: pki.ca.publicJwk,
        })
      ).rejects.toThrow('leaf_must_not_be_ca');
    });

    it('refuses a chain whose issuer has the right name but did not sign the leaf', async () => {
      const pki = await makePki();
      const stranger = await makePki();
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(stranger.caCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('invalid_certificate_signature');
    });

    it('refuses a chain whose next certificate has another name than the leaf issuer', async () => {
      const pki = await makePki();
      const otherCa = await generateKey();
      const otherCaCert = await buildCertificate(
        {
          subject: { commonName: 'Some Other CA' },
          issuer: { commonName: 'Some Other CA' },
          subjectPublicKey: otherCa.publicJwk,
          issuerPublicKey: otherCa.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          isCA: true,
        },
        signer(otherCa)
      );
      await expect(
        validateVcSigningChain([bytesToBase64(pki.leafCert), bytesToBase64(otherCaCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow(/self_signed_certificate_in_chain|issuer_name_mismatch/);
    });

    it('refuses a tampered signature', async () => {
      const pki = await makePki();
      const tampered = Uint8Array.from(pki.leafCert);
      tampered[tampered.length - 1] ^= 0x01;
      await expect(
        validateVcSigningChain([bytesToBase64(tampered), bytesToBase64(pki.caCert)], {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('invalid_certificate_signature');
    });

    it('accepts the Authrim profile and rejects deviations from it', async () => {
      const profile = { issuerHost: HOST, now: NOW, authrimProfile: true };
      const ok = await makePki();
      await expect(
        validateVcSigningChain(await chainOf(ok), { ...profile, publicKey: ok.leaf.publicJwk })
      ).resolves.toBeDefined();

      const wrongCn = await makePki({ leafCommonName: 'other.example.com' });
      await expect(
        validateVcSigningChain(await chainOf(wrongCn), {
          ...profile,
          publicKey: wrongCn.leaf.publicJwk,
        })
      ).rejects.toThrow('leaf_subject_mismatch');

      for (const pathLength of [1, 5]) {
        const open = await makePki({ caPathLength: pathLength });
        await expect(
          validateVcSigningChain(await chainOf(open), {
            ...profile,
            publicKey: open.leaf.publicJwk,
          })
        ).rejects.toThrow('issuing_ca_path_length');
      }
    });

    it('treats a certificate that verifies under its own key as self-signed, whatever its names', async () => {
      const key = await generateKey();
      const ca = await makePki();
      const selfSigned = await buildCertificate(
        {
          subject: { commonName: HOST },
          issuer: { commonName: HOST.toUpperCase() }, // a different DER name, same X.509 name
          subjectPublicKey: key.publicJwk,
          issuerPublicKey: key.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          dnsNames: [HOST],
          isCA: false,
        },
        signer(key)
      );
      await expect(
        validateVcSigningChain([bytesToBase64(selfSigned), bytesToBase64(ca.caCert)], {
          publicKey: key.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('self_signed_certificate_in_chain');
    });

    it('requires an exact chain length and a trusted last certificate when asked', async () => {
      const pki = await makePki();
      const chain = await chainOf(pki);
      const check = { publicKey: pki.leaf.publicJwk, issuerHost: HOST, now: NOW };
      await expect(validateVcSigningChain(chain, { ...check, expectedLength: 3 })).rejects.toThrow(
        'invalid_certificate_chain'
      );
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pki.caCert));
      const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      await expect(
        validateVcSigningChain(chain, {
          ...check,
          expectedLength: 2,
          trustedFinalCertificateSha256: [fingerprint],
        })
      ).resolves.toBeDefined();
      await expect(
        validateVcSigningChain(chain, { ...check, trustedFinalCertificateSha256: ['0'.repeat(64)] })
      ).rejects.toThrow('untrusted_issuing_ca');
      await expect(
        validateVcSigningChain(chain, { ...check, trustedFinalCertificateSha256: [] })
      ).rejects.toThrow('untrusted_issuing_ca');
    });

    it('reports the earliest notAfter of the whole chain', async () => {
      const pki = await makePki({ caNotAfter: NOW + 2 * HOUR });
      const info = await validateVcSigningChain(await chainOf(pki), {
        publicKey: pki.leaf.publicJwk,
        issuerHost: HOST,
        now: NOW,
      });
      expect(info.chainNotAfter).toBe(Math.floor((NOW + 2 * HOUR) / 1000) * 1000);
      expect(info.leafNotAfter).toBeGreaterThan(info.chainNotAfter);
    });

    it('requires the issuer host to be the only name in the leaf', async () => {
      const pki = await makePki({ leafNames: [HOST, 'www.example.com'] });
      await expect(
        validateVcSigningChain(await chainOf(pki), {
          publicKey: pki.leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('leaf_host_mismatch');
    });

    it('refuses a chain that is too large to travel in every credential header', async () => {
      const root = await generateKey();
      const ca = await generateKey();
      const leaf = await generateKey();
      const caCert = await buildCertificate(
        {
          subject: { commonName: 'Big CA', organization: 'O'.repeat(3500) },
          issuer: { commonName: 'Big Root' },
          subjectPublicKey: ca.publicJwk,
          issuerPublicKey: root.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + 10 * HOUR),
          isCA: true,
          pathLength: 0,
        },
        signer(root)
      );
      const leafCert = await buildCertificate(
        {
          subject: { commonName: HOST },
          issuer: { commonName: 'Big CA', organization: 'O'.repeat(3500) },
          subjectPublicKey: leaf.publicJwk,
          issuerPublicKey: ca.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          dnsNames: [HOST],
          isCA: false,
        },
        signer(ca)
      );
      await expect(
        validateVcSigningChain([bytesToBase64(leafCert), bytesToBase64(caCert)], {
          publicKey: leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).rejects.toThrow('certificate_chain_too_large');
    });

    it('treats a renewed CA that keeps its name as self-issued, not self-signed', async () => {
      const oldCa = await generateKey();
      const newCa = await generateKey();
      const leaf = await generateKey();
      const dn = { commonName: 'Renewed Issuing CA' };
      const renewed = await buildCertificate(
        {
          subject: dn,
          issuer: dn,
          subjectPublicKey: newCa.publicJwk,
          issuerPublicKey: oldCa.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + 10 * HOUR),
          isCA: true,
          pathLength: 0,
        },
        signer(oldCa) // signed by the previous CA key: self-issued, not self-signed
      );
      const leafCert = await buildCertificate(
        {
          subject: { commonName: HOST },
          issuer: dn,
          subjectPublicKey: leaf.publicJwk,
          issuerPublicKey: newCa.publicJwk,
          notBefore: new Date(NOW - HOUR),
          notAfter: new Date(NOW + HOUR),
          dnsNames: [HOST],
          isCA: false,
        },
        signer(newCa)
      );
      await expect(
        validateVcSigningChain([bytesToBase64(leafCert), bytesToBase64(renewed)], {
          publicKey: leaf.publicJwk,
          issuerHost: HOST,
          now: NOW,
        })
      ).resolves.toBeDefined();
    });

    it('refuses a path length that is exceeded', async () => {
      const root = await generateKey();
      const ca1 = await generateKey();
      const ca2 = await generateKey();
      const leaf = await generateKey();
      const make = (
        subject: string,
        issuer: string,
        key: TestKey,
        issuerKey: TestKey,
        isCA: boolean,
        pathLength?: number
      ) =>
        buildCertificate(
          {
            subject: { commonName: subject },
            issuer: { commonName: issuer },
            subjectPublicKey: key.publicJwk,
            issuerPublicKey: issuerKey.publicJwk,
            notBefore: new Date(NOW - HOUR),
            notAfter: new Date(NOW + HOUR),
            dnsNames: isCA ? undefined : [HOST],
            isCA,
            pathLength,
          },
          signer(issuerKey)
        );
      const certs = [
        await make(HOST, 'CA2', leaf, ca2, false),
        await make('CA2', 'CA1', ca2, ca1, true, 0),
        await make('CA1', 'Root', ca1, root, true, 5),
      ].map(bytesToBase64);
      // CA1 is allowed one CA below it, but CA2 has pathLen 0 and CA1 sits above it: valid shape.
      await expect(
        validateVcSigningChain(certs, { publicKey: leaf.publicJwk, issuerHost: HOST, now: NOW })
      ).resolves.toBeDefined();
      // Now CA1 (pathLen 0) above CA2 (pathLen 0): CA1 allows no CA below it.
      const bad = [
        certs[0],
        certs[1],
        bytesToBase64(await make('CA1', 'Root', ca1, root, true, 0)),
      ];
      await expect(
        validateVcSigningChain(bad, { publicKey: leaf.publicJwk, issuerHost: HOST, now: NOW })
      ).rejects.toThrow('path_length_exceeded');
    });
  });
});
