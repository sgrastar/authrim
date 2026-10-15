/**
 * POST /device_authorization with the device flow settings (`device_flow.*`): code lifetime,
 * polling interval and the limits kept on the code. The settings come from the real settings
 * reader over a KV stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, DeviceCodeMetadata } from '@authrim/ar-lib-core';
import { deviceAuthorizationHandler } from '../device-authorization';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    module: vi.fn().mockReturnThis(),
    startTimer: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getClientCached: vi.fn().mockImplementation(() => mocks.getClient()),
    getLogger: () => mocks.logger,
  };
});

const TENANT_KEY = 'settings:tenant:default:device-flow';
const CLIENT_KEY = 'settings:client:default:device-client:device-flow';

describe('/device_authorization with device flow settings', () => {
  const stored: DeviceCodeMetadata[] = [];
  let documents: Record<string, Record<string, unknown> | Error>;
  let kvReads: string[];
  let storeFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stored.length = 0;
    documents = {};
    kvReads = [];
    mocks.getClient.mockReset().mockResolvedValue({ client_id: 'device-client' });
    storeFetch = vi.fn(async (request: Request) => {
      stored.push((await request.json()) as DeviceCodeMetadata);
      return Response.json({ success: true });
    });
  });

  async function post(
    body: Record<string, unknown> = { client_id: 'device-client', scope: 'openid' },
    env: Record<string, unknown> = {}
  ) {
    const kv = {
      get: vi.fn(async (key: string) => {
        kvReads.push(key);
        const document = documents[key];
        if (document instanceof Error) throw document;
        return document ? JSON.stringify(document) : null;
      }),
    } as unknown as KVNamespace;
    const c = {
      req: {
        parseBody: vi.fn().mockResolvedValue(body),
        raw: new Request('https://auth.example.com/device_authorization', { method: 'POST' }),
      },
      json: vi.fn((data: unknown, status = 200, headers?: Record<string, string>) =>
        Response.json(data, { status, headers })
      ),
      env: {
        ISSUER_URL: 'https://auth.example.com',
        UI_URL: 'https://ui.example.com',
        SETTINGS: kv,
        DEVICE_CODE_STORE: {
          idFromName: vi.fn().mockReturnValue('device-store'),
          get: vi.fn().mockReturnValue({ fetch: storeFetch }),
        },
        ...env,
      } as unknown as Env,
    } as never;
    const response = await deviceAuthorizationHandler(c);
    return { response, body: (await response.json()) as Record<string, any> };
  }

  const onlyStored = () => stored[0];

  describe('with the default settings (nothing saved)', () => {
    it('answers what the endpoint always did', async () => {
      const { response, body } = await post();

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual([
        'device_code',
        'expires_in',
        'interval',
        'user_code',
        'verification_uri',
        'verification_uri_complete',
      ]);
      expect(body.expires_in).toBe(600);
      expect(body.interval).toBe(5);
    });

    it('stores the record it always did, plus the limits to keep on the code', async () => {
      const before = Date.now();
      const { body } = await post();

      expect(stored).toHaveLength(1);
      const { created_at, expires_at, device_code, user_code, ...rest } = onlyStored();
      expect(device_code).toBe(body.device_code);
      expect(user_code).toBe(body.user_code);
      expect(created_at).toBeGreaterThanOrEqual(before);
      expect(expires_at - created_at).toBe(600_000);
      expect(rest).toEqual({
        tenant_id: 'default',
        client_id: 'device-client',
        scope: 'openid',
        status: 'pending',
        poll_count: 0,
        interval: 5,
        // added: the governor's limits, equal to the constants it used before
        max_interval: 60,
        slow_down_increment: 5,
        max_poll_count: 120,
      });
    });

    it('reads the tenant document and the client document', async () => {
      await post();
      expect(kvReads).toContain(TENANT_KEY);
      expect(kvReads).toContain(CLIENT_KEY);
    });
  });

  describe('the tenant settings', () => {
    it('set the code lifetime, in the response and on the code', async () => {
      documents[TENANT_KEY] = { 'device_flow.expires_in': 900 };
      const { body } = await post();

      expect(body.expires_in).toBe(900);
      expect(onlyStored().expires_at - onlyStored().created_at).toBe(900_000);
    });

    it('set the polling interval, in the response and on the code', async () => {
      documents[TENANT_KEY] = { 'device_flow.poll_interval': 10 };
      const { body } = await post();

      expect(body.interval).toBe(10);
      expect(onlyStored().interval).toBe(10);
    });

    it('keep the slow_down increment, the poll count and the maximum interval on the code', async () => {
      documents[TENANT_KEY] = {
        'device_flow.slow_down_increment': 15,
        'device_flow.max_poll_count': 300,
        'device_flow.max_interval': 90,
      };
      await post();

      expect(onlyStored()).toMatchObject({
        slow_down_increment: 15,
        max_poll_count: 300,
        max_interval: 90,
        interval: 5,
      });
    });

    it('hold the lifetime and the interval between the tenant bounds', async () => {
      documents[TENANT_KEY] = { 'device_flow.min_expires_in': 700, 'device_flow.min_interval': 8 };
      const { body } = await post();

      expect(body.expires_in).toBe(700);
      expect(body.interval).toBe(8);

      stored.length = 0;
      documents[TENANT_KEY] = {
        'device_flow.expires_in': 1500,
        'device_flow.max_expires_in': 900,
        'device_flow.poll_interval': 50,
        'device_flow.max_interval': 20,
      };
      const capped = await post();
      expect(capped.body.expires_in).toBe(900);
      expect(capped.body.interval).toBe(20);
      expect(onlyStored()).toMatchObject({ interval: 20, max_interval: 20 });
    });

    it('fall back to the default for a value outside the setting range', async () => {
      documents[TENANT_KEY] = {
        'device_flow.expires_in': 99999,
        'device_flow.poll_interval': 0,
        'device_flow.slow_down_increment': 1,
        'device_flow.max_poll_count': 5,
      };
      const { body } = await post();

      expect(body).toMatchObject({ expires_in: 600, interval: 5 });
      expect(onlyStored()).toMatchObject({ slow_down_increment: 5, max_poll_count: 120 });
    });

    it('can come from the environment', async () => {
      const { body } = await post(undefined, { DEVICE_FLOW_DEFAULT_EXPIRES_IN: '1200' });
      expect(body.expires_in).toBe(1200);
    });
  });

  describe('the client settings', () => {
    it('beat the tenant settings', async () => {
      documents[TENANT_KEY] = {
        'device_flow.expires_in': 900,
        'device_flow.poll_interval': 10,
        'device_flow.max_poll_count': 200,
      };
      documents[CLIENT_KEY] = {
        'device_flow.expires_in': 500,
        'device_flow.poll_interval': 7,
        'device_flow.max_poll_count': 150,
      };
      const { body } = await post();

      expect(body).toMatchObject({ expires_in: 500, interval: 7 });
      expect(onlyStored()).toMatchObject({ interval: 7, max_poll_count: 150 });
      expect(onlyStored().expires_at - onlyStored().created_at).toBe(500_000);
    });

    it('apply to that client only', async () => {
      documents[TENANT_KEY] = { 'device_flow.expires_in': 900 };
      documents[CLIENT_KEY] = { 'device_flow.expires_in': 500 };
      mocks.getClient.mockResolvedValue({ client_id: 'other-client' });

      const { body } = await post({ client_id: 'other-client', scope: 'openid' });

      expect(body.expires_in).toBe(900);
    });

    it('are held to the tenant bounds', async () => {
      documents[TENANT_KEY] = {
        'device_flow.min_expires_in': 400,
        'device_flow.max_expires_in': 700,
        'device_flow.max_interval': 20,
      };
      documents[CLIENT_KEY] = {
        'device_flow.expires_in': 1700,
        'device_flow.poll_interval': 55,
        // a client cannot widen the tenant's bounds
        'device_flow.max_expires_in': 3600,
        'device_flow.max_interval': 300,
      };
      const { body } = await post();

      expect(body).toMatchObject({ expires_in: 700, interval: 20 });
      expect(onlyStored().max_interval).toBe(20);
    });
  });

  describe('settings that cannot be read', () => {
    it('stop the request with a retryable 503 and store nothing', async () => {
      documents[TENANT_KEY] = new Error('KV unavailable');
      const { response, body } = await post();

      expect(response.status).toBe(503);
      expect(body.error).toBe('temporarily_unavailable');
      expect(storeFetch).not.toHaveBeenCalled();
      expect(stored).toHaveLength(0);
      expect(mocks.logger.error).toHaveBeenCalled();
    });

    it('stop the request when only the client document cannot be read', async () => {
      documents[CLIENT_KEY] = new Error('KV unavailable');
      const { response, body } = await post();

      expect(response.status).toBe(503);
      expect(body.error).toBe('temporarily_unavailable');
      expect(storeFetch).not.toHaveBeenCalled();
    });

    it('do not leak the failure to the caller', async () => {
      documents[TENANT_KEY] = new Error('secret KV detail');
      const { body } = await post();
      expect(JSON.stringify(body)).not.toContain('secret KV detail');
    });
  });

  describe('a request that is refused before the settings matter', () => {
    it('for an unknown client does not read the device flow settings', async () => {
      mocks.getClient.mockResolvedValue(null);
      documents[TENANT_KEY] = new Error('KV unavailable');
      const { response } = await post({ client_id: 'stranger', scope: 'openid' });

      // The client is refused (not a 503 about settings), and the settings are not probed
      expect(response.status).not.toBe(503);
      expect(response.status).not.toBe(200);
      expect(kvReads.filter((key) => key.includes('device-flow'))).toEqual([]);
    });

    it('for a client that may not use the grant does not read the device flow settings', async () => {
      mocks.getClient.mockResolvedValue({
        client_id: 'device-client',
        grant_types: ['authorization_code'],
      });
      documents[TENANT_KEY] = new Error('KV unavailable');
      const { response } = await post();

      expect(response.status).not.toBe(503);
      expect(response.status).not.toBe(200);
      expect(kvReads.filter((key) => key.includes('device-flow'))).toEqual([]);
    });

    it('without a client_id does not read the device flow settings', async () => {
      const { response } = await post({ scope: 'openid' });

      expect(response.status).toBe(400);
      expect(kvReads.filter((key) => key.includes('device-flow'))).toEqual([]);
    });
  });
});
