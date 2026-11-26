/**
 * Deferred credential route and nonce route: each refusal with its exact body, the readiness
 * rule, and the signing hand-off.
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
    findDeferred: vi.fn(),
    parseClaims: vi.fn(),
    parseHolder: vi.fn(),
    updateStatus: vi.fn(),
    createSdjwt: vi.fn(),
    ensureCertificate: vi.fn(),
    generateProofNonce: vi.fn(),
    sha: vi.fn(),
  };
});

vi.mock('../../services/token-validation', () => ({ validateVCIAccessToken: h.validateToken }));
vi.mock('../../services/issuer-ca', () => ({ ensureVcSigningCertificate: h.ensureCertificate }));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://issuer.example.com',
}));
vi.mock('../../../utils/credential-offer-sharding', () => ({
  generateProofNonce: h.generateProofNonce,
}));
vi.mock('../../../utils/crypto', () => ({ sha256Base64url: h.sha }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => h.logger,
    getTenantIdFromContext: () => 'tenant-1',
    resolveTenantMetadataContext: async () => ({ coreDb: {} }),
    ensureDatabaseAdapter: () => ({}),
    createSDJWTVCWithSigner: h.createSdjwt,
    IssuedCredentialRepository: class {
      findDeferredByIdAndUser = h.findDeferred;
      parseClaims = h.parseClaims;
      parseHolderBinding = h.parseHolder;
      updateStatus = h.updateStatus;
    },
  };
});

import { deferredCredentialRoute } from '../deferred';
import { vciNonceRoute } from '../nonce';

const NOW_MS = 1_800_000_000_000;
const IDENTITY_VCT = 'https://authrim.com/credentials/identity/v1';
const ADMIN_VCT = 'https://authrim.com/credentials/admin/v1';
let env: Env;
let sign: ReturnType<typeof vi.fn>;
let keyManagerGet: ReturnType<typeof vi.fn>;
let idFromName: ReturnType<typeof vi.fn<(name: string) => string>>;

const deferred = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: 'tenant-1',
  claims: '{"given_name":"A"}',
  credential_type: IDENTITY_VCT,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  h.validateToken.mockResolvedValue({ valid: true, userId: 'user-1', tenantId: 'tenant-1' });
  h.findDeferred.mockResolvedValue(deferred());
  h.parseClaims.mockReturnValue({ given_name: 'A' });
  h.parseHolder.mockReturnValue({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' });
  h.updateStatus.mockResolvedValue(undefined);
  h.ensureCertificate.mockResolvedValue('current');
  h.createSdjwt.mockImplementation(async (_claims, issuer, signer) => ({
    combined: `${await signer({ iss: issuer, exp: 1000 })}~d~`,
  }));
  sign = vi.fn(async () => ({ token: 'h.p.s' }));
  keyManagerGet = vi.fn(() => ({ signSDJWTIssuerRpc: sign }));
  idFromName = vi.fn((name: string) => `id:${name}`);
  env = { KEY_MANAGER: { idFromName, get: keyManagerGet } } as unknown as Env;
});
afterEach(() => {
  vi.useRealTimers();
});

async function call(
  body: unknown = { transaction_id: 'tx-1' },
  auth: string | null = 'Bearer token',
  raw?: string
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/d', deferredCredentialRoute);
  const response = await app.request(
    'https://issuer.example.com/d',
    {
      method: 'POST',
      headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    },
    env
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('deferredCredentialRoute: access', () => {
  it('matches the Bearer scheme case-insensitively (RFC 9110)', async () => {
    h.validateToken.mockResolvedValue({ valid: false });
    for (const auth of ['bearer token', 'BEARER token']) {
      h.validateToken.mockClear();
      expect((await call(undefined, auth)).status).toBe(401);
      expect(h.validateToken).toHaveBeenCalledWith(
        env,
        'token',
        'https://issuer.example.com',
        'tenant-1'
      );
    }
  });

  it('requires a bearer token that validates for this issuer and tenant', async () => {
    for (const auth of [null, 'Basic abc', 'Token t', 'Bearer', 'Bearer ', 'bearer ']) {
      const result = await call(undefined, auth);
      expect(result).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
    }
    expect(h.validateToken).not.toHaveBeenCalled();
    h.validateToken.mockResolvedValue({ valid: false });
    expect((await call()).status).toBe(401);
    expect(h.validateToken).toHaveBeenCalledWith(
      env,
      'token',
      'https://issuer.example.com',
      'tenant-1'
    );
    for (const missing of [
      { valid: true, tenantId: 't' },
      { valid: true, userId: 'u' },
    ]) {
      h.validateToken.mockResolvedValue(missing);
      expect((await call()).status).toBe(401);
    }
  });

  it('refuses a request without a usable transaction id', async () => {
    for (const body of [{}, { transaction_id: '' }, { transaction_id: 5 }, null]) {
      const result = await call(body);
      expect(result).toMatchObject({ status: 400, body: { error: 'invalid_credential_request' } });
      expect(result.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(await call(undefined, 'Bearer token', 'not json')).toMatchObject({
      status: 400,
      body: { error: 'invalid_credential_request' },
    });
  });

  it('looks the transaction up for the user of the token only', async () => {
    h.findDeferred.mockResolvedValue(null);
    const result = await call();
    expect(result).toMatchObject({ status: 400, body: { error: 'invalid_transaction_id' } });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(h.findDeferred).toHaveBeenCalledWith('tenant-1', 'tx-1', 'user-1');
  });
});

describe('deferredCredentialRoute: readiness', () => {
  it.each([
    ['empty claims', { claims: '{}' }, {}],
    ['pending claims', { claims: 'pending' }, {}],
    ['missing claims', { claims: '' }, {}],
    ['null claims', { claims: null }, {}],
    ['claims that parse to nothing', { claims: '{"a":1}' }, {}],
  ])('answers 202 with the poll interval for %s', async (_name, overrides, parsed) => {
    h.findDeferred.mockResolvedValue(deferred(overrides));
    h.parseClaims.mockReturnValue(parsed);
    const result = await call();
    expect(result).toMatchObject({ status: 202, body: { transaction_id: 'tx-1', interval: 5 } });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(h.createSdjwt).not.toHaveBeenCalled();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('refuses a credential type that is unknown or reserved for administrators', async () => {
    for (const credential_type of ['https://example.com/other', ADMIN_VCT]) {
      h.findDeferred.mockResolvedValue(deferred({ credential_type }));
      expect(await call()).toMatchObject({
        status: 400,
        body: { error: 'invalid_transaction_id' },
      });
    }
    expect(h.createSdjwt).not.toHaveBeenCalled();
  });
});

describe('deferredCredentialRoute: issuance', () => {
  it('builds the credential from the stored claims and activates the row', async () => {
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ credentials: [{ credential: 'h.p.s~d~' }] });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');
    expect(h.createSdjwt).toHaveBeenCalledWith(
      { given_name: 'A' },
      'https://issuer.example.com',
      expect.any(Function),
      {
        vct: IDENTITY_VCT,
        selectiveDisclosureClaims: ['given_name', 'family_name', 'email', 'birthdate'],
        holderBinding: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        expiresAt: NOW_MS / 1000 + 365 * 86400,
      }
    );
    expect(h.updateStatus).toHaveBeenCalledWith('tenant-1', 'tx-1', 'active');
  });

  it('signs with the key manager of the credential row and prepares its certificate', async () => {
    await call();
    expect(idFromName).toHaveBeenCalledWith('tenant-1-v3');
    expect(h.ensureCertificate).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ signSDJWTIssuerRpc: sign }),
      'https://issuer.example.com',
      'tenant-1',
      NOW_MS,
      1_000_000
    );
    expect(keyManagerGet).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledWith({ iss: 'https://issuer.example.com', exp: 1000 });
  });

  it('leaves the certificate step out without an iss and passes no expiry without an exp', async () => {
    h.createSdjwt.mockImplementation(async (_c, _i, signer) => ({
      combined: `${await signer({})}~`,
    }));
    await call();
    expect(h.ensureCertificate).not.toHaveBeenCalled();
    h.createSdjwt.mockImplementation(async (_c, _i, signer) => ({
      combined: `${await signer({ iss: 'x' })}~`,
    }));
    await call();
    expect(h.ensureCertificate.mock.calls[0][5]).toBeUndefined();
  });

  it('answers 500 without detail when issuance fails, and does not activate the row', async () => {
    sign.mockRejectedValue(new Error('km down'));
    const result = await call();
    expect(result).toMatchObject({ status: 500, body: { error: 'server_error' } });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      'Deferred credential retrieval failed',
      {},
      expect.objectContaining({ message: 'km down' })
    );
  });
});

describe('vciNonceRoute', () => {
  let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };

  async function nonce(configured?: string) {
    stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
    stub.fetch.mockResolvedValue(new Response('{}'));
    h.generateProofNonce.mockResolvedValue({ nonce: 'n-1', nonceId: 'id-1', stub });
    h.sha.mockResolvedValue('hash-1');
    env = { C_NONCE_EXPIRY_SECONDS: configured } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.get('/n', vciNonceRoute);
    const response = await app.request('https://issuer.example.com/n', {}, env);
    return response;
  }
  const created = async () =>
    (await (stub.fetch.mock.calls[0][0] as Request).json()) as Record<string, unknown>;

  it('returns the nonce uncached and stores its hash for the tenant', async () => {
    const response = await nonce();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ c_nonce: 'n-1' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(h.generateProofNonce).toHaveBeenCalledWith(env, 'tenant-1');
    expect(h.sha).toHaveBeenCalledWith('n-1');
    const request = stub.fetch.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe('/nonce/create');
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(await created()).toEqual({
      id: 'id-1',
      tenantId: 'tenant-1',
      nonceHash: 'hash-1',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 300_000,
    });
  });

  it.each([
    ['1', 1],
    ['3600', 3600],
    ['3601', 300],
    ['0', 300],
    ['-1', 300],
    ['1.5', 300],
    ['abc', 300],
    [undefined, 300],
  ])('reads the lifetime setting %s as %s seconds', async (configured, seconds) => {
    await nonce(configured);
    expect((await created()).expiresAt).toBe(NOW_MS + seconds * 1000);
  });

  it('fails when the store does not accept the nonce', async () => {
    stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
    stub.fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    h.generateProofNonce.mockResolvedValue({ nonce: 'n-1', nonceId: 'id-1', stub });
    h.sha.mockResolvedValue('hash-1');
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error) => new Response(error.message, { status: 500 }));
    app.get('/n', vciNonceRoute);
    const response = await app.request(
      'https://issuer.example.com/n',
      {},
      { C_NONCE_EXPIRY_SECONDS: '300' }
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('vci_nonce_create_failed');
  });
});
