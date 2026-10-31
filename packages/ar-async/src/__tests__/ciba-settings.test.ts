/**
 * /bc-authorize with the tenant's CIBA settings (`ciba.*`): request lifetime, polling interval
 * and binding message limits. The settings come from the real settings reader over a KV stub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';
import { cibaAuthorizationHandler } from '../ciba-authorization';

const mockGetClient = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  module: vi.fn().mockReturnThis(),
  startTimer: vi.fn().mockReturnValue(() => {}),
}));
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getClientCached: vi
      .fn()
      .mockImplementation((_c, env, clientId) => mockGetClient(env, clientId)),
    getLogger: () => mockLogger,
    publishEvent: vi.fn().mockResolvedValue(undefined),
  };
});

const ISSUER = 'https://auth.example.com';
const CIBA_KEY = 'settings:tenant:default:ciba';
const CLIENT_SECRET_HASH = '3269ad7c6e3e2fe0a25f942328a6099e42978ee9c3d4f55bc222f7520a40d044';

function clientMetadata(overrides: Record<string, unknown> = {}) {
  return {
    client_id: 'ciba-client',
    grant_types: ['urn:openid:params:grant-type:ciba'],
    backchannel_token_delivery_mode: 'poll',
    client_secret_hash: CLIENT_SECRET_HASH,
    token_endpoint_auth_method: 'client_secret_post',
    ...overrides,
  };
}

const baseRequest = {
  client_id: 'ciba-client',
  client_secret: 'ciba-secret',
  scope: 'openid',
  login_hint: 'user@example.com',
};

describe('/bc-authorize with CIBA settings', () => {
  const stored = new Map<string, CIBARequestMetadata>();
  let cibaDocument: (() => Promise<string | null>) | null;
  let storeFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.clear();
    cibaDocument = null;
    mockGetClient.mockResolvedValue(clientMetadata());
    storeFetch = vi.fn(async (request: Request) => {
      const metadata = (await request.json()) as CIBARequestMetadata;
      stored.set(metadata.auth_req_id, metadata);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
  });

  function settings(values: Record<string, unknown> | null) {
    cibaDocument = values === null ? null : async () => JSON.stringify(values);
  }

  async function post(body: Record<string, unknown>, env: Record<string, unknown> = {}) {
    const kv = {
      get: vi.fn(async (key: string) => (key === CIBA_KEY && cibaDocument ? cibaDocument() : null)),
    } as unknown as KVNamespace;
    const c = {
      req: {
        parseBody: vi.fn().mockResolvedValue(body),
        header: vi.fn().mockReturnValue(undefined),
      },
      json: vi.fn((data: unknown, status = 200) => new Response(JSON.stringify(data), { status })),
      env: {
        ISSUER_URL: ISSUER,
        SETTINGS: kv,
        CIBA_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue('store-id'),
          get: vi.fn().mockReturnValue({ fetch: storeFetch }),
        },
        ...env,
      } as unknown as Env,
    } as never;
    const response = await cibaAuthorizationHandler(c);
    return { response, body: (await response.json()) as Record<string, any> };
  }

  const onlyStored = () => [...stored.values()][0] as CIBARequestMetadata;

  describe('with the default settings (nothing saved)', () => {
    it('answers and stores what the endpoint always did', async () => {
      const before = Date.now();
      const { response, body } = await post(baseRequest);

      expect(response.status).toBe(200);
      expect(body.expires_in).toBe(300);
      expect(body.interval).toBe(5);
      expect(Object.keys(body).sort()).toEqual(['auth_req_id', 'expires_in', 'interval']);
      const record = onlyStored();
      expect(record.interval).toBe(5);
      expect(record.max_interval).toBe(60);
      expect(record.expires_at - record.created_at).toBe(300_000);
      expect(record.created_at).toBeGreaterThanOrEqual(before);
    });

    it.each([
      [undefined, 300],
      [30, 60],
      [60, 60],
      [150, 150],
      [600, 600],
      [601, 600],
      [86_400, 600],
    ])('requested_expiry %s gives an expires_in of %s', async (requested_expiry, expected) => {
      const { body } = await post({ ...baseRequest, requested_expiry });
      expect(body.expires_in).toBe(expected);
    });

    it('accepts a binding_message of 140 and refuses one of 141', async () => {
      expect(
        (await post({ ...baseRequest, binding_message: 'a'.repeat(140) })).response.status
      ).toBe(200);
      const refused = await post({ ...baseRequest, binding_message: 'a'.repeat(141) });
      expect(refused.response.status).toBe(400);
      expect(refused.body.error).toBe('invalid_binding_message');
    });

    it('does not require a binding_message', async () => {
      expect((await post(baseRequest)).response.status).toBe(200);
    });
  });

  describe('lifetime', () => {
    it('uses ciba.expires_in when the client sends no requested_expiry', async () => {
      settings({ 'ciba.expires_in': 120 });
      const { body } = await post(baseRequest);

      expect(body.expires_in).toBe(120);
      expect(onlyStored().expires_at - onlyStored().created_at).toBe(120_000);
    });

    it('clamps a requested_expiry into the tenant bounds, both ways', async () => {
      settings({ 'ciba.min_expires_in': 90, 'ciba.max_expires_in': 200 });

      expect((await post({ ...baseRequest, requested_expiry: 30 })).body.expires_in).toBe(90);
      expect((await post({ ...baseRequest, requested_expiry: 150 })).body.expires_in).toBe(150);
      expect((await post({ ...baseRequest, requested_expiry: 5000 })).body.expires_in).toBe(200);
    });

    it('lets a tenant allow a lifetime above the old ceiling', async () => {
      settings({ 'ciba.max_expires_in': 1800 });
      const { body } = await post({ ...baseRequest, requested_expiry: 1200 });

      expect(body.expires_in).toBe(1200);
      expect(onlyStored().expires_at - onlyStored().created_at).toBe(1_200_000);
    });

    it('clamps the default lifetime into the bounds', async () => {
      settings({ 'ciba.min_expires_in': 400 });
      expect((await post(baseRequest)).body.expires_in).toBe(400);
    });
  });

  describe('interval', () => {
    it('returns and stores ciba.poll_interval, with the tenant maximum for slow_down', async () => {
      settings({ 'ciba.poll_interval': 15, 'ciba.max_interval': 25 });
      const { body } = await post(baseRequest);

      expect(body.interval).toBe(15);
      expect(onlyStored()).toMatchObject({ interval: 15, max_interval: 25 });
    });

    it('keeps the interval inside the tenant bounds', async () => {
      settings({ 'ciba.min_interval': 10 });
      expect((await post(baseRequest)).body.interval).toBe(10);

      stored.clear();
      settings({ 'ciba.poll_interval': 50, 'ciba.max_interval': 30 });
      expect((await post(baseRequest)).body.interval).toBe(30);
    });

    it('does not return an interval to a ping client', async () => {
      settings({ 'ciba.poll_interval': 15 });
      mockGetClient.mockResolvedValue(
        clientMetadata({
          backchannel_token_delivery_mode: 'ping',
          backchannel_client_notification_endpoint: 'https://client.example.com/notify',
        })
      );
      const { response, body } = await post({
        ...baseRequest,
        client_notification_token: 'notification-token',
      });

      expect(response.status).toBe(200);
      expect(body.interval).toBeUndefined();
      expect(onlyStored().interval).toBe(15);
    });
  });

  describe('binding message', () => {
    it('limits the length to ciba.max_binding_message_length, at n and n + 1', async () => {
      settings({ 'ciba.max_binding_message_length': 50 });

      expect(
        (await post({ ...baseRequest, binding_message: 'a'.repeat(50) })).response.status
      ).toBe(200);
      stored.clear();
      const refused = await post({ ...baseRequest, binding_message: 'a'.repeat(51) });
      expect(refused.response.status).toBe(400);
      expect(refused.body).toMatchObject({ error: 'invalid_binding_message' });
      expect(refused.body.error_description).toContain('max 50');
      expect(stored.size).toBe(0);
    });

    it('counts UTF-16 code units, so an emoji is two', async () => {
      settings({ 'ciba.max_binding_message_length': 50 });

      expect(
        (await post({ ...baseRequest, binding_message: '😀'.repeat(25) })).response.status
      ).toBe(200);
      expect(
        (await post({ ...baseRequest, binding_message: '😀'.repeat(26) })).response.status
      ).toBe(400);
    });

    it('keeps a whitespace-only binding_message valid when none is required', async () => {
      expect((await post({ ...baseRequest, binding_message: '   ' })).response.status).toBe(200);
    });

    it('accepts a longer message when the tenant allows it', async () => {
      settings({ 'ciba.max_binding_message_length': 300 });
      expect(
        (await post({ ...baseRequest, binding_message: 'a'.repeat(300) })).response.status
      ).toBe(200);
    });

    it('refuses a request without a binding_message when ciba.binding_message_required is on', async () => {
      settings({ 'ciba.binding_message_required': true });

      const missing = await post(baseRequest);
      expect(missing.response.status).toBe(400);
      expect(missing.body).toEqual({
        error: 'invalid_binding_message',
        error_description: 'binding_message is required',
      });
      expect(stored.size).toBe(0);

      for (const blank of ['', '   ', '\n']) {
        const empty = await post({ ...baseRequest, binding_message: blank });
        expect(empty.response.status, JSON.stringify(blank)).toBe(400);
        expect(empty.body).toEqual({
          error: 'invalid_binding_message',
          error_description: 'binding_message is required',
        });
        expect(stored.size).toBe(0);
      }

      expect((await post({ ...baseRequest, binding_message: '1234' })).response.status).toBe(200);
      expect(stored.size).toBe(1);
    });

    it('applies the same rules to the parameters of a signed request object', async () => {
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
      mockGetClient.mockResolvedValue(
        clientMetadata({
          backchannel_authentication_request_signing_alg: 'ES256',
          jwks: { keys: [jwk] },
        })
      );
      const sign = (claims: Record<string, unknown>) =>
        new SignJWT({ scope: 'openid', login_hint: 'user@example.com', ...claims })
          .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
          .setIssuer('ciba-client')
          .setAudience(ISSUER)
          .setIssuedAt()
          .setNotBefore('0s')
          .setExpirationTime('5m')
          .setJti(crypto.randomUUID())
          .sign(privateKey);
      const send = async (claims: Record<string, unknown>) =>
        post({
          client_id: 'ciba-client',
          client_secret: 'ciba-secret',
          request: await sign(claims),
        });

      settings({ 'ciba.binding_message_required': true, 'ciba.max_binding_message_length': 50 });

      const missing = await send({});
      expect(missing.response.status).toBe(400);
      expect(missing.body.error).toBe('invalid_binding_message');
      expect((await send({ binding_message: 'a'.repeat(51) })).body.error).toBe(
        'invalid_binding_message'
      );
      expect(stored.size).toBe(0);
      expect((await send({ binding_message: 'a'.repeat(50) })).response.status).toBe(200);
    });
  });

  describe('polling limits kept on the request', () => {
    it('stores the default slow_down increment and poll count, which are the constants', async () => {
      await post(baseRequest);

      expect(onlyStored()).toMatchObject({ slow_down_increment: 5, max_poll_count: 120 });
    });

    it('stores the tenant slow_down increment and poll count', async () => {
      settings({ 'ciba.slow_down_increment': 12, 'ciba.max_poll_count': 300 });
      await post(baseRequest);

      expect(onlyStored()).toMatchObject({ slow_down_increment: 12, max_poll_count: 300 });
    });

    it('stores a value outside the ranges as the default, and an increment below 5 never', async () => {
      for (const [increment, count] of [
        [4, 9],
        [1, 501],
        [31, 'many'],
        [5.5, 100.5],
      ]) {
        stored.clear();
        settings({ 'ciba.slow_down_increment': increment, 'ciba.max_poll_count': count });
        await post(baseRequest);

        expect(onlyStored(), `${increment}, ${count}`).toMatchObject({
          slow_down_increment: 5,
          max_poll_count: 120,
        });
      }
    });

    it('stores them for a ping client too: the record is the same shape', async () => {
      settings({ 'ciba.slow_down_increment': 9 });
      mockGetClient.mockResolvedValue(
        clientMetadata({
          backchannel_token_delivery_mode: 'ping',
          backchannel_client_notification_endpoint: 'https://client.example.com/notify',
        })
      );
      await post({ ...baseRequest, client_notification_token: 'notification-token' });

      expect(onlyStored().slow_down_increment).toBe(9);
    });
  });

  describe('user_code (ciba.user_code_enabled)', () => {
    const withUserCode = { ...baseRequest, user_code: 'SECRET-1', binding_message: '1234' };

    async function signedRequest(claims: Record<string, unknown>) {
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
      mockGetClient.mockResolvedValue(
        clientMetadata({
          backchannel_authentication_request_signing_alg: 'ES256',
          jwks: { keys: [jwk] },
        })
      );
      return new SignJWT({ scope: 'openid', login_hint: 'user@example.com', ...claims })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer('ciba-client')
        .setAudience(ISSUER)
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime('5m')
        .setJti(crypto.randomUUID())
        .sign(privateKey);
    }

    describe('while it is off, which is the default', () => {
      it('refuses a request that carries a user_code, and stores nothing', async () => {
        const { response, body } = await post(withUserCode);

        expect(response.status).toBe(400);
        expect(body).toEqual({
          error: 'invalid_request',
          error_description: 'user_code is not supported',
        });
        expect(stored.size).toBe(0);
        expect(storeFetch).not.toHaveBeenCalled();
      });

      it('refuses it when the tenant saved the switch off explicitly', async () => {
        settings({ 'ciba.user_code_enabled': false });

        expect((await post(withUserCode)).response.status).toBe(400);
      });

      it('refuses a user_code inside a signed request object', async () => {
        const request = await signedRequest({ user_code: 'SECRET-1' });
        const { response, body } = await post({
          client_id: 'ciba-client',
          client_secret: 'ciba-secret',
          request,
        });

        expect(response.status).toBe(400);
        expect(body).toEqual({
          error: 'invalid_request',
          error_description: 'user_code is not supported',
        });
        expect(stored.size).toBe(0);
      });

      it('refuses a user_code that is not a string, in the signed request object', async () => {
        const request = await signedRequest({ user_code: 123456 });
        const { response, body } = await post({
          client_id: 'ciba-client',
          client_secret: 'ciba-secret',
          request,
        });

        expect(response.status).toBe(400);
        expect(body.error_description).toBe('user_code is not supported');
      });

      it('still accepts a signed request object without one', async () => {
        const request = await signedRequest({ binding_message: '1234' });
        const { response } = await post({
          client_id: 'ciba-client',
          client_secret: 'ciba-secret',
          request,
        });

        expect(response.status).toBe(200);
      });

      it('accepts a request without a user_code, or with an empty one', async () => {
        expect((await post(baseRequest)).response.status).toBe(200);
        stored.clear();
        expect((await post({ ...baseRequest, user_code: '' })).response.status).toBe(200);
        expect(stored.size).toBe(1);
      });

      it('still generates the display code for a binding_message: that is not the parameter', async () => {
        const { response } = await post({ ...baseRequest, binding_message: '1234' });

        expect(response.status).toBe(200);
        expect(onlyStored().user_code).toMatch(/\S+/);
      });
    });

    describe('while it is on', () => {
      beforeEach(() => settings({ 'ciba.user_code_enabled': true }));

      it('accepts the user_code and stores it for the approver', async () => {
        const { response } = await post(withUserCode);

        expect(response.status).toBe(200);
        expect(onlyStored().user_code).toBe('SECRET-1');
      });

      it('accepts a user_code inside a signed request object', async () => {
        const request = await signedRequest({ user_code: 'SECRET-2', binding_message: '1234' });
        const { response } = await post({
          client_id: 'ciba-client',
          client_secret: 'ciba-secret',
          request,
        });

        expect(response.status).toBe(200);
        expect(onlyStored().user_code).toBe('SECRET-2');
      });
    });

    it('is taken from the environment as the deployment default, and a stored value beats it', async () => {
      expect((await post(withUserCode, { ENABLE_CIBA_USER_CODE: 'true' })).response.status).toBe(
        200
      );
      stored.clear();
      settings({ 'ciba.user_code_enabled': false });
      expect((await post(withUserCode, { ENABLE_CIBA_USER_CODE: 'true' })).response.status).toBe(
        400
      );
    });

    it('is not checked before the settings can be read: unreadable settings are a 503', async () => {
      cibaDocument = async () => {
        throw new Error('KV unavailable');
      };

      expect((await post(withUserCode)).response.status).toBe(503);
    });
  });

  describe('settings that cannot be used', () => {
    it('falls back per value, and to the defaults of a pair the wrong way round', async () => {
      settings({
        'ciba.expires_in': 'soon',
        'ciba.min_interval': 40,
        'ciba.max_interval': 10,
        'ciba.poll_interval': 7,
      });
      const { body } = await post(baseRequest);

      expect(body.expires_in).toBe(300);
      expect(body.interval).toBe(7);
      expect(onlyStored().max_interval).toBe(60);
    });

    it('refuses with 503 when the CIBA settings cannot be read, and stores nothing', async () => {
      cibaDocument = async () => {
        throw new Error('KV unavailable');
      };
      const { response, body } = await post({ ...baseRequest, binding_message: 'x' });

      expect(response.status).toBe(503);
      expect(body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'CIBA settings are temporarily unavailable',
      });
      expect(storeFetch).not.toHaveBeenCalled();
      expect(stored.size).toBe(0);
    });

    it('does not fall back to a looser binding_message rule when the settings are unreadable', async () => {
      cibaDocument = async () => {
        throw new Error('KV unavailable');
      };
      const { response } = await post(baseRequest);

      expect(response.status).toBe(503);
      expect(stored.size).toBe(0);
    });

    it('treats a settings document that is not JSON as unreadable', async () => {
      cibaDocument = async () => '{not json';
      const { response } = await post(baseRequest);

      expect(response.status).toBe(503);
      expect(stored.size).toBe(0);
    });
  });
});
