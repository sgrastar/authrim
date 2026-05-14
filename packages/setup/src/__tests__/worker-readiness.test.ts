import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForRouterWorkerReady } from '../core/worker-readiness.js';

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('waitForRouterWorkerReady', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns immediately when router health is reachable', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(JSON.stringify({ status: 'ok' }), 200));

    const result = await waitForRouterWorkerReady({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev/',
      maxWaitMs: 1,
      initialDelayMs: 1,
    });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.checkedUrl).toBe('https://single-ar-router.example.workers.dev/api/health');
  });

  it('backs off and retries while workers.dev route propagation returns Cloudflare 1042', async () => {
    const progress: string[] = [];

    fetchMock
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            error_code: 1042,
            error_name: 'workers_dev_script_not_found',
            detail: 'No Workers script was found for this host on workers.dev.',
          }),
          404
        )
      )
      .mockResolvedValueOnce(textResponse(JSON.stringify({ status: 'ok' }), 200));

    const result = await waitForRouterWorkerReady({
      apiBaseUrl: 'https://single-ar-router.example.workers.dev',
      maxWaitMs: 100,
      initialDelayMs: 1,
      maxDelayMs: 2,
      onProgress: (message) => progress.push(message),
    });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress.some((message) => message.includes('Retrying in'))).toBe(true);
  });

  it('returns a clear failure after the readiness timeout', async () => {
    fetchMock.mockResolvedValue(
      textResponse(
        JSON.stringify({
          error_code: 1042,
          error_name: 'workers_dev_script_not_found',
        }),
        404
      )
    );

    const result = await waitForRouterWorkerReady({
      apiBaseUrl: 'https://missing-ar-router.example.workers.dev',
      maxWaitMs: 0,
      initialDelayMs: 1,
    });

    expect(result.ready).toBe(false);
    expect(result.error).toContain('HTTP 404');
    expect(result.error).toContain('workers_dev_script_not_found');
  });
});
