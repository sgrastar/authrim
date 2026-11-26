/**
 * Credential offer route: every way an offer stays hidden, the fetch record and the response.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return { logger, parseCode: vi.fn(), offerStore: vi.fn(), isConfiguredShard: vi.fn() };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getLogger: () => h.logger,
  getTenantIdFromContext: () => 'tenant-1',
}));
vi.mock('../../../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/configured-shard')>()),
  isConfiguredShard: h.isConfiguredShard,
}));
vi.mock('../../../utils/credential-offer-sharding', () => ({
  parsePreAuthorizedCode: h.parseCode,
  getCredentialOfferStoreById: h.offerStore,
}));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://issuer.example.com',
}));

import { ShardConfigUnavailableError } from '../../../utils/configured-shard';
import { credentialOfferRoute } from '../offer';

const NOW_MS = 1_800_000_000_000;
const GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';
let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };

const offer = (overrides: Record<string, unknown> = {}) => ({
  id: 'offer-1',
  credentialConfigurationId: 'AuthrimIdentityCredential',
  txCodeRequired: false,
  status: 'pending',
  expiresAt: NOW_MS + 1000,
  ...overrides,
});
const answer = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), { status: ok ? 200 : 404 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  stub.fetch.mockImplementation(async (request: Request) =>
    new URL(request.url).pathname === '/get' ? answer(offer()) : answer({ marked: true })
  );
  h.parseCode.mockReturnValue({ offerId: 'offer-1' });
  h.offerStore.mockReturnValue({ stub, resolution: 'r' });
  h.isConfiguredShard.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

async function get(reference = 'code-1') {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/offers/:id', credentialOfferRoute);
  app.get('/offers', credentialOfferRoute);
  const response = await app.request(
    `https://issuer.example.com/offers${reference ? `/${reference}` : ''}`,
    {},
    {} as Env
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const notFound = { status: 404, body: { error: 'not_found' } };

describe('credentialOfferRoute', () => {
  it('names its logger module', async () => {
    await get();
    expect(h.logger.module).toHaveBeenCalledWith('VC-ISSUER');
  });

  it('returns the offer for a pending one, without caching', async () => {
    const result = await get('code-1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      credential_issuer: 'https://issuer.example.com',
      credential_configuration_ids: ['AuthrimIdentityCredential'],
      grants: { [GRANT]: { 'pre-authorized_code': 'code-1' } },
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(h.parseCode).toHaveBeenCalledWith('code-1');
    expect(h.offerStore).toHaveBeenCalledWith({}, 'offer-1', 'tenant-1');
    expect(h.isConfiguredShard).toHaveBeenCalledWith({}, 'tenant-1', 'r');
  });

  it('asks for the transaction code when the offer needs one', async () => {
    stub.fetch.mockImplementation(async (request: Request) =>
      new URL(request.url).pathname === '/get'
        ? answer(offer({ txCodeRequired: true }))
        : answer({})
    );
    const result = await get();
    expect(result.body).toMatchObject({
      grants: {
        [GRANT]: {
          'pre-authorized_code': 'code-1',
          tx_code: { input_mode: 'numeric', length: 6, description: 'Enter the PIN you received' },
        },
      },
    });
  });

  it('looks the offer up by its id in the tenant', async () => {
    h.parseCode.mockReturnValue({ offerId: 'offer/1 x' });
    await get();
    const request = stub.fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe('https://internal/get?id=offer%2F1%20x&tenant_id=tenant-1');
  });

  it('records the first fetch for the owner and still answers when that fails', async () => {
    await get();
    const record = stub.fetch.mock.calls[1][0] as Request;
    expect(new URL(record.url).pathname).toBe('/offer/fetched');
    expect(record.method).toBe('POST');
    expect(record.headers.get('Content-Type')).toBe('application/json');
    expect(await record.json()).toEqual({ id: 'offer-1', tenantId: 'tenant-1', now: NOW_MS });
    stub.fetch.mockImplementation(async (request: Request) => {
      if (new URL(request.url).pathname === '/get') return answer(offer());
      throw new Error('store down');
    });
    expect((await get()).status).toBe(200);
    expect(h.logger.warn).toHaveBeenCalledWith(
      'Failed to record credential offer fetch',
      {},
      expect.objectContaining({ message: 'store down' })
    );
  });

  it('hides offers that are unknown, malformed, foreign to the shard config, used or expired', async () => {
    expect(await get('')).toMatchObject(notFound);
    h.parseCode.mockReturnValue(null);
    expect(await get()).toMatchObject(notFound);
    h.parseCode.mockReturnValue({ offerId: 'offer-1' });
    h.isConfiguredShard.mockResolvedValue(false);
    expect(await get()).toMatchObject(notFound);
    expect(stub.fetch).not.toHaveBeenCalled();
    h.isConfiguredShard.mockResolvedValue(true);
    stub.fetch.mockResolvedValue(answer({}, false));
    expect(await get()).toMatchObject(notFound);
    for (const overrides of [
      { status: 'consumed' },
      { status: 'processing' },
      { status: 'expired' },
      { expiresAt: NOW_MS - 1 },
    ]) {
      stub.fetch.mockImplementation(async () => answer(offer(overrides)));
      expect(await get()).toMatchObject(notFound);
    }
  });

  it('serves an offer that is still valid and hides one that has expired', async () => {
    stub.fetch.mockImplementation(async (request: Request) =>
      new URL(request.url).pathname === '/get'
        ? answer(offer({ expiresAt: NOW_MS + 1 }))
        : answer({})
    );
    expect((await get()).status).toBe(200);
    stub.fetch.mockImplementation(async (request: Request) =>
      new URL(request.url).pathname === '/get'
        ? answer(offer({ expiresAt: NOW_MS - 1 }))
        : answer({})
    );
    expect((await get()).status).toBe(404);
  });

  it('treats the exact expiry instant as expired, like the store does', async () => {
    const serve = (expiresAt: number) =>
      stub.fetch.mockImplementation(async (request: Request) =>
        new URL(request.url).pathname === '/get' ? answer(offer({ expiresAt })) : answer({})
      );
    serve(NOW_MS - 1);
    expect((await get()).status).toBe(404);
    serve(NOW_MS);
    expect((await get()).status).toBe(404);
    serve(NOW_MS + 1);
    expect((await get()).status).toBe(200);
  });

  it('hides every not-found answer from caches', async () => {
    h.parseCode.mockReturnValue(null);
    expect((await get()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 503 when the shard configuration cannot be read and 500 for other failures', async () => {
    h.isConfiguredShard.mockRejectedValue(new ShardConfigUnavailableError('kv'));
    const unavailable = await get();
    expect(unavailable).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
    expect(unavailable.headers.get('Cache-Control')).toBe('no-store');
    h.isConfiguredShard.mockRejectedValue(new Error('boom'));
    const failed = await get();
    expect(failed).toMatchObject({ status: 500, body: { error: 'server_error' } });
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(h.logger.error).toHaveBeenCalledWith(
      'Credential offer retrieval failed',
      {},
      expect.objectContaining({ message: 'boom' })
    );
  });
});
