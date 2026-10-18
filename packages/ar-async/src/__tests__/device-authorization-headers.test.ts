/**
 * POST /device_authorization: every answer, the early ones included (rate limit, FAL3 refusal,
 * unreadable assurance settings, unknown tenant), is uncacheable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { deviceAuthorizationHandler } from '../device-authorization';
import { deviceClients, harness, registerClient } from './device-authorization-harness';

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  const shared = globalThis as unknown as {
    __deviceClients: Map<string, Record<string, unknown>>;
    __deviceLogger: unknown;
  };
  return {
    ...actual,
    getClientCached: async (_c: unknown, _env: unknown, id: string) =>
      shared.__deviceClients.get(id) ?? null,
    getLogger: () => shared.__deviceLogger,
  };
});

const ASSURANCE_KEY = 'settings:tenant:default:assurance';
const FAL3 = JSON.stringify({ 'assurance.enabled': true, 'assurance.default_fal': 'FAL3' });

function expectUncacheable(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Pragma')).toBe('no-cache');
}

beforeEach(async () => {
  deviceClients.clear();
  await registerClient('tv', { token_endpoint_auth_method: 'none' });
});

describe('the early answers', () => {
  it('the FAL3 refusal (400) is uncacheable', async () => {
    const h = harness({
      SETTINGS: { get: vi.fn(async (key: string) => (key === ASSURANCE_KEY ? FAL3 : null)) },
    });
    const { response, body } = await h.post({ client_id: 'tv' });
    expect(response.status).toBe(400);
    expect(body.error).toBe('unauthorized_client');
    expectUncacheable(response);
  });

  it('the answer to unreadable assurance settings (503) is uncacheable', async () => {
    const h = harness({
      SETTINGS: {
        get: vi.fn(async (key: string) => {
          if (key === ASSURANCE_KEY) throw new Error('KV down');
          return null;
        }),
      },
    });
    const { response, body } = await h.post({ client_id: 'tv' });
    expect(response.status).toBe(503);
    expect(body.error).toBe('temporarily_unavailable');
    expectUncacheable(response);
  });

  it('the rate limit answers (429 and 503) are uncacheable', async () => {
    const limited = harness({
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: () => ({
          incrementRpc: async () => ({
            allowed: false,
            current: 61,
            limit: 60,
            resetAt: 4_000_000_000,
          }),
        }),
      },
    });
    const over = await limited.post({ client_id: 'tv' });
    expect(over.response.status).toBe(429);
    expectUncacheable(over.response);

    const unbound = await harness({ RATE_LIMITER: undefined }).post({ client_id: 'tv' });
    expect(unbound.response.status).toBe(503);
    expectUncacheable(unbound.response);
  });

  it('the answer to an unknown tenant is uncacheable', async () => {
    // multi-tenant (BASE_DOMAIN) and no tenant on the request
    const h = harness({ BASE_DOMAIN: 'auth.example.com' });
    const app = new Hono<{ Bindings: Env }>();
    app.post('/device_authorization', deviceAuthorizationHandler);
    const response = await app.request(
      'https://auth.example.com/device_authorization',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'client_id=tv',
      },
      h.env
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expectUncacheable(response);
  });

  it('an unexpected failure is an uncacheable 500 server_error', async () => {
    const h = harness({
      DEVICE_CODE_STORE: {
        idFromName: () => {
          throw new Error('binding broke');
        },
      },
    });
    const { response, body } = await h.post({ client_id: 'tv' });
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'server_error', error_description: expect.any(String) });
    expectUncacheable(response);
  });
});

describe('the late answers', () => {
  it('the code response and the refusals carry them too', async () => {
    const ok = await harness().post({ client_id: 'tv' });
    expect(ok.response.status).toBe(200);
    expectUncacheable(ok.response);
    const forms: Record<string, string>[] = [
      {},
      { client_id: 'nobody' },
      { client_id: 'tv', scope: 'admin' },
    ];
    for (const form of forms) {
      const { response } = await harness().post(form);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expectUncacheable(response);
    }
  });
});
