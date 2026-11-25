import { beforeAll, describe, expect, it } from 'vitest';
import { verifyAssertion } from '../domain/app-attest-assertion';
import { verifyAttestation } from '../domain/app-attest-attestation';
import { compareVersions, type AppAttestPolicy } from '../domain/app-attest-policy';
import { buildAllowed, readBuildInfo } from '../domain/app-attest-extensions';
import { parseAssertionAuthData, parseAttestationAuthData } from '../domain/auth-data';
import {
  concat,
  equalBytes,
  fromBase64,
  fromBase64Url,
  fromHex,
  readUint32,
  toBase64,
  toBase64Url,
  toHex,
  utf8,
} from '../domain/bytes';
import {
  decodeOid,
  ecdsaDerToRaw,
  parseCertificate,
  verifyCertificateSignature,
} from '../domain/x509';
import { finishJws, keyAttestationSigningInput } from '../domain/attestation-jwt';
import { bool, cat, cbor, derEcdsa, enc, int, seq, tlv, type CV } from './support/der';
import {
  ext,
  b64,
  makeAppleWorld,
  makeAssertion,
  makeAttestation,
  makeCert,
  type AppleWorld,
} from './support/apple-fixture';
import { genPair, exportSpki } from './support/keys';

const NOW = 1_800_000_000;
const APP_ID = 'TEAM123456.com.authrim.keyring';
let world: AppleWorld;
let policy: AppAttestPolicy;

beforeAll(async () => {
  world = await makeAppleWorld(NOW);
  policy = {
    appIds: [APP_ID],
    environments: ['development', 'production'],
    allowedCategories: [4],
    requireCategory: false,
    categoryByteOrder: 'big',
    appleRootDer: world.rootDer,
    appleRootSha256: world.rootSha256,
  };
});

describe('bytes', () => {
  it('encodes and decodes strictly', () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe('000fff');
    expect(fromHex('000fFF')).toEqual(Uint8Array.of(0, 15, 255));
    expect(fromHex('0')).toBeNull();
    expect(fromHex('zz')).toBeNull();
    expect(toBase64(Uint8Array.of(251, 255))).toBe('+/8=');
    expect(toBase64Url(Uint8Array.of(251, 255))).toBe('-_8');
    expect(fromBase64('+/8=')).toEqual(Uint8Array.of(251, 255));
    expect(fromBase64Url('-_8')).toEqual(Uint8Array.of(251, 255));
    for (const bad of ['', 'abc', 'ab=c', 'a b=', '-_8=']) expect(fromBase64(bad)).toBeNull();
    for (const bad of ['', 'a', 'ab+', 'ab/', 'ab=', 'abcde'])
      expect(fromBase64Url(bad)).toBeNull();
    expect(fromBase64Url('abcd')).not.toBeNull();
    expect(fromBase64Url('abc')).not.toBeNull();
    expect(readUint32(Uint8Array.of(255, 255, 255, 255), 0)).toBe(4294967295);
    expect(readUint32(Uint8Array.of(0, 1, 0, 2, 9), 1)).toBe(0x01000209);
  });
  it('compares in constant shape and concatenates', () => {
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
    expect(concat(Uint8Array.of(1), Uint8Array.of(2, 3))).toEqual(Uint8Array.of(1, 2, 3));
    expect(utf8('é')).toEqual(Uint8Array.of(0xc3, 0xa9));
  });
});

describe('versions and build policy', () => {
  it('compares dotted integers', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.9', '1.2.10')).toBe(-1);
    expect(compareVersions('1.0', '1')).toBe(0);
    expect(compareVersions('1', '1.0.1')).toBe(-1);
    expect(compareVersions('2', '1')).toBe(1);
    expect(compareVersions('1.0.0', '1')).toBe(0);
    expect(compareVersions('1.a', '1')).toBeNull();
    expect(compareVersions('1.1234567890', '1')).toBeNull();
  });
  it('reads categories and refuses malformed ones', () => {
    const k = { category: 'c', bundleVersion: 'v' };
    expect(readBuildInfo(null, k, 'big')).toEqual({});
    expect(readBuildInfo(new Map<string | number, CV>([['c', 0]]), k, 'big')).toEqual({
      validationCategory: 0,
    });
    expect(readBuildInfo(new Map<string | number, CV>([['c', -1]]), k, 'big')).toBe('invalid');
    expect(
      readBuildInfo(new Map<string | number, CV>([['c', Uint8Array.of(1, 0, 0, 0)]]), k, 'little')
    ).toEqual({ validationCategory: 1 });
    expect(
      readBuildInfo(new Map<string | number, CV>([['c', Uint8Array.of(1, 2, 3, 4)]]), k, 'big')
    ).toEqual({ validationCategory: 0x01020304 });
    expect(
      readBuildInfo(new Map<string | number, CV>([['c', Uint8Array.of(1, 0, 0, 0)]]), k, 'big')
    ).toEqual({ validationCategory: 0x01000000 });
    expect(readBuildInfo(new Map<string | number, CV>([['v', '']]), k, 'big')).toBe('invalid');
    expect(readBuildInfo(new Map<string | number, CV>([['v', 'x'.repeat(65)]]), k, 'big')).toBe(
      'invalid'
    );
    expect(readBuildInfo(new Map<string | number, CV>([['v', 'x'.repeat(64)]]), k, 'big')).toEqual({
      bundleVersion: 'x'.repeat(64),
    });
    expect(
      buildAllowed(
        { validationCategory: 4, bundleVersion: '1.0.0.x' },
        { ...policy, minBundleVersion: '1.0' }
      )
    ).toBe(false); // unparsable version
    expect(
      buildAllowed(
        { validationCategory: 4, bundleVersion: '1.0' },
        { ...policy, minBundleVersion: '1.0' }
      )
    ).toBe(true);
  });
});

describe('authenticator data', () => {
  it('rejects short, trailing and non-map extension data', () => {
    expect(parseAssertionAuthData(new Uint8Array(36))).toBeNull();
    const base = new Uint8Array(37);
    expect(parseAssertionAuthData(base)?.extensions).toBeNull();
    expect(
      parseAssertionAuthData(cat(base, cbor(new Map([['a', 1]]) as never)))?.extensions?.get('a')
    ).toBe(1);
    expect(parseAssertionAuthData(cat(base, cbor(5)))).toBeNull(); // not a map
    expect(
      parseAssertionAuthData(cat(base, cbor(new Map([['a', 1]]) as never), Uint8Array.of(0)))
    ).toBeNull(); // trailing
    expect(parseAssertionAuthData(Uint8Array.of(...base.slice(0, 33), 0, 0, 1, 2))?.counter).toBe(
      258
    );
  });
  it('rejects attestation data with a bad credential id length or COSE key', () => {
    const head = new Uint8Array(53);
    const good = (cose: CV, idLength = 32): Uint8Array =>
      cat(head, Uint8Array.of(0, idLength), new Uint8Array(idLength), cbor(cose));
    const key = (over: Record<string, CV> = {}): Map<string | number, CV> =>
      new Map<string | number, CV>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(32)],
        [-3, new Uint8Array(32)],
        ...Object.entries(over).map(([k, v]) => [Number(k), v] as [number, CV]),
      ]);
    expect(parseAttestationAuthData(good(key()))).not.toBeNull();
    expect(parseAttestationAuthData(good(key(), 31))).toBeNull();
    expect(parseAttestationAuthData(good(key({ '1': 1 })))).toBeNull();
    expect(parseAttestationAuthData(good(key({ '3': -8 })))).toBeNull();
    expect(parseAttestationAuthData(good(key({ '-1': 2 })))).toBeNull();
    expect(parseAttestationAuthData(good(key({ '-2': new Uint8Array(31) })))).toBeNull();
    expect(parseAttestationAuthData(good(key({ '-3': 'x' })))).toBeNull();
    expect(parseAttestationAuthData(good(5))).toBeNull();
    expect(parseAttestationAuthData(new Uint8Array(54))).toBeNull();
  });
});

describe('x509 reader', () => {
  it('reads long-form lengths and generalized times, and refuses malformed DER', async () => {
    const pair = await genPair('P-256');
    const spki = await exportSpki(pair.publicKey);
    const der = await makeCert({
      subjectCn: 'x'.repeat(200),
      issuerCn: 'i',
      subjectSpki: spki,
      issuerKey: pair.privateKey,
      issuerCurve: 'P-256',
      hash: 'SHA-256',
      notBefore: NOW,
      notAfter: 2_900_000_000,
      ca: false,
    });
    const cert = parseCertificate(der);
    expect(cert.notAfter).toBe(2_900_000_000);
    expect(cert.notBefore).toBe(NOW);
    expect(cert.curve).toBe('P-256');
    expect(cert.isCA).toBe(false);
    expect(() => parseCertificate(cat(der, Uint8Array.of(0)))).toThrow('der_trailing_bytes');
    expect(() => parseCertificate(der.slice(0, der.length - 3))).toThrow();
    expect(() => parseCertificate(Uint8Array.of(0x31, 0))).toThrow();
    expect(() =>
      parseCertificate(tlv(0x30, tlv(0x30), tlv(0x30), tlv(0x03, Uint8Array.of(0))))
    ).toThrow();
    expect(() => parseCertificate(Uint8Array.of(0x30, 0x81, 0x05))).toThrow('der_non_minimal');
    expect(() => parseCertificate(Uint8Array.of(0x30, 0x80))).toThrow('der_bad_length');
    expect(decodeOid(Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01))).toBe(
      '1.2.840.10045.2.1'
    );
    expect(() => decodeOid(Uint8Array.of(0x2a, 0x86))).toThrow('der_bad_oid');
    expect(() => decodeOid(new Uint8Array(0))).toThrow('der_bad_oid');
  });
  it('converts DER ECDSA signatures with padding and short integers', () => {
    const raw = new Uint8Array(64).fill(0x81);
    expect(ecdsaDerToRaw(derEcdsa(raw), 32)).toEqual(raw);
    const small = new Uint8Array(64);
    small[31] = 1;
    small[63] = 2;
    expect(ecdsaDerToRaw(derEcdsa(small), 32)).toEqual(small);
    expect(() => ecdsaDerToRaw(cat(derEcdsa(raw), Uint8Array.of(0)), 32)).toThrow('ecdsa_trailing');
    expect(() => ecdsaDerToRaw(seq(tlv(0x02, Uint8Array.of(1))), 32)).toThrow('ecdsa_shape');
    expect(() =>
      ecdsaDerToRaw(seq(tlv(0x02, new Uint8Array(33).fill(1)), tlv(0x02, Uint8Array.of(1))), 32)
    ).toThrow('ecdsa_length');
  });
  it('verifies signatures only for allowed algorithms and matching names', async () => {
    const inter = parseCertificate(world.intermediateDer);
    const root = parseCertificate(world.rootDer);
    expect(
      await verifyCertificateSignature(inter, root, [{ curve: 'P-384', hash: 'SHA-384' }])
    ).toBe(true);
    expect(
      await verifyCertificateSignature(inter, root, [{ curve: 'P-384', hash: 'SHA-256' }])
    ).toBe(false);
    expect(
      await verifyCertificateSignature(inter, root, [{ curve: 'P-256', hash: 'SHA-384' }])
    ).toBe(false);
    expect(
      await verifyCertificateSignature(root, inter, [{ curve: 'P-384', hash: 'SHA-384' }])
    ).toBe(false); // names differ
    expect(inter.isCA && inter.keyCertSign && inter.hasBasicConstraints).toBe(true);
  });
});

describe('chain name check and returned hashes', () => {
  it('refuses a correctly signed certificate whose issuer name does not match the issuer', async () => {
    const pair = await genPair('P-384');
    const subject = await genPair('P-256');
    const issuerSpki = await exportSpki(pair.publicKey);
    const issuerDer = await makeCert({
      subjectCn: 'CA',
      issuerCn: 'CA',
      subjectSpki: issuerSpki,
      issuerKey: pair.privateKey,
      issuerCurve: 'P-384',
      hash: 'SHA-384',
      notBefore: NOW - 100,
      notAfter: NOW + 100,
      ca: true,
    });
    const spki = await exportSpki(subject.publicKey);
    const sign = (issuerCn: string) =>
      makeCert({
        subjectCn: 'leaf',
        issuerCn,
        subjectSpki: spki,
        issuerKey: pair.privateKey,
        issuerCurve: 'P-384',
        hash: 'SHA-384',
        notBefore: NOW - 100,
        notAfter: NOW + 100,
        ca: false,
      });
    const allowed = [{ curve: 'P-384', hash: 'SHA-384' }] as const;
    const issuer = parseCertificate(issuerDer);
    expect(
      await verifyCertificateSignature(parseCertificate(await sign('CA')), issuer, allowed)
    ).toBe(true); // control
    expect(
      await verifyCertificateSignature(parseCertificate(await sign('Other CA')), issuer, allowed)
    ).toBe(false);
  });

  it('returns hashes computed from the input, not constants', async () => {
    const device = await makeAttestation(world, { challenge: 'a-specific-challenge' });
    const r = await verifyAttestation(
      {
        keyId: device.keyId,
        challenge: device.challenge,
        attestationObject: device.attestationObject,
        now: NOW,
      },
      policy
    );
    if (!r.ok) throw new Error('expected ok');
    const sha = async (b: Uint8Array): Promise<string> =>
      toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', b)));
    expect(r.attestation.attestationSha256).toBe(await sha(fromBase64(device.attestationObject)!));
    expect(r.attestation.challengeSha256).toBe(await sha(enc('a-specific-challenge')));
    expect(r.attestation.keyId).toBe(device.keyId);
  });

  it('refuses revoked build versions and non-finite clocks', async () => {
    expect(
      buildAllowed(
        { validationCategory: 4, bundleVersion: '1.0' },
        { ...policy, revokedBundleVersions: ['1.0'] }
      )
    ).toBe(false);
    expect(
      buildAllowed(
        { validationCategory: 4, bundleVersion: '1.1' },
        { ...policy, revokedBundleVersions: ['1.0'] }
      )
    ).toBe(true);
    const device = await makeAttestation(world);
    const base = {
      keyId: device.keyId,
      challenge: device.challenge,
      attestationObject: device.attestationObject,
    };
    expect(await verifyAttestation({ ...base, now: Number.NaN }, policy)).toEqual({
      ok: false,
      reason: 'malformed_input',
    });
  });
});

describe('attestation boundaries', () => {
  const run = (attestationObject: string, keyId = b64(new Uint8Array(32))) =>
    verifyAttestation({ keyId, challenge: 'c', attestationObject, now: NOW }, policy);
  it('limits the object to 16 KiB', async () => {
    expect(await run(toBase64(new Uint8Array(16 * 1024 + 1)))).toEqual({
      ok: false,
      reason: 'malformed_input',
    });
    expect(await run(toBase64(new Uint8Array(16 * 1024).fill(0xff)))).toEqual({
      ok: false,
      reason: 'cbor_invalid',
    });
  });
  it('accepts a chain exactly at the validity boundaries and refuses one second outside', async () => {
    const device = await makeAttestation(world);
    const at = (now: number) =>
      verifyAttestation(
        {
          keyId: device.keyId,
          challenge: device.challenge,
          attestationObject: device.attestationObject,
          now,
        },
        policy
      );
    expect((await at(NOW - 3600)).ok).toBe(true); // credCert notBefore
    expect(await at(NOW - 3601)).toEqual({ ok: false, reason: 'chain_invalid' });
    expect((await at(NOW + 3 * 86400)).ok).toBe(true); // credCert notAfter
    expect(await at(NOW + 3 * 86400 + 1)).toEqual({ ok: false, reason: 'chain_invalid' });
  });
  it('reads the nonce extension in its accepted shapes only', async () => {
    const check = async (nonceShape?: 'bare' | 'double' | 'nested' | 'garbage') => {
      const device = await makeAttestation(world, { nonceShape });
      return verifyAttestation(
        {
          keyId: device.keyId,
          challenge: device.challenge,
          attestationObject: device.attestationObject,
          now: NOW,
        },
        policy
      );
    };
    expect((await check('bare')).ok).toBe(true);
    expect((await check(undefined)).ok).toBe(true);
    for (const shape of ['double', 'nested', 'garbage'] as const)
      expect(await check(shape)).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });
  it('refuses chain profile violations: CA credCert, non-CA or non-signing intermediate, P-384 credCert, missing constraints', async () => {
    const attempt = async (w: AppleWorld, opts = {}) => {
      const device = await makeAttestation(w, opts);
      return verifyAttestation(
        {
          keyId: device.keyId,
          challenge: device.challenge,
          attestationObject: device.attestationObject,
          now: NOW,
        },
        { ...policy, appleRootDer: w.rootDer, appleRootSha256: w.rootSha256 }
      );
    };
    expect(await attempt(world, { credCa: true })).toEqual({ ok: false, reason: 'chain_invalid' });
    expect(await attempt(world, { credCurve: 'P-384' })).toEqual({
      ok: false,
      reason: 'chain_invalid',
    });
    expect(await attempt(await makeAppleWorld(NOW, { intermediateCa: false }))).toEqual({
      ok: false,
      reason: 'chain_invalid',
    });
    expect(await attempt(await makeAppleWorld(NOW, { intermediateKeyUsage: 'sign' }))).toEqual({
      ok: false,
      reason: 'chain_invalid',
    });
  });
  it('outputs the public key as base64url coordinates of the credCert key', async () => {
    const device = await makeAttestation(world);
    const r = await verifyAttestation(
      {
        keyId: device.keyId,
        challenge: device.challenge,
        attestationObject: device.attestationObject,
        now: NOW,
      },
      policy
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.attestation.publicKeyJwk.x).toBe(toBase64Url(device.point.slice(1, 33)));
    expect(r.attestation.publicKeyJwk.y).toBe(toBase64Url(device.point.slice(33, 65)));
    expect(r.attestation.appIdHash).toBe(
      toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc(APP_ID))))
    );
  });
  it('refuses an assertion with an unusable public key or the wrong CBOR shape', async () => {
    const device = await makeAttestation(world);
    const good = await makeAssertion(device, 'd', { counter: 1 });
    const bad = await verifyAssertion(
      {
        assertion: good,
        clientData: 'd',
        publicPoint: new Uint8Array(65),
        storedCounter: 0,
        appIdHash: '00'.repeat(32),
      },
      policy
    );
    expect(bad).toEqual({ ok: false, reason: 'signature_invalid' });
    const shape = await verifyAssertion(
      {
        assertion: b64(
          cbor(
            new Map<string, CV>([
              ['signature', 1],
              ['authenticatorData', 2],
            ])
          )
        ),
        clientData: 'd',
        publicPoint: device.point,
        storedCounter: 0,
        appIdHash: '00'.repeat(32),
      },
      policy
    );
    expect(shape).toEqual({ ok: false, reason: 'format_invalid' });
  });
  it('limits the assertion size to 4096 bytes', async () => {
    const point = new Uint8Array(65);
    const input = (assertion: string) => ({
      assertion,
      clientData: 'd',
      publicPoint: point,
      storedCounter: 0,
      appIdHash: '00'.repeat(32),
    });
    expect(await verifyAssertion(input(toBase64(new Uint8Array(4097))), policy)).toEqual({
      ok: false,
      reason: 'malformed_input',
    });
    expect(await verifyAssertion(input(toBase64(new Uint8Array(4096).fill(0xff))), policy)).toEqual(
      { ok: false, reason: 'cbor_invalid' }
    );
  });
  it('refuses an assertion for an App ID hash that is not valid hex', async () => {
    const device = await makeAttestation(world);
    const assertion = await makeAssertion(device, 'd', { counter: 1 });
    const result = await verifyAssertion(
      { assertion, clientData: 'd', publicPoint: device.point, storedCounter: 0, appIdHash: 'zz' },
      policy
    );
    expect(result).toEqual({ ok: false, reason: 'app_id_mismatch' });
  });
});

describe('JWS assembly', () => {
  it('limits the finished JWS to 16 KiB and a 64-byte signature', () => {
    const sig = new Uint8Array(64);
    const sigLength = toBase64Url(sig).length + 1;
    const exact = 'a'.repeat(16 * 1024 - sigLength);
    expect(finishJws(exact, sig)?.length).toBe(16 * 1024);
    expect(finishJws(exact + 'a', sig)).toBeNull();
    expect(finishJws('x', new Uint8Array(65))).toBeNull();
    expect(finishJws('x', new Uint8Array(63))).toBeNull();
  });
  it('encodes the signing input as two base64url segments', () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: `${'A'.repeat(42)}Q` } as const;
    const { signingInput, signingBytes } = keyAttestationSigningInput([Uint8Array.of(9)], {
      iat: NOW,
      exp: NOW + 60,
      nonce: 'n',
      attested_keys: [jwk],
      key_storage: ['iso_18045_high'],
    });
    expect(signingInput.split('.')).toHaveLength(2);
    expect(new TextDecoder().decode(signingBytes)).toBe(signingInput);
    expect(fromBase64Url(signingInput.split('.')[1])).not.toBeNull();
  });
});

describe('strict DER and base64', () => {
  const rs = (r: number[], s2: number[]): Uint8Array =>
    seq(tlv(0x02, Uint8Array.from(r)), tlv(0x02, Uint8Array.from(s2)));
  it('refuses negative, empty, non-minimal and oversized ECDSA integers', () => {
    expect(() => ecdsaDerToRaw(rs([0x80], [1]), 32)).toThrow('ecdsa_integer'); // negative
    expect(() => ecdsaDerToRaw(rs([], [1]), 32)).toThrow('ecdsa_integer'); // empty
    expect(() => ecdsaDerToRaw(rs([0, 1], [1]), 32)).toThrow('ecdsa_integer'); // redundant zero
    expect(() => ecdsaDerToRaw(rs([0, 0, 0x80], [1]), 32)).toThrow('ecdsa_integer');
    expect(() => ecdsaDerToRaw(rs([1, ...new Array<number>(32).fill(1)], [1]), 32)).toThrow(
      'ecdsa_length'
    );
    expect(ecdsaDerToRaw(rs([0, 0x80], [1]), 32)[31]).toBe(0x80); // one sign byte is fine
  });
  it('accepts only the canonical base64 text of a byte string', () => {
    expect(fromBase64('AA==')).toEqual(Uint8Array.of(0));
    expect(fromBase64('AB==')).toBeNull(); // same byte, non-zero padding bits
    expect(fromBase64('AAB=')).toBeNull();
    expect(fromBase64Url('AB')).toBeNull();
    expect(fromBase64Url('AA')).toEqual(Uint8Array.of(0));
  });
  it('refuses certificate times that do not exist', async () => {
    const pair = await genPair('P-256');
    const spki = await exportSpki(pair.publicKey);
    const good = await makeCert({
      subjectCn: 'a',
      issuerCn: 'a',
      subjectSpki: spki,
      issuerKey: pair.privateKey,
      issuerCurve: 'P-256',
      hash: 'SHA-256',
      notBefore: NOW,
      notAfter: NOW + 10,
      ca: false,
    });
    const text = new TextDecoder().decode(
      good.slice(good.indexOf(0x17) + 2, good.indexOf(0x17) + 15)
    );
    expect(text).toMatch(/^\d{12}Z$/u);
    const patched = (replacement: string): Uint8Array => {
      const at = good.indexOf(0x17) + 2;
      const copy = good.slice();
      copy.set(new TextEncoder().encode(replacement), at);
      return copy;
    };
    expect(() => parseCertificate(patched('261301000000Z'))).toThrow('der_bad_time'); // month 13
    expect(() => parseCertificate(patched('260231000000Z'))).toThrow('der_bad_time'); // 31 February
    expect(() => parseCertificate(patched('260101250000Z'))).toThrow('der_bad_time'); // hour 25
    expect(() => parseCertificate(patched('260101000060Z'))).toThrow('der_bad_time'); // second 60
    expect(parseCertificate(patched('260101000000Z')).notBefore).toBe(Date.UTC(2026, 0, 1) / 1000);
  });
  it('refuses a second extensions wrapper, duplicate extensions and malformed key usage', async () => {
    const pair = await genPair('P-256');
    const spki = await exportSpki(pair.publicKey);
    const base = {
      subjectCn: 'a',
      issuerCn: 'a',
      subjectSpki: spki,
      issuerKey: pair.privateKey,
      issuerCurve: 'P-256',
      hash: 'SHA-256',
      notBefore: NOW,
      notAfter: NOW + 10,
      ca: false,
    } as const;
    expect(() => parseCertificate(new Uint8Array(0))).toThrow();
    await makeCert(base).then((der) => expect(parseCertificate(der).digitalSignature).toBe(true));
    await makeCert({ ...base, extraTbs: tlv(0xa3, seq()) }).then((der) =>
      expect(() => parseCertificate(der)).toThrow('cert_shape')
    );
    await makeCert({ ...base, extraTbs: tlv(0xa1, Uint8Array.of(0, 1)) }).then((der) =>
      expect(() => parseCertificate(der)).toThrow('cert_shape')
    );
    await makeCert({ ...base, keyUsage: { byte: 0x08, unused: 3 } }).then((der) => {
      const cert = parseCertificate(der);
      expect(cert.hasKeyUsage).toBe(true);
      expect(cert.digitalSignature).toBe(false);
    });
    await makeCert({ ...base, keyUsage: { byte: 0x80, unused: 8 } }).then((der) =>
      expect(() => parseCertificate(der)).toThrow('cert_key_usage')
    );
    await makeCert({ ...base, keyUsage: { byte: 0x84, unused: 3 } }).then((der) =>
      expect(() => parseCertificate(der)).toThrow('cert_key_usage')
    ); // a set bit inside the unused area
    await makeCert({ ...base, extra: [ext('2.5.29.15', false, seq())] }).then((der) =>
      expect(() => parseCertificate(der)).toThrow('cert_duplicate_extension')
    );
    await makeCert({ ...base, innerAlgParams: true }).then((der) =>
      expect(() => parseCertificate(der)).toThrow('cert_algorithm_parameters')
    );
    await makeCert({ ...base, outerAlgParams: true }).then((der) =>
      expect(() => parseCertificate(der)).toThrow('cert_algorithm_parameters')
    );
    for (const constraints of [
      seq(bool(true), tlv(0x02, Uint8Array.of(0xff))), // negative pathLen
      seq(bool(true), tlv(0x02, Uint8Array.of(0, 1))), // non-minimal pathLen
      seq(tlv(0x02, Uint8Array.of(1))), // pathLen without CA
      seq(bool(true), int(0), int(1)), // trailing element
      seq(tlv(0x01, Uint8Array.of(1))), // BOOLEAN that is not DER
    ]) {
      await makeCert({
        ...base,
        noBasicConstraints: true,
        extra: [ext('2.5.29.19', true, constraints)],
      }).then((der) => expect(() => parseCertificate(der)).toThrow());
    }
    await makeCert({
      ...base,
      noBasicConstraints: true,
      extra: [ext('2.5.29.19', true, seq(bool(true), int(0)))],
    }).then((der) => expect(parseCertificate(der).isCA).toBe(true));
    await makeCert({ ...base, noBasicConstraints: true }).then((der) =>
      expect(parseCertificate(der).hasBasicConstraints).toBe(false)
    );
  });
  it('refuses a credCert that states a key usage without digital signature', async () => {
    const device = await makeAttestation(world, { credKeyUsage: { byte: 0x08, unused: 3 } });
    const result = await verifyAttestation(
      {
        keyId: device.keyId,
        challenge: device.challenge,
        attestationObject: device.attestationObject,
        now: NOW,
      },
      policy
    );
    expect(result).toEqual({ ok: false, reason: 'chain_invalid' });
  });
});
