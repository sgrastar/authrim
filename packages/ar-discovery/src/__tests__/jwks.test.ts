import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { jwksHandler } from '../jwks';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { generateKeySet } from '@authrim/ar-lib-core/utils/keys';
import type { JWK } from 'jose';

let primaryJwk: JWK;
let secondaryJwk: JWK;
let fallbackJwk: JWK;

function createKeyManager(keys: JWK[] | Promise<JWK[]>) {
  const getAllPublicKeysRpc = vi.fn(async () => keys);
  const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
  const get = vi.fn(() => ({ getAllPublicKeysRpc }));

  return {
    namespace: {
      idFromName,
      get,
    } as unknown as Env['KEY_MANAGER'],
    idFromName,
    get,
    getAllPublicKeysRpc,
  };
}

function createFailingKeyManager(error: Error) {
  const getAllPublicKeysRpc = vi.fn(async () => {
    throw error;
  });
  const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
  const get = vi.fn(() => ({ getAllPublicKeysRpc }));

  return {
    namespace: {
      idFromName,
      get,
    } as unknown as Env['KEY_MANAGER'],
    idFromName,
    get,
    getAllPublicKeysRpc,
  };
}

function createMockEnv(options: {
  keyManager?: Env['KEY_MANAGER'];
  publicJWK?: JWK;
  publicJWKJson?: string;
}): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    PUBLIC_JWK_JSON:
      options.publicJWKJson ?? (options.publicJWK ? JSON.stringify(options.publicJWK) : undefined),
    KEY_MANAGER: options.keyManager,
  } as Env;
}

function createApp(tenantId = 'default') {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as { set: (key: string, value: string) => void }).set('tenantId', tenantId);
    await next();
  });
  app.get('/.well-known/jwks.json', jwksHandler);
  return app;
}

describe('JWKS Handler', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeAll(async () => {
    primaryJwk = (await generateKeySet('primary-key', 2048)).publicJWK;
    secondaryJwk = (await generateKeySet('secondary-key', 2048)).publicJWK;
    fallbackJwk = (await generateKeySet('fallback-key', 2048)).publicJWK;
  });

  beforeEach(() => {
    app = createApp();
  });

  it('returns active public keys from KeyManager', async () => {
    const keyManager = createKeyManager([primaryJwk, secondaryJwk]);
    const response = await app.request(
      '/.well-known/jwks.json',
      { method: 'GET' },
      createMockEnv({
        keyManager: keyManager.namespace,
        publicJWK: fallbackJwk,
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toContain('max-age=300');
    expect(response.headers.get('Vary')).toContain('Accept-Encoding');

    const jwks = (await response.json()) as { keys: JWK[] };
    expect(jwks.keys.map((key) => key.kid)).toEqual(['primary-key', 'secondary-key']);
    expect(jwks.keys.map((key) => key.kid)).not.toContain('fallback-key');
    expect(keyManager.idFromName).toHaveBeenCalledWith('default-v3');
    expect(keyManager.get).toHaveBeenCalledTimes(1);
    expect(keyManager.getAllPublicKeysRpc).toHaveBeenCalledTimes(1);
  });

  it('uses tenant context to select the KeyManager instance', async () => {
    const tenantApp = createApp('tenant-a');
    const keyManager = createKeyManager([primaryJwk]);

    await tenantApp.request(
      '/.well-known/jwks.json',
      { method: 'GET' },
      createMockEnv({ keyManager: keyManager.namespace })
    );

    expect(keyManager.idFromName).toHaveBeenCalledWith('tenant-a-v3');
  });

  it('falls back to PUBLIC_JWK_JSON when KeyManager returns no keys', async () => {
    const keyManager = createKeyManager([]);
    const response = await app.request(
      '/.well-known/jwks.json',
      { method: 'GET' },
      createMockEnv({
        keyManager: keyManager.namespace,
        publicJWK: fallbackJwk,
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('max-age=3600');

    const jwks = (await response.json()) as { keys: JWK[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe('fallback-key');
  });

  it('falls back to PUBLIC_JWK_JSON when KeyManager RPC fails', async () => {
    const keyManager = createFailingKeyManager(new Error('key manager unavailable'));
    const response = await app.request(
      '/.well-known/jwks.json',
      { method: 'GET' },
      createMockEnv({
        keyManager: keyManager.namespace,
        publicJWK: fallbackJwk,
      })
    );

    expect(response.status).toBe(200);
    const jwks = (await response.json()) as { keys: JWK[] };
    expect(jwks.keys[0]?.kid).toBe('fallback-key');
  });

  it('returns an empty key set when neither KeyManager nor fallback keys are available', async () => {
    const keyManager = createKeyManager([]);
    const response = await app.request(
      '/.well-known/jwks.json',
      { method: 'GET' },
      createMockEnv({ keyManager: keyManager.namespace })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ keys: [] });
  });

  it('returns a server error when fallback key JSON is invalid', async () => {
    const keyManager = createKeyManager([]);
    const response = await app.request(
      '/.well-known/jwks.json',
      { method: 'GET' },
      createMockEnv({
        keyManager: keyManager.namespace,
        publicJWKJson: 'invalid-json{',
      })
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      error: 'server_error',
      message: 'Failed to generate JWKS',
    });
  });

  it('does not expose private key material in published keys', async () => {
    const keyManager = createKeyManager([primaryJwk]);
    const response = await app.request(
      '/.well-known/jwks.json',
      { method: 'GET' },
      createMockEnv({ keyManager: keyManager.namespace })
    );

    const jwks = (await response.json()) as { keys: Array<Record<string, unknown>> };
    const jwk = jwks.keys[0];

    expect(jwk).toMatchObject({
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid: 'primary-key',
    });
    expect(jwk?.n).toEqual(expect.any(String));
    expect(jwk?.e).toEqual(expect.any(String));
    expect(jwk?.d).toBeUndefined();
    expect(jwk?.p).toBeUndefined();
    expect(jwk?.q).toBeUndefined();
    expect(jwk?.dp).toBeUndefined();
    expect(jwk?.dq).toBeUndefined();
    expect(jwk?.qi).toBeUndefined();
  });
});
