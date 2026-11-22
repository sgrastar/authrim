/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- mock call inspection */
import { describe, expect, it, vi } from 'vitest';
import {
  replicationCanonicalJson,
  signReplicationRpc,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { createReplicationAuthorityHttp } from './authority-http';

const NOW = 1_800_000_000_000;
const secret = 'a'.repeat(64);
const PATH = 'https://authority.example.test/replication/v1/rpc';
const T = { pairId: 'pair-a', tenantId: 'tenant-a' };
const E = { pairId: 'pair-a', environmentId: 'env-a' };

function authorityFake() {
  const names = [
    'initialize',
    'get',
    'enter',
    'complete',
    'beginDrain',
    'beginFailoverDrain',
    'registerStandbyGeneration',
    'verifyFailoverGeneration',
    'getOperation',
    'verifyGeneration',
    'promote',
  ];
  const fake: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const n of names) fake[n] = vi.fn(async () => ({ from: n, phase: 'active' }));
  fake.get = vi.fn(async () => ({
    phase: 'active',
    ownerDeploymentId: 'aws-a',
    selectedGenerationId: 'gen-1',
    epoch: 4,
  }));
  return fake;
}
function environmentFake() {
  const names = [
    'initialize',
    'get',
    'enter',
    'complete',
    'beginDrain',
    'getOperation',
    'registerGeneration',
    'getGeneration',
    'getServingGeneration',
    'verifyGeneration',
    'promote',
    'cancelDrain',
  ];
  const fake: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const n of names) fake[n] = vi.fn(async () => ({ from: n }));
  return fake;
}
function build(over: Record<string, unknown> = {}) {
  const authority = authorityFake();
  const environmentAuthority = environmentFake();
  const catalog = {
    register: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ catalog: 'entry' })),
  };
  const http = createReplicationAuthorityHttp({
    authority: authority as any,
    environmentAuthority: environmentAuthority as any,
    catalog: catalog as any,
    now: () => NOW,
    credentials: [
      { credentialId: 'tc', ...T, role: 'controller', secret },
      { credentialId: 'tw', ...T, role: 'writer', deploymentId: 'aws-a', secret },
      { credentialId: 'ec', ...E, role: 'controller', secret },
      { credentialId: 'ew', ...E, role: 'writer', deploymentId: 'aws-a', secret },
    ],
    ...over,
  } as any);
  return { http, authority, environmentAuthority, catalog };
}
async function call(
  http: (r: Request) => Promise<Response>,
  credentialId: string,
  action: string,
  payload: unknown,
  init: { method?: string; url?: string; contentType?: string | null; timestamp?: number } = {}
) {
  const body = replicationCanonicalJson({
    version: 1,
    credentialId,
    timestamp: init.timestamp ?? NOW,
    requestId: 'req-1',
    action,
    payload,
  });
  const headers: Record<string, string> = {
    'X-Authrim-Replication-Signature': await signReplicationRpc(body, secret),
  };
  if (init.contentType !== null) headers['Content-Type'] = init.contentType ?? 'application/json';
  return http(
    new Request(init.url ?? PATH, {
      method: init.method ?? 'POST',
      headers,
      ...((init.method ?? 'POST') === 'POST' ? { body } : {}),
    })
  );
}
const REJECT = { error: 'replication_request_rejected' };
async function expectRejected(r: Response) {
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual(REJECT);
}

describe('response envelope and routing', () => {
  it('uses JSON, no-store and exact 404 for wrong method/path/query', async () => {
    const { http } = build();
    for (const [method, url] of [
      ['GET', PATH],
      ['PUT', PATH],
      ['POST', 'https://authority.example.test/replication/v1/rpc/'],
      ['POST', 'https://authority.example.test/replication/v1/other'],
      ['POST', `${PATH}?x=1`],
    ] as const) {
      const r = await call(http, 'tc', 'get', T, { method, url });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not_found' });
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('rejections are 409 with identical bodies and headers', async () => {
    const { http } = build();
    const r = await call(http, 'nobody', 'get', T);
    await expect(r.clone().text()).resolves.toBe('{"error":"replication_request_rejected"}');
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.status).toBe(409);
  });
  it('rejects wrong content-type values and a missing body or signature', async () => {
    const { http, authority } = build();
    for (const contentType of [
      null,
      'text/plain',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
    ]) {
      await expectRejected(await call(http, 'tc', 'get', T, { contentType }));
    }
    await expectRejected(
      await http(
        new Request(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      )
    );
    const body = replicationCanonicalJson({
      version: 1,
      credentialId: 'tc',
      timestamp: NOW,
      requestId: 'r',
      action: 'get',
      payload: T,
    });
    await expectRejected(
      await http(
        new Request(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      )
    );
    expect(authority.get).not.toHaveBeenCalled();
  });
  it('uses Date.now when no clock is injected', async () => {
    const { http } = build({ now: undefined });
    const r = await call(http, 'tc', 'get', T, { timestamp: Date.now() });
    expect(r.status).toBe(200);
  });
  it('accepts a body of exactly 64 KiB and rejects one byte more', async () => {
    const { http, authority } = build();
    const envelope = (pad: string) =>
      replicationCanonicalJson({
        version: 1,
        credentialId: 'tc',
        timestamp: NOW,
        requestId: 'r',
        action: 'initialize',
        payload: { ...T, pad },
      });
    const limit = 64 * 1024;
    const empty = new TextEncoder().encode(envelope('')).byteLength;
    const send = async (pad: string) => {
      const body = envelope(pad);
      return {
        size: new TextEncoder().encode(body).byteLength,
        response: await http(
          new Request(PATH, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Authrim-Replication-Signature': await signReplicationRpc(body, secret),
            },
            body,
          })
        ),
      };
    };
    const atLimit = await send('x'.repeat(limit - empty));
    expect(atLimit.size).toBe(limit);
    expect(atLimit.response.status).toBe(200);
    expect(authority.initialize).toHaveBeenCalledTimes(1);
    const over = await send('x'.repeat(limit - empty + 1));
    expect(over.size).toBe(limit + 1);
    await expectRejected(over.response);
    expect(authority.initialize).toHaveBeenCalledTimes(1);
  });
  it('stops reading and cancels a multi-chunk stream once the cap is exceeded', async () => {
    const { http, authority } = build();
    const body = replicationCanonicalJson({
      version: 1,
      credentialId: 'tc',
      timestamp: NOW,
      requestId: 'r',
      action: 'get',
      payload: T,
    });
    const signature = await signReplicationRpc(body, secret);
    const chunk = new Uint8Array(4 * 1024).fill(0x78);
    const total = 64;
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= total) return controller.close();
          pulled++;
          controller.enqueue(chunk.slice());
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const response = await http(
      new Request(PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Authrim-Replication-Signature': signature,
        },
        body: stream,
        duplex: 'half',
      } as RequestInit)
    );
    await expectRejected(response);
    expect(authority.get).not.toHaveBeenCalled();
    // 64 KiB is 16 chunks of 4 KiB; the stream is abandoned right after the 17th, not drained.
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(total);
    expect(pulled).toBeLessThanOrEqual(20);
  });
});

describe('credential validation', () => {
  const ok = { credentialId: 'c1', ...T, role: 'controller', secret } as any;
  it('requires at least one credential', () => {
    expect(() => createReplicationAuthorityHttp({ authority: {} as any, credentials: [] })).toThrow(
      'replication_authority_credentials_invalid'
    );
  });
  it('rejects duplicates, both scopes, bad roles and controller deployment ids', () => {
    const mk = (credentials: unknown[]) =>
      createReplicationAuthorityHttp({ authority: {} as any, credentials: credentials as any });
    expect(() => mk([ok])).not.toThrow();
    expect(() => mk([ok, ok])).toThrow('replication_authority_credentials_invalid');
    expect(() => mk([{ ...ok, environmentId: 'env-a' }])).toThrow(
      'replication_authority_credentials_invalid'
    );
    expect(() => mk([{ ...ok, role: 'admin' }])).toThrow(
      'replication_authority_credentials_invalid'
    );
    expect(() => mk([{ ...ok, deploymentId: 'aws-a' }])).toThrow(
      'replication_authority_credentials_invalid'
    );
  });
  it('requires a valid deployment id for writers only', () => {
    const mk = (c: unknown) =>
      createReplicationAuthorityHttp({ authority: {} as any, credentials: [c] as any });
    expect(() => mk({ ...ok, role: 'writer' })).toThrow();
    expect(() => mk({ ...ok, role: 'writer', deploymentId: 'bad id!' })).toThrow();
    expect(() => mk({ ...ok, role: 'writer', deploymentId: 'aws-a' })).not.toThrow();
  });
  it('validates identifiers and secret', () => {
    const mk = (c: unknown) =>
      createReplicationAuthorityHttp({ authority: {} as any, credentials: [c] as any });
    expect(() => mk({ ...ok, credentialId: 'bad id' })).toThrow();
    expect(() => mk({ ...ok, pairId: '' })).toThrow();
    expect(() => mk({ ...ok, tenantId: 'bad id' })).toThrow();
    expect(() => mk({ ...ok, tenantId: undefined, environmentId: 'bad id' })).toThrow();
    expect(() => mk({ ...ok, secret: 'short' })).toThrow();
    expect(() => mk({ ...ok, tenantId: undefined, environmentId: 'env-a' })).not.toThrow();
  });
  it('snapshots credentials so later caller mutation cannot widen scope', async () => {
    const cred = { credentialId: 'c1', ...T, role: 'controller', secret } as any;
    const authority = authorityFake();
    const http = createReplicationAuthorityHttp({
      authority: authority as any,
      now: () => NOW,
      credentials: [cred],
    });
    cred.tenantId = 'other';
    const r = await call(http, 'c1', 'get', T);
    expect(r.status).toBe(200);
  });
});

describe('authentication and payload scoping', () => {
  it('rejects unknown credentials, bad signatures and stale timestamps', async () => {
    const { http, authority } = build();
    await expectRejected(await call(http, 'unknown', 'get', T));
    await expectRejected(await call(http, 'tc', 'get', T, { timestamp: NOW - 60_001 }));
    await expectRejected(await call(http, 'tc', 'get', T, { timestamp: NOW + 60_001 }));
    const body = replicationCanonicalJson({
      version: 1,
      credentialId: 'tc',
      timestamp: NOW,
      requestId: 'r',
      action: 'get',
      payload: T,
    });
    // well-formed hex that is a genuine HMAC, but under a different secret
    const mismatching = await signReplicationRpc(body, 'b'.repeat(64));
    expect(mismatching).toMatch(/^[a-f0-9]{64}$/u);
    expect(mismatching).not.toBe(await signReplicationRpc(body, secret));
    await expectRejected(
      await http(
        new Request(PATH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Authrim-Replication-Signature': mismatching,
          },
          body,
        })
      )
    );
    expect(authority.get).not.toHaveBeenCalled();
  });
  it('rejects non-object payloads and payloads for another pair', async () => {
    const { http, authority } = build();
    for (const payload of [
      null,
      'x',
      5,
      [T],
      { ...T, pairId: 'other' },
      { tenantId: 'tenant-a' },
    ]) {
      await expectRejected(await call(http, 'tc', 'get', payload));
    }
    expect(authority.get).not.toHaveBeenCalled();
  });
  it('tenant credentials reject another tenant and any environmentId', async () => {
    const { http, authority } = build();
    await expectRejected(await call(http, 'tc', 'get', { ...T, tenantId: 'other' }));
    await expectRejected(await call(http, 'tc', 'get', { ...T, environmentId: 'env-a' }));
    expect(authority.get).not.toHaveBeenCalled();
  });
});

describe('tenant scope actions', () => {
  const dep = 'aws-a';
  it('controller actions forward the exact payload and response', async () => {
    const { http, authority } = build();
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['initialize', 'initialize', { ...T, extra: 1 }],
      ['beginDrain', 'beginDrain', { ...T, op: 1 }],
      ['beginFailoverDrain', 'beginFailoverDrain', { ...T, op: 2 }],
      ['registerStandbyGeneration', 'registerStandbyGeneration', { ...T, g: 1 }],
      ['getOperation', 'getOperation', { ...T, operationId: 'o' }],
      ['promote', 'promote', { ...T, operationId: 'o' }],
    ];
    for (const [action, method, payload] of cases) {
      const r = await call(http, 'tc', action, payload);
      expect(r.status).toBe(200);
      expect(authority[method]).toHaveBeenCalledWith(payload);
      if (action === 'registerStandbyGeneration')
        expect(await r.json()).toEqual({ registered: true });
      else expect(await r.json()).toEqual({ from: method, phase: 'active' });
    }
  });
  it('get uses credential scope, not payload fields beyond identity', async () => {
    const { http, authority } = build();
    const r = await call(http, 'tc', 'get', T);
    expect(r.status).toBe(200);
    expect(authority.get).toHaveBeenCalledWith('pair-a', 'tenant-a');
  });
  it('registerGeneration requires a catalog and returns registered', async () => {
    const { http, catalog } = build();
    const payload = { ...T, deploymentId: dep, generationId: 'g' };
    const r = await call(http, 'tc', 'registerGeneration', payload);
    expect(await r.json()).toEqual({ registered: true });
    expect(catalog.register).toHaveBeenCalledWith(payload);
    const none = build({ catalog: undefined });
    await expectRejected(await call(none.http, 'tc', 'registerGeneration', payload));
  });
  it('verifyFailoverGeneration forces the credential identity and requires exact keys', async () => {
    const { http, authority } = build();
    const payload = { ...T, operationId: 'op', proof: { p: 1 } };
    const r = await call(http, 'tc', 'verifyFailoverGeneration', payload);
    expect(r.status).toBe(200);
    expect(authority.verifyFailoverGeneration).toHaveBeenCalledWith(
      { pairId: 'pair-a', tenantId: 'tenant-a', operationId: 'op' },
      { p: 1 }
    );
    authority.verifyFailoverGeneration.mockClear();
    await expectRejected(
      await call(http, 'tc', 'verifyFailoverGeneration', { ...payload, extra: 1 })
    );
    await expectRejected(
      await call(http, 'tc', 'verifyFailoverGeneration', { ...T, operationId: 'op' })
    );
    expect(authority.verifyFailoverGeneration).not.toHaveBeenCalled();
  });
  it('verifyGeneration forces the credential identity and requires exact keys', async () => {
    const { http, authority } = build();
    const payload = { ...T, operationId: 'op', generation: { g: 1 } };
    const r = await call(http, 'tc', 'verifyGeneration', payload);
    expect(r.status).toBe(200);
    expect(authority.verifyGeneration).toHaveBeenCalledWith(
      { pairId: 'pair-a', tenantId: 'tenant-a', operationId: 'op' },
      { g: 1 }
    );
    authority.verifyGeneration.mockClear();
    await expectRejected(await call(http, 'tc', 'verifyGeneration', { ...payload, extra: 1 }));
    await expectRejected(await call(http, 'tc', 'verifyGeneration', { ...T, operationId: 'op' }));
    expect(authority.verifyGeneration).not.toHaveBeenCalled();
  });
  it('rejects unknown actions and environment actions in tenant scope', async () => {
    const { http } = build();
    await expectRejected(await call(http, 'tc', 'bogus', T));
    await expectRejected(await call(http, 'tc', 'environmentGet', T));
  });
  it('controllers cannot enter or complete', async () => {
    const { http, authority } = build();
    await expectRejected(await call(http, 'tc', 'enter', { ...T, deploymentId: dep }));
    await expectRejected(await call(http, 'tc', 'complete', { ...T, deploymentId: dep }));
    expect(authority.enter).not.toHaveBeenCalled();
    expect(authority.complete).not.toHaveBeenCalled();
  });
  it('writers are limited to enter/complete/getServingGeneration with their own deployment', async () => {
    const { http, authority } = build();
    const permit = { ...T, deploymentId: dep, permit: 1 };
    const enter = await call(http, 'tw', 'enter', permit);
    expect(await enter.json()).toEqual({ from: 'enter', phase: 'active' });
    expect(authority.enter).toHaveBeenCalledWith(permit);
    const complete = await call(http, 'tw', 'complete', permit);
    expect(await complete.json()).toEqual({ completed: true });
    expect(authority.complete).toHaveBeenCalledWith(permit);
    await expectRejected(await call(http, 'tw', 'enter', { ...permit, deploymentId: 'other' }));
    await expectRejected(await call(http, 'tw', 'enter', T));
    for (const action of [
      'initialize',
      'get',
      'beginDrain',
      'promote',
      'getOperation',
      'registerGeneration',
    ]) {
      await expectRejected(await call(http, 'tw', action, { ...T, deploymentId: dep }));
    }
    expect(authority.initialize).not.toHaveBeenCalled();
    expect(authority.promote).not.toHaveBeenCalled();
  });
  describe('getServingGeneration', () => {
    const payload = { ...T, deploymentId: 'aws-a' };
    it('resolves the owner generation from current authority state', async () => {
      const { http, authority, catalog } = build();
      const r = await call(http, 'tw', 'getServingGeneration', payload);
      expect(await r.json()).toEqual({ catalog: 'entry' });
      expect(authority.get).toHaveBeenCalledWith('pair-a', 'tenant-a');
      expect(catalog.get).toHaveBeenCalledWith({
        pairId: 'pair-a',
        tenantId: 'tenant-a',
        deploymentId: 'aws-a',
        generationId: 'gen-1',
        epoch: 4,
      });
    });
    it('denies when not active, owner differs, no catalog or extra keys', async () => {
      const a = build();
      a.authority.get.mockResolvedValue({
        phase: 'draining',
        ownerDeploymentId: 'aws-a',
        epoch: 1,
      });
      await expectRejected(await call(a.http, 'tw', 'getServingGeneration', payload));
      const b = build();
      b.authority.get.mockResolvedValue({ phase: 'active', ownerDeploymentId: 'other', epoch: 1 });
      await expectRejected(await call(b.http, 'tw', 'getServingGeneration', payload));
      const c = build({ catalog: undefined });
      await expectRejected(await call(c.http, 'tw', 'getServingGeneration', payload));
      const d = build();
      await expectRejected(
        await call(d.http, 'tw', 'getServingGeneration', { ...payload, extra: 1 })
      );
      await expectRejected(await call(d.http, 'tw', 'getServingGeneration', T));
      expect(d.catalog.get).not.toHaveBeenCalled();
      expect(a.catalog.get).not.toHaveBeenCalled();
      expect(b.catalog.get).not.toHaveBeenCalled();
    });
  });
});

describe('environment scope actions', () => {
  it('rejects when no environment authority is configured or the action is not environment prefixed', async () => {
    const none = build({ environmentAuthority: undefined });
    await expectRejected(await call(none.http, 'ec', 'environmentGet', E));
    const { http } = build();
    await expectRejected(await call(http, 'ec', 'get', E));
    await expectRejected(await call(http, 'ec', 'initialize', E));
  });
  it('rejects mismatched environment id or a tenant id', async () => {
    const { http, environmentAuthority } = build();
    await expectRejected(
      await call(http, 'ec', 'environmentGet', { ...E, environmentId: 'other' })
    );
    await expectRejected(await call(http, 'ec', 'environmentGet', { pairId: 'pair-a' }));
    expect(environmentAuthority.get).not.toHaveBeenCalled();
  });
  it('controller actions forward exact payloads', async () => {
    const { http, environmentAuthority: a } = build();
    const cases: Array<[string, string]> = [
      ['environmentInitialize', 'initialize'],
      ['environmentBeginDrain', 'beginDrain'],
      ['environmentGetOperation', 'getOperation'],
      ['environmentPromote', 'promote'],
      ['environmentCancelDrain', 'cancelDrain'],
    ];
    for (const [action, method] of cases) {
      const payload = { ...E, x: action };
      const r = await call(http, 'ec', action, payload);
      expect(await r.json()).toEqual({ from: method });
      expect(a[method]).toHaveBeenCalledWith(payload);
    }
    const reg = await call(http, 'ec', 'environmentRegisterGeneration', { ...E, g: 1 });
    expect(await reg.json()).toEqual({ registered: true });
    expect(a.registerGeneration).toHaveBeenCalledWith({ ...E, g: 1 });
  });
  it('environmentGet requires exact keys and uses the credential scope', async () => {
    const { http, environmentAuthority: a } = build();
    const r = await call(http, 'ec', 'environmentGet', E);
    expect(await r.json()).toEqual({ from: 'get' });
    expect(a.get).toHaveBeenCalledWith('pair-a', 'env-a');
    await expectRejected(await call(http, 'ec', 'environmentGet', { ...E, extra: 1 }));
  });
  it('environmentGetGeneration requires exact keys', async () => {
    const { http, environmentAuthority: a } = build();
    const payload = { ...E, deploymentId: 'aws-a', epoch: 2, generationId: 'g' };
    const r = await call(http, 'ec', 'environmentGetGeneration', payload);
    expect(await r.json()).toEqual({ from: 'getGeneration' });
    expect(a.getGeneration).toHaveBeenCalledWith(payload);
    await expectRejected(
      await call(http, 'ec', 'environmentGetGeneration', { ...payload, extra: 1 })
    );
    const { generationId: _g, ...missing } = payload;
    await expectRejected(await call(http, 'ec', 'environmentGetGeneration', missing));
  });
  it('environmentVerifyGeneration forces identity and requires exact keys', async () => {
    const { http, environmentAuthority: a } = build();
    const payload = { ...E, operationId: 'op', proof: { p: 1 } };
    const r = await call(http, 'ec', 'environmentVerifyGeneration', payload);
    expect(await r.json()).toEqual({ from: 'verifyGeneration' });
    expect(a.verifyGeneration).toHaveBeenCalledWith(
      { pairId: 'pair-a', environmentId: 'env-a', operationId: 'op' },
      { p: 1 }
    );
    await expectRejected(
      await call(http, 'ec', 'environmentVerifyGeneration', { ...payload, extra: 1 })
    );
    await expectRejected(
      await call(http, 'ec', 'environmentVerifyGeneration', { ...E, operationId: 'op' })
    );
  });
  it('controllers cannot use writer actions', async () => {
    const { http, environmentAuthority: a } = build();
    for (const action of ['environmentEnter', 'environmentComplete']) {
      await expectRejected(await call(http, 'ec', action, { ...E, deploymentId: 'aws-a' }));
    }
    expect(a.enter).not.toHaveBeenCalled();
    expect(a.complete).not.toHaveBeenCalled();
  });
  it('controllers may read the serving generation with exact keys', async () => {
    const { http, environmentAuthority: a } = build();
    const payload = { ...E, deploymentId: 'aws-a' };
    const r = await call(http, 'ec', 'environmentGetServingGeneration', payload);
    expect(await r.json()).toEqual({ from: 'getServingGeneration' });
    expect(a.getServingGeneration).toHaveBeenCalledWith(payload);
    await expectRejected(
      await call(http, 'ec', 'environmentGetServingGeneration', { ...payload, extra: 1 })
    );
    await expectRejected(await call(http, 'ec', 'environmentGetServingGeneration', E));
  });
  it('writers may only enter, complete or read serving generation for their deployment', async () => {
    const { http, environmentAuthority: a } = build();
    const payload = { ...E, deploymentId: 'aws-a', w: 1 };
    const enter = await call(http, 'ew', 'environmentEnter', payload);
    expect(await enter.json()).toEqual({ from: 'enter' });
    expect(a.enter).toHaveBeenCalledWith(payload);
    const complete = await call(http, 'ew', 'environmentComplete', payload);
    expect(await complete.json()).toEqual({ completed: true });
    expect(a.complete).toHaveBeenCalledWith(payload);
    const serving = await call(http, 'ew', 'environmentGetServingGeneration', {
      ...E,
      deploymentId: 'aws-a',
    });
    expect(await serving.json()).toEqual({ from: 'getServingGeneration' });
    await expectRejected(
      await call(http, 'ew', 'environmentEnter', { ...payload, deploymentId: 'x' })
    );
    await expectRejected(await call(http, 'ew', 'environmentEnter', E));
    for (const action of [
      'environmentInitialize',
      'environmentGet',
      'environmentBeginDrain',
      'environmentGetOperation',
      'environmentRegisterGeneration',
      'environmentGetGeneration',
      'environmentVerifyGeneration',
      'environmentPromote',
      'environmentCancelDrain',
      'environmentBogus',
    ]) {
      await expectRejected(await call(http, 'ew', action, { ...E, deploymentId: 'aws-a' }));
    }
    expect(a.promote).not.toHaveBeenCalled();
    expect(a.initialize).not.toHaveBeenCalled();
  });
  it('unknown environment actions are rejected', async () => {
    const { http } = build();
    await expectRejected(await call(http, 'ec', 'environmentBogus', E));
  });
  it('redacts backing failures', async () => {
    const { http, environmentAuthority: a, authority } = build();
    a.promote.mockRejectedValue(new Error('private db detail'));
    const r = await call(http, 'ec', 'environmentPromote', E);
    expect(await r.text()).not.toContain('private');
    expect(r.status).toBe(409);
    authority.promote.mockRejectedValue(new Error('private db detail'));
    await expectRejected(await call(http, 'tc', 'promote', T));
  });
});
