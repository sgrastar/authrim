/**
 * Credential endpoint (pre-authorized Bearer path): request validation, store protocol,
 * compensation outcomes, custom claims and the signing hand-off, with fakes at every boundary.
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
    ensureDatabaseAdapter: () => ({ adapter: true }),
    resolveTenantMetadataContext: async () => ({ coreDb: {} }),
    createSDJWTVCWithSigner: h.createSdjwt,
    reserveCredentialStatusSlot: h.reserveSlot,
    transitionCredentialStatus: h.transition,
    IssuedCredentialRepository: class {
      updateStatusIfCurrent = h.updateIfCurrent;
    },
  };
});

import { ShardConfigUnavailableError } from '../../../utils/configured-shard';
import { credentialRoute } from '../credential';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const ISSUER = 'https://issuer.example.com';
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
const bodyOf = async (call: unknown[]) => (await (call[0] as Request).clone().json()) as unknown;

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

async function post(body: unknown = defaultBody, raw?: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/vci/credential', credentialRoute);
  const response = await app.request(
    'https://issuer.example.com/vci/credential',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
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

describe('credentialRoute: request body', () => {
  it('rejects a body that is not JSON', async () => {
    expect(await post(undefined, 'not json')).toMatchObject({
      status: 400,
      body: { error: 'invalid_credential_request', error_description: 'Request body must be JSON' },
    });
  });

  it.each(['null', '[]', '5', '"text"'])('rejects the body %s as not an object', async (raw) => {
    expect(await post(undefined, raw)).toMatchObject({
      status: 400,
      body: {
        error: 'invalid_credential_request',
        error_description: 'Request body must be a JSON object',
      },
    });
  });
});

describe('credentialRoute: success', () => {
  it('issues the credential and follows the store protocol in order', async () => {
    const result = await post();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ credentials: [{ credential: 'h.p.s~d1~' }] });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');

    const [reserve] = callsTo(nonceStub, '/nonce/reserve');
    const reserveBody = (await bodyOf(reserve)) as Record<string, unknown>;
    expect(reserveBody).toMatchObject({
      id: 'nonce-id',
      tenantId: 'tenant-1',
      accessTokenJti: 'jti-1',
      now: NOW_MS,
    });
    expect(reserveBody.nonceHash).not.toBe(reserveBody.proofFingerprint);
    const [complete] = callsTo(nonceStub, '/nonce/complete');
    expect(await bodyOf(complete)).toEqual({
      id: 'nonce-id',
      tenantId: 'tenant-1',
      reservationId: 'res-1',
    });
    const [get] = callsTo(offerStub, '/get');
    expect(pathOf(get).search).toBe('?id=offer-1&tenant_id=tenant-1');
    expect(await bodyOf(callsTo(offerStub, '/issuance/claim')[0])).toEqual({
      id: 'offer-1',
      tenantId: 'tenant-1',
      accessTokenJti: 'jti-1',
      now: NOW_MS,
    });
    expect(await bodyOf(callsTo(offerStub, '/issuance/complete')[0])).toMatchObject({
      id: 'offer-1',
      accessTokenJti: 'jti-1',
      now: NOW_MS,
    });
    expect(h.reserveSlot).toHaveBeenCalledWith(
      { adapter: true },
      {
        tenantId: 'tenant-1',
        userId: 'user-1',
        credentialType: 'https://authrim.com/credentials/identity/v1',
        format: 'dc+sd-jwt',
        holderBinding: HOLDER,
        expiresAt: NOW + 365 * 86400,
      }
    );
    expect(h.updateIfCurrent).toHaveBeenCalledWith('tenant-1', 'cred-1', 'pending', 'active');
    expect(callsTo(nonceStub, '/nonce/release')).toHaveLength(0);
    expect(callsTo(offerStub, '/issuance/fail')).toHaveLength(0);
  });

  it('hands the claims, status reference and options to the SD-JWT builder', async () => {
    await post();
    const [claims, issuer, , options] = h.createSdjwt.mock.calls[0];
    expect(claims).toEqual({ given_name: 'Alice' });
    expect(issuer).toBe(ISSUER);
    expect(options).toEqual({
      vct: 'https://authrim.com/credentials/identity/v1',
      selectiveDisclosureClaims: ['given_name', 'family_name', 'email', 'birthdate'],
      holderBinding: HOLDER,
      expiresAt: NOW + 365 * 86400,
      status: { status_list: { idx: 7, uri: `${ISSUER}/vci/status-lists/list-1` } },
    });
  });

  it('prepares the signing key with the credential expiry and signs with a fresh stub', async () => {
    await post();
    expect(h.ensureCertificate).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ signSDJWTIssuerRpc: sign }),
      ISSUER,
      'tenant-1',
      NOW_MS,
      (NOW + 100) * 1000
    );
    expect(keyManagerGet).toHaveBeenCalledTimes(2);
    expect(keyManagerGet).toHaveBeenCalledWith('id:tenant-1-v3');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0]).toHaveLength(1);
  });

  it('passes no expiry to the certificate step when the payload has none, and none when no iss', async () => {
    h.createSdjwt.mockImplementation(async (_c, _i, signer) => ({
      combined: `${await signer({ iss: ISSUER })}~`,
      issuerSignedJwt: '',
      disclosures: [],
    }));
    await post();
    expect(h.ensureCertificate.mock.calls[0][5]).toBeUndefined();
    h.ensureCertificate.mockClear();
    h.createSdjwt.mockImplementation(async (_c, _i, signer) => ({
      combined: `${await signer({})}~`,
      issuerSignedJwt: '',
      disclosures: [],
    }));
    await post();
    expect(h.ensureCertificate).not.toHaveBeenCalled();
  });
});

describe('credentialRoute: proof nonce store', () => {
  it('refuses a nonce whose shard cannot be resolved or is not configured', async () => {
    h.proofStore.mockImplementation(() => {
      throw new Error('bad shard');
    });
    expect(await post()).toMatchObject({ status: 400, body: { error: 'invalid_nonce' } });
    h.proofStore.mockReturnValue({ stub: nonceStub, nonceId: 'nonce-id', resolution: 'r1' });
    h.isConfiguredShard.mockResolvedValueOnce(false);
    expect(await post()).toMatchObject({ status: 400, body: { error: 'invalid_nonce' } });
    expect(nonceStub.fetch).not.toHaveBeenCalled();
  });

  it('answers 503 for a store that did not answer and 400 for an explicit refusal', async () => {
    routeFor(nonceStub, { '/nonce/reserve': () => json({}, false) });
    expect(await post()).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
    for (const answer of [
      { reserved: false },
      { reserved: true },
      { reserved: false, reservationId: 'r' },
    ]) {
      routeFor(nonceStub, { '/nonce/reserve': () => json(answer) });
      expect(await post()).toMatchObject({ status: 400, body: { error: 'invalid_nonce' } });
    }
  });

  it('answers 500 when the nonce cannot be completed and releases the issuance claim', async () => {
    for (const answer of [json({ completed: false }), json({}, false)]) {
      happyRoutes();
      routeFor(nonceStub, {
        '/nonce/reserve': () => json({ reserved: true, reservationId: 'res-1' }),
        '/nonce/complete': () => answer,
        '/nonce/release': () => json({}),
      });
      expect(await post()).toMatchObject({ status: 500, body: { error: 'server_error' } });
      expect(loggedErrors()).toContain('vci_nonce_completion_failed');
      expect(callsTo(offerStub, '/issuance/fail')).toHaveLength(1);
      offerStub.fetch.mockClear();
      h.logger.error.mockClear();
    }
  });
});

describe('credentialRoute: the grant behind the issuance', () => {
  it('fails closed on a token without an offer id', async () => {
    h.validateToken.mockResolvedValue({
      valid: true,
      userId: 'user-1',
      tenantId: 'tenant-1',
      credentialConfigurationId: IDENTITY,
      jti: 'jti-1',
    });
    expect(await post()).toMatchObject({ status: 500, body: { error: 'server_error' } });
    expect(loggedErrors()).toContain('vci_access_token_missing_offer_id');
    expect(callsTo(nonceStub, '/nonce/release')).toHaveLength(1);
  });

  it('refuses an offer whose binding does not match the token', async () => {
    const cases = [
      { status: 'reserved' },
      { expiresAt: NOW_MS },
      { expiresAt: NOW_MS - 1 },
      { userId: 'other' },
      { credentialConfigurationId: 'AuthrimAgeVerification' },
    ];
    for (const overrides of cases) {
      h.logger.error.mockClear();
      routeFor(offerStub, { '/get': () => json(offerBody(overrides)) });
      expect(await post()).toMatchObject({ status: 500, body: { error: 'server_error' } });
      expect(loggedErrors()).toEqual(['vci_offer_binding_mismatch']);
    }
  });

  it('accepts an offer that expires just after now and reads a missing subject kind as end user', async () => {
    const offer = offerBody({ expiresAt: NOW_MS + 1 });
    delete (offer as Record<string, unknown>).subjectKind;
    routeFor(offerStub, {
      '/get': () => json(offer),
      '/issuance/claim': () => json({ claimed: true }),
      '/issuance/complete': () => json({ completed: true }),
    });
    expect((await post()).status).toBe(200);
  });

  it('fails when the offer is unknown to its store', async () => {
    routeFor(offerStub, { '/get': () => json({}, false) });
    expect((await post()).status).toBe(500);
    expect(loggedErrors()).toContain('vci_offer_not_found');
  });

  it('refuses an offer of the other subject kind', async () => {
    routeFor(offerStub, { '/get': () => json(offerBody({ subjectKind: 'admin' })) });
    expect(await post()).toMatchObject({
      status: 400,
      body: { error: 'invalid_credential_request' },
    });
    expect(callsTo(offerStub, '/issuance/claim')).toHaveLength(0);
  });

  it('names the failing store call when the claim cannot be made', async () => {
    routeFor(offerStub, {
      '/get': () => json(offerBody()),
      '/issuance/claim': () => json({}, false),
    });
    expect((await post()).status).toBe(500);
    expect(loggedErrors()).toContain('vci_offer_store__issuance_claim_failed');
  });

  it('refuses a request that loses the issuance claim', async () => {
    routeFor(offerStub, {
      '/get': () => json(offerBody()),
      '/issuance/claim': () => json({ claimed: false }),
    });
    expect(await post()).toMatchObject({
      status: 400,
      body: { error: 'invalid_credential_request' },
    });
    expect(callsTo(nonceStub, '/nonce/release')).toHaveLength(1);
    expect(h.reserveSlot).not.toHaveBeenCalled();
  });

  it('refuses a token whose offer shard is no longer configured', async () => {
    h.isConfiguredShard.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await post();
    expect(result).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
    expect(callsTo(offerStub, '/get')).toHaveLength(0);
  });

  it('fails on an issuance that cannot be completed', async () => {
    routeFor(offerStub, {
      '/get': () => json(offerBody()),
      '/issuance/claim': () => json({ claimed: true }),
      '/issuance/complete': () => json({ completed: false }),
      '/issuance/fail': () => json({}),
    });
    expect(await post()).toMatchObject({ status: 500, body: { error: 'server_error' } });
    expect(loggedErrors()).toContain('vci_issuance_completion_failed');
  });
});

describe('credentialRoute: compensation decides 503 against the refusal', () => {
  const lostClaim = () =>
    routeFor(offerStub, {
      '/get': () => json(offerBody()),
      '/issuance/claim': () => json({ claimed: false }),
    });

  it('answers 503 when the nonce release is refused or throws', async () => {
    lostClaim();
    routeFor(nonceStub, {
      '/nonce/reserve': () => json({ reserved: true, reservationId: 'res-1' }),
      '/nonce/release': () => json({}, false),
    });
    expect((await post()).status).toBe(503);
    nonceStub.fetch.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/nonce/release') throw new Error('network');
      return json({ reserved: true, reservationId: 'res-1' });
    });
    expect((await post()).status).toBe(503);
  });

  it('answers 503 when revoking the pending row conflicts or throws, 400 when it changed', async () => {
    h.updateIfCurrent.mockResolvedValue(false);
    expect((await post()).status).toBe(400);
    expect(h.transition).toHaveBeenCalledWith(
      { adapter: true },
      { tenantId: 'tenant-1', credentialId: 'cred-1', from: ['pending', 'active'], to: 'revoked' }
    );
    h.transition.mockResolvedValue({ outcome: 'conflict' });
    expect((await post()).status).toBe(503);
    h.transition.mockRejectedValue(new Error('db'));
    expect((await post()).status).toBe(503);
  });

  it('answers 503 when failing the issuance throws and 400 when it succeeds', async () => {
    h.updateIfCurrent.mockResolvedValue(false);
    expect((await post()).status).toBe(400);
    expect(await bodyOf(callsTo(offerStub, '/issuance/fail')[0])).toEqual({
      id: 'offer-1',
      tenantId: 'tenant-1',
      accessTokenJti: 'jti-1',
      now: NOW_MS,
    });
    routeFor(offerStub, {
      '/get': () => json(offerBody()),
      '/issuance/claim': () => json({ claimed: true }),
      '/issuance/fail': () => json({}, false),
    });
    expect((await post()).status).toBe(503);
  });

  it('keeps the known refusals below 500 only when everything was compensated', async () => {
    for (const message of ['x5c_required', 'vc_issuer_key_retention_cap_reached']) {
      sign.mockRejectedValue(new Error(`signing: ${message}`));
      expect(await post()).toMatchObject({
        status: 424,
        body: { error: 'temporarily_unavailable' },
      });
    }
    h.transition.mockResolvedValue({ outcome: 'conflict' });
    expect((await post()).status).toBe(503);
    h.transition.mockResolvedValue({ outcome: 'changed', previous: 'pending' });
    h.isConfiguredShard.mockRejectedValueOnce(new ShardConfigUnavailableError('kv'));
    expect((await post()).status).toBe(424);
    sign.mockRejectedValue(new Error('boom'));
    expect(await post()).toMatchObject({ status: 500, body: { error: 'server_error' } });
  });
});

describe('credentialRoute: the issued credential', () => {
  it.each(['', 'not-a-jwt~d1', 'a.b~d1', undefined])(
    'refuses the credential %j',
    async (combined) => {
      h.createSdjwt.mockResolvedValue({ combined, issuerSignedJwt: '', disclosures: [] });
      expect(await post()).toMatchObject({ status: 500, body: { error: 'server_error' } });
      expect(h.updateIfCurrent).not.toHaveBeenCalled();
      expect(callsTo(nonceStub, '/nonce/release')).toHaveLength(1);
    }
  );
});

describe('credentialRoute: custom claims', () => {
  const resolver = { resolveClaimsForTarget: h.resolveClaims };
  beforeEach(() => {
    h.featureConfig.mockResolvedValue({ enabled: true, flag: 1 });
    h.runtimeSources.mockResolvedValue({ schemaDb: 'schema-db', piiDb: 'pii-db' });
    h.createResolver.mockReturnValue(resolver);
    h.resolveClaims.mockResolvedValue({
      claims: { nickname: 'Al', secret: 'x' },
      pii_accessed: false,
    });
    h.loadSchemas.mockResolvedValue([]);
  });

  it('merges the resolved claims over the offer claims', async () => {
    await post();
    expect(h.featureConfig).toHaveBeenCalledWith(env, 'tenant-1');
    expect(h.runtimeSources).toHaveBeenCalledWith(env, 'tenant-1', { accountId: 'account:user-1' });
    expect(h.createResolver).toHaveBeenCalledWith('schema-db', 'pii-db', env.AUTHRIM_CONFIG, {
      enabled: true,
      flag: 1,
    });
    expect(h.resolveClaims).toHaveBeenCalledWith('tenant-1', 'user-1', [], 'vc');
    expect(h.createSdjwt.mock.calls[0][0]).toEqual({
      given_name: 'Alice',
      nickname: 'Al',
      secret: 'x',
    });
    expect(h.schemaLoaderArgs).not.toHaveBeenCalled();
    expect(h.createSdjwt.mock.calls[0][3].selectiveDisclosureClaims).toEqual([
      'given_name',
      'family_name',
      'email',
      'birthdate',
    ]);
  });

  it('passes null when no config namespace is bound', async () => {
    env = { ...env, AUTHRIM_CONFIG: undefined } as unknown as Env;
    h.resolveClaims.mockResolvedValue({ claims: {}, pii_accessed: true });
    await post();
    expect(h.createResolver.mock.calls[0][2]).toBeNull();
    expect(h.schemaLoaderArgs).toHaveBeenCalledWith('schema-db', null);
  });

  it('adds the names of the PII claims it actually returned to the disclosures once', async () => {
    h.resolveClaims.mockResolvedValue({
      claims: { nickname: 'Al', phone: '1', email: 'a@b' },
      pii_accessed: true,
    });
    const schemas = [
      { id: 'a', is_vc_claim: 1, is_pii: 1 },
      { id: 'b', is_vc_claim: 1, is_pii: 1 },
      { id: 'c', is_vc_claim: 1, is_pii: 0 },
      { id: 'd', is_vc_claim: 0, is_pii: 1 },
      { id: 'e', is_vc_claim: 1, is_pii: 1 },
    ];
    h.loadSchemas.mockResolvedValue(schemas);
    h.resolveName.mockImplementation(
      (schema: { id: string }) =>
        ({ a: 'phone', b: 'email', c: 'nickname', d: 'secret', e: 'absent' })[schema.id]
    );
    await post();
    expect(h.schemaLoaderArgs).toHaveBeenCalledWith('schema-db', env.AUTHRIM_CONFIG);
    expect(h.loadSchemas).toHaveBeenCalledWith('tenant-1');
    expect(h.resolveName).toHaveBeenCalledTimes(3);
    expect(h.createSdjwt.mock.calls[0][3].selectiveDisclosureClaims).toEqual([
      'given_name',
      'family_name',
      'email',
      'birthdate',
      'phone',
    ]);
  });

  it('keeps issuing with the offer claims when the resolution fails', async () => {
    h.resolveClaims.mockRejectedValue(new Error('schema db down'));
    expect((await post()).status).toBe(200);
    expect(h.createSdjwt.mock.calls[0][0]).toEqual({ given_name: 'Alice' });
    expect(loggedErrors()).toContain('schema db down');
  });

  it('does not resolve claims when the feature is off', async () => {
    h.featureConfig.mockResolvedValue({ enabled: false });
    await post();
    expect(h.runtimeSources).not.toHaveBeenCalled();
  });
});
