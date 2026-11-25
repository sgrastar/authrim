/** Contract test: what the provider signs must be accepted by the OP's real verifiers (ar-lib-core). */
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyKeyAttestation } from '@op-verifiers/key-attestation';
import {
  verifyWalletAttestation,
  type WalletAttestationAnchor,
} from '@op-verifiers/wallet-attestation';
import { SignJWT, exportJWK } from 'jose';
import {
  boundedExpiry,
  chainLimit,
  finishJws,
  keyAttestationSigningInput,
  walletAttestationSigningInput,
  keyAttestationClaims,
  KEY_ATTESTATION_TYP,
  walletAttestationClaims,
  WALLET_ATTESTATION_TYP,
} from '../domain/attestation-jwt';
import { isOnCurve, isPrintableToken, normalizeJwk } from '../domain/client-data';
import { sha256, toHex } from '../domain/bytes';
import { exportSpki, genPair } from './support/keys';
import { makeCert } from './support/apple-fixture';
import { bool, octet, oid, seq, type B } from './support/der';

const NOW = 1_800_000_000;
const DAY = 86400;

interface Signer {
  priv: CryptoKey;
  chain: B[];
  anchor: WalletAttestationAnchor;
}
async function p256(): Promise<{ priv: CryptoKey; spki: B }> {
  const kp = await genPair('P-256');
  return { priv: kp.privateKey, spki: await exportSpki(kp.publicKey) };
}
const b64 = (b: B): string => btoa(String.fromCharCode(...b));

let root: { priv: CryptoKey; spki: B; der: B };
let wallet: Signer;
let key: Signer;
let instance: { publicJwk: { kty: string; crv: string; x: string; y: string }; priv: CryptoKey };

async function makeSigner(
  name: string,
  opts: { eku?: boolean; leafNotAfter?: number } = {}
): Promise<Signer> {
  const inter = await p256();
  const leaf = await p256();
  const interDer = await makeCert({
    subjectCn: name,
    issuerCn: 'Provider Root',
    subjectSpki: inter.spki,
    issuerKey: root.priv,
    issuerCurve: 'P-256',
    hash: 'SHA-256',
    notBefore: NOW - DAY,
    notAfter: NOW + 700 * DAY,
    ca: true,
  });
  const leafDer = await makeCert({
    subjectCn: `${name} leaf`,
    issuerCn: name,
    subjectSpki: leaf.spki,
    issuerKey: inter.priv,
    issuerCurve: 'P-256',
    hash: 'SHA-256',
    notBefore: NOW - DAY,
    notAfter: opts.leafNotAfter ?? NOW + 30 * DAY,
    ca: false,
    extra: opts.eku ? [seq(oid('2.5.29.37'), octet(seq(oid('1.3.6.1.5.5.7.3.2'))))] : [],
  });
  return {
    priv: leaf.priv,
    chain: [leafDer, interDer],
    anchor: { certificate: b64(interDer), sha256: toHex(await sha256(interDer)), label: name },
  };
}

async function signWith(signer: Signer, typ: string, claims: object): Promise<string> {
  const { signingInput, signingBytes } =
    typ === WALLET_ATTESTATION_TYP
      ? walletAttestationSigningInput(signer.chain, claims as never)
      : keyAttestationSigningInput(signer.chain, claims as never);
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.priv, signingBytes)
  );
  const jwt = finishJws(signingInput, raw);
  if (!jwt) throw new Error('jws too large');
  return jwt;
}

beforeAll(async () => {
  const r = await p256();
  root = {
    ...r,
    der: await makeCert({
      subjectCn: 'Provider Root',
      issuerCn: 'Provider Root',
      subjectSpki: r.spki,
      issuerKey: r.priv,
      issuerCurve: 'P-256',
      hash: 'SHA-256',
      notBefore: NOW - DAY,
      notAfter: NOW + 3000 * DAY,
      ca: true,
    }),
  };
  wallet = await makeSigner('Wallet Attestation CA');
  key = await makeSigner('Key Attestation CA');
  const kp = await genPair('P-256');
  const jwk = await exportJWK(kp.publicKey);
  instance = {
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string },
    priv: kp.privateKey,
  };
});

async function pop(
  audience: string,
  sub: string,
  over: Record<string, unknown> = {}
): Promise<string> {
  return new SignJWT({ jti: crypto.randomUUID(), ...over })
    .setProtectedHeader({ alg: 'ES256', typ: 'oauth-client-attestation-pop+jwt' })
    .setIssuer(sub)
    .setAudience(audience)
    .setIssuedAt(NOW)
    .sign(instance.priv);
}

describe('wallet attestation accepted by the OP verifier', () => {
  const issuerUrl = 'https://op.example';
  const seen = new Set<string>();
  const consumeJti = async (j: string): Promise<boolean> =>
    seen.has(j) ? false : (seen.add(j), true);

  it('verifies with the intermediate as the allowlisted anchor', async () => {
    const exp = boundedExpiry({
      now: NOW,
      ttlSeconds: 3600,
      chainLimit: chainLimit(wallet.chain)!,
    })!;
    const jwt = await signWith(
      wallet,
      WALLET_ATTESTATION_TYP,
      walletAttestationClaims({
        issuer: 'https://wallet-provider.authrim.com',
        clientId: 'keyring-ios',
        now: NOW,
        exp,
        jwk: normalizeJwk(instance.publicJwk)!,
      })
    );
    const result = await verifyWalletAttestation({
      attestation: jwt,
      pop: await pop(issuerUrl, 'keyring-ios'),
      audience: issuerUrl,
      anchors: [wallet.anchor],
      now: NOW,
      clientId: 'keyring-ios',
      consumeJti,
    });
    expect(result).toMatchObject({
      ok: true,
      clientId: 'keyring-ios',
      attestationExpiresAt: NOW + 3600,
    });
  });

  it('is refused under the wrong anchor (key attestation CA) and when the chain carries an EKU', async () => {
    const exp = NOW + 3600;
    const claims = walletAttestationClaims({
      issuer: 'https://p',
      clientId: 'keyring-ios',
      now: NOW,
      exp,
      jwk: normalizeJwk(instance.publicJwk)!,
    });
    const jwt = await signWith(wallet, WALLET_ATTESTATION_TYP, claims);
    const wrong = await verifyWalletAttestation({
      attestation: jwt,
      pop: await pop(issuerUrl, 'keyring-ios'),
      audience: issuerUrl,
      anchors: [key.anchor],
      now: NOW,
      consumeJti,
    });
    expect(wrong).toEqual({ ok: false, error: 'attestation_chain_untrusted' });
    const withEku = await makeSigner('EKU CA', { eku: true });
    const bad = await signWith(withEku, WALLET_ATTESTATION_TYP, claims);
    const r = await verifyWalletAttestation({
      attestation: bad,
      pop: await pop(issuerUrl, 'keyring-ios'),
      audience: issuerUrl,
      anchors: [withEku.anchor],
      now: NOW,
      consumeJti,
    });
    expect(r.ok).toBe(false);
  });

  it('is refused once the chain has expired although the JWT and the PoP are still valid', async () => {
    const short = await makeSigner('Short CA', { leafNotAfter: NOW + 2 * 3600 });
    const limit = chainLimit(short.chain)!;
    expect(boundedExpiry({ now: NOW, ttlSeconds: 3600, chainLimit: limit })).toBe(NOW + 3600); // limit - 1h
    expect(boundedExpiry({ now: NOW + 3600, ttlSeconds: 3600, chainLimit: limit })).toBeNull();
    // An unbounded JWT (exp after the chain ends) is what the bound prevents; build one to prove the OP refuses it.
    const later = NOW + 3 * 3600;
    const claims = walletAttestationClaims({
      issuer: 'https://p',
      clientId: 'keyring-ios',
      now: NOW,
      exp: NOW + 20 * 3600,
      jwk: normalizeJwk(instance.publicJwk)!,
    });
    const jwt = await signWith(short, WALLET_ATTESTATION_TYP, claims);
    const freshPop = await new SignJWT({ jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'ES256', typ: 'oauth-client-attestation-pop+jwt' })
      .setIssuer('keyring-ios')
      .setAudience(issuerUrl)
      .setIssuedAt(later)
      .sign(instance.priv);
    const common = {
      attestation: jwt,
      pop: freshPop,
      audience: issuerUrl,
      anchors: [short.anchor],
      consumeJti,
    } as const;
    expect(await verifyWalletAttestation({ ...common, now: later })).toEqual({
      ok: false,
      error: 'attestation_chain_invalid',
    });
    const control = await new SignJWT({ jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'ES256', typ: 'oauth-client-attestation-pop+jwt' })
      .setIssuer('keyring-ios')
      .setAudience(issuerUrl)
      .setIssuedAt(NOW + 3600)
      .sign(instance.priv);
    expect((await verifyWalletAttestation({ ...common, pop: control, now: NOW + 3600 })).ok).toBe(
      true
    ); // still inside the chain
  });
});

describe('key attestation accepted by the OP verifier', () => {
  const claimsFor = (nonce: string, exp = NOW + 600) =>
    keyAttestationClaims({
      now: NOW,
      exp,
      nonce,
      jwk: normalizeJwk(instance.publicJwk)!,
      keyStorage: ['iso_18045_high'],
    });

  it('verifies and meets the iso_18045_high requirement', async () => {
    const jwt = await signWith(key, KEY_ATTESTATION_TYP, claimsFor('c-nonce-1'));
    const r = await verifyKeyAttestation({
      jwt,
      anchors: [key.anchor],
      now: NOW,
      expectedNonce: 'c-nonce-1',
      proofKey: instance.publicJwk,
      requiredKeyStorage: 'iso_18045_high',
    });
    expect(r).toMatchObject({ ok: true, keyStorage: 'iso_18045_high', attestedKeyCount: 1 });
  });

  it('is refused for another nonce, another proof key, the wallet anchor, and an expired attestation', async () => {
    const jwt = await signWith(key, KEY_ATTESTATION_TYP, claimsFor('n1'));
    const base = {
      jwt,
      anchors: [key.anchor],
      now: NOW,
      expectedNonce: 'n1',
      proofKey: instance.publicJwk,
    } as const;
    expect(await verifyKeyAttestation({ ...base, expectedNonce: 'n2' })).toEqual({
      ok: false,
      error: 'key_attestation_nonce_mismatch',
    });
    const other = await exportJWK((await genPair('P-256')).publicKey);
    expect(await verifyKeyAttestation({ ...base, proofKey: other })).toEqual({
      ok: false,
      error: 'key_attestation_key_not_attested',
    });
    expect((await verifyKeyAttestation({ ...base, anchors: [wallet.anchor] })).ok).toBe(false);
    expect(await verifyKeyAttestation({ ...base, now: NOW + 700 })).toEqual({
      ok: false,
      error: 'key_attestation_expired',
    });
  });
});

describe('claim validation before signing', () => {
  const jwk = (): { kty: 'EC'; crv: 'P-256'; x: string; y: string } => ({
    ...instance.publicJwk,
    kty: 'EC',
    crv: 'P-256',
  });
  const wallet = (over: Record<string, unknown> = {}) =>
    ({
      iss: 'https://p.example',
      sub: 'keyring-ios',
      iat: NOW,
      exp: NOW + 3600,
      cnf: { jwk: jwk() },
      ...over,
    }) as never;
  const keyClaims = (over: Record<string, unknown> = {}) =>
    ({
      iat: NOW,
      exp: NOW + 600,
      nonce: 'n1',
      attested_keys: [jwk()],
      key_storage: ['iso_18045_high'],
      ...over,
    }) as never;
  const chain = [new Uint8Array([1])];

  it('signs only the exact wallet attestation shape', () => {
    expect(() => walletAttestationSigningInput(chain, wallet())).not.toThrow();
    const bad: Record<string, unknown>[] = [
      { iss: '' },
      { sub: '' },
      { sub: 'has space' },
      { exp: NOW },
      { exp: NOW - 1 },
      { exp: NOW + 86401 },
      { iat: 1.5 },
      { extra: 1 },
      { cnf: { jwk: jwk(), more: 1 } },
      { cnf: { jwk: { ...jwk(), d: 'x' } } },
      { cnf: { jwk: { ...jwk(), kid: 'k' } } },
      { cnf: {} },
      { iss: 'x'.repeat(513) },
    ];
    for (const over of bad)
      expect(
        () => walletAttestationSigningInput(chain, wallet(over)),
        JSON.stringify(over)
      ).toThrow('wallet_claims_invalid');
    expect(() => walletAttestationSigningInput(chain, wallet({ exp: NOW + 86400 }))).not.toThrow();
  });

  it('signs a copy of what it validated, not an object that serialises differently', () => {
    const tricky = wallet() as { toJSON?: () => unknown };
    Object.defineProperty(tricky, 'toJSON', {
      value: () => ({ sub: 'victim', exp: 9_999_999_999 }),
      enumerable: false,
    });
    const { signingInput } = walletAttestationSigningInput(chain, tricky as never);
    const payload = JSON.parse(
      atob(signingInput.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/'))
    ) as Record<string, unknown>;
    expect(payload.sub).toBe('keyring-ios');
    expect(Object.keys(payload).sort()).toEqual(['cnf', 'exp', 'iat', 'iss', 'sub']);
    const getterKeys = keyClaims();
    Object.defineProperty(getterKeys, 'toJSON', {
      value: () => ({ nonce: 'x' }),
      enumerable: false,
    });
    const key = keyAttestationSigningInput(chain, getterKeys as never);
    const keyPayload = JSON.parse(
      atob(key.signingInput.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/'))
    ) as Record<string, unknown>;
    expect(keyPayload.nonce).toBe('n1');
  });

  it('signs only the exact key attestation shape', () => {
    expect(() => keyAttestationSigningInput(chain, keyClaims())).not.toThrow();
    const bad: Record<string, unknown>[] = [
      { nonce: 'a b' },
      { nonce: '' },
      { exp: NOW },
      { exp: NOW + 3601 },
      { attested_keys: [] },
      { attested_keys: [jwk(), jwk()] },
      { attested_keys: [{ ...jwk(), d: 'x' }] },
      { key_storage: [] },
      { key_storage: ['made_up'] },
      { key_storage: Array(9).fill('iso_18045_high') },
      { aud: 'x' },
      { nbf: NOW },
    ];
    for (const over of bad)
      expect(
        () => keyAttestationSigningInput(chain, keyClaims(over)),
        JSON.stringify(over)
      ).toThrow('key_claims_invalid');
  });

  it('refuses a chain of zero or more than three certificates, and writes the fixed header', () => {
    expect(() => walletAttestationSigningInput([], wallet())).toThrow('chain_length');
    expect(() =>
      walletAttestationSigningInput([...chain, ...chain, ...chain, ...chain], wallet())
    ).toThrow('chain_length');
    expect(() =>
      walletAttestationSigningInput([...chain, ...chain, ...chain], wallet())
    ).not.toThrow();
    const { signingInput } = keyAttestationSigningInput(chain, keyClaims());
    const header = JSON.parse(
      atob(signingInput.split('.')[0].replace(/-/gu, '+').replace(/_/gu, '/'))
    ) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'ES256', typ: 'key-attestation+jwt', x5c: ['AQ=='] });
  });
});

describe('claim builders and helpers', () => {
  it('refuses unusable nonces, bad JWKs and oversize or malformed signatures', async () => {
    expect(() =>
      keyAttestationClaims({
        now: 1,
        exp: 2,
        nonce: 'has space',
        jwk: normalizeJwk(instance.publicJwk)!,
        keyStorage: [],
      })
    ).toThrow();
    expect(isPrintableToken('abc')).toBe(true);
    expect(isPrintableToken('a b')).toBe(false);
    expect(isPrintableToken('')).toBe(false);
    expect(isPrintableToken('x'.repeat(513))).toBe(false);
    expect(normalizeJwk({ ...instance.publicJwk, d: 'x' })).toBeNull();
    expect(normalizeJwk({ ...instance.publicJwk, crv: 'P-384' })).toBeNull();
    expect(normalizeJwk({ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' })).toBeNull();
    expect(await isOnCurve({ kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) })).toBe(
      false
    );
    expect(await isOnCurve(normalizeJwk(instance.publicJwk)!)).toBe(true);
    expect(finishJws('a.b', new Uint8Array(63))).toBeNull();
    expect(chainLimit([new Uint8Array(3)])).toBeNull();
    expect(boundedExpiry({ now: 0, ttlSeconds: 3600, chainLimit: 10 })).toBeNull();
    void bool;
  });
});
