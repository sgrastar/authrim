import { describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { PermissionChangeHub } from '../PermissionChangeHub';

function harness(storedTenant?: string) {
  const data = new Map<string, unknown>();
  if (storedTenant) data.set('tenantId', storedTenant);
  const sockets: FakeSocket[] = [];
  const tags = new Map<FakeSocket, string[]>();
  let initialized = Promise.resolve();
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => data.get(key)),
      put: vi.fn(async (key: string, value: unknown) => data.set(key, value)),
    },
    blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => {
      initialized = callback();
      return initialized;
    }),
    getWebSockets: vi.fn(() => sockets),
    getTags: vi.fn((socket: FakeSocket) => tags.get(socket) ?? []),
  };
  return {
    hub: new PermissionChangeHub(ctx as unknown as DurableObjectState, {} as never),
    data,
    sockets,
    tags,
    get initialized() {
      return initialized;
    },
  };
}

class FakeSocket {
  readonly send = vi.fn();
  readonly close = vi.fn();
}

const event = {
  tenant_id: 'tenant-a',
  event: 'relationship_changed',
  subject_id: 'user-1',
  resource: 'document:123',
  relation: 'viewer',
  permission: 'read',
  timestamp: 100,
};

function request(path: string, body?: unknown, method?: string): Request {
  return new Request(`https://hub.example${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('PermissionChangeHub tenant and subscription isolation', () => {
  it('requires setup before stats and binds the instance to one tenant', async () => {
    const h = harness();
    await h.initialized;
    expect((await h.hub.fetch(request('/stats'))).status).toBe(409);
    expect((await h.hub.fetch(request('/setup', {}))).status).toBe(400);
    expect((await h.hub.fetch(request('/setup', { tenant_id: 'tenant-a' }))).status).toBe(200);
    expect(h.data.get('tenantId')).toBe('tenant-a');
    expect((await h.hub.fetch(request('/setup', { tenant_id: 'tenant-a' }))).status).toBe(200);
    expect((await h.hub.fetch(request('/setup', { tenant_id: 'tenant-b' }))).status).toBe(409);
    expect(await (await h.hub.fetch(request('/stats'))).json()).toEqual({
      tenant_id: 'tenant-a',
      active_connections: 0,
      subscriptions: 0,
    });
    expect((await h.hub.fetch(request('/missing'))).status).toBe(404);
  });

  it('restores tenant and subscriptions and handles subscribe, ping, and unsubscribe', async () => {
    const h = harness('tenant-a');
    const socket = new FakeSocket();
    h.sockets.push(socket);
    h.tags.set(socket, [JSON.stringify({ subscriptionId: 'sub-1', connectedAt: 1 })]);
    await h.initialized;
    await h.hub.webSocketMessage(
      socket as never,
      JSON.stringify({
        type: 'subscribe',
        subject_id: 'user-1',
        resources: ['document:*'],
        relations: ['viewer'],
      })
    );
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      type: 'subscribed',
      subscription_id: 'sub-1',
      subscriptions: { subjects: ['user-1'] },
    });
    await h.hub.webSocketMessage(
      socket as never,
      new TextEncoder().encode(JSON.stringify({ type: 'ping', timestamp: 42 })).buffer
    );
    expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({ type: 'pong', timestamp: 42 });
    await h.hub.webSocketMessage(
      socket as never,
      JSON.stringify({ type: 'unsubscribe', subscription_id: 'wrong' })
    );
    expect(JSON.parse(socket.send.mock.calls[2][0])).toMatchObject({
      type: 'error',
      code: 'invalid_subscription',
    });
    await h.hub.webSocketMessage(
      socket as never,
      JSON.stringify({ type: 'unsubscribe', subscription_id: 'sub-1' })
    );
    expect(socket.close).toHaveBeenCalledWith(1000, 'Unsubscribed');
  });

  it('notifies only matching subject/resource/relation subscriptions', async () => {
    const h = harness('tenant-a');
    const matching = new FakeSocket();
    const subjectMismatch = new FakeSocket();
    const resourceMismatch = new FakeSocket();
    const relationMismatch = new FakeSocket();
    const wildcard = new FakeSocket();
    const unattached = new FakeSocket();
    h.sockets.push(
      matching,
      subjectMismatch,
      resourceMismatch,
      relationMismatch,
      wildcard,
      unattached
    );
    for (const [index, socket] of h.sockets.entries()) {
      if (socket !== unattached)
        h.tags.set(socket, [JSON.stringify({ subscriptionId: `sub-${index}`, connectedAt: 1 })]);
    }
    await h.initialized;
    const subscribe = async (socket: FakeSocket, body: Record<string, unknown>) =>
      h.hub.webSocketMessage(socket as never, JSON.stringify({ type: 'subscribe', ...body }));
    await subscribe(matching, {
      subjects: ['user-1'],
      resources: ['document:*'],
      relations: ['viewer'],
    });
    await subscribe(subjectMismatch, { subjects: ['user-2'] });
    await subscribe(resourceMismatch, { resources: ['folder:*'] });
    await subscribe(relationMismatch, { relations: ['owner'] });
    await subscribe(wildcard, { subjects: ['*'], resources: ['*'], relations: ['*'] });
    h.sockets.forEach((socket) => socket.send.mockClear());

    const response = await h.hub.fetch(request('/broadcast', event));
    expect(await response.json()).toEqual({ success: true, notified: 2, total_connections: 6 });
    expect(matching.send).toHaveBeenCalledOnce();
    expect(wildcard.send).toHaveBeenCalledOnce();
    expect(subjectMismatch.send).not.toHaveBeenCalled();
    expect(resourceMismatch.send).not.toHaveBeenCalled();
    expect(relationMismatch.send).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant and malformed broadcasts and initializes from first valid event', async () => {
    const initialized = harness('tenant-a');
    await initialized.initialized;
    expect(
      (await initialized.hub.fetch(request('/broadcast', { ...event, tenant_id: 'tenant-b' })))
        .status
    ).toBe(409);
    expect((await initialized.hub.fetch(request('/broadcast', {}))).status).toBe(500);

    const fresh = harness();
    await fresh.initialized;
    expect((await fresh.hub.fetch(request('/broadcast', event))).status).toBe(200);
    expect(fresh.data.get('tenantId')).toBe('tenant-a');
  });

  it('handles malformed messages, missing attachments, close, and socket errors safely', async () => {
    const h = harness('tenant-a');
    const socket = new FakeSocket();
    await h.initialized;
    await h.hub.webSocketMessage(socket as never, '{');
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ code: 'parse_error' });
    await h.hub.webSocketMessage(
      socket as never,
      JSON.stringify({ type: 'subscribe', subjects: [] })
    );
    expect(JSON.parse(socket.send.mock.calls[1][0])).toMatchObject({ code: 'no_attachment' });
    await h.hub.webSocketMessage(socket as never, JSON.stringify({ type: 'unknown' }));
    expect(JSON.parse(socket.send.mock.calls[2][0])).toMatchObject({
      code: 'unknown_message_type',
    });
    await h.hub.webSocketClose(socket as never, 1000, '', true);
    await h.hub.webSocketError(socket as never, new Error('closed'));
  });
});
