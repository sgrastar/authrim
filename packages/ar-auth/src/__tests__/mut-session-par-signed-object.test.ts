import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    validateClientId: vi.fn(),
    validateRedirectUri: vi.fn(),
    validateScope: vi.fn(),
    isRedirectUriRegistered: vi.fn(),
    validateClientAssertion: vi.fn(),
    validateDPoPProof: vi.fn(),
    verifyClientSecretHash: vi.fn(),
    getTokenFormat: vi.fn(),
    decryptRequestObject: vi.fn(),
    parseToken: vi.fn(),
    parseTokenHeader: vi.fn(),
    isInternalUrl: vi.fn(),
    safeFetchJson: vi.fn(),
    validateAuthorizationDetails: vi.fn(),
    getClientCached: vi.fn(),
    getPARRequestStoreForNewRequest: vi.fn(),
    storeRequestRpc: vi.fn(),
    logger,
    jwtVerify: vi.fn(),
    importJWK: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    validateClientId: m.validateClientId,
    validateRedirectUri: m.validateRedirectUri,
    validateScope: m.validateScope,
    isRedirectUriRegistered: m.isRedirectUriRegistered,
    validateClientAssertion: m.validateClientAssertion,
    validateDPoPProof: m.validateDPoPProof,
    verifyClientSecretHash: m.verifyClientSecretHash,
    getTokenFormat: m.getTokenFormat,
    decryptRequestObject: m.decryptRequestObject,
    parseToken: m.parseToken,
    parseTokenHeader: m.parseTokenHeader,
    isInternalUrl: m.isInternalUrl,
    safeFetchJson: m.safeFetchJson,
    validateAuthorizationDetails: m.validateAuthorizationDetails,
    getClientCached: m.getClientCached,
    getPARRequestStoreForNewRequest: m.getPARRequestStoreForNewRequest,
    getLogger: () => m.logger,
  };
});

vi.mock('../issuer', () => ({
  getRequestIssuer: vi.fn().mockReturnValue('https://op.example.com'),
}));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, jwtVerify: m.jwtVerify, importJWK: m.importJWK };
});

import { parHandler } from '../par';
import {
  CALLBACK,
  baseBody,
  createParContext,
  platformSettings,
} from './helpers/mut-session-par-context';

const PUBLIC_CLIENT = {
  client_id: 'client-123',
  redirect_uris: [CALLBACK],
  token_endpoint_auth_method: 'none',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.validateClientId.mockReturnValue({ valid: true });
  m.validateRedirectUri.mockReturnValue({ valid: true });
  m.validateScope.mockReturnValue({ valid: true });
  m.isRedirectUriRegistered.mockReturnValue(true);
  m.validateClientAssertion.mockResolvedValue({ valid: true });
  m.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'thumbprint' });
  m.verifyClientSecretHash.mockResolvedValue(true);
  m.getTokenFormat.mockReturnValue('jwt');
  m.parseToken.mockReturnValue(null);
  m.parseTokenHeader.mockReturnValue({ alg: 'RS256' });
  m.isInternalUrl.mockReturnValue(false);
  m.validateAuthorizationDetails.mockReturnValue({ valid: true, sanitized: [{ type: 'x' }] });
  m.getClientCached.mockResolvedValue({ ...PUBLIC_CLIENT });
  m.storeRequestRpc.mockResolvedValue(undefined);
  m.getPARRequestStoreForNewRequest.mockResolvedValue({
    requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
    stub: { storeRequestRpc: m.storeRequestRpc },
  });
  m.importJWK.mockResolvedValue({ type: 'public' });
});

async function run(options: Parameters<typeof createParContext>[0]) {
  const response = await parHandler(createParContext(options) as never);
  const body = await response.json<Record<string, unknown>>();
  return { status: response.status, body };
}

function stored(): Record<string, unknown> {
  const first = m.storeRequestRpc.mock.calls[0] as [{ data: Record<string, unknown> }] | undefined;
  return first?.[0].data ?? {};
}

const invalidObject = (description: string) => ({
  status: 400,
  body: { error: 'invalid_request_object', error_description: description },
});
const RSA = { kty: 'RSA', use: 'sig', n: 'n', e: 'AQAB' };
const EC = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
const OKP = { kty: 'OKP', crv: 'Ed25519', x: 'x' };
const NO_JWKS_KEY = 'No suitable signing key found in client jwks';
const signedBody = { ...baseBody, request: 'signed.request.object' };
const ALL_ALGS = ['RS256', 'PS256', 'ES256', 'EdDSA', 'ES384'];

function now() {
  return Math.floor(Date.now() / 1000);
}

/** Message Signing settings so that non-RS256 algorithms are accepted. */
function messageSigning(extra: Record<string, unknown> = {}) {
  return platformSettings({
    fapi: {
      messageSigning: { enabled: true, requestObjectSigningAlgorithms: ALL_ALGS, ...extra },
    },
  });
}

async function runSigned(options: {
  jwks?: unknown;
  alg?: string;
  kid?: string;
  client?: Record<string, unknown>;
  settings?: KVNamespace;
}) {
  m.getClientCached.mockResolvedValue({
    ...PUBLIC_CLIENT,
    ...(options.jwks !== undefined ? { jwks: options.jwks } : {}),
    ...options.client,
  });
  m.parseTokenHeader.mockReturnValue({ alg: options.alg ?? 'RS256', kid: options.kid });
  return run({
    body: signedBody,
    env: options.settings ? { SETTINGS: options.settings } : {},
  });
}

beforeEach(() => {
  m.jwtVerify.mockResolvedValue({
    payload: { client_id: 'client-123', nbf: now(), exp: now() + 60 },
  });
});

describe('PAR request object signing key selection', () => {
  it('refuses a JWKS without a keys array', async () => {
    expect(await runSigned({ jwks: { keys: 'x' } })).toEqual(invalidObject(NO_JWKS_KEY));
  });

  it('parses a JWKS stored as a JSON string', async () => {
    const res = await runSigned({ jwks: JSON.stringify({ keys: [RSA] }) });
    expect(res.status).toBe(201);
    expect(m.importJWK).toHaveBeenCalledWith(RSA, 'RS256');
  });

  it.each([
    ['an encryption key', { ...RSA, use: 'enc' }],
    ['a key whose key_ops exclude verify', { ...RSA, key_ops: ['sign'] }],
    ['a key registered for another algorithm', { ...RSA, alg: 'PS256' }],
    ['an RSA key without a modulus', { kty: 'RSA', use: 'sig', e: 'AQAB' }],
    ['an RSA key without an exponent', { kty: 'RSA', use: 'sig', n: 'n' }],
    ['an EC key for RS256', EC],
  ])('ignores %s for RS256', async (_name, key) => {
    expect(await runSigned({ jwks: { keys: [key] } })).toEqual(invalidObject(NO_JWKS_KEY));
    expect(m.importJWK).not.toHaveBeenCalled();
  });

  it('accepts a key whose key_ops include verify', async () => {
    const key = { ...RSA, key_ops: ['verify'] };
    expect((await runSigned({ jwks: { keys: [key] } })).status).toBe(201);
    expect(m.importJWK).toHaveBeenCalledWith(key, 'RS256');
  });

  it.each([
    ['PS256', RSA],
    ['ES256', EC],
    ['EdDSA', OKP],
    ['EdDSA', { ...OKP, crv: 'Ed448' }],
  ])('selects a matching key for %s', async (alg, key) => {
    const res = await runSigned({ jwks: { keys: [key] }, alg, settings: messageSigning() });
    expect(res.status).toBe(201);
    expect(m.importJWK).toHaveBeenCalledWith(key, alg);
  });

  it.each([
    ['ES256', { ...EC, crv: 'P-384' }],
    ['ES256', { kty: 'EC', crv: 'P-256', y: 'y' }],
    ['ES256', { kty: 'EC', crv: 'P-256', x: 'x' }],
    ['ES256', RSA],
    ['PS256', { kty: 'RSA', n: 'n' }],
    ['PS256', EC],
    ['EdDSA', { ...OKP, crv: 'X25519' }],
    ['EdDSA', { kty: 'EC', crv: 'Ed25519', x: 'x' }],
    ['EdDSA', { kty: 'OKP', crv: 'Ed25519' }],
    ['EdDSA', RSA],
    ['ES384', { kty: 'EC', crv: 'P-384', x: 'x', y: 'y' }],
  ])('rejects an unsuitable key for %s', async (alg, key) => {
    const res = await runSigned({ jwks: { keys: [key] }, alg, settings: messageSigning() });
    expect(res).toEqual(invalidObject(NO_JWKS_KEY));
  });

  it('needs exactly one candidate when the header has no kid', async () => {
    const a = { ...RSA, kid: 'a' };
    const b = { ...RSA, kid: 'b' };
    expect(await runSigned({ jwks: { keys: [a, b] } })).toEqual(invalidObject(NO_JWKS_KEY));
    expect((await runSigned({ jwks: { keys: [a, b] }, kid: 'b' })).status).toBe(201);
    expect(m.importJWK).toHaveBeenLastCalledWith(b, 'RS256');
    expect(await runSigned({ jwks: { keys: [a] }, kid: 'c' })).toEqual(invalidObject(NO_JWKS_KEY));
  });

  it('refuses a symmetric key import', async () => {
    m.importJWK.mockResolvedValueOnce(new Uint8Array([1]));
    expect(await runSigned({ jwks: { keys: [RSA] } })).toEqual(
      invalidObject('Invalid key format in client JWKS')
    );
  });
});

describe('PAR signed request object checks', () => {
  it('refuses an unsupported or missing algorithm', async () => {
    const unsupported = invalidObject('Unsupported request object signing algorithm');
    expect(await runSigned({ jwks: { keys: [RSA] }, alg: 'HS256' })).toEqual(unsupported);
    m.getClientCached.mockResolvedValue({ ...PUBLIC_CLIENT, jwks: { keys: [RSA] } });
    m.parseTokenHeader.mockReturnValue(null);
    expect(await run({ body: signedBody })).toEqual(unsupported);
  });

  it('refuses an algorithm other than the registered one', async () => {
    const res = await runSigned({
      jwks: { keys: [EC] },
      alg: 'ES256',
      client: { request_object_signing_alg: 'PS256' },
      settings: messageSigning(),
    });
    expect(res).toEqual(
      invalidObject('Request object algorithm does not match the registered client metadata')
    );
  });

  it('refuses a request object whose signature does not verify', async () => {
    m.jwtVerify.mockRejectedValueOnce(new Error('signature'));
    expect(await runSigned({ jwks: { keys: [RSA] } })).toEqual(
      invalidObject('Request object signature verification failed')
    );
  });

  it('applies a 10 second default clock tolerance and the configured age limit', async () => {
    expect((await runSigned({ jwks: { keys: [RSA] }, settings: messageSigning() })).status).toBe(
      201
    );
    expect(m.jwtVerify.mock.calls[0][2]).toEqual({
      issuer: 'client-123',
      audience: 'https://op.example.com',
      algorithms: ALL_ALGS,
      clockTolerance: 10,
    });
    m.jwtVerify.mockResolvedValueOnce({
      payload: { client_id: 'client-123', nbf: now() - 120, exp: now() + 60 },
    });
    const res = await runSigned({
      jwks: { keys: [RSA] },
      settings: messageSigning({ maxRequestObjectAgeSeconds: 60 }),
    });
    expect(res).toEqual(invalidObject('nbf claim must not be more than 60 seconds in the past'));
  });

  it('applies the configured lifetime limit', async () => {
    m.jwtVerify.mockResolvedValueOnce({
      payload: { client_id: 'client-123', nbf: now(), exp: now() + 120 },
    });
    const res = await runSigned({
      jwks: { keys: [RSA] },
      settings: messageSigning({ maxRequestObjectLifetimeSeconds: 60 }),
    });
    expect(res).toEqual(invalidObject('request object lifetime must not exceed 60 seconds'));
  });
});

describe('PAR client jwks_uri', () => {
  const client = { jwks_uri: 'https://client.example.com/jwks' };

  it('fetches the JWKS with bounded options and verifies with the selected key', async () => {
    m.safeFetchJson.mockResolvedValueOnce({ keys: [RSA] });
    expect((await runSigned({ client })).status).toBe(201);
    expect(m.safeFetchJson).toHaveBeenCalledWith('https://client.example.com/jwks', {
      timeoutMs: 5000,
      maxResponseSize: 256 * 1024,
      redirect: 'error',
    });
    expect(m.importJWK).toHaveBeenCalledWith(RSA, 'RS256');
  });

  it('refuses a JWKS without a suitable key', async () => {
    m.safeFetchJson.mockResolvedValueOnce({ keys: [EC] });
    expect(await runSigned({ client })).toEqual(
      invalidObject('No suitable signing key found in client jwks_uri')
    );
  });

  it('refuses a symmetric key import', async () => {
    m.safeFetchJson.mockResolvedValueOnce({ keys: [RSA] });
    m.importJWK.mockResolvedValueOnce(new Uint8Array([1]));
    expect(await runSigned({ client })).toEqual(invalidObject('Invalid key format in client JWKS'));
  });

  it('refuses when the JWKS cannot be fetched', async () => {
    m.safeFetchJson.mockRejectedValueOnce(new Error('timeout'));
    expect(await runSigned({ client })).toEqual(invalidObject('Failed to fetch client jwks_uri'));
  });
});

describe('PAR signed request object coverage (request_object_signed)', () => {
  const full = {
    client_id: 'client-123',
    response_type: 'code',
    redirect_uri: CALLBACK,
    scope: 'openid profile',
  };
  async function signedWith(payload: Record<string, unknown>, form: Record<string, unknown> = {}) {
    m.jwtVerify.mockResolvedValueOnce({ payload: { ...full, ...payload } });
    m.getClientCached.mockResolvedValue({ ...PUBLIC_CLIENT, jwks: { keys: [RSA] } });
    m.storeRequestRpc.mockClear();
    const res = await run({ body: { ...baseBody, ...form, request: 'signed.request.object' } });
    expect(res.status).toBe(201);
    return stored().request_object_signed;
  }

  it('is set when the signed object carries every parameter used', async () => {
    expect(await signedWith({})).toBe(true);
    expect(await signedWith({ max_age: 0 })).toBe(true);
    expect(await signedWith({ dpop_jkt: 'k'.repeat(43) })).toBe(true);
    expect(await signedWith({ error_uri: 'https://client.example.com/e' })).toBe(true);
    expect(await signedWith({}, { state: '' })).toBe(true);
  });

  it('is not set when a parameter used came from the form only', async () => {
    expect(await signedWith({}, { state: 'form-state' })).toBeUndefined();
    expect(await signedWith({}, { max_age: '10' })).toBeUndefined();
    expect(await signedWith({}, { dpop_jkt: 'k'.repeat(43) })).toBeUndefined();
    expect(await signedWith({}, { error_uri: 'https://client.example.com/e' })).toBeUndefined();
  });
});
