import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  executeD1Batch,
  listD1Databases,
  parseCloudflareRetryAfterMs,
} from '../core/cloudflare.js';

describe('Cloudflare setup REST deadlines', () => {
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'private-test-token';
  });

  afterEach(() => {
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
    vi.unstubAllGlobals();
  });

  it('retries a read after a network rejection without exposing the provider error', async () => {
    fetchMock
      .mockRejectedValueOnce(
        new Error('request failed for https://api.cloudflare.test/?token=private-test-token')
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ name: 'test-authrim-core-db', uuid: 'database-id' }],
          result_info: { total_count: 1 },
        }),
      });

    await expect(listD1Databases()).resolves.toEqual([
      { name: 'test-authrim-core-db', uuid: 'database-id' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('retries a half-open read after aborting its expired attempt', async () => {
    let firstSignal: AbortSignal | undefined;
    fetchMock
      .mockImplementationOnce(
        (_input: string | URL, init?: globalThis.RequestInit) =>
          new Promise((_resolve, reject) => {
            firstSignal = init?.signal ?? undefined;
            const rejectAborted = () =>
              reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
            if (firstSignal?.aborted) rejectAborted();
            else firstSignal?.addEventListener('abort', rejectAborted, { once: true });
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ name: 'test-authrim-core-db', uuid: 'database-id' }],
          result_info: { total_count: 1 },
        }),
      });

    await expect(listD1Databases()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstSignal?.aborted).toBe(true);
  });

  it('parses delta and HTTP-date Retry-After values with a bounded delay', () => {
    const now = Date.parse('2026-08-31T00:00:00.000Z');
    expect(parseCloudflareRetryAfterMs('1.5', now)).toBe(1_500);
    expect(parseCloudflareRetryAfterMs('Sun, 31 Aug 2026 00:00:12 GMT', now)).toBe(12_000);
    expect(parseCloudflareRetryAfterMs('3600', now)).toBe(30_000);
    expect(parseCloudflareRetryAfterMs('not-a-delay', now)).toBeNull();
  });

  it('aborts a half-open D1 mutation and never resends the ambiguous batch', async () => {
    let observedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_input: string | URL, init?: globalThis.RequestInit) =>
        new Promise((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          const rejectAborted = () =>
            reject(Object.assign(new Error('transport aborted'), { name: 'AbortError' }));
          if (observedSignal?.aborted) rejectAborted();
          else observedSignal?.addEventListener('abort', rejectAborted, { once: true });
        })
    );

    await expect(
      executeD1Batch('11111111-1111-1111-1111-111111111111', [{ sql: 'SELECT 1' }])
    ).rejects.toThrow('cloudflare_d1_batch_ambiguous');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(true);
  });

  it('stops a repeatedly half-open read after the bounded retry budget', async () => {
    fetchMock.mockImplementation(
      (_input: string | URL, init?: globalThis.RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAborted = () =>
            reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
          if (signal?.aborted) rejectAborted();
          else signal?.addEventListener('abort', rejectAborted, { once: true });
        })
    );
    execaMock.mockRejectedValue(new Error('Wrangler inventory unavailable'));

    const failure = await listD1Databases().catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      'Cloudflare D1 database list failed after 4 attempts (request timeout)'
    );
    expect((failure as Error).message).not.toContain('private-test-token');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry an ambiguous D1 mutation after a provider 5xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'retry-after': '1' }),
      json: async () => ({ success: false }),
    });

    await expect(
      executeD1Batch('11111111-1111-1111-1111-111111111111', [{ sql: 'SELECT 1' }])
    ).rejects.toThrow('cloudflare_d1_batch_ambiguous:503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
