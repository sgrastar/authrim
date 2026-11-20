import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { directoryRelayConnectHandler } from '../directory-relay-route';

function createRelay() {
  const fetch = vi.fn(async () => new Response('relayed', { status: 200 }));
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
    get: vi.fn(() => ({ fetch }) as unknown as DurableObjectStub),
  };
  return { namespace, fetch };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/connect/:tenantId/:connectorId', directoryRelayConnectHandler);
  return app;
}

async function call(path: string, env: Partial<Env>, headers: Record<string, string> = {}) {
  return createApp().request(path, { headers }, env);
}

describe('directoryRelayConnectHandler', () => {
  it('requires a websocket upgrade header', async () => {
    const relay = createRelay();
    const env = { DIRECTORY_CONNECTOR_RELAY: relay.namespace } as unknown as Partial<Env>;
    const missing = await call('/connect/tenant-a/wwcon_1', env);
    expect(missing.status).toBe(426);
    expect(await missing.json()).toEqual({ error: 'websocket_upgrade_required' });

    const wrong = await call('/connect/tenant-a/wwcon_1', env, { upgrade: 'h2c' });
    expect(wrong.status).toBe(426);
    expect(await wrong.json()).toEqual({ error: 'websocket_upgrade_required' });
    expect(relay.fetch).not.toHaveBeenCalled();
  });

  it('accepts the upgrade header case-insensitively and forwards to the tenant/connector relay', async () => {
    const relay = createRelay();
    const env = { DIRECTORY_CONNECTOR_RELAY: relay.namespace } as unknown as Partial<Env>;
    const response = await call('/connect/tenant%20a/wwcon_1', env, { Upgrade: 'WebSocket' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('relayed');
    expect(relay.namespace.idFromName).toHaveBeenCalledWith('tenant%20a:wwcon_1');
    expect(relay.namespace.get).toHaveBeenCalledWith({ name: 'tenant%20a:wwcon_1' });
    expect(relay.fetch).toHaveBeenCalledTimes(1);
    const forwarded = relay.fetch.mock.calls[0] as unknown as [Request];
    expect(forwarded[0]).toBeInstanceOf(Request);
    expect(forwarded[0].url).toContain('/connect/tenant%20a/wwcon_1');
  });

  it.each([
    ['/connect/%20/wwcon_1', 'blank tenant'],
    [`/connect/${'t'.repeat(129)}/wwcon_1`, 'tenant longer than 128'],
    ['/connect/tenant-a/bad.id', 'connector with invalid characters'],
    [`/connect/tenant-a/${'c'.repeat(65)}`, 'connector longer than 64'],
    ['/connect/tenant-a/%20', 'blank connector'],
  ])('rejects %s (%s) as invalid_relay_route', async (path) => {
    const relay = createRelay();
    const env = { DIRECTORY_CONNECTOR_RELAY: relay.namespace } as unknown as Partial<Env>;
    const response = await call(path, env, { upgrade: 'websocket' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_relay_route' });
    expect(relay.fetch).not.toHaveBeenCalled();
  });

  it('accepts boundary lengths and trims surrounding whitespace', async () => {
    const relay = createRelay();
    const env = { DIRECTORY_CONNECTOR_RELAY: relay.namespace } as unknown as Partial<Env>;
    const tenant = 't'.repeat(128);
    const connector = 'c'.repeat(64);
    const response = await call(`/connect/%20${tenant}%20/${connector}`, env, {
      upgrade: 'websocket',
    });
    expect(response.status).toBe(200);
    expect(relay.namespace.idFromName).toHaveBeenCalledWith(`${tenant}:${connector}`);
  });

  it('returns 503 when the relay binding is missing', async () => {
    const response = await call('/connect/tenant-a/wwcon_1', {}, { upgrade: 'websocket' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'directory_connector_relay_not_configured' });
  });
});
