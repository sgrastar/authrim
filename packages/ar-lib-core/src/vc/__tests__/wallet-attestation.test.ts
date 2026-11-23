import { describe, it, expect, beforeAll } from 'vitest';
import { bytesToBase64 } from '../x509-certificate';
import { p256JwkThumbprint, verifyWalletAttestation } from '../wallet-attestation';
import {
  CLIENT_ID,
  ISSUER,
  NOW,
  NOW_MS,
  attestationJwt,
  generateKey,
  makePki,
  popJwt,
  type Pki,
  type TestKey,
} from './wallet-test-pki';

function seen() {
  const store = new Set<string>();
  return async (jti: string) => {
    if (store.has(jti)) return false;
    store.add(jti);
    return true;
  };
}

describe('verifyWalletAttestation', () => {
  let pki: Pki;
  let instance: TestKey;

  beforeAll(async () => {
    pki = await makePki();
    instance = await generateKey();
  });

  const verify = async (
    attestation: string,
    pop: string,
    extra: Partial<Parameters<typeof verifyWalletAttestation>[0]> = {}
  ) =>
    verifyWalletAttestation({
      attestation,
      pop,
      audience: ISSUER,
      anchors: [pki.anchor],
      now: NOW,
      consumeJti: seen(),
      ...extra,
    });

  it('accepts a good attestation and returns the client id and instance key thumbprint', async () => {
    const result = await verify(await attestationJwt(pki, instance), await popJwt(instance));
    expect(result).toMatchObject({
      ok: true,
      clientId: CLIENT_ID,
      anchorSha256: pki.anchor.sha256,
    });
    if (result.ok) {
      expect(result.instanceKeyThumbprint).toBe(await p256JwkThumbprint(instance.publicJwk));
    }
  });

  it('accepts a chain that includes the anchor itself', async () => {
    const jwt = await attestationJwt(pki, instance, {
      x5c: [bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert), pki.anchor.certificate],
    });
    expect((await verify(jwt, await popJwt(instance))).ok).toBe(true);
  });

  it('refuses a chain that ends at no allowlisted anchor', async () => {
    const other = await makePki();
    const result = await verify(await attestationJwt(pki, instance), await popJwt(instance), {
      anchors: [other.anchor],
    });
    expect(result).toEqual({ ok: false, error: 'attestation_chain_untrusted' });
    expect(
      await verify(await attestationJwt(pki, instance), await popJwt(instance), { anchors: [] })
    ).toEqual({ ok: false, error: 'attestation_chain_untrusted' });
  });

  it('refuses an anchor whose hash does not match its certificate', async () => {
    const result = await verify(await attestationJwt(pki, instance), await popJwt(instance), {
      anchors: [{ ...pki.anchor, sha256: '0'.repeat(64) }],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses an expired certificate, a CA as leaf and a broken chain order', async () => {
    const expired = await makePki({ leafNotAfter: NOW_MS - 1000 });
    const jwt = await attestationJwt(expired, instance);
    expect(await verify(jwt, await popJwt(instance), { anchors: [expired.anchor] })).toEqual({
      ok: false,
      error: 'attestation_chain_invalid',
    });
    const swapped = await attestationJwt(pki, instance, {
      x5c: [bytesToBase64(pki.caCert), bytesToBase64(pki.leafCert)],
    });
    expect((await verify(swapped, await popJwt(instance))).ok).toBe(false);
    const caAsLeaf = await attestationJwt(pki, instance, {
      x5c: [bytesToBase64(pki.caCert)],
      signWith: pki.caKey,
    });
    expect((await verify(caAsLeaf, await popJwt(instance))).ok).toBe(false);
  });

  it('refuses an attestation not signed by the chain leaf', async () => {
    const forged = await attestationJwt(pki, instance, { signWith: await generateKey() });
    expect(await verify(forged, await popJwt(instance))).toEqual({
      ok: false,
      error: 'attestation_signature_invalid',
    });
  });

  it('refuses wrong headers: type, algorithm and embedded keys', async () => {
    for (const header of [
      { typ: 'JWT' },
      { jwk: instance.publicJwk },
      { jku: 'https://x.example.com/jwks' },
    ]) {
      const jwt = await attestationJwt(pki, instance, { header });
      expect((await verify(jwt, await popJwt(instance))).ok).toBe(false);
    }
  });

  it('refuses bad attestation claims', async () => {
    const cases: Record<string, unknown>[] = [
      { exp: NOW - 120 },
      { exp: undefined },
      { exp: NOW + 7 * 24 * 3600 },
      { sub: '' },
      { sub: 7 },
      { iss: undefined },
      { cnf: {} },
      { cnf: { jwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' } } },
      { cnf: { jwk: { ...instance.publicJwk, d: 'secret' } } },
      { nbf: NOW + 3600 },
    ];
    for (const claims of cases) {
      const jwt = await attestationJwt(pki, instance, { claims });
      const result = await verify(jwt, await popJwt(instance));
      expect(result.ok, JSON.stringify(claims)).toBe(false);
    }
  });

  it('refuses claims that name another issuer or are not yet valid', async () => {
    for (const claims of [
      { aud: 'https://other-op.example.com' },
      { aud: [ISSUER, 'https://other-op.example.com'] },
      { iat: NOW + 3600 },
      { iat: NOW, exp: NOW - 1 + 3600 * 0 },
    ]) {
      const jwt = await attestationJwt(pki, instance, { claims });
      expect((await verify(jwt, await popJwt(instance))).ok, JSON.stringify(claims)).toBe(false);
    }
    // An attestation addressed to this issuer is fine.
    const own = await attestationJwt(pki, instance, { claims: { aud: ISSUER } });
    expect((await verify(own, await popJwt(instance))).ok).toBe(true);
  });

  it('refuses an attestation with no signed starting point for its lifetime', async () => {
    const jwt = await attestationJwt(pki, instance, { claims: { iat: undefined, nbf: undefined } });
    expect((await verify(jwt, await popJwt(instance))).ok).toBe(false);
  });

  it('refuses a PoP that has expired or is not yet valid', async () => {
    const jwt = await attestationJwt(pki, instance);
    for (const claims of [{ exp: NOW - 600 }, { nbf: NOW + 600 }, { exp: 'soon' }]) {
      expect(await verify(jwt, await popJwt(instance, { claims }))).toEqual({
        ok: false,
        error: 'pop_not_fresh',
      });
    }
  });

  it('refuses a leaf limited to another purpose by an extended key usage', async () => {
    const tls = await makePki({
      leafExtra: [
        {
          oid: '2.5.29.37',
          critical: false,
          // SEQUENCE { OID 1.3.6.1.5.5.7.3.1 (serverAuth) }
          value: Uint8Array.from([
            0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,
          ]),
        },
      ],
    });
    const jwt = await attestationJwt(tls, instance);
    expect(await verify(jwt, await popJwt(instance), { anchors: [tls.anchor] })).toEqual({
      ok: false,
      error: 'attestation_chain_invalid',
    });
  });

  it('refuses a request whose client_id differs from the attestation sub', async () => {
    const result = await verify(await attestationJwt(pki, instance), await popJwt(instance), {
      clientId: 'someone-else',
    });
    expect(result).toEqual({ ok: false, error: 'attestation_client_mismatch' });
  });

  it('refuses a PoP signed by another key, for another audience or from another client', async () => {
    const jwt = await attestationJwt(pki, instance);
    const stranger = await generateKey();
    expect(await verify(jwt, await popJwt(stranger))).toEqual({
      ok: false,
      error: 'pop_signature_invalid',
    });
    expect(
      await verify(jwt, await popJwt(instance, { claims: { aud: 'https://other.example.com' } }))
    ).toEqual({ ok: false, error: 'pop_audience_mismatch' });
    expect(
      await verify(jwt, await popJwt(instance, { claims: { aud: [ISSUER, 'https://x'] } }))
    ).toEqual({ ok: false, error: 'pop_audience_mismatch' });
    expect((await verify(jwt, await popJwt(instance, { claims: { iss: 'x' } }))).ok).toBe(false);
  });

  it('refuses stale and future PoPs, and missing or empty jti', async () => {
    const jwt = await attestationJwt(pki, instance);
    expect(await verify(jwt, await popJwt(instance, { claims: { iat: NOW - 600 } }))).toEqual({
      ok: false,
      error: 'pop_not_fresh',
    });
    expect(await verify(jwt, await popJwt(instance, { claims: { iat: NOW + 600 } }))).toEqual({
      ok: false,
      error: 'pop_not_fresh',
    });
    for (const jti of [undefined, '', 5]) {
      expect((await verify(jwt, await popJwt(instance, { claims: { jti } }))).ok).toBe(false);
    }
    expect((await verify(jwt, await popJwt(instance, { header: { typ: 'JWT' } }))).ok).toBe(false);
  });

  it('refuses a replayed PoP and a store that fails', async () => {
    const jwt = await attestationJwt(pki, instance);
    const pop = await popJwt(instance);
    const consumeJti = seen();
    expect((await verify(jwt, pop, { consumeJti })).ok).toBe(true);
    expect(await verify(jwt, pop, { consumeJti })).toEqual({ ok: false, error: 'pop_replayed' });
    const broken = await verify(jwt, await popJwt(instance), {
      consumeJti: async () => {
        throw new Error('store down');
      },
    });
    expect(broken).toEqual({ ok: false, error: 'pop_replayed' });
  });

  it('checks the issuer challenge when one is expected', async () => {
    const jwt = await attestationJwt(pki, instance);
    const ok = await verify(jwt, await popJwt(instance, { claims: { challenge: 'abc' } }), {
      expectedChallenge: 'abc',
    });
    expect(ok.ok).toBe(true);
    const wrong = await verify(jwt, await popJwt(instance), { expectedChallenge: 'abc' });
    expect(wrong.ok).toBe(false);
  });

  it('refuses malformed tokens without throwing', async () => {
    for (const [attestation, pop] of [
      ['', ''],
      ['a.b', 'c.d.e'],
      ['not a jwt', 'x'],
      ['a'.repeat(20_000), 'a.b.c'],
    ]) {
      expect((await verify(attestation, pop)).ok).toBe(false);
    }
  });
});
