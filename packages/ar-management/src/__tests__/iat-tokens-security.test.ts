import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  hash: vi.fn(async () => 'a'.repeat(64)),
  audit: vi.fn(async () => undefined),
  logError: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.VALIDATION_INVALID_VALUE]: 400,
    [actual.AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    hashInitialAccessToken: mocks.hash,
    createAuditLogFromContext: mocks.audit,
    getLogger: () => ({ module: () => ({ error: mocks.logError }) }),
    createErrorResponse: (
      c: { json: (body: unknown, status?: number) => Response },
      code: string
    ) => c.json({ error_code: code }, statusByCode[code] ?? 500),
  };
});

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { adminIATCreateHandler, adminIATListHandler, adminIATRevokeHandler } from '../iat-tokens';

type Kv = {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function kv(): Kv {
  return {
    list: vi.fn(async () => ({ keys: [] })),
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function app() {
  const instance = new Hono<{ Bindings: { INITIAL_ACCESS_TOKENS?: Kv } }>();
  instance.get('/tokens', adminIATListHandler as never);
  instance.post('/tokens', adminIATCreateHandler as never);
  instance.delete('/tokens/:tokenHash', adminIATRevokeHandler as never);
  return instance;
}

function metadata(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    description: 'registration token',
    createdAt: '2026-07-14T00:00:00.000Z',
    expiresAt: '2026-08-13T00:00:00.000Z',
    single_use: false,
    type: 'iat',
    ...overrides,
  });
}

describe('initial access token security behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['GET', '/tokens'],
    ['POST', '/tokens'],
    ['DELETE', `/tokens/${'a'.repeat(64)}`],
  ])('fails closed when token storage is unavailable for %s', async (method, path) => {
    const response = await app().request(path, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error_code: AR_ERROR_CODES.INTERNAL_ERROR });
  });

  it('lists metadata without exposing token material and skips missing KV values', async () => {
    const store = kv();
    store.list.mockResolvedValue({
      keys: [{ name: `iat:${'a'.repeat(64)}` }, { name: `iat:${'b'.repeat(64)}` }],
    });
    store.get.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(null);

    const response = await app().request('/tokens', {}, { INITIAL_ACCESS_TOKENS: store });
    expect(response.status).toBe(200);
    const body = await response.json<{ tokens: Array<Record<string, unknown>>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.tokens[0]).toEqual({
      tokenHash: 'a'.repeat(64),
      description: 'registration token',
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-08-13T00:00:00.000Z',
      single_use: false,
    });
    expect(JSON.stringify(body)).not.toContain('plaintext');
    expect(store.get).toHaveBeenNthCalledWith(1, `iat:${'a'.repeat(64)}`);
  });

  it('returns a redacted internal error for corrupt token metadata', async () => {
    const store = kv();
    store.list.mockResolvedValue({ keys: [{ name: `iat:${'a'.repeat(64)}` }] });
    store.get.mockResolvedValue('{not-json');
    const response = await app().request('/tokens', {}, { INITIAL_ACCESS_TOKENS: store });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error_code: AR_ERROR_CODES.INTERNAL_ERROR });
    expect(mocks.logError).toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'text/plain'],
    [JSON.stringify({ expiresInDays: '30' }), 'application/json'],
    [JSON.stringify({ expiresInDays: 1.5 }), 'application/json'],
    [JSON.stringify({ expiresInDays: 0 }), 'application/json'],
    [JSON.stringify({ expiresInDays: 366 }), 'application/json'],
    ['{"expiresInDays":1e400}', 'application/json'],
    [JSON.stringify({ description: 42 }), 'application/json'],
    [JSON.stringify({ description: 'x'.repeat(257) }), 'application/json'],
    [JSON.stringify({ single_use: 'true' }), 'application/json'],
  ])(
    'rejects invalid creation input before generating or storing a token',
    async (body, contentType) => {
      const store = kv();
      const response = await app().request(
        '/tokens',
        { method: 'POST', headers: { 'Content-Type': contentType }, body },
        { INITIAL_ACCESS_TOKENS: store }
      );
      expect(response.status).toBe(400);
      expect(mocks.hash).not.toHaveBeenCalled();
      expect(store.put).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it('stores only a hash and returns the plaintext token exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    const store = kv();
    const response = await app().request(
      '/tokens',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: '  device registration\u0000  ',
          expiresInDays: 7,
          single_use: true,
        }),
      },
      { INITIAL_ACCESS_TOKENS: store }
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ token: string; tokenHash: string }>();
    expect(body.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.tokenHash).toBe('a'.repeat(64));
    expect(mocks.hash).toHaveBeenCalledWith(body.token);
    expect(store.put).toHaveBeenCalledTimes(1);
    const [key, storedValue, options] = store.put.mock.calls[0] as [
      string,
      string,
      { expirationTtl: number },
    ];
    expect(key).toBe(`iat:${'a'.repeat(64)}`);
    expect(storedValue).not.toContain(body.token);
    expect(JSON.parse(storedValue)).toEqual({
      description: 'device registration',
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-21T00:00:00.000Z',
      single_use: true,
      type: 'iat',
    });
    expect(options.expirationTtl).toBe(7 * 24 * 60 * 60);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'iat.token.create',
      'iat_token',
      'aaaaaaaa',
      expect.objectContaining({ expiresInDays: 7, single_use: true })
    );
  });

  it('uses safe defaults for blank nullable creation fields', async () => {
    const store = kv();
    const response = await app().request(
      '/tokens',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: '   ', expiresInDays: null, single_use: null }),
      },
      { INITIAL_ACCESS_TOKENS: store }
    );
    expect(response.status).toBe(201);
    expect(store.put).toHaveBeenCalledWith(
      `iat:${'a'.repeat(64)}`,
      expect.stringContaining('Initial Access Token for Dynamic Client Registration'),
      { expirationTtl: 30 * 24 * 60 * 60 }
    );
  });

  it.each(['short', 'g'.repeat(64), '../other-key', 'A'.repeat(64)])(
    'rejects malformed token hash %s before KV access',
    async (tokenHash) => {
      const store = kv();
      const response = await app().request(
        `/tokens/${encodeURIComponent(tokenHash)}`,
        { method: 'DELETE' },
        { INITIAL_ACCESS_TOKENS: store }
      );
      expect(response.status).toBe(400);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.delete).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it('does not reveal whether an unknown valid hash has related metadata', async () => {
    const store = kv();
    const hash = 'b'.repeat(64);
    const response = await app().request(
      `/tokens/${hash}`,
      { method: 'DELETE' },
      { INITIAL_ACCESS_TOKENS: store }
    );
    expect(response.status).toBe(404);
    expect(store.delete).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('revokes an existing token and audits only a hash prefix', async () => {
    const store = kv();
    const hash = 'c'.repeat(64);
    store.get.mockResolvedValue(metadata());
    const response = await app().request(
      `/tokens/${hash}`,
      { method: 'DELETE' },
      { INITIAL_ACCESS_TOKENS: store }
    );
    expect(response.status).toBe(200);
    expect(store.delete).toHaveBeenCalledWith(`iat:${hash}`);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'iat.token.revoke',
      'iat_token',
      'cccccccc',
      {},
      'warning'
    );
  });

  it('does not emit a success audit when storage creation or deletion fails', async () => {
    const createStore = kv();
    createStore.put.mockRejectedValue(new Error('KV unavailable'));
    expect(
      (
        await app().request(
          '/tokens',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
          { INITIAL_ACCESS_TOKENS: createStore }
        )
      ).status
    ).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();

    const revokeStore = kv();
    revokeStore.get.mockResolvedValue(metadata());
    revokeStore.delete.mockRejectedValue(new Error('KV unavailable'));
    expect(
      (
        await app().request(
          `/tokens/${'d'.repeat(64)}`,
          { method: 'DELETE' },
          { INITIAL_ACCESS_TOKENS: revokeStore }
        )
      ).status
    ).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
