import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { FlowStateStore } from '../FlowStateStore';
import { SAMLRequestStore } from '../SAMLRequestStore';

class Storage {
  readonly data = new Map<string, unknown>();
  readonly alarms: number[] = [];
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async setAlarm(value: number): Promise<void> {
    this.alarms.push(value);
  }
  async deleteAlarm(): Promise<void> {
    this.alarms.length = 0;
  }
}

function durableState(storage = new Storage()): DurableObjectState {
  return { storage } as unknown as DurableObjectState;
}

function flowRequest(path: string, body?: unknown, headers = true, method?: string): Request {
  return new Request(`https://flow.example${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      ...(headers ? { 'X-Tenant-Id': 'tenant-a', 'X-Flow-Session-Id': 'session-1' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe('FlowStateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('binds state to tenant/session headers and processes submissions idempotently', async () => {
    const storage = new Storage();
    const store = new FlowStateStore(durableState(storage));
    const init = await store.fetch(
      flowRequest('/init', {
        sessionId: 'session-1',
        flowId: 'flow-1',
        flowType: 'login',
        tenantId: 'tenant-a',
        clientId: 'client-1',
        entryNodeId: 'start',
        ttlMs: 60_000,
        oauthParams: { state: 'state-1' },
      })
    );
    expect(init.status).toBe(200);
    expect(await json(init)).toMatchObject({
      success: true,
      state: { currentNodeId: 'start', tenantId: 'tenant-a' },
    });
    expect(storage.alarms).toEqual([Date.now() + 60_000]);

    const submitBody = {
      requestId: 'request-1',
      capabilityId: 'email',
      response: { code: '123456' },
      result: { type: 'continue', uiContract: { screen: 'done' } },
      nextNodeId: 'done',
      requestTimestamps: [Date.now(), 'bad', Number.NaN],
    };
    expect((await store.fetch(flowRequest('/submit', submitBody))).status).toBe(200);
    const replay = await store.fetch(flowRequest('/submit', submitBody));
    expect(replay.headers.get('X-Idempotent')).toBe('true');
    expect(await json(replay)).toEqual(submitBody.result);

    const check = await store.fetch(flowRequest('/check-request', { requestId: 'request-1' }));
    expect(await json(check)).toMatchObject({ found: true, result: submitBody.result });
    const missing = await store.fetch(flowRequest('/check-request', { requestId: 'request-2' }));
    expect(await json(missing)).toMatchObject({ found: false });
    expect(await json(await store.fetch(flowRequest('/state')))).toMatchObject({
      state: {
        currentNodeId: 'done',
        completedCapabilities: ['email'],
        requestTimestamps: [Date.now()],
      },
    });
  });

  it('rejects missing and mismatched security context and duplicate initialization', async () => {
    const store = new FlowStateStore(durableState());
    const params = {
      sessionId: 'session-1',
      flowId: 'flow-1',
      flowType: 'login',
      tenantId: 'tenant-a',
      clientId: 'client-1',
      entryNodeId: 'start',
    };
    expect((await store.fetch(flowRequest('/init', params, false))).status).toBe(400);
    expect(
      (
        await store.fetch(
          new Request('https://flow.example/init', {
            method: 'POST',
            headers: { 'X-Tenant-Id': 'tenant-b', 'X-Flow-Session-Id': 'session-1' },
            body: JSON.stringify(params),
          })
        )
      ).status
    ).toBe(403);
    await store.fetch(flowRequest('/init', params));
    expect((await store.fetch(flowRequest('/init', params))).status).toBe(409);
    const wrongSession = new Request('https://flow.example/state', {
      headers: { 'X-Tenant-Id': 'tenant-a', 'X-Flow-Session-Id': 'other' },
    });
    expect((await store.fetch(wrongSession)).status).toBe(403);
  });

  it('reports missing/expired sessions and supports idempotent cancellation and alarms', async () => {
    const storage = new Storage();
    const store = new FlowStateStore(durableState(storage));
    expect((await store.fetch(flowRequest('/state'))).status).toBe(404);
    expect((await store.fetch(flowRequest('/submit', {}))).status).toBe(404);
    expect((await store.fetch(flowRequest('/unknown'))).status).toBe(404);
    expect((await store.fetch(flowRequest('/cancel', undefined, true, 'DELETE'))).status).toBe(200);
    await store.fetch(
      flowRequest('/init', {
        sessionId: 'session-1',
        flowId: 'flow-1',
        flowType: 'login',
        tenantId: 'tenant-a',
        clientId: 'client-1',
        entryNodeId: 'start',
        ttlMs: 1,
      })
    );
    vi.advanceTimersByTime(2);
    expect((await store.fetch(flowRequest('/state'))).status).toBe(410);
    expect((await store.fetch(flowRequest('/check-request', { requestId: 'r' }))).status).toBe(410);
    await store.alarm();
    expect(storage.data.has('runtimeState')).toBe(false);
  });

  it('restores persisted state with missing backward-compatible collections', async () => {
    const storage = new Storage();
    storage.data.set('runtimeState', {
      sessionId: 'session-1',
      flowId: 'flow-1',
      flowType: 'login',
      tenantId: 'tenant-a',
      clientId: 'client-1',
      currentNodeId: 'start',
      visitedNodeIds: ['start'],
      collectedData: {},
      completedCapabilities: [],
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      lastActivityAt: Date.now(),
    });
    const store = new FlowStateStore(durableState(storage));
    expect(await json(await store.fetch(flowRequest('/state')))).toMatchObject({
      state: { requestTimestamps: [] },
    });
  });
});

describe('SAMLRequestStore replay protection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('stores and consumes requests, artifacts, and assertion IDs only once', async () => {
    const store = new SAMLRequestStore(durableState(), {} as never);
    await store.storeRequest({
      requestId: 'request-1',
      requestType: 'AuthnRequest',
      issuer: 'https://sp.example',
      destination: 'https://idp.example/sso',
      relayState: 'relay',
      createdAt: 0,
      expiresAt: 0,
      used: false,
    } as never);
    await expect(store.checkRequest('request-1')).resolves.toBe(true);
    await expect(store.consumeRequest('request-1')).resolves.toMatchObject({ used: true });
    await expect(store.consumeRequest('request-1')).resolves.toBeNull();
    await expect(store.consumeRequest('missing')).resolves.toBeNull();

    await store.storeArtifact({
      artifact: 'artifact-1',
      message: '<Response/>',
      createdAt: 0,
      expiresAt: 0,
      used: false,
    } as never);
    await expect(store.resolveArtifact('artifact-1')).resolves.toMatchObject({ used: true });
    await expect(store.resolveArtifact('artifact-1')).resolves.toBeNull();
    await expect(store.resolveArtifact('missing')).resolves.toBeNull();

    await expect(store.consumeAssertionId('assertion-1')).resolves.toBe(true);
    await expect(store.checkAssertionId('assertion-1')).resolves.toBe(true);
    await expect(store.consumeAssertionId('assertion-1')).resolves.toBe(false);
  });

  it('rejects expired requests and artifacts and cleans old persisted entries', async () => {
    const storage = new Storage();
    storage.data.set('state', {
      requests: [
        ['old', { requestId: 'old', expiresAt: Date.now() - 120_000, used: false }],
        ['recent', { requestId: 'recent', expiresAt: Date.now() + 1000, used: false }],
      ],
      artifacts: [
        [
          'old-artifact',
          { artifact: 'old-artifact', expiresAt: Date.now() - 120_000, used: false },
        ],
      ],
      consumedAssertionIds: [],
    });
    const store = new SAMLRequestStore(durableState(storage), {} as never);
    await expect(store.checkRequest('recent')).resolves.toBe(true);
    expect(JSON.stringify(storage.data.get('state'))).not.toContain('old-artifact');
    vi.advanceTimersByTime(2000);
    await expect(store.consumeRequest('recent')).resolves.toBeNull();
  });

  it('routes HTTP operations and returns safe failures', async () => {
    const store = new SAMLRequestStore(durableState(), {} as never);
    const post = (path: string, body: unknown) =>
      new Request(`https://saml.example${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    expect(
      (await store.fetch(post('/store', { requestId: 'r', expiresAt: Date.now() + 1000 }))).status
    ).toBe(200);
    const peek = await store.fetch(new Request('https://saml.example/request/r'));
    expect(peek.status).toBe(200);
    expect(await peek.json()).toMatchObject({ requestId: 'r' });
    expect((await store.fetch(post('/consume/r', {}))).status).toBe(200);
    expect((await store.fetch(new Request('https://saml.example/request/r'))).status).toBe(404);
    expect((await store.fetch(post('/consume/r', {}))).status).toBe(404);
    expect((await store.fetch(new Request('https://saml.example/check/r'))).status).toBe(200);
    expect((await store.fetch(post('/assertion/consume', { assertionId: 'a' }))).status).toBe(200);
    expect((await store.fetch(post('/assertion/consume', { assertionId: 'a' }))).status).toBe(409);
    expect((await store.fetch(new Request('https://saml.example/assertion/check/a'))).status).toBe(
      200
    );
    expect((await store.fetch(new Request('https://saml.example/unknown'))).status).toBe(404);
  });
});
