import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, exportPKCS8, generateKeyPair, type JWK } from 'jose';
import {
  base64ToBytes,
  buildCertificate,
  bytesToBase64,
  parseCertificate,
  validateVcSigningChain,
} from '@authrim/ar-lib-core';
import {
  ensureVcSigningCertificate,
  resetIssuerCaState,
  type IssuerCaEnv,
  type VcCertificateKeyManager,
} from '../issuer-ca';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-23T00:00:00Z');
const HOST = 'issuer.example.com';

interface Pair {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function pair(): Promise<Pair> {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  return {
    privateKey: keys.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  };
}

const signWith = (key: CryptoKey) => async (tbs: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, tbs));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A root, an issuing CA signed by it, and the environment that configures the CA. */
async function makeCa(
  options: { caNotAfter?: number; caNotBefore?: number; pathLength?: number; isCA?: boolean } = {}
) {
  const root = await pair();
  const ca = await pair();
  const caCert = await buildCertificate(
    {
      // A leaf-shaped "CA" (isCA false) cannot carry an organization, by the builder's rule.
      subject: {
        commonName: 'Authrim Test Issuing CA',
        organization: options.isCA === false ? undefined : 'Authrim',
      },
      issuer: { commonName: 'Authrim Test Root CA', organization: 'Authrim' },
      subjectPublicKey: ca.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(options.caNotBefore ?? NOW - DAY),
      notAfter: new Date(options.caNotAfter ?? NOW + 1000 * DAY),
      isCA: options.isCA ?? true,
      pathLength: options.isCA === false ? undefined : (options.pathLength ?? 0),
      dnsNames: options.isCA === false ? [HOST] : undefined,
    },
    signWith(root.privateKey)
  );
  const pem = await exportPKCS8(ca.privateKey);
  const fingerprint = await sha256Hex(caCert);
  const env: IssuerCaEnv = {
    VC_ISSUING_CA_PRIVATE_KEY_PEM: pem,
    VC_ISSUING_CA_CERTIFICATE: bytesToBase64(caCert),
    VC_X5C_ISSUING_CA_SHA256: fingerprint,
  };
  return { env, ca, caCert, fingerprint };
}

/** A KeyManager stand-in that validates a registration the way the real one does. */
function fakeKeyManager(publicJwk: JWK, trusted: string[]) {
  const stored: {
    chain: string[] | null;
    host: string | null;
    chainNotAfter: number | null;
    ca: string | null;
  } = { chain: null, host: null, chainNotAfter: null, ca: null };
  const register = vi.fn(async (input: { kid: string; chain: string[]; issuerHost: string }) => {
    const info = await validateVcSigningChain(input.chain, {
      publicKey: publicJwk,
      issuerHost: input.issuerHost,
      now: Date.now(),
      expectedLength: 2,
      authrimProfile: true,
      trustedFinalCertificateSha256: trusted,
    });
    stored.chain = info.x5c;
    stored.host = input.issuerHost;
    stored.chainNotAfter = info.chainNotAfter;
    stored.ca = info.finalCertificateSha256;
    return info;
  });
  const state = vi.fn(async () => ({
    kid: 'vc-key-1',
    publicJWK: publicJwk,
    issuerHost: stored.host,
    caSha256: stored.ca,
    chainNotAfter: stored.chainNotAfter,
  }));
  const manager: VcCertificateKeyManager = {
    getVcSigningCertificateStateRpc: state as never,
    setVcIssuerKeyCertificateChainRpc: register as never,
  };
  return { manager, register, state, stored };
}

describe('ensureVcSigningCertificate', () => {
  beforeEach(() => {
    resetIssuerCaState();
    vi.useFakeTimers({ now: NOW });
  });

  const issuerUrl = `https://${HOST}`;

  it('does nothing unless the issuing CA is configured', async () => {
    const key = await pair();
    const { manager, register, state } = fakeKeyManager(key.publicJwk, []);
    expect(await ensureVcSigningCertificate({}, manager, issuerUrl, 't1', NOW)).toBe('disabled');
    for (const missing of [
      'VC_ISSUING_CA_PRIVATE_KEY_PEM',
      'VC_ISSUING_CA_CERTIFICATE',
      'VC_X5C_ISSUING_CA_SHA256',
    ] as const) {
      resetIssuerCaState();
      const { env } = await makeCa();
      delete env[missing];
      expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW)).toBe('disabled');
    }
    expect(register).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });

  it('issues a leaf that satisfies the KeyManager profile and registers leaf plus CA', async () => {
    const key = await pair();
    const { env, caCert, fingerprint } = await makeCa();
    const { manager, register, stored } = fakeKeyManager(key.publicJwk, [fingerprint]);

    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW)).toBe('issued');
    expect(register).toHaveBeenCalledTimes(1);
    const call = register.mock.calls[0][0];
    expect(call).toMatchObject({ kid: 'vc-key-1', issuerHost: HOST });
    expect(call.chain).toHaveLength(2);
    expect(base64ToBytes(call.chain[1])).toEqual(caCert);

    const leaf = parseCertificate(base64ToBytes(call.chain[0]));
    expect(leaf.dnsNames).toEqual([HOST]);
    expect(leaf.subjectCommonNames).toEqual([HOST]);
    expect(leaf.isCA).toBe(false);
    expect(leaf.notAfter.getTime() - NOW).toBeGreaterThan(399 * DAY);
    expect(leaf.notAfter.getTime() - NOW).toBeLessThanOrEqual(400 * DAY);
    expect(stored.host).toBe(HOST);
  });

  it('reports current and does not issue again while the certificate is good', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, register, state } = fakeKeyManager(key.publicJwk, [fingerprint]);
    await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW);
    // KeyManager is asked every time, so a rotated key or a replaced chain is seen at once.
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW + 1000)).toBe(
      'current'
    );
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW + 11 * 60_000)).toBe(
      'current'
    );
    expect(state).toHaveBeenCalledTimes(3);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('gives a rotated key its own certificate at once, however recent the last answer was', async () => {
    const first = await pair();
    const second = await pair();
    const { env, fingerprint } = await makeCa();
    const stores = fakeKeyManager(first.publicJwk, [fingerprint]);
    await ensureVcSigningCertificate(env, stores.manager, issuerUrl, 't1', NOW);
    // The key rotates: the same tenant and host, a new key without a chain.
    stores.state.mockImplementation(async () => ({
      kid: 'vc-key-2',
      publicJWK: second.publicJwk,
      issuerHost: null,
      caSha256: null,
      chainNotAfter: null,
    }));
    stores.register.mockImplementation((async () => ({})) as never);
    expect(await ensureVcSigningCertificate(env, stores.manager, issuerUrl, 't1', NOW + 1000)).toBe(
      'issued'
    );
    expect(stores.register).toHaveBeenCalledTimes(2);
    expect(stores.register.mock.calls[1][0].kid).toBe('vc-key-2');
  });

  it('renews a certificate when a third of its life, at most 30 days, is left', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    const sixty = { ...env, VC_X5C_LEAF_LIFETIME_DAYS: '60' };
    await ensureVcSigningCertificate(sixty, manager, issuerUrl, 't1', NOW);
    expect(register).toHaveBeenCalledTimes(1);
    // Day 35: 25 days left, more than a third (20): current.
    vi.setSystemTime(NOW + 35 * DAY);
    expect(await ensureVcSigningCertificate(sixty, manager, issuerUrl, 't1', NOW + 35 * DAY)).toBe(
      'current'
    );
    // Day 45: 15 days left: renewed (the fake KeyManager validates at the real clock, so move it too).
    vi.setSystemTime(NOW + 45 * DAY);
    expect(await ensureVcSigningCertificate(sixty, manager, issuerUrl, 't1', NOW + 45 * DAY)).toBe(
      'issued'
    );
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("keeps the first host's certificate when another host asks, until it ends", async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, register, stored } = fakeKeyManager(key.publicJwk, [fingerprint]);
    await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW);
    // Alternating names never thrash the registration.
    for (const url of ['https://other.example.com', issuerUrl, 'https://other.example.com']) {
      expect(await ensureVcSigningCertificate(env, manager, url, 't1', NOW)).toBe('current');
    }
    expect(register).toHaveBeenCalledTimes(1);
    expect(stored.host).toBe(HOST);
  });

  it('renews early when the credential outlives the leaf and a new leaf would reach it', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const short = { ...env, VC_X5C_LEAF_LIFETIME_DAYS: '30' };
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    await ensureVcSigningCertificate(short, manager, issuerUrl, 't1', NOW);
    // One hour later a 30 day credential would end after the leaf: a new leaf reaches it.
    const later = NOW + 3_600_000;
    vi.setSystemTime(later);
    expect(
      await ensureVcSigningCertificate(short, manager, issuerUrl, 't1', later, later + 30 * DAY)
    ).toBe('issued');
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('does not reissue when even a new leaf could not reach the credential', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const short = { ...env, VC_X5C_LEAF_LIFETIME_DAYS: '30' };
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    await ensureVcSigningCertificate(short, manager, issuerUrl, 't1', NOW);
    for (let hour = 1; hour <= 3; hour += 1) {
      const at = NOW + hour * 3_600_000;
      vi.setSystemTime(at);
      expect(
        await ensureVcSigningCertificate(short, manager, issuerUrl, 't1', at, at + 90 * DAY)
      ).toBe('current');
    }
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('accepts a did:web issuer and reads its host', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, stored } = fakeKeyManager(key.publicJwk, [fingerprint]);
    expect(await ensureVcSigningCertificate(env, manager, `did:web:${HOST}`, 't1', NOW)).toBe(
      'issued'
    );
    expect(stored.host).toBe(HOST);
  });

  it('refuses hosts that cannot be a certificate name, without asking KeyManager to register', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    const longHost = `${'a'.repeat(60)}.example.com`;
    for (const url of [
      'not a url',
      'http://issuer.example.com',
      `https://${longHost}`,
      'https://[::1]',
    ]) {
      resetIssuerCaState();
      expect(await ensureVcSigningCertificate(env, manager, url, 't1', NOW)).toBe('failed');
    }
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a certificate that is not trusted',
      async () => {
        const made = await makeCa();
        return { ...made.env, VC_X5C_ISSUING_CA_SHA256: 'f'.repeat(64) };
      },
    ],
    [
      'an expired issuing CA',
      async () => (await makeCa({ caNotAfter: NOW - HOUR, caNotBefore: NOW - 3 * DAY })).env,
    ],
    [
      'an issuing CA that is not a CA',
      async () => (await makeCa({ isCA: false, pathLength: undefined })).env,
    ],
    [
      'an issuing CA with a path length above zero',
      async () => (await makeCa({ pathLength: 1 })).env,
    ],
    [
      'an issuing CA that is about to expire',
      async () => (await makeCa({ caNotAfter: NOW + 3 * DAY })).env,
    ],
    [
      'a private key that is not the certified one',
      async () => {
        const a = await makeCa();
        const b = await makeCa();
        return { ...a.env, VC_ISSUING_CA_PRIVATE_KEY_PEM: b.env.VC_ISSUING_CA_PRIVATE_KEY_PEM };
      },
    ],
    [
      'garbage in place of the certificate',
      async () => {
        const a = await makeCa();
        return { ...a.env, VC_ISSUING_CA_CERTIFICATE: 'AAAA' };
      },
    ],
    [
      'garbage in place of the private key',
      async () => {
        const a = await makeCa();
        return { ...a.env, VC_ISSUING_CA_PRIVATE_KEY_PEM: 'not a key' };
      },
    ],
  ])('fails, without registering anything, for %s', async (_label, makeEnv) => {
    const key = await pair();
    const env = await makeEnv();
    const { manager, register } = fakeKeyManager(key.publicJwk, ['f'.repeat(64)]);
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW)).toBe('failed');
    expect(register).not.toHaveBeenCalled();
  });

  it('shortens the leaf so it never outlives the issuing CA', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa({ caNotAfter: NOW + 40 * DAY });
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW)).toBe('issued');
    const leaf = parseCertificate(base64ToBytes(register.mock.calls[0][0].chain[0]));
    expect(leaf.notAfter.getTime()).toBeLessThan(NOW + 40 * DAY);
    expect(leaf.notAfter.getTime() - NOW).toBeGreaterThan(38 * DAY);
  });

  it('keeps the leaf lifetime setting within bounds', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    for (const [setting, expectedDays] of [
      ['30', 30],
      ['2', 400],
      ['5000', 400],
      ['abc', 400],
    ] as const) {
      resetIssuerCaState();
      const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
      await ensureVcSigningCertificate(
        { ...env, VC_X5C_LEAF_LIFETIME_DAYS: setting },
        manager,
        issuerUrl,
        't1',
        NOW
      );
      const leaf = parseCertificate(base64ToBytes(register.mock.calls[0][0].chain[0]));
      expect(Math.round((leaf.notAfter.getTime() - NOW) / DAY)).toBe(expectedDays);
    }
  });

  it('backs off after a failure, for that key and host only, and tries again later', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    register.mockRejectedValueOnce(new Error('registry unavailable'));
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW)).toBe('failed');
    expect(register).toHaveBeenCalledTimes(1);
    // Within the back-off the same key and host are not retried.
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW + 10_000)).toBe(
      'failed'
    );
    expect(register).toHaveBeenCalledTimes(1);
    // Another host (a key that has no certificate yet) is not held back by it.
    const other = fakeKeyManager(key.publicJwk, [fingerprint]).manager;
    expect(
      await ensureVcSigningCertificate(env, other, 'https://b.example.com', 't1', NOW + 10_000)
    ).toBe('issued');
    // After the back-off the retry succeeds.
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW + 61_000)).toBe(
      'issued'
    );
  });

  it('does not let a failure for the old key hold back the new key', async () => {
    const first = await pair();
    const second = await pair();
    const { env, fingerprint } = await makeCa();
    const stores = fakeKeyManager(first.publicJwk, [fingerprint]);
    stores.register.mockRejectedValueOnce(new Error('registry unavailable'));
    expect(await ensureVcSigningCertificate(env, stores.manager, issuerUrl, 't1', NOW)).toBe(
      'failed'
    );
    stores.state.mockImplementation(async () => ({
      kid: 'vc-key-2',
      publicJWK: second.publicJwk,
      issuerHost: null,
      caSha256: null,
      chainNotAfter: null,
    }));
    stores.register.mockImplementation((async () => ({})) as never);
    expect(await ensureVcSigningCertificate(env, stores.manager, issuerUrl, 't1', NOW + 1000)).toBe(
      'issued'
    );
  });

  it('issues again when the credential about to be signed would outlive the chain', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    const shortEnv = { ...env, VC_X5C_LEAF_LIFETIME_DAYS: '60' };
    await ensureVcSigningCertificate(shortEnv, manager, issuerUrl, 't1', NOW);
    // A 30-day credential is covered by the 60-day leaf.
    expect(
      await ensureVcSigningCertificate(shortEnv, manager, issuerUrl, 't1', NOW, NOW + 30 * DAY)
    ).toBe('current');
    // A one-year credential is not: with a longer lifetime allowed, a new leaf is issued
    // (the fake KeyManager validates at the real clock, so move it too).
    vi.setSystemTime(NOW + DAY);
    expect(
      await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW + DAY, NOW + 365 * DAY)
    ).toBe('issued');
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('does not reissue on every request when only the issuing CA is short', async () => {
    const key = await pair();
    // The CA ends in 40 days: the first leaf already runs to the CA's end, a new one could not.
    const { env, fingerprint } = await makeCa({ caNotAfter: NOW + 40 * DAY });
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    expect(await ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW)).toBe('issued');
    vi.setSystemTime(NOW + 20 * DAY);
    for (let i = 0; i < 3; i += 1) {
      expect(
        await ensureVcSigningCertificate(
          env,
          manager,
          issuerUrl,
          't1',
          NOW + 20 * DAY,
          NOW + 365 * DAY
        )
      ).toBe('current');
    }
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('renews early enough for a short leaf lifetime: a third of it, not a fixed 30 days', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, register } = fakeKeyManager(key.publicJwk, [fingerprint]);
    const shortEnv = { ...env, VC_X5C_LEAF_LIFETIME_DAYS: '14' };
    await ensureVcSigningCertificate(shortEnv, manager, issuerUrl, 't1', NOW);
    // Day 8: 6 days left, more than a third (4.7 days): still current.
    vi.setSystemTime(NOW + 8 * DAY);
    expect(
      await ensureVcSigningCertificate(shortEnv, manager, issuerUrl, 't1', NOW + 8 * DAY)
    ).toBe('current');
    // Day 10: 4 days left: renewed.
    vi.setSystemTime(NOW + 10 * DAY);
    expect(
      await ensureVcSigningCertificate(shortEnv, manager, issuerUrl, 't1', NOW + 10 * DAY)
    ).toBe('issued');
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('limits certificates to the allowed issuer hosts when a list is set', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const fresh = () => fakeKeyManager(key.publicJwk, [fingerprint]);
    const { manager, register } = fresh();
    const list = {
      ...env,
      VC_X5C_ALLOWED_ISSUER_HOSTS: 'issuer.example.com, *.tenants.example.com',
    };
    expect(
      await ensureVcSigningCertificate(list, manager, 'https://evil.example.org', 't1', NOW)
    ).toBe('failed');
    expect(register).not.toHaveBeenCalled();
    resetIssuerCaState();
    expect(
      await ensureVcSigningCertificate(
        list,
        fresh().manager,
        'https://acme.tenants.example.com',
        't1',
        NOW
      )
    ).toBe('issued');
    resetIssuerCaState();
    expect(
      await ensureVcSigningCertificate(
        list,
        fresh().manager,
        'https://tenants.example.com',
        't1',
        NOW
      )
    ).toBe('failed');
    resetIssuerCaState();
    expect(
      await ensureVcSigningCertificate(
        list,
        fresh().manager,
        'https://notissuer.example.com',
        't1',
        NOW
      )
    ).toBe('failed');
    resetIssuerCaState();
    expect(await ensureVcSigningCertificate(list, fresh().manager, issuerUrl, 't1', NOW)).toBe(
      'issued'
    );
  });

  it('tells two CAs of the same size apart, in both directions', async () => {
    const key = await pair();
    const a = await makeCa();
    const b = await makeCa();
    // Same lengths everywhere, different key: the mismatch is found, and a fix is seen at once.
    const mixed = { ...a.env, VC_ISSUING_CA_PRIVATE_KEY_PEM: b.env.VC_ISSUING_CA_PRIVATE_KEY_PEM };
    const fresh = () => fakeKeyManager(key.publicJwk, [a.fingerprint]);
    const { manager, register } = fresh();
    expect(await ensureVcSigningCertificate(mixed, manager, issuerUrl, 't1', NOW)).toBe('failed');
    resetIssuerCaState();
    expect(await ensureVcSigningCertificate(a.env, manager, issuerUrl, 't1', NOW)).toBe('issued');
    expect(register).toHaveBeenCalledTimes(1);
    // And the other way round: a good CA followed by a mismatched one.
    resetIssuerCaState();
    expect(await ensureVcSigningCertificate(a.env, fresh().manager, issuerUrl, 't1', NOW)).toBe(
      'issued'
    );
    expect(await ensureVcSigningCertificate(mixed, fresh().manager, issuerUrl, 't1', NOW)).toBe(
      'failed'
    );
  });

  it('serves concurrent callers without sharing anything between them', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager } = fakeKeyManager(key.publicJwk, [fingerprint]);
    const results = await Promise.all([
      ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW),
      ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW),
      ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW),
    ]);
    // Each call decides for itself; every one ends with a registered certificate.
    for (const result of results) expect(['issued', 'current']).toContain(result);
  });

  it('never throws when KeyManager itself fails', async () => {
    const key = await pair();
    const { env, fingerprint } = await makeCa();
    const { manager, state } = fakeKeyManager(key.publicJwk, [fingerprint]);
    state.mockRejectedValueOnce(new Error('durable object unavailable'));
    await expect(ensureVcSigningCertificate(env, manager, issuerUrl, 't1', NOW)).resolves.toBe(
      'failed'
    );
  });
});
