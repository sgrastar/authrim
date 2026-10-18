/**
 * POST /device_authorization over a real Hono app: the real client authentication, scope check
 * and rate limiter (RateLimiterCounter), with the client registry and the DeviceCodeStore stubbed.
 * Each test file mocks `getClientCached` to read `deviceClients` (see the files that use this).
 */
import { Hono } from 'hono';
import { vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import {
  buildPolicyConstrainedRegionShardConfig,
  buildRegionShardConfigKvKey,
  hashClientSecret,
  type Env,
} from '@authrim/ar-lib-core';
import { deviceAuthorizationHandler } from '../device-authorization';
import { realRateLimiter, type RealRateLimiter } from './real-rate-limiter';

export const ISSUER = 'https://auth.example.com';
export const SECRET = 'a-long-random-client-secret';

/**
 * The client registry the mocked `getClientCached` reads, and the logger it returns. They live on
 * globalThis because the `vi.mock` factory of ar-lib-core cannot import this module (this module
 * imports the handler, which imports ar-lib-core: the factory would wait for itself).
 */
const shared = globalThis as unknown as {
  __deviceClients?: Map<string, Record<string, unknown>>;
  __deviceLogger?: Record<string, ReturnType<typeof vi.fn>>;
};
export const deviceClients = (shared.__deviceClients ??= new Map());
export const silentLogger = (shared.__deviceLogger ??= {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  module: vi.fn().mockReturnThis(),
  startTimer: vi.fn().mockReturnValue(() => {}),
});

export const FORM = 'application/x-www-form-urlencoded';

export interface Harness {
  /** The device code records the store received. */
  stored: Array<Record<string, any>>;
  limiter: RealRateLimiter;
  env: Record<string, unknown>;
  post: (
    body: string | Record<string, string>,
    options?: { headers?: Record<string, string>; ip?: string; stream?: ReadableStream<Uint8Array> }
  ) => Promise<{ response: Response; body: Record<string, any> }>;
}

export function harness(envOverrides: Record<string, unknown> = {}): Harness {
  const stored: Array<Record<string, any>> = [];
  const limiter = realRateLimiter();
  const jtis = new Set<string>();
  const env = {
    ISSUER_URL: ISSUER,
    UI_URL: 'https://ui.example.com',
    SETTINGS: { get: vi.fn(async () => null) },
    DEVICE_CODE_STORE: {
      idFromName: () => 'device-store',
      get: () => ({
        fetch: async (request: Request) => {
          stored.push((await request.json()) as Record<string, any>);
          return Response.json({ success: true });
        },
      }),
    },
    // the region shard config the assertion replay store is placed by
    AUTHRIM_CONFIG: {
      get: async (key: string) =>
        key === buildRegionShardConfigKvKey('default')
          ? buildPolicyConstrainedRegionShardConfig({
              residency: {
                version: 1,
                residencyPolicyId: 'test-policy',
                residencyPartition: 'test',
                policyGeneration: 1,
                allowedRegions: ['apac', 'enam', 'weur'],
                jurisdiction: null,
              },
            })
          : null,
    },
    // client assertion replay protection: a jti is accepted once
    DPOP_JTI_STORE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const { jti } = JSON.parse(String(init.body)) as { jti: string };
          if (jtis.has(jti)) return Response.json({ error: 'replay' }, { status: 400 });
          jtis.add(jti);
          return Response.json({ success: true });
        },
      }),
    },
    RATE_LIMITER: limiter.namespace,
    ...envOverrides,
  } as Record<string, unknown>;

  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', 'default');
    await next();
  });
  app.post('/device_authorization', deviceAuthorizationHandler);

  return {
    stored,
    limiter,
    env,
    post: async (body, options = {}) => {
      const response = await app.request(
        `${ISSUER}/device_authorization`,
        {
          method: 'POST',
          headers: {
            'Content-Type': FORM,
            'CF-Connecting-IP': options.ip ?? '203.0.113.9',
            ...options.headers,
          },
          body:
            options.stream ??
            (typeof body === 'string' ? body : new URLSearchParams(body).toString()),
          ...(options.stream ? { duplex: 'half' } : {}),
        } as RequestInit,
        env
      );
      const text = await response.clone().text();
      return { response, body: text ? JSON.parse(text) : {} };
    },
  };
}

export async function registerClient(
  clientId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  deviceClients.set(clientId, { client_id: clientId, ...metadata });
}

/** A client that authenticates with a secret, by the given method. */
export async function registerSecretClient(
  clientId: string,
  method: 'client_secret_basic' | 'client_secret_post' | undefined = 'client_secret_post',
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await registerClient(clientId, {
    client_secret_hash: await hashClientSecret(SECRET),
    ...(method ? { token_endpoint_auth_method: method } : {}),
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
    ...metadata,
  });
}

export const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/** A private_key_jwt client; `assert` signs an assertion for it (or with another key). */
export async function registerJwtClient(clientId: string) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: 'k1' };
  await registerClient(clientId, {
    token_endpoint_auth_method: 'private_key_jwt',
    jwks: { keys: [jwk] },
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
  });
  let counter = 0;
  const assert = (options: { audience?: string; wrongKey?: boolean; jti?: string } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(options.audience ?? `${ISSUER}/device_authorization`)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(options.jti ?? `jti-${clientId}-${++counter}`)
      .sign(options.wrongKey ? other.privateKey : privateKey);
  };
  return { assert };
}

export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
