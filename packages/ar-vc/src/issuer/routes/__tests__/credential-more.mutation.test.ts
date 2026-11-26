/**
 * Credential endpoint (pre-authorized Bearer path), part two: request parameters, token scheme,
 * holder binding rules, administrator claims and request headers.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    validateToken: vi.fn(),
    validateProof: vi.fn(),
    decodeNonce: vi.fn(),
    proofStore: vi.fn(),
    offerStore: vi.fn(),
    isConfiguredShard: vi.fn(),
    ensureCertificate: vi.fn(),
    featureConfig: vi.fn(),
    runtimeSources: vi.fn(),
    createResolver: vi.fn(),
    resolveClaims: vi.fn(),
    loadSchemas: vi.fn(),
    schemaLoaderArgs: vi.fn(),
    resolveName: vi.fn(),
    createSdjwt: vi.fn(),
    reserveSlot: vi.fn(),
    transition: vi.fn(),
    updateIfCurrent: vi.fn(),
    holderRequired: vi.fn(),
    adapterArgs: vi.fn(),
  };
});

vi.mock('../../services/token-validation', () => ({
  validateVCIAccessToken: h.validateToken,
  validateProofOfPossession: h.validateProof,
  decodeVCIProofNonce: h.decodeNonce,
}));
vi.mock('../../services/issuer-ca', () => ({ ensureVcSigningCertificate: h.ensureCertificate }));
vi.mock('../../../utils/credential-offer-sharding', () => ({
  getCredentialOfferStoreByProofNonce: h.proofStore,
  getCredentialOfferStoreById: h.offerStore,
}));
vi.mock('../../../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/configured-shard')>()),
  isConfiguredShard: h.isConfiguredShard,
}));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://issuer.example.com',
}));
vi.mock('../../../utils/vc-config', () => ({
  createVCConfigManager: () => ({ isHolderBindingRequired: h.holderRequired }),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => h.logger,
    getTenantIdFromContext: () => 'tenant-1',
    loadFeatureConfig: h.featureConfig,
    resolveCustomClaimRuntimeSourcesFromEnv: h.runtimeSources,
    createCustomClaimSchemaResolver: h.createResolver,
    SchemaLoader: class {
      constructor(...args: unknown[]) {
        h.schemaLoaderArgs(...args);
      }
      loadActiveSchemas = h.loadSchemas;
    },
    ClaimNameResolver: class {
      resolve = h.resolveName;
    },
    ensureDatabaseAdapter: (...args: unknown[]) => {
      h.adapterArgs(...args);
      return { adapter: true };
    },
    resolveTenantMetadataContext: async () => ({ coreDb: {} }),
    createSDJWTVCWithSigner: h.createSdjwt,
    reserveCredentialStatusSlot: h.reserveSlot,
    transitionCredentialStatus: h.transition,
    IssuedCredentialRepository: class {
      updateStatusIfCurrent = h.updateIfCurrent;
    },
  };
});

import { credentialRoute } from '../credential';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const IDENTITY = 'AuthrimIdentityCredential';
const HOLDER = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

interface Stub {
  fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>>;
}
let nonceStub: Stub;
let offerStub: Stub;
let eligibility: ReturnType<typeof vi.fn>;
let sign: ReturnType<typeof vi.fn>;
let keyManagerGet: ReturnType<typeof vi.fn>;
let env: Env;

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
const pathOf = (call: unknown[]) => new URL((call[0] as Request).url);
const callsTo = (stub: Stub, path: string) =>
  stub.fetch.mock.calls.filter((call) => pathOf(call).pathname === path);

const offerBody = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  credentialConfigurationId: IDENTITY,
  claims: { given_name: 'Alice' },
  subjectKind: 'end_user',
  status: 'consumed',
  expiresAt: NOW_MS + 1000,
  ...overrides,
});

function routeFor(stub: Stub, routes: Record<string, () => unknown>) {
  stub.fetch.mockImplementation(async (request: Request) => {
    const handler = routes[new URL(request.url).pathname];
    if (!handler) throw new Error(`unexpected ${request.url}`);
    return handler();
  });
}

function happyRoutes() {
  routeFor(nonceStub, {
    '/nonce/reserve': () => json({ reserved: true, reservationId: 'res-1' }),
    '/nonce/complete': () => json({ completed: true }),
    '/nonce/release': () => json({}),
  });
  routeFor(offerStub, {
    '/get': () => json(offerBody()),
    '/issuance/claim': () => json({ claimed: true }),
    '/issuance/complete': () => json({ completed: true }),
    '/issuance/fail': () => json({}),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  nonceStub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  offerStub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  happyRoutes();
  h.validateToken.mockResolvedValue({
    valid: true,
    userId: 'user-1',
    tenantId: 'tenant-1',
    credentialConfigurationId: IDENTITY,
    jti: 'jti-1',
    offerId: 'offer-1',
  });
  h.validateProof.mockResolvedValue({ valid: true, holderPublicKey: HOLDER });
  h.decodeNonce.mockReturnValue('nonce-1');
  h.proofStore.mockReturnValue({ stub: nonceStub, nonceId: 'nonce-id', resolution: 'r1' });
  h.offerStore.mockReturnValue({ stub: offerStub, resolution: 'r2' });
  h.isConfiguredShard.mockResolvedValue(true);
  h.ensureCertificate.mockResolvedValue('current');
  h.featureConfig.mockResolvedValue({ enabled: false });
  h.holderRequired.mockResolvedValue(true);
  h.reserveSlot.mockResolvedValue({ credentialId: 'cred-1', listId: 'list-1', index: 7 });
  h.transition.mockResolvedValue({ outcome: 'changed', previous: 'pending' });
  h.updateIfCurrent.mockResolvedValue(true);
  h.createSdjwt.mockImplementation(async (_claims, issuer, signer) => {
    const jwt = await signer({ iss: issuer, exp: NOW + 100 });
    return { combined: `${jwt}~d1~`, issuerSignedJwt: jwt, disclosures: [] };
  });
  eligibility = vi.fn().mockResolvedValue({ eligible: true });
  sign = vi.fn(async () => ({ token: 'h.p.s' }));
  keyManagerGet = vi.fn(() => ({ signSDJWTIssuerRpc: sign }));
  env = {
    AUTHRIM_CONFIG: { kv: true },
    KEY_MANAGER: { idFromName: (name: string) => `id:${name}`, get: keyManagerGet },
    ADMIN_CREDENTIAL_ELIGIBILITY: { checkAdminCredentialEligibility: eligibility },
  } as unknown as Env;
});
afterEach(() => {
  vi.useRealTimers();
});

async function post(body: unknown = defaultBody, raw?: string, authorization = 'Bearer token') {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/vci/credential', credentialRoute);
  const response = await app.request(
    'https://issuer.example.com/vci/credential',
    {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    },
    env
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}
const defaultBody = { credential_configuration_id: IDENTITY, proofs: { jwt: ['proof.jwt.x'] } };
const loggedErrors = () =>
  h.logger.error.mock.calls.map((call) => (call[2] as Error | undefined)?.message);

const ADMIN = 'AuthrimAdminCredential';
const asAdmin = () => {
  h.validateToken.mockResolvedValue({
    valid: true,
    userId: 'user-1',
    tenantId: 'tenant-1',
    credentialConfigurationId: ADMIN,
    jti: 'jti-1',
    offerId: 'offer-1',
  });
  routeFor(offerStub, {
    '/get': () =>
      json(
        offerBody({ subjectKind: 'admin', credentialConfigurationId: ADMIN, claims: { stale: 1 } })
      ),
    '/issuance/claim': () => json({ claimed: true }),
    '/issuance/complete': () => json({ completed: true }),
    '/issuance/fail': () => json({}),
  });
};
const adminBody = { credential_configuration_id: ADMIN, proofs: { jwt: ['proof.jwt.x'] } };

describe('credentialRoute: token and request parameters', () => {
  it('names its logger module and hands the bearer token to the validator as sent', async () => {
    await post();
    expect(h.logger.module).toHaveBeenCalledWith('VC-ISSUER');
    expect(h.validateToken).toHaveBeenCalledWith(
      env,
      'token',
      'https://issuer.example.com',
      'tenant-1'
    );
  });

  it('matches the Bearer scheme case-insensitively (RFC 9110)', async () => {
    for (const authorization of ['bearer token', 'BEARER token', 'BeArEr token']) {
      h.validateToken.mockClear();
      await post(defaultBody, undefined, authorization);
      expect(h.validateToken).toHaveBeenCalledWith(
        env,
        'token',
        'https://issuer.example.com',
        'tenant-1'
      );
    }
  });

  it('refuses other schemes, a missing token and an empty header', async () => {
    for (const authorization of ['Basic abc', 'Token t', 'Bearer', 'Bearer ', 'bearer ', '']) {
      expect(await post(defaultBody, undefined, authorization)).toMatchObject({
        status: 401,
        body: { error: 'invalid_token' },
      });
    }
    expect(h.validateToken).not.toHaveBeenCalled();
  });

  it('refuses a token the validator did not accept even if it carried identity', async () => {
    h.validateToken.mockResolvedValue({
      valid: false,
      userId: 'u',
      tenantId: 'tenant-1',
      jti: 'j',
      offerId: 'offer-1',
    });
    expect(await post()).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
    for (const incomplete of [
      { userId: 'u', tenantId: 't' },
      { userId: 'u', jti: 'j' },
      { tenantId: 't', jti: 'j' },
    ]) {
      h.validateToken.mockResolvedValue({ valid: true, ...incomplete });
      expect((await post()).status).toBe(401);
    }
  });

  it.each([
    [
      'a credential identifier',
      { ...defaultBody, credential_identifier: 'x' },
      'invalid_credential_request',
      'credential_identifier is not supported; use credential_configuration_id',
    ],
    [
      'no configuration id',
      { proofs: defaultBody.proofs },
      'invalid_credential_request',
      'credential_configuration_id is required',
    ],
    [
      'a numeric configuration id',
      { ...defaultBody, credential_configuration_id: 5 },
      'invalid_credential_request',
      'credential_configuration_id is required',
    ],
    [
      'an unknown configuration',
      { ...defaultBody, credential_configuration_id: 'Nope' },
      'unknown_credential_configuration',
      undefined,
    ],
    [
      'another configuration than the token grants',
      { ...defaultBody, credential_configuration_id: 'AuthrimAgeVerification' },
      'invalid_credential_request',
      'credential_configuration_id is not authorized by the access token',
    ],
    [
      'the pre-final proof parameter',
      { ...defaultBody, proof: {} },
      'invalid_credential_request',
      'Use proofs instead of proof',
    ],
    [
      'no proofs',
      { credential_configuration_id: IDENTITY },
      'invalid_proof',
      'Exactly one jwt proof is required',
    ],
    [
      'a proof list that is not an array',
      { ...defaultBody, proofs: { jwt: 'x' } },
      'invalid_proof',
      'Exactly one jwt proof is required',
    ],
    [
      'two proofs',
      { ...defaultBody, proofs: { jwt: ['a', 'b'] } },
      'invalid_proof',
      'Exactly one jwt proof is required',
    ],
    [
      'an empty proof list',
      { ...defaultBody, proofs: { jwt: [] } },
      'invalid_proof',
      'Exactly one jwt proof is required',
    ],
    [
      'a proof that is not a string',
      { ...defaultBody, proofs: { jwt: [5] } },
      'invalid_proof',
      'Exactly one jwt proof is required',
    ],
  ])('refuses %s', async (_name, body, error, description) => {
    const result = await post(body);
    expect(result.status).toBe(400);
    expect(result.body).toEqual(
      description ? { error, error_description: description } : { error }
    );
    expect(nonceStub.fetch).not.toHaveBeenCalled();
  });

  it('refuses a proof without a readable nonce or that does not validate', async () => {
    h.decodeNonce.mockReturnValue(null);
    expect(await post()).toMatchObject({ status: 400, body: { error: 'invalid_nonce' } });
    h.decodeNonce.mockReturnValue('nonce-1');
    h.validateProof.mockResolvedValue({ valid: false, holderPublicKey: HOLDER });
    expect(await post()).toMatchObject({ status: 400, body: { error: 'invalid_proof' } });
    expect(h.validateProof).toHaveBeenCalledWith(
      env,
      { proof_type: 'jwt', jwt: 'proof.jwt.x' },
      'nonce-1',
      'https://issuer.example.com'
    );
  });
});

describe('credentialRoute: holder binding', () => {
  const TOKEN_KEY = { kty: 'EC', crv: 'P-256', x: 'token-x', y: 'token-y' };
  const boundTo = () =>
    (h.reserveSlot.mock.calls[0][1] as { holderBinding: unknown }).holderBinding;

  it('prefers the key the token is bound to over the key of the proof', async () => {
    h.validateToken.mockResolvedValue({
      valid: true,
      userId: 'user-1',
      tenantId: 'tenant-1',
      credentialConfigurationId: IDENTITY,
      jti: 'jti-1',
      offerId: 'offer-1',
      holderBinding: TOKEN_KEY,
    });
    await post();
    expect(boundTo()).toEqual(TOKEN_KEY);
    expect(h.createSdjwt.mock.calls[0][3].holderBinding).toEqual(TOKEN_KEY);
  });

  it('binds to the proof key when the token has none', async () => {
    await post();
    expect(boundTo()).toEqual(HOLDER);
  });

  it('fails closed when a validator answer carries no holder key and the tenant requires binding', async () => {
    // Defensive only: a successful proof validation always returns the holder key.
    h.validateProof.mockResolvedValue({ valid: true });
    h.holderRequired.mockResolvedValue(true);
    expect(await post()).toMatchObject({ status: 400, body: { error: 'invalid_proof' } });
    expect(callsTo(nonceStub, '/nonce/release')).toHaveLength(1);
  });

  it('does not ask the tenant policy for an administrator credential, which is always bound', async () => {
    asAdmin();
    // Defensive only: a successful proof validation always returns the holder key.
    h.validateProof.mockResolvedValue({ valid: true });
    h.holderRequired.mockResolvedValue(false);
    expect(await post(adminBody)).toMatchObject({ status: 400, body: { error: 'invalid_proof' } });
  });
});

describe('credentialRoute: administrator credentials', () => {
  beforeEach(asAdmin);
  const claimsOf = () => h.createSdjwt.mock.calls[0][0] as Record<string, unknown>;

  it('builds the fixed claims from the eligibility result and ignores the offer claims', async () => {
    eligibility.mockResolvedValue({ eligible: true, email: 'ada@example.com', name: 'Ada' });
    expect((await post(adminBody)).status).toBe(200);
    expect(eligibility).toHaveBeenCalledWith({ tenantId: 'tenant-1', adminUserId: 'user-1' });
    expect(claimsOf()).toEqual({
      sub: 'user-1',
      tenant_id: 'tenant-1',
      email: 'ada@example.com',
      name: 'Ada',
    });
    expect(h.featureConfig).not.toHaveBeenCalled();
    expect(h.createSdjwt.mock.calls[0][3].selectiveDisclosureClaims).toEqual(['email', 'name']);
  });

  it.each([
    ['empty strings', { email: '', name: '' }],
    ['non-strings', { email: 5, name: { a: 1 } }],
    ['nothing', {}],
  ])('leaves out an email and a name that are %s', async (_name, extra) => {
    eligibility.mockResolvedValue({ eligible: true, ...extra });
    await post(adminBody);
    expect(claimsOf()).toEqual({ sub: 'user-1', tenant_id: 'tenant-1' });
  });

  it('refuses an administrator who is no longer eligible, or without the binding', async () => {
    for (const result of [{ eligible: false }, undefined]) {
      eligibility.mockResolvedValue(result);
      expect(await post(adminBody)).toMatchObject({
        status: 400,
        body: { error: 'invalid_credential_request' },
      });
      expect(h.transition).toHaveBeenCalledTimes(1);
      h.transition.mockClear();
    }
    env = { ...env, ADMIN_CREDENTIAL_ELIGIBILITY: undefined } as unknown as Env;
    expect((await post(adminBody)).status).toBe(400);
  });
});

describe('credentialRoute: store calls', () => {
  it('opens the issuer core database under its name', async () => {
    await post();
    expect(h.adapterArgs).toHaveBeenCalledWith({}, 'vc-issuer-core');
  });

  it('speaks JSON to the stores', async () => {
    await post();
    for (const [stub, path] of [
      [nonceStub, '/nonce/reserve'],
      [nonceStub, '/nonce/complete'],
      [offerStub, '/issuance/claim'],
      [offerStub, '/issuance/complete'],
    ] as const) {
      expect((callsTo(stub, path)[0][0] as Request).headers.get('Content-Type')).toBe(
        'application/json'
      );
    }
    h.updateIfCurrent.mockResolvedValue(false);
    await post();
    expect(
      (callsTo(nonceStub, '/nonce/release')[0][0] as Request).headers.get('Content-Type')
    ).toBe('application/json');
  });

  it('trusts no answer of a store that reported a failure', async () => {
    routeFor(nonceStub, {
      '/nonce/reserve': () => json({ reserved: true, reservationId: 'res-1' }),
      '/nonce/complete': () => json({ completed: true }, false),
      '/nonce/release': () => json({}),
    });
    expect(await post()).toMatchObject({ status: 500, body: { error: 'server_error' } });
    expect(loggedErrors()).toContain('vci_nonce_completion_failed');
  });

  it('answers invalid_nonce for a reservation answer that is not an object', async () => {
    routeFor(nonceStub, { '/nonce/reserve': () => json(null) });
    expect(await post()).toMatchObject({ status: 400, body: { error: 'invalid_nonce' } });
  });

  it.each([
    [{ outcome: 'unchanged' }],
    [{ outcome: 'not_found' }],
    [{ outcome: 'not_allowed', current: 'revoked' }],
  ] as const)('settles compensation as complete for the %j transition result', async (result) => {
    h.updateIfCurrent.mockResolvedValue(false);
    h.transition.mockResolvedValue(result);
    expect((await post()).status).toBe(400);
  });

  it('keeps the exact message of a failing offer store call', async () => {
    routeFor(offerStub, {
      '/get': () => json(offerBody()),
      '/issuance/claim': () => json({}, false),
    });
    await post();
    expect(loggedErrors()).toContain('vci_offer_store__issuance_claim_failed');
  });

  it('logs why an issued credential was refused', async () => {
    for (const [combined, message] of [
      ['', 'credentials entries must carry a non-empty credential string'],
      [undefined, 'credentials entries must carry a non-empty credential string'],
      ['not-a-jwt~d1', 'Invalid JWT format in credential'],
      ['a.b~d1', 'Invalid JWT format in credential'],
    ] as const) {
      h.logger.error.mockClear();
      h.createSdjwt.mockResolvedValue({ combined, issuerSignedJwt: '', disclosures: [] });
      expect((await post()).status).toBe(500);
      expect(loggedErrors()).toContain(message);
    }
  });
});
