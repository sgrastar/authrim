/**
 * Client Credentials grant (token.ts handleClientCredentialsGrant): the scope and audience
 * granted, DPoP and certificate sender constraint, the access token claims, the issued event and
 * the response headers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TestClientMetadata } from './helpers/fixtures';
import type { Harness } from './helpers/mut-nativesso-harness';
import { contextHeader } from './helpers/mut-nativesso-fixtures';
import {
  CLIENT_ID,
  requestClientCredentials,
  setupM2MClient,
} from './helpers/mut-clientcreds-fixtures';

const mocks = await vi.hoisted(async () => {
  const { createHarnessMocks } = await import('./helpers/mut-nativesso-harness');
  return createHarnessMocks();
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const { arLibCoreMock } = await import('./helpers/mut-nativesso-harness');
  return arLibCoreMock(await importOriginal(), mocks);
});

vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  importPKCS8: vi.fn().mockResolvedValue({ type: 'private' }),
  importJWK: vi.fn().mockResolvedValue({ type: 'public' }),
}));

import { tokenHandler } from '../token';
import { setupHarness } from './helpers/mut-nativesso-harness';

// A DER-shaped test certificate (only its bytes are hashed) and the client registering it.
const CERTIFICATE_B64 = btoa('test-client-certificate-der');

/** RFC 8705 x5t#S256: the base64url SHA-256 of the DER certificate. */
async function certificateThumbprint(certificateB64: string): Promise<string> {
  const der = Uint8Array.from(atob(certificateB64), (char) => char.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

describe('Client Credentials grant: issued access token', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness(mocks);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const setupClient = (overrides: Partial<TestClientMetadata> = {}) =>
    setupM2MClient(mocks, overrides);
  const request = (
    overrides: Record<string, string | undefined> = {},
    options: { env?: Record<string, unknown>; headers?: Record<string, string> } = {}
  ) => requestClientCredentials(harness, tokenHandler, overrides, options);
  const claims = () => mocks.mockCreateAccessToken.mock.calls[0][0] as Record<string, unknown>;

  describe('scope', () => {
    it('grants openid by default to a client without a default scope or a scope policy', async () => {
      setupClient({ default_scope: undefined, allowed_scopes: undefined });

      const { response, body } = await request({ scope: undefined });

      expect(response.status).toBe(200);
      expect(body.scope).toBe('openid');
    });

    it('grants any requested scope to a client without a scope policy', async () => {
      setupClient({ allowed_scopes: undefined });

      const { body } = await request({ scope: 'api:custom reports:read' });

      expect(body.scope).toBe('api:custom reports:read');
      expect(claims().scope).toBe('api:custom reports:read');
    });

    it('keeps the requested scopes within the client policy, space separated', async () => {
      setupClient();

      const { body } = await request({ scope: 'api:read api:write api:delete' });

      expect(body.scope).toBe('api:read api:write');
    });
  });

  describe('sender constraint', () => {
    it('issues a bearer token with no confirmation claim without DPoP or a certificate', async () => {
      setupClient();

      const { body } = await request();

      expect(body.token_type).toBe('Bearer');
      expect(Object.keys(claims())).not.toContain('cnf');
    });

    it('binds only the DPoP key when only a DPoP proof is presented', async () => {
      setupClient();
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'm2m-jkt' });

      const { body } = await request();

      expect(body.token_type).toBe('DPoP');
      expect(claims().cnf).toStrictEqual({ jkt: 'm2m-jkt' });
    });

    it('binds only the certificate thumbprint for a certificate-bound client', async () => {
      setupClient({
        tls_client_certificate_bound_access_tokens: true,
        jwks: { keys: [{ kty: 'RSA', x5c: [CERTIFICATE_B64] }] },
      } as Record<string, unknown>);
      const ctx = { tlsClientAuth: { certPresented: '1', certRFC9440: `:${CERTIFICATE_B64}:` } };
      // The handler reads the certificate from `c.req.raw.cf`, which the mock context's Request
      // does not carry: define it on the prototype for this request, then put back what was there.
      const original = Request.prototype;
      const previous = Object.getOwnPropertyDescriptor(original, 'cf');
      Object.defineProperty(original, 'cf', { configurable: true, get: () => ctx });
      try {
        const { response } = await request();
        expect(response.status).toBe(200);
      } finally {
        if (previous) Object.defineProperty(original, 'cf', previous);
        else delete (original as unknown as { cf?: unknown }).cf;
      }

      const cnf = claims().cnf as Record<string, unknown>;
      expect(Object.keys(cnf)).toEqual(['x5t#S256']);
      expect(cnf['x5t#S256']).toBe(await certificateThumbprint(CERTIFICATE_B64));
    });

    it('applies the nonce policy of the requested resource to a DPoP nonce error', async () => {
      setupClient();
      harness.setSystemSettings({
        security: { dpop_nonce_resource_overrides: { 'svc://m2m-api': false } },
      });
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: false, error: 'use_dpop_nonce' });

      const withResource = await request({ resource: 'svc://m2m-api' });
      const withoutResource = await request();

      expect(withResource.body.error).toBe('invalid_dpop_proof');
      expect(withoutResource.body.error).toBe('use_dpop_nonce');
      expect(withoutResource.response.headers.get('DPoP-Nonce')).toBeTruthy();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });
  });

  it('fails without issuing when the signing key cannot be loaded', async () => {
    setupClient();
    harness.mockEnv.AUTHRIM_CONFIG.get = vi.fn(async (key: string) =>
      key.startsWith('v1:key-version:') ? `rotated-${Math.random()}` : null
    );
    (harness.mockEnv as unknown as { KEY_MANAGER?: unknown }).KEY_MANAGER = undefined;

    const { response, body } = await request();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'server_error',
      error_description: 'Failed to load signing key',
    });
    expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
  });

  it('names the client as the subject, publishes the issued event and answers uncached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    setupClient();

    const { ctx, response, body } = await request({ scope: 'api:read api:write' });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      access_token: 'mock-access-token',
      token_type: 'Bearer',
      expires_in: 1800,
      scope: 'api:read api:write',
    });
    expect(claims()).toMatchObject({ sub: `client:${CLIENT_ID}`, client_id: CLIENT_ID });
    expect(mocks.mockPublishEvent).toHaveBeenCalledWith(expect.anything(), {
      type: 'token.access.issued',
      tenantId: 'default',
      data: {
        jti: 'at-jti-001',
        clientId: CLIENT_ID,
        userId: `client:${CLIENT_ID}`,
        scopes: ['api:read', 'api:write'],
        expiresAt: now + 1800,
        grantType: 'client_credentials',
      },
    });
    expect(contextHeader(ctx, 'Cache-Control')).toBe('no-store');
    expect(contextHeader(ctx, 'Pragma')).toBe('no-cache');
  });
});
