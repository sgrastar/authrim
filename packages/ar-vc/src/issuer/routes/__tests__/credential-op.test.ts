/**
 * Credential Endpoint, HAIP path: an access token of the Authrim OP, bound to the wallet's DPoP
 * key, a proof whose holder key is attested by a provider the wallet type's allowlist entry
 * trusts, issuance only with an `x5c` chain. Real crypto throughout (OP token, DPoP proof, proof
 * JWT, key attestation chain); the Durable Objects and the database are fakes.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { Context } from 'hono';
import {
  buildCertificate,
  buildPolicyConstrainedRegionShardConfig,
  bytesToBase64,
} from '@authrim/ar-lib-core';
import type { Env } from '../../../types';

vi.mock('../../../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/configured-shard')>()),
  isConfiguredShard: vi.fn(async () => true),
}));
vi.mock('../../../utils/crypto', () => ({
  generateSecureNonce: vi.fn().mockResolvedValue('mock-c-nonce'),
  sha256Base64url: vi.fn(async (value: string) => `digest-${value.length}`),
}));

const core = vi.hoisted(() => ({
  reserveCredentialStatusSlot: vi.fn(),
  transitionCredentialStatus: vi.fn(),
  updateStatusIfCurrent: vi.fn(),
  resolveTenantMetadataContext: vi.fn(),
  getRevocationStoreByJti: vi.fn(),
  findOAuthClientConsentRevocation: vi.fn(),
  recordReplayJti: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  // The issuance claim of the route goes through the real function, observed by a spy.
  core.recordReplayJti.mockImplementation(actual.recordReplayJti);
  return {
    ...actual,
    recordReplayJti: core.recordReplayJti,
    createSDJWTVCWithSigner: vi.fn(
      async (
        _claims: Record<string, unknown>,
        issuer: string,
        signer: (payload: Record<string, unknown>) => Promise<string>,
        options: { vct: string }
      ) => {
        const jwt = await signer({ iss: issuer, vct: options.vct, iat: 1, _sd_alg: 'sha-256' });
        return { combined: `${jwt}~d1~`, issuerSignedJwt: jwt, disclosures: ['d1'] };
      }
    ),
    loadFeatureConfig: vi.fn().mockResolvedValue({ enabled: false }),
    resolveTenantMetadataContext: core.resolveTenantMetadataContext,
    reserveCredentialStatusSlot: core.reserveCredentialStatusSlot,
    transitionCredentialStatus: core.transitionCredentialStatus,
    getRevocationStoreByJti: core.getRevocationStoreByJti,
    findOAuthClientConsentRevocation: core.findOAuthClientConsentRevocation,
    IssuedCredentialRepository: class {
      updateStatusIfCurrent = core.updateStatusIfCurrent;
    },
  };
});

import { credentialRoute } from '../credential';
import { issueCredentialDpopNonce } from '../../services/dpop-nonce';
import { issuerMetadataRoute } from '../metadata';

const ISSUER = 'https://authrim.com';
const CREDENTIAL_ENDPOINT = `${ISSUER}/vci/credential`;
const PROOF_NONCE =
  'g1:apac:3:cn_550e8400-e29b-41d4-a716-446655440000.abcdefghijklmnopqrstuvwxyzABCDEF';
const WALLET = 'keyring-wallet';
const SERVER_SECRET = 'test-server-secret';
const CONFIGURATION = 'AuthrimAdminCredential';
const SCOPE = 'authrim_admin_credential';

const REGION_CONFIG = buildPolicyConstrainedRegionShardConfig({
  residency: {
    version: 1,
    residencyPolicyId: 'test-residency',
    residencyPartition: 'default',
    policyGeneration: 1,
    allowedRegions: ['apac'],
    jurisdiction: null,
  },
  totalShards: 1,
  now: 1,
  updatedBy: 'test',
});

interface Pair {
  privateKey: CryptoKey;
  publicJwk: JWK;
}
async function ecPair(): Promise<Pair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}
const signer = (key: CryptoKey) => async (tbs: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, tbs));

async function sha256Hex(der: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', der))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function sha256Base64url(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  );
  return bytesToBase64(digest).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

interface Fixture {
  op: { privateKey: CryptoKey; publicJwk: JWK };
  dpop: Pair;
  holder: Pair;
  attestationLeaf: Pair;
  chain: string[];
  keyRoot: { certificate: string; sha256: string };
}
let fx: Fixture;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const opJwk = { ...(await exportJWK(publicKey)), kid: 'op-key-1', alg: 'RS256', use: 'sig' };
  const root = await ecPair();
  const ca = await ecPair();
  const leaf = await ecPair();
  const rootName = { commonName: 'Key Attestation Root', organization: 'Wallet Co' };
  const now = Date.now();
  const rootDer = await buildCertificate(
    {
      subject: rootName,
      issuer: rootName,
      subjectPublicKey: root.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(now - 3600_000),
      notAfter: new Date(now + 365 * 24 * 3600_000),
      isCA: true,
      pathLength: 1,
    },
    signer(root.privateKey)
  );
  const caDer = await buildCertificate(
    {
      subject: { commonName: 'Key Attestation CA', organization: 'Wallet Co' },
      issuer: rootName,
      subjectPublicKey: ca.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(now - 3600_000),
      notAfter: new Date(now + 300 * 24 * 3600_000),
      isCA: true,
      pathLength: 0,
    },
    signer(root.privateKey)
  );
  const leafDer = await buildCertificate(
    {
      subject: { commonName: 'attester.example.com' },
      issuer: { commonName: 'Key Attestation CA', organization: 'Wallet Co' },
      subjectPublicKey: leaf.publicJwk,
      issuerPublicKey: ca.publicJwk,
      notBefore: new Date(now - 3600_000),
      notAfter: new Date(now + 30 * 24 * 3600_000),
      dnsNames: ['attester.example.com'],
      isCA: false,
    },
    signer(ca.privateKey)
  );
  fx = {
    op: { privateKey, publicJwk: opJwk },
    dpop: await ecPair(),
    holder: await ecPair(),
    attestationLeaf: leaf,
    chain: [bytesToBase64(leafDer), bytesToBase64(caDer)],
    keyRoot: { certificate: bytesToBase64(rootDer), sha256: await sha256Hex(rootDer) },
  };
});

const lastHeaders: Record<string, string> = {};
const revocation = {
  revoked: false,
  status: 200,
  shardBody: { revoked: false } as unknown,
  legacy: { status: 200, body: { revoked: false } as unknown },
};
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function opToken(
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {}
) {
  const jkt = await calculateJwkThumbprint(fx.dpop.publicJwk);
  return new SignJWT({
    sub: 'admin-1',
    scope: SCOPE,
    client_id: WALLET,
    token_use: 'access',
    attestation_authenticated: true,
    cnf: { jkt },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'op-key-1', ...header })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(crypto.randomUUID())
    .sign(fx.op.privateKey);
}

async function dpopProof(
  token: string,
  overrides: { key?: Pair; htu?: string; ath?: string; nonce?: string | null } = {}
): Promise<string> {
  const key = overrides.key ?? fx.dpop;
  const nonce =
    overrides.nonce === undefined
      ? await issueCredentialDpopNonce(
          { VC_TRANSACTION_CODE_HMAC_SECRET: SERVER_SECRET } as Env,
          'default'
        )
      : overrides.nonce;
  return new SignJWT({
    ...(nonce ? { nonce } : {}),
    htm: 'POST',
    htu: overrides.htu ?? CREDENTIAL_ENDPOINT,
    iat: nowSeconds(),
    jti: crypto.randomUUID(),
    ath: overrides.ath ?? (await sha256Base64url(token)),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: key.publicJwk })
    .sign(key.privateKey);
}

async function keyAttestation(
  overrides: { claims?: Record<string, unknown>; keys?: JWK[] } = {}
): Promise<string> {
  return new SignJWT({
    iat: nowSeconds(),
    exp: nowSeconds() + 600,
    nonce: PROOF_NONCE,
    attested_keys: overrides.keys ?? [fx.holder.publicJwk],
    key_storage: ['iso_18045_high'],
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'key-attestation+jwt', x5c: fx.chain })
    .sign(fx.attestationLeaf.privateKey);
}

async function proofJwt(attestation: string | null): Promise<string> {
  return new SignJWT({ aud: ISSUER, iat: nowSeconds(), nonce: PROOF_NONCE })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'openid4vci-proof+jwt',
      jwk: fx.holder.publicJwk,
      ...(attestation ? { key_attestation: attestation } : {}),
    })
    .sign(fx.holder.privateKey);
}

function allowlist(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    updatedAt: 1,
    revision: 1,
    entries: [
      {
        clientId: WALLET,
        label: 'Keyring',
        enabled: true,
        attestationRoots: [fx.keyRoot],
        keyAttestationRoots: [fx.keyRoot],
        redirectUris: ['https://wallet.example.com/cb'],
        ...overrides,
      },
    ],
  });
}

interface Harness {
  signSDJWTIssuerRpc: ReturnType<typeof vi.fn>;
  eligibility: ReturnType<typeof vi.fn>;
  offerCalls: string[];
  nonceReserve: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;
}

function setup(options: { allowlist?: string | null } = {}) {
  const replayed = new Set<string>();
  const offerCalls: string[] = [];
  const nonceStub = {
    fetch: vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      offerCalls.push(path);
      if (path === '/nonce/reserve') {
        return Response.json({ reserved: true, reservationId: 'reservation-1' });
      }
      if (path === '/nonce/complete') return Response.json({ completed: true });
      return Response.json({ released: true });
    }),
  };
  const signSDJWTIssuerRpc = vi.fn().mockResolvedValue({ token: 'issuer.jwt.signature' });
  const eligibility = vi.fn().mockResolvedValue({
    eligible: true,
    email: 'admin@example.com',
    name: 'Admin',
  });
  const env = {
    DB: {} as D1Database,
    AUTHRIM_CONFIG: {
      get: vi.fn(async (key: string) =>
        key.startsWith('region_shard_config:') ? REGION_CONFIG : null
      ),
    } as unknown as KVNamespace,
    SETTINGS: {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:default:wallet-attestation-allowlist'
          ? options.allowlist === undefined
            ? allowlist()
            : options.allowlist
          : null
      ),
    } as unknown as KVNamespace,
    AUTH_RUNTIME_PORTS: {
      replayGuard: {
        record: vi.fn(async ({ key }: { key: string }) => {
          if (replayed.has(key)) return 'replayed';
          replayed.add(key);
          return 'recorded';
        }),
        isRecorded: vi.fn(async ({ key }: { key: string }) => replayed.has(key)),
      },
    },
    CREDENTIAL_OFFER_STORE: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
      get: vi.fn().mockReturnValue(nonceStub),
    },
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'km-id' }),
      get: vi.fn().mockReturnValue({
        getAllOIDCPublicKeysRpc: vi.fn(async () => [fx.op.publicJwk]),
        signSDJWTIssuerRpc,
      }),
    },
    TOKEN_REVOCATION_STORE: {
      idFromName: vi.fn().mockReturnValue({}),
      // The tenant-wide instance of the older layout: nothing is revoked there.
      get: vi.fn().mockReturnValue({
        fetch: vi.fn(async () =>
          revocation.legacy.status === 200
            ? Response.json(revocation.legacy.body)
            : new Response('x', { status: revocation.legacy.status })
        ),
      }),
    },
    ADMIN_CREDENTIAL_ELIGIBILITY: { checkAdminCredentialEligibility: eligibility },
    ISSUER_URL: ISSUER,
    VC_TRANSACTION_CODE_HMAC_SECRET: SERVER_SECRET,
    C_NONCE_EXPIRY_SECONDS: '300',
  } as unknown as Env;
  const harness: Harness = {
    signSDJWTIssuerRpc,
    eligibility,
    offerCalls,
    nonceReserve: nonceStub.fetch,
  };
  return { env, harness };
}

async function call(
  env: Env,
  input: {
    scheme?: string;
    token?: string;
    dpop?: string | null;
    body?: Record<string, unknown>;
    proof?: string | null;
    configuration?: string;
  } = {}
): Promise<Response> {
  const token = input.token ?? (await opToken());
  const dpop = input.dpop === undefined ? await dpopProof(token) : input.dpop;
  const proof = input.proof === undefined ? await proofJwt(await keyAttestation()) : input.proof;
  const headers: Record<string, string | undefined> = {
    Authorization: `${input.scheme ?? 'DPoP'} ${token}`,
    ...(dpop ? { DPoP: dpop } : {}),
  };
  const body = input.body ?? {
    credential_configuration_id: input.configuration ?? CONFIGURATION,
    proofs: { jwt: [proof] },
  };
  const url = CREDENTIAL_ENDPOINT;
  const rawRequest = new Request(url, { method: 'POST', headers: { Host: 'authrim.com' } });
  const c = {
    env,
    req: {
      raw: rawRequest,
      url,
      method: 'POST',
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? undefined,
      json: async () => body,
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    header: vi.fn((name: string, value: string) => {
      lastHeaders[name] = value;
    }),
    get: vi.fn().mockReturnValue(undefined),
  } as unknown as Context<{ Bindings: Env }>;
  for (const key of Object.keys(lastHeaders)) delete lastHeaders[key];
  return credentialRoute(c);
}

beforeEach(() => {
  vi.clearAllMocks();
  core.resolveTenantMetadataContext.mockImplementation(async (env: Env, tenantId: string) => ({
    tenantId,
    coreDb: env.DB,
  }));
  core.reserveCredentialStatusSlot.mockResolvedValue({
    credentialId: 'credential-1',
    credentialInternalId: 'credential-internal-1',
    listId: 'status-list-1',
    listInternalId: 'status-list-internal-1',
    index: 7,
  });
  core.updateStatusIfCurrent.mockResolvedValue(true);
  core.findOAuthClientConsentRevocation.mockResolvedValue({ generation: 0, revokedAt: null });
  core.transitionCredentialStatus.mockResolvedValue({ outcome: 'changed', previous: 'pending' });
  revocation.revoked = false;
  revocation.legacy = { status: 200, body: { revoked: false } };
  revocation.shardBody = { revoked: false };
  revocation.status = 200;
  core.getRevocationStoreByJti.mockResolvedValue({
    instanceName: 'token-revocation:default:0',
    stub: {
      fetch: vi.fn(async () =>
        revocation.status === 200
          ? Response.json(revocation.revoked ? { revoked: true } : revocation.shardBody)
          : new Response('x', { status: revocation.status })
      ),
    },
  });
});

describe('HAIP credential issuance', () => {
  it('issues the admin credential to a wallet with an attested key, with an x5c required', async () => {
    const { env, harness } = setup();
    const response = await call(env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      credentials: [{ credential: 'issuer.jwt.signature~d1~' }],
    });
    // Signed with a certificate chain required, and for the administrator the token names.
    expect(harness.signSDJWTIssuerRpc).toHaveBeenCalledWith(
      expect.objectContaining({ iss: ISSUER }),
      { requireX5c: true }
    );
    expect(harness.eligibility).toHaveBeenCalledWith({
      tenantId: 'default',
      adminUserId: 'admin-1',
    });
    // No offer is involved: only the proof nonce is reserved and completed.
    expect(harness.offerCalls).toEqual(['/nonce/reserve', '/nonce/complete']);
  });

  it('issues one credential per token: the same token cannot be used twice', async () => {
    const { env } = setup();
    const token = await opToken();
    expect((await call(env, { token })).status).toBe(200);
    const again = await call(env, { token });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_credential_request' });
  });

  it('refuses a key that is not attested well enough, not attested at all, or for another nonce', async () => {
    const cases: Record<string, string | null> = {
      software: await keyAttestation({ claims: { key_storage: ['software'] } }),
      moderate: await keyAttestation({ claims: { key_storage: ['iso_18045_moderate'] } }),
      otherNonce: await keyAttestation({ claims: { nonce: 'another' } }),
      otherKey: await keyAttestation({ keys: [(await ecPair()).publicJwk] }),
      none: null,
    };
    for (const [name, attestation] of Object.entries(cases)) {
      const { env, harness } = setup();
      const response = await call(env, { proof: await proofJwt(attestation) });
      expect(response.status, name).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_proof' });
      expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
    }
  });

  it("trusts only the wallet type's own key attestation roots, read now", async () => {
    const other = await ecPair();
    void other;
    for (const list of [
      allowlist({ keyAttestationRoots: [] }),
      allowlist({ enabled: false }),
      JSON.stringify({ version: 1, updatedAt: 1, revision: 1, entries: [] }),
      null,
    ]) {
      const { env, harness } = setup({ allowlist: list });
      const response = await call(env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_proof' });
      expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
    }
    // An allowlist that cannot be read is a temporary failure, not a refusal of the wallet.
    const { env } = setup({ allowlist: '{"version":9}' });
    expect((await call(env)).status).toBe(424);
  });

  it('refuses a request without a DPoP proof, or one made with another key, endpoint or token', async () => {
    const { env } = setup();
    const token = await opToken();
    const cases = [
      null,
      await dpopProof(token, { key: await ecPair() }),
      await dpopProof(token, { htu: 'https://authrim.com/vci/other' }),
      await dpopProof(token, { ath: await sha256Base64url('another token') }),
    ];
    for (const dpop of cases) {
      const response = await call(env, { token, dpop });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
    }
  });

  it('keeps the two token kinds apart', async () => {
    const { env } = setup();
    // An OP token presented as a Bearer token (the pre-authorized path) is not accepted.
    const asBearer = await call(env, { scheme: 'Bearer' });
    expect(asBearer.status).toBe(401);
    // Tokens the OP did not issue for this credential issuer, or that are not DPoP-bound.
    const cases = [
      await opToken({}, { kid: 'unknown-key' }),
      await opToken({ cnf: undefined }),
      await opToken({ token_use: 'refresh' }),
      await opToken({ client_id: undefined }),
      'not.a.jwt',
    ];
    for (const token of cases) {
      const response = await call(env, { token });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_token' });
    }
  });

  it("issues only what the token's scope and the configuration allow", async () => {
    const { env } = setup();
    // The token was not granted the credential scope.
    const noScope = await call(env, { token: await opToken({ scope: 'other_scope' }) });
    expect(noScope.status).toBe(400);
    // The OP flow is for configurations that declare a HAIP key attestation: not the end-user ones.
    const endUser = await call(env, {
      token: await opToken({ scope: 'authrim_identity_credential' }),
      configuration: 'AuthrimIdentityCredential',
    });
    expect(endUser.status).toBe(400);
    expect(await endUser.json()).toMatchObject({ error: 'invalid_credential_request' });
  });

  it('refuses a subject that is not an eligible administrator', async () => {
    const { env, harness } = setup();
    harness.eligibility.mockResolvedValue({ eligible: false });
    const response = await call(env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_credential_request' });
    expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
  });

  it('never falls back to a certificate-less credential', async () => {
    const { env, harness } = setup();
    harness.signSDJWTIssuerRpc.mockRejectedValue(new Error('x5c_required'));
    const response = await call(env);
    // Below 500: every compensation completed, so the replication writer settles its permit.
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(core.transitionCredentialStatus).toHaveBeenCalled();
  });
});

describe('issuer metadata for the HAIP path', () => {
  const metadata = async (list: string | null) => {
    const { env } = setup({ allowlist: list });
    const c = {
      env,
      req: { raw: new Request(`${ISSUER}/.well-known/openid-credential-issuer`), url: ISSUER },
      json: (data: unknown) => Response.json(data),
      header: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Context<{ Bindings: Env }>;
    return (await (await issuerMetadataRoute(c)).json()) as {
      authorization_servers: string[];
      credential_configurations_supported: Record<string, { proof_types_supported: unknown }>;
    };
  };

  it('advertises the key attestation requirement of the admin credential only with a HAIP wallet', async () => {
    const on = await metadata(allowlist());
    expect(on.credential_configurations_supported[CONFIGURATION].proof_types_supported).toEqual({
      jwt: {
        proof_signing_alg_values_supported: ['ES256'],
        key_attestations_required: { key_storage: ['iso_18045_high'] },
      },
    });
    // The end-user configurations are never HAIP configurations.
    expect(
      on.credential_configurations_supported['AuthrimIdentityCredential'].proof_types_supported
    ).toEqual({ jwt: { proof_signing_alg_values_supported: ['ES256'] } });
    const off = await metadata(null);
    expect(off.credential_configurations_supported[CONFIGURATION].proof_types_supported).toEqual({
      jwt: { proof_signing_alg_values_supported: ['ES256'] },
    });
  });

  it('lists the OP after the pre-authorized server once a wallet is enabled, and only then', async () => {
    expect((await metadata(allowlist())).authorization_servers).toEqual([`${ISSUER}/vci`, ISSUER]);
    for (const list of [null, allowlist({ enabled: false }), '{"version":9}']) {
      expect((await metadata(list)).authorization_servers).toEqual([`${ISSUER}/vci`]);
    }
  });
});

describe('HAIP credential issuance: what the token must be', () => {
  it('refuses a token the OP revoked, and answers below 500 when revocation cannot be told', async () => {
    const { env, harness } = setup();
    revocation.revoked = true;
    const revoked = await call(env);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: 'invalid_token' });
    revocation.revoked = false;
    revocation.status = 500;
    const unknown = await call(env);
    expect(unknown.status).toBe(424);
    expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
  });

  it('accepts only a grant of a wallet that authenticated with its attestation, typ JWT, RS256 sig keys', async () => {
    const { env } = setup();
    for (const token of [
      await opToken({ attestation_authenticated: undefined }),
      await opToken({ attestation_authenticated: false }),
      await opToken({}, { typ: 'at+jwt' }),
    ]) {
      const response = await call(env, { token });
      expect(response.status).toBe(401);
    }
  });

  it('does not take a signing key that is an encryption or PS256 key of the same set', async () => {
    for (const patch of [{ use: 'enc' }, { alg: 'PS256' }]) {
      const { env } = setup();
      const keyManager = (
        env.KEY_MANAGER as unknown as {
          get: () => { getAllOIDCPublicKeysRpc: ReturnType<typeof vi.fn> };
        }
      ).get();
      keyManager.getAllOIDCPublicKeysRpc.mockResolvedValue([{ ...fx.op.publicJwk, ...patch }]);
      expect((await call(env)).status).toBe(401);
    }
  });

  it('refuses a proof that names another client than the wallet of the token', async () => {
    const { env } = setup();
    const attestation = await keyAttestation();
    const proofFor = async (iss?: string) =>
      new SignJWT({ aud: ISSUER, iat: nowSeconds(), nonce: PROOF_NONCE, ...(iss ? { iss } : {}) })
        .setProtectedHeader({
          alg: 'ES256',
          typ: 'openid4vci-proof+jwt',
          jwk: fx.holder.publicJwk,
          key_attestation: attestation,
        })
        .sign(fx.holder.privateKey);
    expect((await call(env, { proof: await proofFor('another-wallet') })).status).toBe(400);
    expect((await call(env, { proof: await proofFor(WALLET) })).status).toBe(200);
  });

  it('spends no status list slot on a subject that is not an eligible administrator', async () => {
    const { env, harness } = setup();
    harness.eligibility.mockResolvedValue({ eligible: false });
    expect((await call(env)).status).toBe(400);
    expect(core.reserveCredentialStatusSlot).not.toHaveBeenCalled();
  });
});

describe('HAIP credential issuance: failures and what they tell the replication writer', () => {
  it('answers a refusal below 500 only when every compensation completed', async () => {
    // Eligible at the first check, not at the second (after the slot was reserved).
    const first = setup();
    first.harness.eligibility
      .mockResolvedValueOnce({ eligible: true, email: 'a@example.com', name: 'A' })
      .mockResolvedValue({ eligible: false });
    const compensated = await call(first.env);
    expect(compensated.status).toBe(400);
    expect(core.transitionCredentialStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'revoked', credentialId: 'credential-1' })
    );
    // The row could not be revoked (a concurrent writer won): the outcome is unknown.
    core.transitionCredentialStatus.mockResolvedValue({ outcome: 'conflict' });
    const second = setup();
    second.harness.eligibility
      .mockResolvedValueOnce({ eligible: true, email: 'a@example.com', name: 'A' })
      .mockResolvedValue({ eligible: false });
    expect((await call(second.env)).status).toBe(503);
  });

  it('answers 503 when the proof nonce cannot be reserved or released', async () => {
    const reserve = setup();
    (
      reserve.env.CREDENTIAL_OFFER_STORE as unknown as { get: ReturnType<typeof vi.fn> }
    ).get.mockReturnValue({ fetch: vi.fn(async () => new Response('x', { status: 500 })) });
    expect((await call(reserve.env)).status).toBe(503);
    // Release fails after a refusal that needed it.
    const release = setup();
    release.harness.signSDJWTIssuerRpc.mockRejectedValue(new Error('x5c_required'));
    release.harness.nonceReserve.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/nonce/reserve') {
        return Response.json({ reserved: true, reservationId: 'reservation-1' });
      }
      return new Response('x', { status: 500 });
    });
    expect((await call(release.env)).status).toBe(503);
  });

  it('answers 503 when the DPoP replay store fails', async () => {
    const { env } = setup();
    const ports = (
      env as unknown as {
        AUTH_RUNTIME_PORTS: { replayGuard: { record: ReturnType<typeof vi.fn> } };
      }
    ).AUTH_RUNTIME_PORTS;
    ports.replayGuard.record.mockRejectedValue(new Error('store down'));
    expect((await call(env)).status).toBe(503);
  });

  it('treats the key retention cap like the missing chain: a known refusal below 500', async () => {
    const { env, harness } = setup();
    harness.signSDJWTIssuerRpc.mockRejectedValue(new Error('vc_issuer_key_retention_cap_reached'));
    expect((await call(env)).status).toBe(424);
  });

  it('refuses a token whose revocation status is not an explicit answer', async () => {
    const { env } = setup();
    for (const patch of [
      () => {
        revocation.shardBody = {};
      },
      () => {
        revocation.shardBody = { revoked: 'false' };
      },
      () => {
        revocation.legacy = { status: 500, body: {} };
      },
      () => {
        revocation.legacy = { status: 200, body: { revoked: 'true' } };
      },
    ]) {
      revocation.shardBody = { revoked: false };
      revocation.legacy = { status: 200, body: { revoked: false } };
      patch();
      expect((await call(env, { token: await opToken() })).status).toBe(424);
    }
    revocation.shardBody = { revoked: false };
    revocation.legacy = { status: 200, body: { revoked: true } };
    expect((await call(env, { token: await opToken() })).status).toBe(401);
  });

  it('ends a token when the person withdrew the consent it was issued under', async () => {
    const { env, harness } = setup();
    // The token carries the consent generation it was granted under; the OP has since moved on.
    core.findOAuthClientConsentRevocation.mockResolvedValue({
      generation: 2,
      revokedAt: Date.now(),
    });
    const response = await call(env, { token: await opToken({ authrim_consent_generation: 1 }) });
    expect(response.status).toBe(401);
    expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
    // The same generation is current: fine.
    core.findOAuthClientConsentRevocation.mockResolvedValue({
      generation: 1,
      revokedAt: Date.now(),
    });
    expect(
      (await call(env, { token: await opToken({ authrim_consent_generation: 1 }) })).status
    ).toBe(200);
    // The lookup is made for the account of the token and its wallet.
    expect(core.findOAuthClientConsentRevocation).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      userId: 'admin-1',
      clientId: WALLET,
    });
  });

  it('resolves the subject of the token to its account', async () => {
    const { env } = setup();
    // A sealed reference that is not one cannot be opened: the token has no usable subject.
    const response = await call(env, { token: await opToken({ authrim_subject_ref: 5 }) });
    expect(response.status).toBe(401);
  });

  it('advertises the HAIP path only when a wallet can pass the key attestation', async () => {
    const { env } = setup({ allowlist: allowlist({ keyAttestationRoots: [] }) });
    const c = {
      env,
      req: { raw: new Request(`${ISSUER}/.well-known/openid-credential-issuer`), url: ISSUER },
      json: (data: unknown) => Response.json(data),
      header: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Context<{ Bindings: Env }>;
    const data = (await (await issuerMetadataRoute(c)).json()) as {
      authorization_servers: string[];
    };
    expect(data.authorization_servers).toEqual([`${ISSUER}/vci`]);
  });
});

describe('HAIP credential issuance: the server DPoP nonce', () => {
  it('sends a proof without the current nonce back for one, and gives a fresh one on success', async () => {
    const { env } = setup();
    const token = await opToken();
    for (const nonce of [null, 'stale.nonce', '0.aaaa', 'x'.repeat(200)]) {
      const response = await call(env, { token, dpop: await dpopProof(token, { nonce }) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'use_dpop_nonce' });
      expect(lastHeaders['DPoP-Nonce']).toMatch(/^\d+\.[A-Za-z0-9_-]+$/u);
      expect(lastHeaders['WWW-Authenticate']).toContain('use_dpop_nonce');
    }
    const ok = await call(env);
    expect(ok.status).toBe(200);
    expect(lastHeaders['DPoP-Nonce']).toMatch(/^\d+\.[A-Za-z0-9_-]+$/u);
  });

  it('accepts a nonce of the previous window only, and refuses one of another tenant or secret', async () => {
    const { env } = setup();
    const previous = await issueCredentialDpopNonce(
      { VC_TRANSACTION_CODE_HMAC_SECRET: SERVER_SECRET } as Env,
      'default',
      Date.now() - 120_000
    );
    const older = await issueCredentialDpopNonce(
      { VC_TRANSACTION_CODE_HMAC_SECRET: SERVER_SECRET } as Env,
      'default',
      Date.now() - 600_000
    );
    const otherTenant = await issueCredentialDpopNonce(
      { VC_TRANSACTION_CODE_HMAC_SECRET: SERVER_SECRET } as Env,
      'tenant-2'
    );
    const otherSecret = await issueCredentialDpopNonce(
      { VC_TRANSACTION_CODE_HMAC_SECRET: 'another-secret' } as Env,
      'default'
    );
    const token = await opToken();
    expect(
      (await call(env, { token, dpop: await dpopProof(token, { nonce: previous }) })).status
    ).toBe(200);
    for (const nonce of [older, otherTenant, otherSecret]) {
      const t = await opToken();
      const response = await call(env, { token: t, dpop: await dpopProof(t, { nonce }) });
      expect(response.status).toBe(401);
    }
  });

  it('is a temporary failure when the issuer has no server secret to derive a nonce from', async () => {
    const { env } = setup();
    (
      env as unknown as { VC_TRANSACTION_CODE_HMAC_SECRET?: string }
    ).VC_TRANSACTION_CODE_HMAC_SECRET = undefined;
    expect((await call(env)).status).toBe(424);
  });
});

describe('HAIP credential issuance: when a token is used up (characterization, AWS portability P1)', () => {
  it('a refusal after the issuance claim leaves the token spent: the wallet needs a new token', async () => {
    const { env, harness } = setup();
    const token = await opToken();
    // The key attestation passes, the claim is recorded, then signing is refused (no chain).
    harness.signSDJWTIssuerRpc.mockRejectedValueOnce(new Error('x5c_required'));
    expect((await call(env, { token })).status).toBe(424);
    expect(harness.signSDJWTIssuerRpc).toHaveBeenCalledTimes(1);

    // The same token, with the signer healthy again, never reaches eligibility or signing. The proof
    // nonce is reserved first and released after the duplicate claim is found.
    harness.signSDJWTIssuerRpc.mockClear();
    harness.eligibility.mockClear();
    harness.offerCalls.length = 0;
    const again = await call(env, { token });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_credential_request' });
    expect(harness.eligibility).not.toHaveBeenCalled();
    expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
    expect(harness.offerCalls).toEqual(['/nonce/reserve', '/nonce/release']);
    // A new token works.
    expect((await call(env, { token: await opToken() })).status).toBe(200);
  });

  it('a revocation status that cannot be told is refused BEFORE the claim: the same token may be tried again', async () => {
    const { env, harness } = setup();
    const token = await opToken();
    const record = (
      env as unknown as {
        AUTH_RUNTIME_PORTS: { replayGuard: { record: ReturnType<typeof vi.fn> } };
      }
    ).AUTH_RUNTIME_PORTS.replayGuard.record;
    // The very same DPoP proof is used for both calls: nothing was recorded by the first one.
    const dpop = await dpopProof(token);
    revocation.legacy = { status: 500, body: {} };
    const unknown = await call(env, { token, dpop });
    expect(unknown.status).toBe(424);
    expect(await unknown.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(record).not.toHaveBeenCalled();
    expect(harness.eligibility).not.toHaveBeenCalled();
    revocation.legacy = { status: 200, body: { revoked: false } };
    expect((await call(env, { token, dpop })).status).toBe(200);
  });

  it('an unknown revocation status answers 424 even to a proof without the server nonce (it is asked first)', async () => {
    const { env } = setup();
    const token = await opToken();
    revocation.legacy = { status: 500, body: {} };
    const response = await call(env, { token, dpop: await dpopProof(token, { nonce: null }) });
    expect(response.status).toBe(424);
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('an explicit refusal of the nonce store is a 400 invalid_nonce (not a 503), also before the claim', async () => {
    const { env, harness } = setup();
    const token = await opToken();
    harness.nonceReserve.mockImplementationOnce(async () => Response.json({ reserved: false }));
    const refused = await call(env, { token });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_nonce' });
    expect((await call(env, { token })).status).toBe(200);
  });

  it('a failing nonce store (unknown outcome) is a 503 before the claim: the same token and a good proof may be tried again', async () => {
    const { env, harness } = setup();
    const token = await opToken();
    harness.nonceReserve.mockImplementationOnce(async () => new Response('x', { status: 500 }));
    expect((await call(env, { token })).status).toBe(503);
    expect((await call(env, { token })).status).toBe(200);
  });

  it('keeps the claim for the token up to its last accepted moment: ttl = max(120, exp - now + 120) seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Frozen at the real now: the certificates of the fixtures are valid around it.
      const start = Date.now();
      vi.setSystemTime(start);
      const cases = [
        { at: 0, ttl: 420 }, // 300 s left + 120
        { at: 240_000, ttl: 180 }, // 60 s left + 120
        { at: 301_000, ttl: 120 }, // 1 s past the expiry (inside the validator's 5 s tolerance): the floor
      ];
      for (const { at, ttl } of cases) {
        vi.setSystemTime(start);
        const { env } = setup();
        const token = await opToken();
        vi.setSystemTime(start + at);
        core.recordReplayJti.mockClear();
        expect((await call(env, { token })).status, `at ${at}`).toBe(200);
        const claims = core.recordReplayJti.mock.calls
          .map(([, input]) => input as { jti: string; ttlSeconds: number })
          .filter((input) => input.jti.startsWith('vci-op-token:'));
        expect(claims, `at ${at}`).toHaveLength(1);
        expect(claims[0].ttlSeconds, `at ${at}`).toBe(ttl);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('a missing eligibility binding counts as ineligible, but only after the claim: the token is spent', async () => {
    const { env, harness } = setup();
    const token = await opToken();
    (env as unknown as { ADMIN_CREDENTIAL_ELIGIBILITY?: unknown }).ADMIN_CREDENTIAL_ELIGIBILITY =
      undefined;
    const refused = await call(env, { token });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_credential_request' });
    expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
    // It is refused at the early check: no status list slot was spent.
    expect(core.reserveCredentialStatusSlot).not.toHaveBeenCalled();

    // The configuration is repaired; the spent token still does not work.
    (env as unknown as { ADMIN_CREDENTIAL_ELIGIBILITY: unknown }).ADMIN_CREDENTIAL_ELIGIBILITY = {
      checkAdminCredentialEligibility: harness.eligibility,
    };
    const again = await call(env, { token });
    expect(again.status).toBe(400);
    expect(harness.eligibility).not.toHaveBeenCalled();
    expect((await call(env, { token: await opToken() })).status).toBe(200);
  });

  it('the second eligibility check (after the slot is reserved) also comes before signing', async () => {
    const { env, harness } = setup();
    harness.eligibility
      .mockResolvedValueOnce({ eligible: true, email: 'a@example.com', name: 'A' })
      .mockResolvedValue({ eligible: false });
    expect((await call(env)).status).toBe(400);
    expect(core.reserveCredentialStatusSlot).toHaveBeenCalledTimes(1);
    expect(harness.eligibility).toHaveBeenCalledTimes(2);
    expect(harness.signSDJWTIssuerRpc).not.toHaveBeenCalled();
    // Early check, then the slot, then the check again.
    const [early, late] = harness.eligibility.mock.invocationCallOrder;
    const [slot] = core.reserveCredentialStatusSlot.mock.invocationCallOrder;
    expect(early).toBeLessThan(slot);
    expect(slot).toBeLessThan(late);
  });
});
