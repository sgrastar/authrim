/**
 * DID login and DID linking with REAL cryptography.
 *
 * did-auth.test.ts and did-link.test.ts mock `jose` and `resolveDID`, so a signature, a `did:key`
 * or a DID document is never actually checked there. This file mocks neither: proofs are signed
 * with `SignJWT`, `did:key` identifiers are built to the spec (multicodec + base58btc), and the
 * handlers verify them with the real `jwtVerify`, the real `resolveDID` and the real
 * `didLookupSubject`. Only storage is replaced (challenge store, session store, linked
 * identities, lookup directory, events, audit log, settings KV).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { SignJWT, base64url, generateKeyPair } from 'jose';
import {
  InMemoryChallengeStore,
  InMemoryDidDirectory,
  InMemoryLinkedIdentities,
  TEST_ISSUER,
  base58btcEncode,
  createDidKeyIdentity,
  createJwkIdentity,
  didWebDocument,
  signProof,
  unsecuredProof,
  uncompressedDidKey,
  invalidP256DidKeys,
  type DidKeyIdentity,
  type SigningIdentity,
  type ProofOptions,
} from './helpers/did-real-crypto';

type ApiResponse = Record<string, unknown>;
type SettingsMode = 'on' | 'off' | 'missing' | 'throws';

interface CreatedSession {
  sessionId: string;
  userId: string;
  ttl: number;
  data: Record<string, unknown>;
  tenantId: string;
}

class World {
  challenges = new InMemoryChallengeStore();
  links = new InMemoryLinkedIdentities();
  directory = new InMemoryDidDirectory();
  sessions: CreatedSession[] = [];
  /** session cookie value -> user id (what `getSessionRpc` returns) */
  browserSessions = new Map<string, string>();
  events: Array<{ type: string; data: Record<string, unknown> }> = [];
  audits: Array<Record<string, unknown>> = [];
  settings: SettingsMode = 'on';
  private sessionSequence = 0;

  nextSessionId(): string {
    return `session-${++this.sessionSequence}`;
  }
}

const world = vi.hoisted(() => ({ current: undefined as unknown as World }));

vi.mock('@authrim/ar-lib-core', async () => {
  // The REAL resolveDID / didLookupSubject / createErrorResponse stay: only storage is replaced.
  const actual = await vi.importActual<Record<string, unknown>>('@authrim/ar-lib-core');
  return {
    ...actual,
    getChallengeStoreByDID: vi.fn(() => world.current.challenges),
    getSessionStoreForNewSession: vi.fn(async () => ({
      sessionId: world.current.nextSessionId(),
      stub: {
        createSessionRpc: async (
          sessionId: string,
          userId: string,
          ttl: number,
          data: Record<string, unknown>,
          tenantId: string
        ) => {
          world.current.sessions.push({ sessionId, userId, ttl, data, tenantId });
        },
      },
    })),
    getSessionStoreBySessionId: vi.fn((_env: unknown, sessionId: string) => ({
      stub: {
        getSessionRpc: async () => {
          const userId = world.current.browserSessions.get(sessionId);
          return userId ? { id: sessionId, userId } : null;
        },
      },
    })),
    LinkedIdentityRepository: class {
      findByProviderUser = (...args: [string, string, string]) =>
        world.current.links.findByProviderUser(...args);
      findByUserId = (tenantId: string, userId: string) =>
        world.current.links.findByUserId(tenantId, userId);
      createLinkedIdentity = (
        input: Parameters<InMemoryLinkedIdentities['createLinkedIdentity']>[0]
      ) => world.current.links.createLinkedIdentity(input);
    },
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    resolveAccountDataContextByIdentifierFromHono: vi.fn(
      async (_c: unknown, input: { identifier: { subject: string } }) =>
        world.current.directory.lookup(input.identifier.subject)
    ),
    resolveAccountDataContextFromHono: vi.fn(async (_c: unknown, userId: string) => ({
      tenantId: 'default',
      accountId: `account:${userId}`,
      legacyUserId: userId,
    })),
    publishEvent: vi.fn(
      async (_c: unknown, event: { type: string; data: Record<string, unknown> }) => {
        world.current.events.push({ type: event.type, data: event.data });
      }
    ),
    createAuditLog: vi.fn(async (_env: unknown, entry: Record<string, unknown>) => {
      world.current.audits.push(entry);
    }),
  };
});

import { didAuthChallengeHandler, didAuthVerifyHandler } from '../did-auth';
import { didRegisterChallengeHandler, didRegisterVerifyHandler } from '../did-link';

const SETTINGS_KEY = 'settings:tenant:default:authentication-methods';
const BROWSER_SESSION_COOKIE = 'browser-session-of-user-1';

function createContext(options: {
  body?: unknown;
  cookie?: string;
  env?: Partial<Env>;
}): Context<{ Bindings: Env }> {
  const env = {
    DB: {} as D1Database,
    DB_PII: {} as D1Database,
    CHALLENGE_STORE: {} as DurableObjectNamespace,
    SESSION_STORE: {} as DurableObjectNamespace,
    ISSUER_URL: TEST_ISSUER,
    ACCOUNT_PROVISIONER: world.current.directory.provisioner,
    SETTINGS: {
      get: async (key: string) => {
        if (key !== SETTINGS_KEY) return null;
        switch (world.current.settings) {
          case 'on':
            return JSON.stringify({ 'authentication-methods.did.login_enabled': true });
          case 'off':
            return JSON.stringify({ 'authentication-methods.did.login_enabled': false });
          case 'missing':
            return null;
          case 'throws':
            throw new Error('KV unavailable');
        }
      },
    },
    ...options.env,
  } as unknown as Env;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.cookie) headers.set('Cookie', `authrim_session=${options.cookie}`);
  const raw = new Request(`${TEST_ISSUER}/api/auth/dids/test`, { method: 'POST', headers });
  const store = new Map<string, unknown>([['tenantId', 'default']]);

  return {
    req: {
      raw,
      json: async () => options.body ?? {},
      header: (name: string) => raw.headers.get(name) ?? undefined,
      param: () => undefined,
    },
    env,
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
  } as unknown as Context<{ Bindings: Env }>;
}

interface Result {
  status: number;
  text: string;
  body: ApiResponse;
}

async function read(response: Response): Promise<Result> {
  const text = await response.text();
  let body: ApiResponse = {};
  try {
    body = JSON.parse(text) as ApiResponse;
  } catch {
    // not JSON; `text` is still available
  }
  return { status: response.status, text, body };
}

/** The stable part of an error answer: status plus the machine-readable error fields. */
function errorShape(result: Result) {
  return { status: result.status, error: result.body.error, code: result.body.error_code };
}

const SIGNATURE_REJECTED = 'AR000006';

/**
 * 'signature': the proof failed jwtVerify (signature, algorithm, audience, exp) or the challenge
 * was unusable. 'invalid': it verified but a claim or the kid did not match the challenge. 'any':
 * refused, and which check refused it does not matter (algorithm handling).
 */
function expectRefused(result: Result, kind: 'signature' | 'invalid' | 'any'): void {
  expect(result.status).toBe(400);
  if (kind === 'any') return;
  if (kind === 'signature') {
    expect(result.body.error_code).toBe(SIGNATURE_REJECTED);
  } else {
    expect(result.body.error).toBe('invalid_request');
    expect(result.body.error_code).not.toBe(SIGNATURE_REJECTED);
  }
}

const challengeRequest = async (did: string, env?: Partial<Env>) =>
  read(await didAuthChallengeHandler(createContext({ body: { did }, env })));

const verifyRequest = async (challengeId: unknown, proof: unknown, env?: Partial<Env>) =>
  read(
    await didAuthVerifyHandler(createContext({ body: { challenge_id: challengeId, proof }, env }))
  );

const registerChallengeRequest = async (
  did: unknown,
  cookie: string | null = BROWSER_SESSION_COOKIE
) =>
  read(
    await didRegisterChallengeHandler(createContext({ body: { did }, cookie: cookie ?? undefined }))
  );

const registerVerifyRequest = async (challengeId: unknown, proof: unknown) =>
  read(
    await didRegisterVerifyHandler(
      createContext({ body: { challenge_id: challengeId, proof }, cookie: BROWSER_SESSION_COOKIE })
    )
  );

interface IssuedChallenge {
  challenge_id: string;
  nonce: string;
  allowed_verification_methods: Array<{ id: string }>;
}

async function issueChallenge(did: string): Promise<IssuedChallenge> {
  const result = await challengeRequest(did);
  expect(result.status).toBe(200);
  return result.body as unknown as IssuedChallenge;
}

/** challenge -> sign -> verify through the real handlers. */
async function login(identity: SigningIdentity, proof: ProofOptions = {}) {
  const challenge = await issueChallenge(identity.did);
  const jws = await signProof(identity, challenge, proof);
  return { challenge, jws, result: await verifyRequest(challenge.challenge_id, jws) };
}

function linkFixture(identity: SigningIdentity, userId = 'user-1') {
  world.current.directory.addRoute(identity.did, userId);
  world.current.links.rows.push({
    id: `fixture-${world.current.links.rows.length + 1}`,
    tenant_id: 'default',
    user_id: userId,
    provider_id: 'did',
    provider_user_id: identity.did,
    raw_attributes: null,
    linked_at: Date.now(),
    last_used_at: null,
  });
}

const failureEvents = () => world.current.events.filter((e) => e.type.endsWith('did.failed'));

describe('DID login with real cryptography', () => {
  let identity: DidKeyIdentity;

  beforeEach(async () => {
    world.current = new World();
    identity = await createDidKeyIdentity('EdDSA');
  });

  describe('test fixtures are spec-correct', () => {
    it('base58btc encoder reproduces a published did:key vector through the real resolver', async () => {
      const { resolveDID } = await import('@authrim/ar-lib-core');
      const known = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
      const document = await resolveDID(known);
      const x = document.verificationMethod?.[0].publicKeyJwk?.x as string;
      const raw = base64url.decode(x);
      expect(`did:key:z${base58btcEncode(new Uint8Array([0xed, 0x01, ...raw]))}`).toBe(known);
    });

    it('the generated did:key resolves back to the generated public key (Ed25519, P-256, P-384, P-521)', async () => {
      const { resolveDID } = await import('@authrim/ar-lib-core');
      for (const alg of ['EdDSA', 'ES256', 'ES384', 'ES512'] as const) {
        const generated = await createDidKeyIdentity(alg);
        const document = await resolveDID(generated.did);
        const jwk = document.verificationMethod?.[0].publicKeyJwk;
        expect(document.verificationMethod?.[0].id).toBe(generated.kid);
        expect(jwk?.x).toBe(generated.publicJwk.x);
        if (alg !== 'EdDSA') expect(jwk?.y).toBe(generated.publicJwk.y);
      }
    });
  });

  describe('successful login', () => {
    it('Ed25519 did:key: challenge -> sign -> verify opens a did session for the linked user', async () => {
      linkFixture(identity);

      const { result } = await login(identity);

      expect(result.status).toBe(200);
      expect(result.body.user_id).toBe('user-1');
      expect(typeof result.body.session_id).toBe('string');
      expect(result.body.expires_in).toBeGreaterThan(0);

      expect(world.current.sessions).toHaveLength(1);
      const [session] = world.current.sessions;
      expect(session.sessionId).toBe(result.body.session_id);
      expect(session.userId).toBe('user-1');
      expect(session.data).toMatchObject({
        amr: ['did'],
        acr: 'urn:authrim:acr:did',
        did: identity.did,
        verification_method: identity.kid,
      });
      expect(typeof session.data.proven_at).toBe('number');
      expect(world.current.events.map((e) => e.type)).toEqual(
        expect.arrayContaining([expect.stringMatching(/did\.succeeded$/)])
      );
      expect(world.current.audits).toHaveLength(1);
      expect(world.current.audits[0]).toMatchObject({ action: 'user.login', userId: 'user-1' });
    });

    it('P-256 did:key with ES256 also logs in (real key decompression and ECDSA verification)', async () => {
      const ec = await createDidKeyIdentity('ES256');
      linkFixture(ec, 'user-ec');

      const { result } = await login(ec);

      expect(result.status).toBe(200);
      expect(result.body.user_id).toBe('user-ec');
    });

    it.each(['ES384', 'ES512'] as const)(
      'did:key with %s also logs in (compressed point decompressed by the resolver)',
      async (alg) => {
        const ec = await createDidKeyIdentity(alg);
        linkFixture(ec, 'user-ec');

        const { result } = await login(ec);

        expect(result.status).toBe(200);
      }
    );

    it('the challenge announces the DID key as the only allowed verification method', async () => {
      const challenge = await issueChallenge(identity.did);
      expect(challenge.allowed_verification_methods.map((m) => m.id)).toEqual([identity.kid]);
    });
  });

  describe('DID that is not linked', () => {
    it('no lookup route and a route without a link row give the identical BRIDGE_LINK_REQUIRED answer', async () => {
      const noRoute = identity;
      const routeOnly = await createDidKeyIdentity('EdDSA');
      world.current.directory.addRoute(routeOnly.did, 'user-9'); // route published, link row missing

      const first = await login(noRoute);
      const second = await login(routeOnly);

      expect(first.result.status).toBe(400);
      expect(first.result.body.error_code).toBe('AR090001');
      expect(errorShape(first.result)).toEqual(errorShape(second.result));
      // Everything but per-request identifiers is identical, byte for byte.
      const strip = (text: string, did: string) => text.split(did).join('<did>');
      expect(strip(first.result.text, noRoute.did)).toBe(strip(second.result.text, routeOnly.did));
      expect(world.current.sessions).toHaveLength(0);
      expect(failureEvents().map((e) => e.data.errorCode)).toEqual([
        'identity_not_linked',
        'identity_not_linked',
      ]);
    });

    it('a link row that points at another account than the route is a server error, never a session', async () => {
      world.current.directory.addRoute(identity.did, 'user-2');
      world.current.links.rows.push({
        id: 'mismatch',
        tenant_id: 'default',
        user_id: 'user-1',
        provider_id: 'did',
        provider_user_id: identity.did,
        raw_attributes: null,
        linked_at: Date.now(),
        last_used_at: null,
      });

      const { result } = await login(identity);

      expect(result.status).toBe(500);
      expect(world.current.sessions).toHaveLength(0);
    });
  });

  describe('proof validation', () => {
    beforeEach(() => linkFixture(identity));

    it('rejects a signature made by a different key under the right kid', async () => {
      const attacker = await generateKeyPair('EdDSA', { extractable: true });
      const { result } = await login(identity, { key: attacker.privateKey });

      expect(result.status).toBe(400);
      expect(result.body.error_code).toBe('AR000006');
      expect(world.current.sessions).toHaveLength(0);
      expect(failureEvents().map((e) => e.data.errorCode)).toEqual([
        'signature_verification_failed',
      ]);
    });

    it('rejects a proof whose payload was altered after signing', async () => {
      const challenge = await issueChallenge(identity.did);
      const jws = await signProof(identity, challenge);
      const [header, , signature] = jws.split('.');
      const forged = base64url.encode(
        JSON.stringify({
          iss: identity.did,
          aud: TEST_ISSUER,
          nonce: challenge.nonce,
          sub: 'admin',
        })
      );

      const result = await verifyRequest(
        challenge.challenge_id,
        `${header}.${forged}.${signature}`
      );

      expectRefused(result, 'signature');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects a wrong nonce', async () => {
      const { result } = await login(identity, { nonce: 'not-the-nonce' });
      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects a proof without a nonce', async () => {
      const { result } = await login(identity, { nonce: null });
      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects a wrong audience (a proof made for another service)', async () => {
      const { result } = await login(identity, { aud: 'https://other-service.example.com' });
      expectRefused(result, 'signature');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects an issuer that is not the DID', async () => {
      const other = await createDidKeyIdentity('EdDSA');
      const { result } = await login(identity, { iss: other.did });
      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects an expired proof (exp in the past)', async () => {
      const { result } = await login(identity, { exp: Math.floor(Date.now() / 1000) - 60 });
      expectRefused(result, 'signature');
      expect(world.current.sessions).toHaveLength(0);
    });

    // CURRENT BEHAVIOR, pinned on purpose: `exp` is not required. The proof is bound to the
    // single-use challenge by `nonce`, and the challenge itself expires after 300 s, so a proof
    // without `exp` still cannot be replayed. If `exp` becomes mandatory, change this test.
    it('accepts a proof WITHOUT exp (exp is checked only when present)', async () => {
      const { result } = await login(identity, { exp: null });
      expect(result.status).toBe(200);
    });

    it('rejects a kid that belongs to a different DID', async () => {
      const other = await createDidKeyIdentity('EdDSA');
      const { result } = await login(identity, { kid: other.kid, key: other.privateKey });
      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects a different fragment of the same DID', async () => {
      const { result } = await login(identity, { kid: `${identity.did}#some-other-key` });
      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects a proof with no kid', async () => {
      const { result } = await login(identity, { kid: null });
      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects a symmetric algorithm (HS256 with the DID key bytes as the secret)', async () => {
      const challenge = await issueChallenge(identity.did);
      const secret = base64url.decode(identity.publicJwk.x as string);
      const jws = await new SignJWT({ nonce: challenge.nonce })
        .setProtectedHeader({ alg: 'HS256', kid: identity.kid })
        .setIssuer(identity.did)
        .setAudience(TEST_ISSUER)
        .setExpirationTime('2m')
        .sign(secret);

      const result = await verifyRequest(challenge.challenge_id, jws);

      expectRefused(result, 'any');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects alg none with an empty signature', async () => {
      const challenge = await issueChallenge(identity.did);
      const result = await verifyRequest(
        challenge.challenge_id,
        unsecuredProof(identity, challenge)
      );
      expectRefused(result, 'any');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects an algorithm that does not fit the key (ES256 header over an Ed25519 DID key)', async () => {
      const ec = await generateKeyPair('ES256', { extractable: true });
      const { result } = await login(identity, { alg: 'ES256', key: ec.privateKey });
      expectRefused(result, 'any');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects an algorithm outside the allow-list even when the key would verify (RS256 header)', async () => {
      const challenge = await issueChallenge(identity.did);
      const rsa = await generateKeyPair('RS256', { extractable: true });
      const jws = await signProof(identity, challenge, { alg: 'RS256', key: rsa.privateKey });
      const result = await verifyRequest(challenge.challenge_id, jws);
      expectRefused(result, 'any');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects input that is not a JWS', async () => {
      const challenge = await issueChallenge(identity.did);
      for (const proof of ['not-a-jws', 'a.b.c', 'x'.repeat(5000)]) {
        const result = await verifyRequest(challenge.challenge_id, proof);
        expect(result.status).toBe(400);
      }
      expect(world.current.sessions).toHaveLength(0);
    });

    it('rejects a kid that is not a DID URL', async () => {
      const { result } = await login(identity, { kid: 'https://evil.example.com/key#1' });
      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });
  });

  describe('challenge lifecycle', () => {
    beforeEach(() => linkFixture(identity));

    it('is single use: the same proof presented twice opens exactly one session', async () => {
      const { challenge, jws, result } = await login(identity);
      expect(result.status).toBe(200);

      const replay = await verifyRequest(challenge.challenge_id, jws);

      expect(replay.status).toBe(400);
      expect(replay.body.error_code).toBe('AR000006');
      expect(world.current.sessions).toHaveLength(1);
    });

    it('a failed verification burns the challenge: the right proof afterwards is refused', async () => {
      const challenge = await issueChallenge(identity.did);
      const bad = await signProof(identity, challenge, { nonce: 'wrong' });
      const good = await signProof(identity, challenge);

      expect((await verifyRequest(challenge.challenge_id, bad)).status).toBe(400);
      expect((await verifyRequest(challenge.challenge_id, good)).status).toBe(400);
      expect(world.current.sessions).toHaveLength(0);
    });

    it('a proof captured from one challenge is useless against a fresh challenge (nonce binding)', async () => {
      const first = await issueChallenge(identity.did);
      const captured = await signProof(identity, first);
      const second = await issueChallenge(identity.did);

      const result = await verifyRequest(second.challenge_id, captured);

      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    // The in-memory store is one shard, so the challenge is found and then refused because B's kid is
    // not among A's allowed methods. With real sharding B's shard may not hold it at all (then the
    // answer is the "unusable challenge" one); either way no session may open.
    it('a challenge issued for DID A cannot be consumed with a proof from DID B', async () => {
      const intruder = await createDidKeyIdentity('EdDSA');
      linkFixture(intruder, 'user-intruder');
      const challengeOfA = await issueChallenge(identity.did);
      const proofOfB = await signProof(intruder, challengeOfA);

      const result = await verifyRequest(challengeOfA.challenge_id, proofOfB);

      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('a challenge past its 300 s TTL is refused', async () => {
      const challenge = await issueChallenge(identity.did);
      const jws = await signProof(identity, challenge);
      world.current.challenges.advance(301_000);

      const result = await verifyRequest(challenge.challenge_id, jws);

      expect(result.status).toBe(400);
      expect(result.body.error_code).toBe('AR000006');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('an unknown challenge id is refused', async () => {
      const challenge = { nonce: 'n' };
      const jws = await signProof(identity, challenge);
      const result = await verifyRequest('00000000-0000-4000-8000-000000000000', jws);
      expect(result.status).toBe(400);
      expect(world.current.sessions).toHaveLength(0);
    });

    it('a registration (linking) challenge cannot be used to log in', async () => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const registration = await read(
        await didRegisterChallengeHandler(
          createContext({ body: { did: identity.did }, cookie: BROWSER_SESSION_COOKIE })
        )
      );
      expect(registration.status).toBe(200);
      const regChallenge = registration.body as unknown as IssuedChallenge;
      const jws = await signProof(identity, regChallenge);

      const result = await verifyRequest(regChallenge.challenge_id, jws);

      expect(result.status).toBe(400);
      expect(world.current.sessions).toHaveLength(0);
    });
  });

  describe('login_enabled switch', () => {
    beforeEach(() => linkFixture(identity));

    it('off: challenge and verify both answer a policy error and nothing is stored or consumed', async () => {
      world.current.settings = 'off';

      const challenge = await challengeRequest(identity.did);
      expect(challenge.status).toBe(403);
      expect(challenge.body.error).toBe('access_denied');
      expect(world.current.challenges.storeCalls).toHaveLength(0);

      const verify = await verifyRequest('some-id', await signProof(identity, { nonce: 'n' }));
      expect(verify.status).toBe(403);
      expect(world.current.challenges.consumeCalls).toHaveLength(0);
      expect(world.current.sessions).toHaveLength(0);
    });

    it('missing setting counts as off', async () => {
      world.current.settings = 'missing';
      expect((await challengeRequest(identity.did)).status).toBe(403);
    });

    it('switching off between challenge and verify leaves the challenge unconsumed; back on it works', async () => {
      const challenge = await issueChallenge(identity.did);
      const jws = await signProof(identity, challenge);

      world.current.settings = 'off';
      expect((await verifyRequest(challenge.challenge_id, jws)).status).toBe(403);
      expect(world.current.challenges.consumeCalls).toHaveLength(0);
      expect(world.current.challenges.consumedCount).toBe(0);

      world.current.settings = 'on';
      expect((await verifyRequest(challenge.challenge_id, jws)).status).toBe(200);
    });

    it('unreadable settings: 503 for challenge and verify, and the challenge is not consumed', async () => {
      const challenge = await issueChallenge(identity.did);
      const jws = await signProof(identity, challenge);
      const storedBefore = world.current.challenges.storeCalls.length;

      world.current.settings = 'throws';
      const refusedChallenge = await challengeRequest(identity.did);
      const refusedVerify = await verifyRequest(challenge.challenge_id, jws);

      expect(refusedChallenge.status).toBe(503);
      expect(refusedChallenge.body.error).toBe('temporarily_unavailable');
      expect(refusedVerify.status).toBe(503);
      expect(world.current.challenges.storeCalls).toHaveLength(storedBefore);
      expect(world.current.challenges.consumeCalls).toHaveLength(0);

      world.current.settings = 'on';
      expect((await verifyRequest(challenge.challenge_id, jws)).status).toBe(200);
    });

    it('a string "true" does not turn DID login on', async () => {
      const env = {
        SETTINGS: {
          get: async () => JSON.stringify({ 'authentication-methods.did.login_enabled': 'true' }),
        },
      } as unknown as Partial<Env>;
      expect((await challengeRequest(identity.did, env)).status).toBe(403);
    });
  });

  describe('DID URLs and DIDs the lookup directory cannot index', () => {
    // did:key tolerates a path, query or fragment after the method-specific id and resolves it to
    // the same key. Such strings are DID URLs, not DIDs: accepted as an identifier they would give
    // one key several links and lookup routes (aliases). They are refused as invalid values.
    const oddForms: Array<[string, (did: string) => string]> = [
      ['a path', (did) => `${did}/alias`],
      ['a query', (did) => `${did}?x=1`],
      ['a fragment', (did) => `${did}#frag`],
      ['trailing whitespace', (did) => `${did} `],
      ['leading whitespace', (did) => ` ${did}`],
      ['over 1024 bytes', (did) => `${did}${'a'.repeat(1100)}`],
      ['a control character', (did) => `${did}\u0007`],
    ];

    it.each(oddForms)(
      'challenge: a DID with %s is a 400 and nothing is stored',
      async (_n, mutate) => {
        const result = await challengeRequest(mutate(identity.did));
        expect(result.status).toBe(400);
        expect(result.body.error).toBe('invalid_request');
        expect(world.current.challenges.storeCalls).toHaveLength(0);
      }
    );

    it.each([
      ['a path', (did: string) => `${did}/alias`],
      ['a query', (did: string) => `${did}?x=1`],
      ['trailing whitespace', (did: string) => `${did} `],
      ['over 1024 bytes', (did: string) => `${did}/${'a'.repeat(1100)}`],
      ['a control character', (did: string) => `${did}\u0007`],
    ])(
      'verify: a kid whose DID has %s is a 400 before the challenge is consumed',
      async (_name, mutate) => {
        linkFixture(identity);
        const challenge = await issueChallenge(identity.did);
        const aliasDid = mutate(identity.did);
        const jws = await signProof(identity, challenge, {
          kid: `${aliasDid}#${identity.multibaseKey}`,
          iss: aliasDid,
        });

        const result = await verifyRequest(challenge.challenge_id, jws);

        expect(result.status).toBe(400);
        expect(result.body.error).toBe('invalid_request');
        expect(world.current.challenges.consumeCalls).toHaveLength(0);
        expect(world.current.sessions).toHaveLength(0);
        // The genuine proof for the same challenge still works: the refusal did not burn it.
        const genuine = await signProof(identity, challenge);
        expect((await verifyRequest(challenge.challenge_id, genuine)).status).toBe(200);
      }
    );

    it('a link of the plain DID is not reachable through an alias of the same key', async () => {
      linkFixture(identity, 'user-plain');
      const alias = `${identity.did}/alias`;

      expect((await challengeRequest(alias)).status).toBe(400);
      expect((await login(identity)).result.body.user_id).toBe('user-plain');
    });

    it('leading whitespace in the kid is rejected as an invalid value, not a 500', async () => {
      const { result } = await login(identity, { kid: ` ${identity.kid}` });
      expect(result.status).toBe(400);
    });
  });

  describe('uncompressed EC did:key (a second DID string for one key)', () => {
    it.each(['ES256', 'ES384', 'ES512'] as const)(
      '%s: the uncompressed form is refused at the challenge, the compressed form of the same key works',
      async (alg) => {
        const ec = await createDidKeyIdentity(alg);
        const odd = uncompressedDidKey(ec);
        expect(odd.did).not.toBe(ec.did);

        const refused = await challengeRequest(odd.did);
        expect(refused.status).toBe(400);
        expect(refused.body.error).toBe('invalid_request');
        expect(world.current.challenges.storeCalls).toHaveLength(0);

        linkFixture(ec, 'user-ec');
        expect((await login(ec)).result.status).toBe(200);
      }
    );

    it('a compressed EC did:key that is not a point of the curve is refused at both challenges', async () => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const { outOfRange, nonResidue } = invalidP256DidKeys();

      for (const did of [outOfRange, nonResidue]) {
        const login_ = await challengeRequest(did);
        const link = await registerChallengeRequest(did);
        for (const result of [login_, link]) {
          expect(result.status).toBe(400);
          expect(result.body.error).toBe('invalid_request');
          expect(result.text).not.toContain(did);
        }
      }
      expect(world.current.challenges.storeCalls).toHaveLength(0);
    });

    it('verify: a proof under the uncompressed kid is refused even for a challenge of the compressed DID', async () => {
      const ec = await createDidKeyIdentity('ES256');
      const odd = uncompressedDidKey(ec);
      linkFixture(ec, 'user-ec');
      world.current.directory.addRoute(odd.did, 'user-alias');
      const challenge = await issueChallenge(ec.did);

      const result = await verifyRequest(
        challenge.challenge_id,
        await signProof(ec, challenge, { kid: odd.kid, iss: odd.did })
      );

      expect(result.status).toBe(400);
      expect(world.current.sessions).toHaveLength(0);
    });
  });

  describe('information leakage', () => {
    it('an unresolvable DID gives a generic error that does not echo the DID', async () => {
      const unsupported = 'did:example:secret-subject-123';
      const result = await challengeRequest(unsupported);

      expect(result.status).toBe(400);
      expect(result.text).not.toContain('secret-subject-123');
      expect(result.text).not.toContain(unsupported);
    });

    it('a malformed did:key answers like any other bad value and does not echo it', async () => {
      const malformed = 'did:key:z0OIl-not-base58';
      const result = await challengeRequest(malformed);
      expect(result.status).toBe(400);
      expect(result.text).not.toContain('not-base58');
    });

    it('a bad signature answer carries no DID, key or nonce', async () => {
      linkFixture(identity);
      const attacker = await generateKeyPair('EdDSA', { extractable: true });
      const { challenge, result } = await login(identity, { key: attacker.privateKey });

      expect(result.status).toBe(400);
      expect(result.text).not.toContain(identity.did);
      expect(result.text).not.toContain(identity.multibaseKey);
      expect(result.text).not.toContain(challenge.nonce);
    });

    it('the not-linked answer carries no DID, key or user id', async () => {
      world.current.directory.addRoute(identity.did, 'user-secret-77');
      const { result } = await login(identity);

      expect(result.status).toBe(400);
      expect(result.text).not.toContain(identity.did);
      expect(result.text).not.toContain(identity.multibaseKey);
      expect(result.text).not.toContain('user-secret-77');
    });

    it('the challenge answer does not reveal whether the DID is linked', async () => {
      const linked = await createDidKeyIdentity('EdDSA');
      linkFixture(linked);
      const keys = (body: ApiResponse) => Object.keys(body).sort();

      const forLinked = await challengeRequest(linked.did);
      const forUnlinked = await challengeRequest(identity.did);

      expect(forLinked.status).toBe(forUnlinked.status);
      expect(keys(forLinked.body)).toEqual(keys(forUnlinked.body));
    });
  });

  describe('request shape', () => {
    it.each([
      ['missing', {}],
      ['empty', { did: '' }],
      ['whitespace only', { did: '   ' }],
      ['not a DID', { did: 'https://example.com' }],
    ])('challenge: %s did is a 400', async (_name, body) => {
      const result = await read(await didAuthChallengeHandler(createContext({ body })));
      expect(result.status).toBe(400);
    });

    it('challenge: a did that is not a string is a 400', async () => {
      for (const did of [123, {}, ['did:key:z'], true]) {
        const result = await read(await didAuthChallengeHandler(createContext({ body: { did } })));
        expect(result.status).toBe(400);
        expect(world.current.challenges.storeCalls).toHaveLength(0);
      }
    });

    it.each([
      ['challenge', didAuthChallengeHandler],
      ['verify', didAuthVerifyHandler],
      ['register challenge', didRegisterChallengeHandler],
      ['register verify', didRegisterVerifyHandler],
    ])('%s: a body that is not JSON is a 400', async (_name, handler) => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const c = createContext({ body: {}, cookie: BROWSER_SESSION_COOKIE });
      (c.req as unknown as { json: () => Promise<unknown> }).json = async () => {
        throw new SyntaxError('Unexpected token');
      };
      const result = await read(await handler(c));
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
    });

    it.each([
      ['challenge', didAuthChallengeHandler],
      ['verify', didAuthVerifyHandler],
      ['register challenge', didRegisterChallengeHandler],
      ['register verify', didRegisterVerifyHandler],
    ])('%s: a JSON body that is not an object is a 400', async (_name, handler) => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      for (const raw of [null, [], 'text', 5]) {
        const c = createContext({ body: {}, cookie: BROWSER_SESSION_COOKIE });
        (c.req as unknown as { json: () => Promise<unknown> }).json = async () => raw;
        expect((await handler(c)).status).toBe(400);
      }
    });

    it('the settings gate still comes first: off is 403 and unreadable is 503 even for a bad body', async () => {
      const bad = () => {
        const c = createContext({ body: {}, cookie: BROWSER_SESSION_COOKIE });
        (c.req as unknown as { json: () => Promise<unknown> }).json = async () => {
          throw new SyntaxError('Unexpected token');
        };
        return c;
      };
      world.current.settings = 'off';
      expect((await didAuthChallengeHandler(bad())).status).toBe(403);
      expect((await didAuthVerifyHandler(bad())).status).toBe(403);
      world.current.settings = 'throws';
      expect((await didAuthChallengeHandler(bad())).status).toBe(503);
      expect((await didAuthVerifyHandler(bad())).status).toBe(503);
    });

    it('verify: malformed proofs and non-string proofs are a 400, never a session', async () => {
      for (const body of [
        { challenge_id: 'x', proof: 2 },
        { challenge_id: 'x', proof: {} },
        { challenge_id: 'x', proof: ['y.y.y'] },
        { challenge_id: 'x', proof: 'not-a-jws' },
      ]) {
        const result = await read(await didAuthVerifyHandler(createContext({ body })));
        expect(result.status).toBe(400);
      }
      expect(world.current.sessions).toHaveLength(0);
    });

    it('verify: a VALID proof with a challenge_id that is not a string is refused before anything is consumed', async () => {
      linkFixture(identity);
      const challenge = await issueChallenge(identity.did);
      const jws = await signProof(identity, challenge);

      // Interpolated into `did_auth:${challenge_id}`, an array of the id would match the stored one.
      for (const challengeId of [
        [challenge.challenge_id],
        { toString: () => challenge.challenge_id },
        42,
      ]) {
        const result = await verifyRequest(challengeId, jws);
        expect(result.status).toBe(400);
        expect(result.body.error).toBe('invalid_request');
      }
      expect(world.current.challenges.consumeCalls).toHaveLength(0);
      expect(world.current.sessions).toHaveLength(0);
      // The same proof with the string id still works: nothing was burned.
      expect((await verifyRequest(challenge.challenge_id, jws)).status).toBe(200);
    });

    it('register verify: a VALID proof with a challenge_id that is not a string is refused before anything is consumed', async () => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const challenge = (await registerChallengeRequest(identity.did))
        .body as unknown as IssuedChallenge;
      const jws = await signProof(identity, challenge);

      for (const challengeId of [[challenge.challenge_id], 42]) {
        const result = await registerVerifyRequest(challengeId, jws);
        expect(result.status).toBe(400);
        expect(result.body.error).toBe('invalid_request');
      }
      expect(world.current.challenges.consumeCalls).toHaveLength(0);
      expect(world.current.links.rows).toHaveLength(0);
      expect((await registerVerifyRequest(challenge.challenge_id, jws)).status).toBe(200);
    });

    it.each([123, { a: 1 }, ['did:key:z'], true])(
      'a kid header that is not a string (%j) is a 400, not a 500, and consumes nothing',
      async (kid) => {
        linkFixture(identity);
        world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
        const nonStringKid = async (nonce: string) =>
          new SignJWT({ nonce })
            .setProtectedHeader({ alg: 'EdDSA', kid: kid as unknown as string })
            .setIssuer(identity.did)
            .setAudience(TEST_ISSUER)
            .setExpirationTime('2m')
            .sign(identity.privateKey);

        const login_ = await issueChallenge(identity.did);
        const loginResult = await verifyRequest(
          login_.challenge_id,
          await nonStringKid(login_.nonce)
        );
        const reg = (await registerChallengeRequest(identity.did))
          .body as unknown as IssuedChallenge;
        const regResult = await registerVerifyRequest(
          reg.challenge_id,
          await nonStringKid(reg.nonce)
        );

        for (const result of [loginResult, regResult]) {
          expect(result.status).toBe(400);
          expect(result.body.error).toBe('invalid_request');
        }
        expect(world.current.challenges.consumeCalls).toHaveLength(0);
        expect(world.current.sessions).toHaveLength(0);
        expect(world.current.links.rows).toHaveLength(1); // only the fixture
      }
    );

    it('register challenge: a did that is not a string is a 400', async () => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const result = await read(
        await didRegisterChallengeHandler(
          createContext({ body: { did: 123 }, cookie: BROWSER_SESSION_COOKIE })
        )
      );
      expect(result.status).toBe(400);
    });

    it.each([
      ['missing challenge_id', { proof: 'a.b.c' }],
      ['missing proof', { challenge_id: 'x' }],
      ['whitespace proof', { challenge_id: 'x', proof: '  ' }],
    ])('verify: %s is a 400', async (_name, body) => {
      const result = await read(await didAuthVerifyHandler(createContext({ body })));
      expect(result.status).toBe(400);
    });
  });
});

describe('did:web login with real cryptography (DID document served by a stubbed fetch)', () => {
  const DID = 'did:web:did.example.com';
  let documents: Map<string, unknown>;
  let fetched: string[];

  beforeEach(() => {
    world.current = new World();
    documents = new Map();
    fetched = [];
    // Only the network is replaced: resolveDID, safeFetch and the DID-document checks are real.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(String(url));
        const document = documents.get(String(url));
        return document === undefined
          ? new Response('not found', { status: 404 })
          : new Response(JSON.stringify(document), {
              status: 200,
              headers: { 'Content-Type': 'application/did+json' },
            });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const publish = (document: unknown) =>
    documents.set('https://did.example.com/.well-known/did.json', document);

  it('logs in with a P-256 key published in the did:web document', async () => {
    const key = await createJwkIdentity(DID, 'key-1', 'ES256');
    publish(didWebDocument(DID, [key]));
    linkFixture(key);

    const { result } = await login(key);

    expect(result.status).toBe(200);
    expect(fetched).toContain('https://did.example.com/.well-known/did.json');
    expect(world.current.sessions[0].data).toMatchObject({
      did: DID,
      verification_method: key.kid,
    });
  });

  // `alg` is optional in a JWK and usually absent in did:web documents; the key is imported under
  // the proof's algorithm in that case (checked against the allow-list first).
  it.each([
    ['ES256', 'ES256'],
    ['EdDSA', 'EdDSA'],
  ])('logs in with a %s did:web JWK that has no alg member', async (alg) => {
    const key = await createJwkIdentity(DID, 'key-1', alg);
    publish(didWebDocument(DID, [key], undefined, { jwkAlg: false }));
    linkFixture(key);

    const { result } = await login(key);

    expect(result.status).toBe(200);
    expect(world.current.sessions).toHaveLength(1);
  });

  it.each([
    ['ES256', 'ES256'],
    ['EdDSA', 'EdDSA'],
  ])('links a %s did:web JWK that has no alg member, and login then works', async (alg) => {
    world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
    const key = await createJwkIdentity(DID, 'key-1', alg);
    publish(didWebDocument(DID, [key], undefined, { jwkAlg: false }));

    const challenge = (await registerChallengeRequest(DID)).body as unknown as IssuedChallenge;
    const linked = await registerVerifyRequest(
      challenge.challenge_id,
      await signProof(key, challenge)
    );

    expect(linked.status).toBe(200);
    expect(world.current.links.rows).toHaveLength(1);
    expect((await login(key)).result.status).toBe(200);
  });

  it('refuses a JWK whose alg disagrees with the proof header, even if the proof verifies', async () => {
    const key = await createJwkIdentity(DID, 'key-1', 'ES256');
    const document = didWebDocument(DID, [key]);
    document.verificationMethod[0].publicKeyJwk = { ...key.publicJwk, alg: 'ES384' };
    publish(document);
    linkFixture(key);

    // A proof that is valid under the key (ES256, header ES256) but the JWK says ES384.
    const { result } = await login(key);

    expectRefused(result, 'signature');
    expect(world.current.sessions).toHaveLength(0);
    expect(failureEvents().map((e) => e.data.errorCode)).toEqual(['signature_verification_failed']);
  });

  it('link: a JWK whose alg disagrees with the proof header links nothing', async () => {
    world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
    const key = await createJwkIdentity(DID, 'key-1', 'ES256');
    const document = didWebDocument(DID, [key]);
    document.verificationMethod[0].publicKeyJwk = { ...key.publicJwk, alg: 'ES384' };
    publish(document);

    const challenge = (await registerChallengeRequest(DID)).body as unknown as IssuedChallenge;
    const result = await registerVerifyRequest(
      challenge.challenge_id,
      await signProof(key, challenge)
    );

    expectRefused(result, 'signature');
    expect(world.current.links.rows).toHaveLength(0);
  });

  it('refuses a header algorithm outside the allow-list when the JWK has no alg (RS256)', async () => {
    const rsa = await createJwkIdentity(DID, 'rsa-key', 'RS256');
    publish(didWebDocument(DID, [rsa], undefined, { jwkAlg: false }));
    linkFixture(rsa);

    const { result } = await login(rsa);

    expectRefused(result, 'signature');
    expect(world.current.sessions).toHaveLength(0);
    expect(failureEvents().map((e) => e.data.errorCode)).toEqual(['signature_verification_failed']);
  });

  it('refuses HS256 and PS256 headers over a JWK without alg, and alg none', async () => {
    const key = await createJwkIdentity(DID, 'key-1', 'ES256');
    publish(didWebDocument(DID, [key], undefined, { jwkAlg: false }));
    linkFixture(key);

    for (const alg of ['HS256', 'PS256']) {
      const challenge = await issueChallenge(DID);
      const secret =
        alg === 'HS256' ? new Uint8Array(32).fill(7) : (await generateKeyPair('PS256')).privateKey;
      const jws = await signProof(key, challenge, { alg, key: secret });
      expectRefused(await verifyRequest(challenge.challenge_id, jws), 'signature');
    }
    const challenge = await issueChallenge(DID);
    expectRefused(
      await verifyRequest(challenge.challenge_id, unsecuredProof(key, challenge)),
      'signature'
    );
    expect(world.current.sessions).toHaveLength(0);
  });

  it('link: an RS256 proof over a JWK without alg links nothing', async () => {
    world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
    const rsa = await createJwkIdentity(DID, 'rsa-key', 'RS256');
    publish(didWebDocument(DID, [rsa], undefined, { jwkAlg: false }));

    const challenge = (await registerChallengeRequest(DID)).body as unknown as IssuedChallenge;
    const result = await registerVerifyRequest(
      challenge.challenge_id,
      await signProof(rsa, challenge)
    );

    expectRefused(result, 'signature');
    expect(world.current.links.rows).toHaveLength(0);
  });

  it.each([
    [
      'a port (%3A)',
      'did:web:did.example.com%3A8443',
      'https://did.example.com:8443/.well-known/did.json',
    ],
    [
      'a path (: segments)',
      'did:web:did.example.com:users:alice',
      'https://did.example.com/users/alice/did.json',
    ],
    [
      'a port and a path',
      'did:web:did.example.com%3A8443:users:alice',
      'https://did.example.com:8443/users/alice/did.json',
    ],
  ])('a valid did:web with %s logs in and links', async (_name, did, url) => {
    world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
    const key = await createJwkIdentity(did, 'key-1', 'ES256');
    documents.set(url, didWebDocument(did, [key], undefined, { jwkAlg: false }));

    const challenge = (await registerChallengeRequest(did)).body as unknown as IssuedChallenge;
    expect(
      (await registerVerifyRequest(challenge.challenge_id, await signProof(key, challenge))).status
    ).toBe(200);
    expect(fetched).toContain(url);

    const { result } = await login(key);
    expect(result.status).toBe(200);
    expect(world.current.sessions[0].data.did).toBe(did);
  });

  describe('the key must be an authentication method NOW, not only when the challenge was issued', () => {
    it('login: a key removed from authentication after the challenge is refused like an unknown method', async () => {
      const key = await createJwkIdentity(DID, 'key-1', 'ES256');
      publish(didWebDocument(DID, [key]));
      linkFixture(key);
      const challenge = await issueChallenge(DID);
      const jws = await signProof(key, challenge);

      publish(didWebDocument(DID, [key], [])); // still a verification method, no longer authentication
      const result = await verifyRequest(challenge.challenge_id, jws);

      expectRefused(result, 'invalid');
      expect(world.current.sessions).toHaveLength(0);
    });

    it('link: a key removed from authentication after the challenge links nothing', async () => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const key = await createJwkIdentity(DID, 'key-1', 'ES256');
      publish(didWebDocument(DID, [key]));
      const challenge = (await registerChallengeRequest(DID)).body as unknown as IssuedChallenge;
      const jws = await signProof(key, challenge);

      publish(didWebDocument(DID, [key], []));
      const result = await registerVerifyRequest(challenge.challenge_id, jws);

      expectRefused(result, 'invalid');
      expect(world.current.links.rows).toHaveLength(0);
    });

    it('login and link: a key referenced by id from authentication works', async () => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const key = await createJwkIdentity(DID, 'key-1', 'ES256');
      publish(didWebDocument(DID, [key], [key.kid]));

      const challenge = (await registerChallengeRequest(DID)).body as unknown as IssuedChallenge;
      expect(
        (await registerVerifyRequest(challenge.challenge_id, await signProof(key, challenge)))
          .status
      ).toBe(200);
      expect((await login(key)).result.status).toBe(200);
    });

    it('login and link: an inline method in authentication works', async () => {
      world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
      const key = await createJwkIdentity(DID, 'inline-key', 'ES256');
      publish({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: DID,
        authentication: [
          {
            id: key.kid,
            type: 'JsonWebKey2020',
            controller: DID,
            publicKeyJwk: { ...key.publicJwk, alg: 'ES256' },
          },
        ],
      });

      const challenge = (await registerChallengeRequest(DID)).body as unknown as IssuedChallenge;
      expect(
        (await registerVerifyRequest(challenge.challenge_id, await signProof(key, challenge)))
          .status
      ).toBe(200);
      expect((await login(key)).result.status).toBe(200);
    });

    it('login: removing only one of two authentication keys keeps the other working', async () => {
      const first = await createJwkIdentity(DID, 'key-1', 'ES256');
      const second = await createJwkIdentity(DID, 'key-2', 'ES256');
      publish(didWebDocument(DID, [first, second]));
      linkFixture(first);
      const challenge = await issueChallenge(DID);
      const jwsFirst = await signProof(first, challenge);

      publish(didWebDocument(DID, [first, second], [second.kid]));

      expectRefused(await verifyRequest(challenge.challenge_id, jwsFirst), 'invalid');
      // (the challenge was consumed by the first attempt: a fresh one for the remaining key)
      const fresh = await issueChallenge(DID);
      expect((await verifyRequest(fresh.challenge_id, await signProof(second, fresh))).status).toBe(
        200
      );
    });
  });

  it('refuses a key that the document lists as a verification method but not under authentication', async () => {
    const auth = await createJwkIdentity(DID, 'auth-key', 'ES256');
    const assertionOnly = await createJwkIdentity(DID, 'assert-key', 'ES256');
    publish(didWebDocument(DID, [auth, assertionOnly], [auth.kid]));
    linkFixture(auth);

    const { result } = await login(assertionOnly);

    expectRefused(result, 'invalid');
    expect(world.current.sessions).toHaveLength(0);
  });

  it('refuses a proof signed with the key a document had before it was rotated', async () => {
    const oldKey = await createJwkIdentity(DID, 'key-1', 'ES256');
    const newKey = await createJwkIdentity(DID, 'key-1', 'ES256'); // same kid, new key material
    publish(didWebDocument(DID, [oldKey]));
    linkFixture(oldKey);
    const challenge = await issueChallenge(DID);
    publish(didWebDocument(DID, [newKey])); // rotated between challenge and verify

    const result = await verifyRequest(challenge.challenge_id, await signProof(oldKey, challenge));

    expectRefused(result, 'signature');
    expect(world.current.sessions).toHaveLength(0);
  });

  // The allow-list (ES256/384/512, EdDSA) is the only thing between a did:web document that
  // publishes an RSA key and an RS256 proof: the key itself would verify.
  it('refuses RS256 even though the document publishes a matching RSA key', async () => {
    const rsa = await createJwkIdentity(DID, 'rsa-key', 'RS256');
    publish(didWebDocument(DID, [rsa]));
    linkFixture(rsa);

    const { result } = await login(rsa);

    expectRefused(result, 'any');
    expect(world.current.sessions).toHaveLength(0);
  });

  it('refuses a document whose id is not the DID (no challenge, DID not echoed)', async () => {
    const key = await createJwkIdentity(DID, 'key-1', 'ES256');
    publish(didWebDocument('did:web:evil.example.com', [key]));

    const result = await challengeRequest(DID);

    expect(result.status).toBe(400);
    expect(result.text).not.toContain('evil.example.com');
    expect(world.current.challenges.storeCalls).toHaveLength(0);
  });

  it('answers a missing document (404) generically without echoing the DID', async () => {
    const result = await challengeRequest(DID);
    expect(result.status).toBe(400);
    expect(result.text).not.toContain('did.example.com');
  });

  it('a document without authentication methods yields no challenge', async () => {
    const key = await createJwkIdentity(DID, 'key-1', 'ES256');
    publish(didWebDocument(DID, [key], []));
    expect((await challengeRequest(DID)).status).toBe(400);
  });

  it('SSRF: a did:web that names a private or loopback host is never fetched', async () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254']) {
      const result = await challengeRequest(`did:web:${host}`);
      expect(result.status).toBe(400);
    }
    expect(fetched).toEqual([]);
  });
});

describe('DID linking round trip with real cryptography', () => {
  let identity: DidKeyIdentity;

  beforeEach(async () => {
    world.current = new World();
    world.current.browserSessions.set(BROWSER_SESSION_COOKIE, 'user-1');
    identity = await createDidKeyIdentity('EdDSA');
  });

  const registerChallenge = async (did: string, cookie: string | null = BROWSER_SESSION_COOKIE) =>
    read(
      await didRegisterChallengeHandler(
        createContext({ body: { did }, cookie: cookie ?? undefined })
      )
    );
  const registerVerify = async (
    challengeId: string,
    proof: string,
    cookie = BROWSER_SESSION_COOKIE
  ) =>
    read(
      await didRegisterVerifyHandler(
        createContext({ body: { challenge_id: challengeId, proof }, cookie })
      )
    );

  it('register challenge -> sign -> register verify creates the link and publishes the route; login then works', async () => {
    const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;
    const jws = await signProof(identity, challenge);

    const linked = await registerVerify(challenge.challenge_id, jws);

    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ success: true, did: identity.did });

    expect(world.current.links.rows).toHaveLength(1);
    expect(world.current.links.rows[0]).toMatchObject({
      tenant_id: 'default',
      user_id: 'user-1',
      provider_id: 'did',
      provider_user_id: identity.did,
    });

    expect(world.current.directory.published).toHaveLength(1);
    const [publication] = world.current.directory.published;
    expect(publication).toMatchObject({
      schemaVersion: 1,
      tenantId: 'default',
      accountId: 'account:user-1',
      userId: 'user-1',
      linkedIdentityId: world.current.links.rows[0].id,
      did: identity.did,
    });
    expect(publication.operationId).toMatch(/^did-route-[0-9a-f]{32}$/);
    expect(publication.idempotencyKey).toMatch(/^auth-did-route:[0-9a-f]{64}$/);

    const session = await login(identity);
    expect(session.result.status).toBe(200);
    expect(session.result.body.user_id).toBe('user-1');
    expect(world.current.sessions[0].data).toMatchObject({ amr: ['did'], did: identity.did });
  });

  it('repeating the link of the same user republishes the same operation and creates no second row', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;
      const jws = await signProof(identity, challenge);
      const result = await registerVerify(challenge.challenge_id, jws);
      expect(result.status).toBe(200);
    }

    expect(world.current.links.rows).toHaveLength(1);
    const [first, second] = world.current.directory.published;
    expect(second.operationId).toBe(first.operationId);
  });

  it('a link attempt without the DID private key (other key, same kid) links nothing', async () => {
    const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;
    const attacker = await generateKeyPair('EdDSA', { extractable: true });
    const jws = await signProof(identity, challenge, { key: attacker.privateKey });

    const result = await registerVerify(challenge.challenge_id, jws);

    expect(result.status).toBe(400);
    expect(world.current.links.rows).toHaveLength(0);
    expect(world.current.directory.published).toHaveLength(0);
  });

  it.each([
    ['wrong nonce', { nonce: 'nope' }],
    ['wrong audience', { aud: 'https://other.example.com' }],
    ['wrong issuer', { iss: 'did:key:zSomeoneElse' }],
  ] as Array<[string, ProofOptions]>)(
    'a link proof with %s links nothing',
    async (_name, options) => {
      const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;
      const jws = await signProof(identity, challenge, options);

      const result = await registerVerify(challenge.challenge_id, jws);

      expect(result.status).toBe(400);
      expect(world.current.links.rows).toHaveLength(0);
    }
  );

  describe('a DID linked to another user', () => {
    const linkElsewhere = () =>
      world.current.links.rows.push({
        id: 'other-link',
        tenant_id: 'default',
        user_id: 'user-2',
        provider_id: 'did',
        provider_user_id: identity.did,
        raw_attributes: null,
        linked_at: Date.now(),
        last_used_at: null,
      });
    const stripIds = (text: string) => text.replace(/[0-9a-f-]{36}/g, '<id>');

    it('the challenge is identical for a DID linked elsewhere and for an unlinked DID (no probing)', async () => {
      const other = await createDidKeyIdentity('EdDSA');
      linkElsewhere();

      const elsewhere = await registerChallenge(identity.did);
      const unlinked = await registerChallenge(other.did);

      expect(elsewhere.status).toBe(200);
      expect(unlinked.status).toBe(200);
      expect(Object.keys(elsewhere.body).sort()).toEqual(Object.keys(unlinked.body).sort());
      expect(world.current.challenges.storeCalls).toHaveLength(2);
    });

    it('a valid proof for it is refused with the generic answer, after the proof, and nothing is written', async () => {
      linkElsewhere();
      const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;

      const result = await registerVerify(
        challenge.challenge_id,
        await signProof(identity, challenge)
      );

      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
      expect(world.current.links.rows).toHaveLength(1);
      expect(world.current.directory.published).toHaveLength(0);
    });

    it('a bad proof for it is answered exactly like a bad proof for an unlinked DID', async () => {
      const other = await createDidKeyIdentity('EdDSA');
      linkElsewhere();
      const attacker = await generateKeyPair('EdDSA', { extractable: true });

      const answers: Result[] = [];
      for (const target of [identity, other]) {
        const challenge = (await registerChallenge(target.did)).body as unknown as IssuedChallenge;
        const proof = await signProof(target, challenge, { key: attacker.privateKey });
        answers.push(await registerVerify(challenge.challenge_id, proof));
      }

      expect(answers[0].status).toBe(400);
      expect(answers[0].body.error_code).toBe('AR000006');
      expect(errorShape(answers[0])).toEqual(errorShape(answers[1]));
      expect(stripIds(answers[0].text).split(identity.did).join('<did>')).toBe(
        stripIds(answers[1].text).split(other.did).join('<did>')
      );
    });
  });

  it('linking needs a signed-in browser session', async () => {
    const result = await registerChallenge(identity.did, null);
    expect(result.status).toBe(401);
    const unknownSession = await registerChallenge(identity.did, 'not-a-session');
    expect(unknownSession.status).toBe(401);
    expect(world.current.challenges.storeCalls).toHaveLength(0);
  });

  it('login_enabled=false refuses linking too, without consuming anything', async () => {
    world.current.settings = 'off';
    expect((await registerChallenge(identity.did)).status).toBe(403);
    expect((await registerVerify('id', 'a.b.c')).status).toBe(403);
    expect(world.current.challenges.consumeCalls).toHaveLength(0);
  });

  it.each([
    ['a path', (did: string) => `${did}/alias`],
    ['a query', (did: string) => `${did}?x=1`],
    ['trailing whitespace', (did: string) => `${did} `],
    ['over 1024 bytes', (did: string) => `${did}${'a'.repeat(1100)}`],
    ['a control character', (did: string) => `${did}\u0007`],
  ])(
    'register challenge: a DID with %s is refused and nothing is stored',
    async (_name, mutate) => {
      const result = await registerChallenge(mutate(identity.did));
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
      expect(world.current.challenges.storeCalls).toHaveLength(0);
    }
  );

  it('register verify: an alias kid links nothing and does not consume the challenge', async () => {
    const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;
    const alias = `${identity.did}/alias`;
    const jws = await signProof(identity, challenge, {
      kid: `${alias}#${identity.multibaseKey}`,
      iss: alias,
    });

    const result = await registerVerify(challenge.challenge_id, jws);

    expect(result.status).toBe(400);
    expect(world.current.links.rows).toHaveLength(0);
    expect(world.current.directory.published).toHaveLength(0);
    expect(world.current.challenges.consumeCalls).toHaveLength(0);
  });

  it('one key cannot be linked twice through aliases: the alias of a linked DID is refused', async () => {
    const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;
    expect(
      (await registerVerify(challenge.challenge_id, await signProof(identity, challenge))).status
    ).toBe(200);

    expect((await registerChallenge(`${identity.did}?x=1`)).status).toBe(400);
    expect(world.current.links.rows).toHaveLength(1);
  });

  it('a publication that fails transiently leaves the row, answers 503, and the repeat succeeds', async () => {
    let failures = 1;
    const provisioner = world.current.directory.provisioner;
    const flaky = {
      publishAuthDidRoute: async (input: Parameters<typeof provisioner.publishAuthDidRoute>[0]) => {
        if (failures-- > 0) throw new Error('outbox_unavailable');
        return provisioner.publishAuthDidRoute(input);
      },
    };
    const env = { ACCOUNT_PROVISIONER: flaky } as unknown as Partial<Env>;
    const attempt = async () => {
      const challenge = (await registerChallenge(identity.did)).body as unknown as IssuedChallenge;
      const jws = await signProof(identity, challenge);
      return read(
        await didRegisterVerifyHandler(
          createContext({
            body: { challenge_id: challenge.challenge_id, proof: jws },
            cookie: BROWSER_SESSION_COOKIE,
            env,
          })
        )
      );
    };

    const first = await attempt();
    expect(first.status).toBe(503);
    expect(world.current.links.rows).toHaveLength(1);
    // The route does not exist yet: login says "not linked".
    expect((await login(identity)).result.body.error_code).toBe('AR090001');

    const second = await attempt();
    expect(second.status).toBe(200);
    expect((await login(identity)).result.status).toBe(200);
  });

  it('base58btc leading zero bytes survive the encoder (guards the fixture itself)', () => {
    expect(base58btcEncode(new Uint8Array([0, 0, 1]))).toBe('112');
  });
});
