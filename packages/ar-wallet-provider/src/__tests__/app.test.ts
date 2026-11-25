/** The provider app end to end: Apple-shaped devices in, JWTs out, checked by the OP's real verifiers. */
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { verifyKeyAttestation } from '@op-verifiers/key-attestation';
import { verifyWalletAttestation } from '@op-verifiers/wallet-attestation';
import { buildClientData } from '../domain/client-data';
import type { CV } from './support/der';
import { makeAssertion, makeAttestation, type DeviceFixture } from './support/apple-fixture';
import { genPair } from './support/keys';
import { makeWorld, NOW, type World, type WorldOptions } from './support/service-world';

const PRODUCTION_BUILD = new Map<string, CV>([
  ['apple_validation_category_01', Uint8Array.of(4, 0, 0, 0)],
  ['apple_bundle_version_01', '1.0'],
]);
const build = (category: number, version = '1.0') =>
  new Map<string, CV>([
    ['apple_validation_category_01', Uint8Array.of(category, 0, 0, 0)],
    ['apple_bundle_version_01', version],
  ]);

interface Instance {
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  priv: CryptoKey;
}
let instance: Instance;
beforeAll(async () => {
  const kp = await genPair('P-256');
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as { x: string; y: string };
  instance = { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, priv: kp.privateKey };
});

async function challengeOf(w: World, ip?: string): Promise<string> {
  const res = await w.post('/challenge', {}, ip);
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

async function registered(
  w: World,
  opts: { extensions?: Map<string, CV>; aaguid?: 'development' | 'production' } = {}
): Promise<DeviceFixture> {
  const challenge = await challengeOf(w);
  const dev = await makeAttestation(w.apple, {
    challenge,
    aaguid: opts.aaguid ?? 'production',
    extensions: opts.extensions ?? PRODUCTION_BUILD,
  });
  const res = await w.post('/register', {
    key_id: dev.keyId,
    challenge,
    attestation_object: dev.attestationObject,
  });
  expect(res.status).toBe(200);
  return dev;
}

async function assertionBody(
  w: World,
  dev: DeviceFixture,
  purpose: 'wallet-attestation' | 'key-attestation',
  counter: number,
  over: { challenge?: string; nonce?: string; extensions?: Map<string, CV>; tamper?: boolean } = {}
) {
  const challenge = over.challenge ?? (await challengeOf(w));
  const nonce = purpose === 'key-attestation' ? (over.nonce ?? 'c-nonce-1') : undefined;
  const clientData = await buildClientData({ purpose, challenge, jwk: instance.jwk, nonce });
  const assertion = await makeAssertion(dev, clientData, {
    counter,
    extensions: over.extensions ?? PRODUCTION_BUILD,
    tamper: over.tamper,
  });
  return { key_id: dev.keyId, challenge, purpose, assertion, jwk: instance.jwk, nonce };
}

const attest = (w: World, path: string, body: unknown) => w.post(path, body);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

async function pop(aud: string, sub: string): Promise<string> {
  return new SignJWT({ jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: 'ES256', typ: 'oauth-client-attestation-pop+jwt' })
    .setIssuer(sub)
    .setAudience(aud)
    .setIssuedAt(NOW)
    .sign(instance.priv);
}

describe.each<WorldOptions['backend']>(['memory', 'd1'])('full flow on %s', (backend) => {
  it('registers, then issues wallet and key attestations that the OP verifiers accept', async () => {
    const w = await makeWorld({ backend });
    const dev = await registered(w);

    const wallet = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 1)
    );
    expect(wallet.status).toBe(200);
    expect(wallet.headers.get('cache-control')).toBe('no-store');
    const { attestation: walletJwt } = (await wallet.json()) as { attestation: string };
    const seen = new Set<string>();
    const verified = await verifyWalletAttestation({
      attestation: walletJwt,
      pop: await pop('https://op.example', 'keyring-ios'),
      audience: 'https://op.example',
      anchors: [w.wallet.anchor],
      now: NOW,
      clientId: 'keyring-ios',
      consumeJti: async (j) => (seen.has(j) ? false : (seen.add(j), true)),
    });
    expect(verified).toMatchObject({ ok: true, clientId: 'keyring-ios' });

    const key = await attest(
      w,
      '/key-attestation',
      await assertionBody(w, dev, 'key-attestation', 2, { nonce: 'c-nonce-9' })
    );
    expect(key.status).toBe(200);
    const { attestation: keyJwt } = (await key.json()) as { attestation: string };
    expect(
      await verifyKeyAttestation({
        jwt: keyJwt,
        anchors: [w.key.anchor],
        now: NOW,
        expectedNonce: 'c-nonce-9',
        proofKey: instance.jwk,
        requiredKeyStorage: 'iso_18045_high',
      })
    ).toMatchObject({ ok: true, keyStorage: 'iso_18045_high' });
    // the two purposes use separate chains: the wallet anchor does not accept the key JWT
    expect(
      (
        await verifyKeyAttestation({
          jwt: keyJwt,
          anchors: [w.wallet.anchor],
          now: NOW,
          expectedNonce: 'c-nonce-9',
          proofKey: instance.jwk,
        })
      ).ok
    ).toBe(false);
    expect((await w.ports.registry.get(dev.keyId))?.counter).toBe(2);
  });

  it('answers a registration retry after the challenge expired, and refuses a different attestation', async () => {
    const w = await makeWorld({ backend });
    const challenge = await challengeOf(w);
    const dev = await makeAttestation(w.apple, {
      challenge,
      aaguid: 'production',
      extensions: PRODUCTION_BUILD,
    });
    const body = { key_id: dev.keyId, challenge, attestation_object: dev.attestationObject };
    expect((await w.post('/register', body)).status).toBe(200);
    w.clock.t += 3600; // the challenge is long gone
    expect((await w.post('/register', body)).status).toBe(200);
    const other = await makeAttestation(w.apple, {
      challenge,
      aaguid: 'production',
      extensions: PRODUCTION_BUILD,
      keyIdOverride: dev.keyIdBytes,
    });
    const res = await w.post('/register', { ...body, attestation_object: other.attestationObject });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('key_exists');
  });
});

describe('registration policy', () => {
  it('refuses a development-signed build with the production entitlement in production', async () => {
    const w = await makeWorld();
    const challenge = await challengeOf(w);
    const dev = await makeAttestation(w.apple, {
      challenge,
      aaguid: 'production',
      extensions: build(3),
    });
    const res = await w.post('/register', {
      key_id: dev.keyId,
      challenge,
      attestation_object: dev.attestationObject,
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('invalid_attestation');
    expect(w.logs.at(-1)?.reason).toBe('build_not_allowed');
    expect(await w.ports.registry.get(dev.keyId)).toBeNull();
  });

  it('refuses a production attestation without the category (requireCategory)', async () => {
    const w = await makeWorld();
    const challenge = await challengeOf(w);
    const dev = await makeAttestation(w.apple, { challenge, aaguid: 'production' });
    const res = await w.post('/register', {
      key_id: dev.keyId,
      challenge,
      attestation_object: dev.attestationObject,
    });
    expect(await errorOf(res)).toBe('invalid_attestation');
  });

  it('staging accepts development (category 3) and TestFlight (2) but not App Store (4)', async () => {
    const w = await makeWorld({ environment: 'staging' });
    await registered(w, { aaguid: 'development', extensions: build(3) });
    await registered(w, { aaguid: 'production', extensions: build(2) });
    const challenge = await challengeOf(w);
    const dev = await makeAttestation(w.apple, {
      challenge,
      aaguid: 'production',
      extensions: build(4),
    });
    const res = await w.post('/register', {
      key_id: dev.keyId,
      challenge,
      attestation_object: dev.attestationObject,
    });
    expect(await errorOf(res)).toBe('invalid_attestation');
  });

  it('refuses a challenge from the other environment, a forged one, an expired one and a claimed one', async () => {
    const staging = await makeWorld({ environment: 'staging' });
    const production = await makeWorld();
    const foreign = await challengeOf(staging);
    const dev = await makeAttestation(production.apple, {
      challenge: foreign,
      aaguid: 'production',
      extensions: PRODUCTION_BUILD,
    });
    const body = {
      key_id: dev.keyId,
      challenge: foreign,
      attestation_object: dev.attestationObject,
    };
    expect(await errorOf(await production.post('/register', body))).toBe('invalid_challenge');
    expect(
      await errorOf(
        await production.post('/register', { ...body, challenge: 'forged-challenge-123' })
      )
    ).toBe('invalid_challenge');

    const own = await challengeOf(production);
    production.clock.t += 301;
    const late = await makeAttestation(production.apple, {
      challenge: own,
      aaguid: 'production',
      extensions: PRODUCTION_BUILD,
    });
    const lateRes = await production.post('/register', {
      key_id: late.keyId,
      challenge: own,
      attestation_object: late.attestationObject,
    });
    expect(await errorOf(lateRes)).toBe('invalid_challenge');

    const claimed = await challengeOf(production);
    const first = await makeAttestation(production.apple, {
      challenge: claimed,
      aaguid: 'production',
      extensions: PRODUCTION_BUILD,
    });
    const second = await makeAttestation(production.apple, {
      challenge: claimed,
      aaguid: 'production',
      extensions: PRODUCTION_BUILD,
    });
    const send = (d: DeviceFixture) =>
      production.post('/register', {
        key_id: d.keyId,
        challenge: claimed,
        attestation_object: d.attestationObject,
      });
    expect((await send(first)).status).toBe(200);
    const res = await send(second);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('invalid_challenge');
  });

  it('refuses malformed requests', async () => {
    const w = await makeWorld();
    expect((await w.post('/register', { key_id: 'short' })).status).toBe(400);
    expect((await w.post('/register', [1, 2])).status).toBe(400);
    const big = await w.app.request('/register', {
      method: 'POST',
      body: 'x'.repeat(40 * 1024),
      headers: { 'content-length': String(40 * 1024) },
    });
    expect(big.status).toBe(400);
    expect((await w.app.request('/nothing')).status).toBe(404);
  });
});

describe('assertion rules', () => {
  it('answers unknown, revoked, replayed, tampered and wrong-purpose requests as the error table says', async () => {
    const w = await makeWorld();
    const stranger = await makeAttestation(w.apple, { aaguid: 'production' });
    const unknown = await attest(w, '/wallet-attestation', {
      ...(await assertionBody(w, stranger, 'wallet-attestation', 1)),
    });
    expect(unknown.status).toBe(401);
    expect(await errorOf(unknown)).toBe('unknown_key');

    const dev = await registered(w);
    const ok = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 3)
    );
    expect(ok.status).toBe(200);
    const replay = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 3)
    );
    expect(replay.status).toBe(401);
    expect(await errorOf(replay)).toBe('counter_replayed');
    expect(replay.headers.get('retry-after')).toBeNull();

    const bad = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 4, { tamper: true })
    );
    expect(await errorOf(bad)).toBe('invalid_assertion');

    const crossPurpose = { ...(await assertionBody(w, dev, 'wallet-attestation', 5)) };
    expect(await errorOf(await attest(w, '/key-attestation', crossPurpose))).toBe(
      'invalid_request'
    );
    // a wallet assertion renamed as key attestation signs other client data: refused, not issued
    const renamed = {
      ...(await assertionBody(w, dev, 'wallet-attestation', 6)),
      purpose: 'key-attestation',
      nonce: 'n',
    };
    expect(await errorOf(await attest(w, '/key-attestation', renamed))).toBe('invalid_assertion');
    expect((await w.ports.registry.get(dev.keyId))?.counter).toBe(3);

    await w.ports.registry.revoke(dev.keyId, 'test', NOW);
    const revoked = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 7)
    );
    expect(revoked.status).toBe(403);
    expect(await errorOf(revoked)).toBe('revoked');
  });

  it('applies requireCategory to devices registered while it was off (migration)', async () => {
    const w = await makeWorld({ policy: { requireCategory: false, allowedCategories: [4, 3] } });
    const dev = await registered(w, { extensions: new Map() });
    const lenient = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 1, { extensions: new Map() })
    );
    expect(lenient.status).toBe(200);
    w.config.policy = { ...w.config.policy, requireCategory: true };
    const strict = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 2, { extensions: new Map() })
    );
    expect(strict.status).toBe(400);
    expect(await errorOf(strict)).toBe('invalid_attestation');
    const category3 = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 3, { extensions: build(5) })
    );
    expect(await errorOf(category3)).toBe('invalid_attestation');
  });

  it('refuses requests with a bad nonce, JWK, or a nonce on a wallet attestation', async () => {
    const w = await makeWorld();
    const dev = await registered(w);
    const base = await assertionBody(w, dev, 'key-attestation', 1);
    expect(
      await errorOf(await attest(w, '/key-attestation', { ...base, nonce: 'has space' }))
    ).toBe('invalid_request');
    expect(await errorOf(await attest(w, '/key-attestation', { ...base, nonce: undefined }))).toBe(
      'invalid_request'
    );
    expect(
      await errorOf(
        await attest(w, '/key-attestation', { ...base, jwk: { ...instance.jwk, d: 'x' } })
      )
    ).toBe('invalid_request');
    expect(
      await errorOf(
        await attest(w, '/key-attestation', {
          ...base,
          jwk: { ...instance.jwk, y: instance.jwk.x },
        })
      )
    ).toBe('invalid_request');
    const wallet = await assertionBody(w, dev, 'wallet-attestation', 2);
    expect(await errorOf(await attest(w, '/wallet-attestation', { ...wallet, nonce: 'n' }))).toBe(
      'invalid_request'
    );
  });
});

describe('failure behaviour', () => {
  it('a signer outage or a chain about to expire changes no state and a retry with the same assertion works', async () => {
    const down = await makeWorld({ walletSecret: null });
    const dev = await registered(down);
    const body = await assertionBody(down, dev, 'wallet-attestation', 1);
    const res = await attest(down, '/wallet-attestation', body);
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('provider_unavailable');
    expect((await down.ports.registry.get(dev.keyId))?.counter).toBe(0);

    const w = await makeWorld();
    const d2 = await registered(w);
    w.clock.t = NOW + 30 * 86400 - 1800; // inside the margin before the leaf expires
    const b2 = await assertionBody(w, d2, 'wallet-attestation', 1);
    expect((await attest(w, '/wallet-attestation', b2)).status).toBe(503);
    expect((await w.ports.registry.get(d2.keyId))?.counter).toBe(0);
    w.clock.t = NOW;
    expect((await attest(w, '/wallet-attestation', b2)).status).toBe(200);
  });

  it('a store failure answers 503 and never claims an outcome', async () => {
    const w = await makeWorld();
    const dev = await registered(w);
    const body = await assertionBody(w, dev, 'wallet-attestation', 1);
    const original = w.ports.registry.advanceCounter.bind(w.ports.registry);
    w.ports.registry.advanceCounter = async () => {
      throw new Error('store down');
    };
    const res = await attest(w, '/wallet-attestation', body);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('store down');
    w.ports.registry.advanceCounter = original;
    expect((await attest(w, '/wallet-attestation', body)).status).toBe(200);
  });

  it('rate limits challenges per source', async () => {
    const w = await makeWorld({
      limits: { challengePerSource: { windowSeconds: 60, maxRequests: 3 } },
    });
    for (let i = 0; i < 3; i += 1)
      expect((await w.post('/challenge', {}, '198.51.100.9')).status).toBe(200);
    const limited = await w.post('/challenge', {}, '198.51.100.9');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await w.post('/challenge', {}, '198.51.100.10')).status).toBe(200); // another source
  });

  it('locks a key for 15 minutes once the failure limit is reached', async () => {
    const w = await makeWorld({
      limits: {
        failuresPerKey: { windowSeconds: 3600, maxRequests: 2 },
        failureLockoutSeconds: 900,
      },
    });
    const dev = await registered(w);
    for (let i = 1; i <= 2; i += 1) {
      const res = await attest(
        w,
        '/wallet-attestation',
        await assertionBody(w, dev, 'wallet-attestation', i, { tamper: true })
      );
      expect(res.status).toBe(401);
    }
    const locked = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 9)
    );
    expect(locked.status).toBe(429);
    expect(await errorOf(locked)).toBe('rate_limited');
    expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(900);
    w.clock.t += 901;
    const again = await attest(
      w,
      '/wallet-attestation',
      await assertionBody(w, dev, 'wallet-attestation', 9)
    );
    expect(again.status).toBe(200);
  });

  it('keeps the source limits of challenge, register and attestation apart', async () => {
    const w = await makeWorld({
      limits: {
        challengePerSource: { windowSeconds: 60, maxRequests: 100 },
        registerPerSource: { windowSeconds: 3600, maxRequests: 2 },
      },
    });
    for (let i = 0; i < 20; i += 1) await w.post('/challenge', {}, '192.0.2.5');
    // twenty challenges did not use up the registration budget of the same source
    for (let i = 0; i < 2; i += 1) {
      expect((await w.post('/register', { key_id: 'bad' }, '192.0.2.5')).status).toBe(400);
    }
    expect((await w.post('/register', { key_id: 'bad' }, '192.0.2.5')).status).toBe(429);
    // and a new challenge cannot reset the registration window
    w.clock.t += 61;
    await w.post('/challenge', {}, '192.0.2.5');
    expect((await w.post('/register', { key_id: 'bad' }, '192.0.2.5')).status).toBe(429);
  });

  it('creates no per-key counter for unregistered key ids', async () => {
    const w = await makeWorld({
      limits: { attestPerKey: { windowSeconds: 3600, maxRequests: 1 } },
    });
    const stranger = await makeAttestation(w.apple, { aaguid: 'production' });
    for (let i = 1; i <= 3; i += 1) {
      const res = await attest(
        w,
        '/wallet-attestation',
        await assertionBody(w, stranger, 'wallet-attestation', i)
      );
      expect(res.status).toBe(401); // always unknown_key, never rate limited per key
    }
  });

  it('cuts off a body that exceeds the limit without Content-Length', async () => {
    const w = await makeWorld();
    const chunk = new TextEncoder().encode('x'.repeat(8 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 40) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await w.app.request('/register', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as Parameters<typeof w.app.request>[1]);
    expect(res.status).toBe(400);
    expect(sent).toBeLessThan(10); // stopped reading after the limit, did not drain 320 KiB
  });

  it('a lost race on the counter returns no JWT to the loser', async () => {
    const w = await makeWorld({ backend: 'd1' });
    const dev = await registered(w);
    const body = await assertionBody(w, dev, 'wallet-attestation', 1);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => attest(w, '/wallet-attestation', body))
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 401)).toHaveLength(3);
    const bodies = await Promise.all(
      results.map((r) => r.json() as Promise<{ attestation?: string }>)
    );
    expect(bodies.filter((b) => b.attestation !== undefined)).toHaveLength(1);
  });

  it('reports leaf days left on /healthz and turns unhealthy near expiry', async () => {
    const w = await makeWorld();
    const ok = await w.get('/healthz');
    expect(await ok.json()).toEqual({
      status: 'ok',
      environment: 'production',
      leafDaysRemaining: { wallet: 30, key: 30 },
    });
    w.clock.t = NOW + 30 * 86400;
    expect((await w.get('/healthz')).status).toBe(503);
  });
});
