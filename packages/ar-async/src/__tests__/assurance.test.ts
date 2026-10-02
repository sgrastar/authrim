import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { fal3Refusal } from '../assurance';
import { deviceAuthorizationHandler } from '../device-authorization';
import { cibaAuthorizationHandler } from '../ciba-authorization';

const ASSURANCE_KEY = 'settings:tenant:default:assurance';

function settings(read: () => Promise<string | null>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => (key === ASSURANCE_KEY ? read() : null)),
  } as unknown as KVNamespace;
}

const FAL3 = async () =>
  JSON.stringify({ 'assurance.enabled': true, 'assurance.default_fal': 'FAL3' });

function context(env: Partial<Env>, body: Record<string, unknown> = {}) {
  return {
    req: {
      parseBody: vi.fn().mockResolvedValue(body),
      header: vi.fn().mockReturnValue(undefined),
      raw: new Request('https://auth.example.com/', { method: 'POST' }),
      url: 'https://auth.example.com/',
    },
    get: vi.fn().mockReturnValue(undefined),
    json: vi.fn((data: unknown, status = 200) => new Response(JSON.stringify(data), { status })),
    env: { ISSUER_URL: 'https://auth.example.com', ...env },
  } as never;
}

describe('fal3Refusal', () => {
  it('lets the flow go on while FAL3 is not required', async () => {
    expect(await fal3Refusal(context({ SETTINGS: settings(async () => null) }), 'default')).toBe(
      null
    );
  });

  it('refuses the flow at FAL3', async () => {
    const response = await fal3Refusal(context({ SETTINGS: settings(FAL3) }), 'default');

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: 'unauthorized_client' });
  });

  it('stops when the assurance settings cannot be read', async () => {
    const response = await fal3Refusal(
      context({
        SETTINGS: settings(async () => {
          throw new Error('KV unavailable');
        }),
      }),
      'default'
    );

    expect(response?.status).toBe(503);
  });
});

describe('flows without a pushed request at FAL3', () => {
  it.each([
    ['the device authorization endpoint', deviceAuthorizationHandler],
    ['the backchannel authentication endpoint', cibaAuthorizationHandler],
  ])('%s refuses every request', async (_label, handler) => {
    const response = await handler(
      context({ SETTINGS: settings(FAL3) }, { client_id: 'client', scope: 'openid' })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'unauthorized_client' });
  });
});
