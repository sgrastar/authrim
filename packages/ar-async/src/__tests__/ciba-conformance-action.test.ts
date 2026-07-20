import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { cibaConformanceActionHandler } from '../ciba-conformance-action';

const { sendPingNotification } = vi.hoisted(() => ({ sendPingNotification: vi.fn() }));
vi.mock('@authrim/ar-lib-core/notifications', () => ({ sendPingNotification }));

async function keyFor(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return `ciba-approval:${Buffer.from(digest).toString('base64url')}`;
}

describe('CIBA conformance capability action', () => {
  const secret = 'a'.repeat(43);
  let storeFetch: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    storeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/get-by-auth-req-id') {
        return Response.json({
          auth_req_id: 'request-1',
          client_id: 'client-1',
          scope: 'openid',
          status: 'pending',
          delivery_mode: 'ping',
          client_notification_endpoint: 'https://certification.openid.net/ciba-callback',
          client_notification_token: 'notification-token',
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          poll_count: 0,
          interval: 5,
          acr_values: 'urn:mace:incommon:iap:silver urn:example:secondary',
          token_issued: false,
        });
      }
      return Response.json({ success: true });
    });
    const capabilityKey = await keyFor(secret);
    env = {
      DEFAULT_TENANT_ID: 'fapi-ciba',
      INITIAL_ACCESS_TOKENS: {
        get: vi.fn(async (key: string) =>
          key === capabilityKey
            ? JSON.stringify({
                type: 'ciba-conformance-approval',
                tenantId: 'fapi-ciba',
                userId: 'user-1',
                sub: 'user-1',
                expiresAt: Date.now() + 60_000,
              })
            : null
        ),
      } as unknown as KVNamespace,
      CIBA_REQUEST_STORE: {
        idFromName: vi.fn(() => 'id'),
        get: vi.fn(() => ({ fetch: storeFetch })),
      } as unknown as Env['CIBA_REQUEST_STORE'],
    } as Env;
  });

  it('approves a pending request and sends exactly one ping', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, 'fapi-ciba' as never);
      await next();
    });
    app.post('/action', cibaConformanceActionHandler);

    const response = await app.request(
      `/action?secret=${secret}&auth_req_id=request-1&action=allow`,
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(200);
    expect(storeFetch).toHaveBeenCalledTimes(2);
    expect(new URL((storeFetch.mock.calls[1][0] as Request).url).pathname).toBe('/approve');
    await expect((storeFetch.mock.calls[1][0] as Request).clone().json()).resolves.toMatchObject({
      authenticated_acr: 'urn:mace:incommon:iap:silver',
    });
    expect(sendPingNotification).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an unknown capability', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.post('/action', cibaConformanceActionHandler);
    const response = await app.request(
      `/action?secret=${'b'.repeat(43)}&auth_req_id=request-1&action=allow`,
      { method: 'POST' },
      env
    );
    expect(response.status).toBe(401);
    expect(storeFetch).not.toHaveBeenCalled();
  });
});
