import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, type JWK } from 'jose';
import { bytesToBase64 } from '../x509-certificate';
import { KEY_ATTESTATION_JWT_TYP, verifyKeyAttestation } from '../key-attestation';
import { NOW, generateKey, makePki, type Pki, type TestKey } from './wallet-test-pki';

const NONCE = 'c-nonce-123';

async function keyAttestation(
  pki: Pki,
  attested: JWK[],
  overrides: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    signWith?: TestKey;
    x5c?: string[];
  } = {}
): Promise<string> {
  return new SignJWT({
    iat: NOW,
    exp: NOW + 600,
    nonce: NONCE,
    attested_keys: attested,
    key_storage: ['iso_18045_high'],
    ...overrides.claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: KEY_ATTESTATION_JWT_TYP,
      x5c: overrides.x5c ?? [bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)],
      ...overrides.header,
    })
    .sign((overrides.signWith ?? pki.leafKey).privateKey);
}

describe('verifyKeyAttestation', () => {
  let pki: Pki;
  let proofKey: TestKey;
  beforeAll(async () => {
    pki = await makePki();
    proofKey = await generateKey();
  });

  const verify = async (
    jwt: string,
    extra: Partial<Parameters<typeof verifyKeyAttestation>[0]> = {}
  ) =>
    verifyKeyAttestation({
      jwt,
      anchors: [pki.anchor],
      now: NOW,
      expectedNonce: NONCE,
      proofKey: proofKey.publicJwk,
      requiredKeyStorage: 'iso_18045_high',
      expectedAudience: 'https://issuer.example.com',
      ...extra,
    });

  it('accepts an attestation of the proof key, bound to the nonce, with strong storage', async () => {
    const other = await generateKey();
    const result = await verify(await keyAttestation(pki, [other.publicJwk, proofKey.publicJwk]));
    expect(result).toMatchObject({
      ok: true,
      keyStorage: 'iso_18045_high',
      anchorSha256: pki.anchor.sha256,
      attestedKeyCount: 2,
    });
  });

  it('refuses a proof key that is not among the attested keys', async () => {
    const other = await generateKey();
    expect(await verify(await keyAttestation(pki, [other.publicJwk]))).toEqual({
      ok: false,
      error: 'key_attestation_key_not_attested',
    });
  });

  it('refuses a missing, different or replayed nonce', async () => {
    for (const nonce of [undefined, 'another', '']) {
      const jwt = await keyAttestation(pki, [proofKey.publicJwk], { claims: { nonce } });
      expect(await verify(jwt)).toEqual({ ok: false, error: 'key_attestation_nonce_mismatch' });
    }
  });

  it('applies the required storage level, and any level when none is required', async () => {
    for (const keyStorage of [['iso_18045_moderate'], [], ['software'], undefined]) {
      const jwt = await keyAttestation(pki, [proofKey.publicJwk], {
        claims: { key_storage: keyStorage },
      });
      expect(await verify(jwt)).toEqual({
        ok: false,
        error: 'key_attestation_storage_insufficient',
      });
      expect((await verify(jwt, { requiredKeyStorage: undefined })).ok).toBe(true);
    }
    const moderate = await keyAttestation(pki, [proofKey.publicJwk], {
      claims: { key_storage: ['iso_18045_moderate'] },
    });
    expect((await verify(moderate, { requiredKeyStorage: 'iso_18045_moderate' })).ok).toBe(true);
    expect((await verify(moderate, { requiredKeyStorage: 'iso_18045_basic' })).ok).toBe(true);
  });

  it('refuses a chain that ends at no allowlisted root, and a tampered signature', async () => {
    const jwt = await keyAttestation(pki, [proofKey.publicJwk]);
    const other = await makePki();
    expect(await verify(jwt, { anchors: [other.anchor] })).toEqual({
      ok: false,
      error: 'key_attestation_chain_untrusted',
    });
    expect(await verify(jwt, { anchors: [] })).toEqual({
      ok: false,
      error: 'key_attestation_chain_untrusted',
    });
    const forged = await keyAttestation(pki, [proofKey.publicJwk], {
      signWith: await generateKey(),
    });
    expect(await verify(forged)).toEqual({
      ok: false,
      error: 'key_attestation_signature_invalid',
    });
  });

  it('refuses wrong headers and malformed tokens', async () => {
    for (const header of [
      { typ: 'JWT' },
      { jwk: proofKey.publicJwk },
      { jku: 'https://x.example.com' },
    ]) {
      const jwt = await keyAttestation(pki, [proofKey.publicJwk], { header });
      expect((await verify(jwt)).ok).toBe(false);
    }
    for (const jwt of ['', 'a.b', 'x'.repeat(20_000)]) {
      expect(await verify(jwt)).toEqual({ ok: false, error: 'key_attestation_malformed' });
    }
  });

  it('refuses stale, future and expired attestations and bad key lists', async () => {
    const cases: Record<string, unknown>[] = [
      { iat: NOW - 3 * 24 * 3600 },
      { iat: NOW + 3600 },
      { iat: undefined },
      { exp: NOW - 120 },
      { exp: undefined },
      { nbf: NOW + 3600 },
      { aud: 'https://another-issuer.example.com' },
      { aud: ['https://another-issuer.example.com'] },
      { attested_keys: [] },
      { attested_keys: 'nope' },
      { attested_keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
      { key_storage: 'iso_18045_high' },
    ];
    for (const claims of cases) {
      const jwt = await keyAttestation(pki, [proofKey.publicJwk], { claims });
      expect((await verify(jwt)).ok, JSON.stringify(claims)).toBe(false);
    }
  });

  it('accepts an attestation addressed to this issuer', async () => {
    for (const aud of ['https://issuer.example.com', ['https://issuer.example.com', 'x']]) {
      const jwt = await keyAttestation(pki, [proofKey.publicJwk], {
        claims: { aud, nbf: NOW - 10 },
      });
      expect((await verify(jwt)).ok).toBe(true);
    }
  });

  it('refuses a proof key that is not a public P-256 key', async () => {
    const jwt = await keyAttestation(pki, [proofKey.publicJwk]);
    expect(await verify(jwt, { proofKey: { kty: 'RSA' } })).toEqual({
      ok: false,
      error: 'key_attestation_key_not_attested',
    });
  });
});
