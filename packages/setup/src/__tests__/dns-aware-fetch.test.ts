import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithPublicDns: vi.fn(),
}));

vi.mock('../core/public-dns-fetch.js', () => ({
  fetchWithPublicDns: mocks.fetchWithPublicDns,
  isDnsResolutionError: (error: unknown) =>
    (error as { cause?: { code?: string } })?.cause?.code === 'ENOTFOUND',
}));

import { fetchWithDnsFallback } from '../core/dns-aware-fetch.js';

describe('fetchWithDnsFallback', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mocks.fetchWithPublicDns.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves POST bodies when retrying a DNS miss through public DNS', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    );
    mocks.fetchWithPublicDns.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const response = await fetchWithDnsFallback(
      'https://api.example.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      },
      { allowPublicDnsFallback: true }
    );

    expect(response.ok).toBe(true);
    expect(mocks.fetchWithPublicDns).toHaveBeenCalledWith(
      new URL('https://api.example.com/token'),
      expect.objectContaining({
        method: 'POST',
        body: 'grant_type=client_credentials',
      }),
      expect.any(Number)
    );
  });

  it('does not treat an HTTP failure as a DNS failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));

    const response = await fetchWithDnsFallback(
      'https://api.example.com/health',
      {},
      { allowPublicDnsFallback: true }
    );

    expect(response.status).toBe(503);
    expect(mocks.fetchWithPublicDns).not.toHaveBeenCalled();
  });

  it('rejects before starting a request when the shared deadline has expired', async () => {
    await expect(
      fetchWithDnsFallback('https://api.example.com/health', {}, { deadlineAt: Date.now() - 1 })
    ).rejects.toThrow('request_deadline_exceeded');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.fetchWithPublicDns).not.toHaveBeenCalled();
  });

  it('aborts the public-DNS retry when the remaining shared deadline expires', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    );
    mocks.fetchWithPublicDns.mockImplementationOnce(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () => reject(new Error('public_dns_fetch_aborted'));
        if (init.signal?.aborted) rejectAborted();
        else init.signal?.addEventListener('abort', rejectAborted, { once: true });
      });
    });

    await expect(
      fetchWithDnsFallback(
        'https://api.example.com/health',
        {},
        { allowPublicDnsFallback: true, deadlineAt: Date.now() + 20 }
      )
    ).rejects.toThrow('public_dns_fetch_aborted');

    expect(mocks.fetchWithPublicDns.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
