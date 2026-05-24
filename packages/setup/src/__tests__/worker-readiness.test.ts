import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWorkerDeployments: vi.fn(),
}));

vi.mock('../core/cloudflare.js', () => ({
  getWorkerDeployments: mocks.getWorkerDeployments,
}));

import {
  buildWorkerHttpReadinessTargets,
  waitForRouterWorkerReady,
  waitForWorkerDeploymentsReady,
  waitForWorkerHttpReady,
} from '../core/worker-readiness.js';

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
    mocks.getWorkerDeployments.mockReset();
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
      maxWaitMs: 1000,
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

  it('includes fetch cause details when the router cannot be reached', async () => {
    const error = new TypeError('fetch failed') as TypeError & {
      cause: Error & { code: string; syscall: string; hostname: string };
    };
    error.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'api.example.com',
    });
    fetchMock.mockRejectedValue(error);

    const result = await waitForRouterWorkerReady({
      apiBaseUrl: 'https://api.example.com',
      maxWaitMs: 0,
      initialDelayMs: 1,
    });

    expect(result.ready).toBe(false);
    expect(result.error).toContain('fetch failed');
    expect(result.error).toContain('ENOTFOUND');
    expect(result.error).toContain('api.example.com');
  });
});

describe('waitForWorkerDeploymentsReady', () => {
  it('returns ready when every worker deployment is visible and current', async () => {
    mocks.getWorkerDeployments.mockResolvedValue({
      exists: true,
      lastDeployedAt: '2026-05-18T00:00:30.000Z',
    });

    const result = await waitForWorkerDeploymentsReady({
      targets: [
        { workerName: 'dev-ar-auth', deployedAt: '2026-05-18T00:00:00.000Z' },
        { workerName: 'dev-ar-router', deployedAt: '2026-05-18T00:00:00.000Z' },
      ],
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(true);
    expect(result.checkedWorkers).toEqual(['dev-ar-auth', 'dev-ar-router']);
    expect(result.missingWorkers).toEqual([]);
    expect(result.staleWorkers).toEqual([]);
  });

  it('reports missing and stale workers when deployment visibility does not converge', async () => {
    mocks.getWorkerDeployments.mockImplementation(async (workerName: string) => {
      if (workerName === 'dev-ar-auth') {
        return { exists: false, lastDeployedAt: null };
      }
      return { exists: true, lastDeployedAt: '2026-05-17T23:00:00.000Z' };
    });

    const result = await waitForWorkerDeploymentsReady({
      targets: [
        { workerName: 'dev-ar-auth', deployedAt: '2026-05-18T00:00:00.000Z' },
        { workerName: 'dev-ar-router', deployedAt: '2026-05-18T00:00:00.000Z' },
      ],
      requireFreshDeployment: true,
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(false);
    expect(result.missingWorkers).toEqual(['dev-ar-auth']);
    expect(result.staleWorkers).toEqual(['dev-ar-router']);
    expect(result.error).toContain('missing: dev-ar-auth');
    expect(result.error).toContain('stale: dev-ar-router');
  });

  it('treats existing workers as visible by default even when deployment timestamps are older', async () => {
    mocks.getWorkerDeployments.mockResolvedValue({
      exists: true,
      lastDeployedAt: '2026-05-17T23:00:00.000Z',
    });

    const result = await waitForWorkerDeploymentsReady({
      targets: [{ workerName: 'dev-ar-router', deployedAt: '2026-05-18T00:00:00.000Z' }],
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(true);
    expect(result.staleWorkers).toEqual([]);
  });
});

describe('Worker HTTP readiness helpers', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds health check targets for API workers and skips UI workers', () => {
    expect(
      buildWorkerHttpReadinessTargets(
        [
          { workerName: 'dev-ar-auth' },
          { workerName: 'dev-ar-token' },
          { workerName: 'dev-ar-saml' },
          { workerName: 'dev-ar-admin-ui' },
        ],
        'example'
      )
    ).toEqual([
      {
        workerName: 'dev-ar-auth',
        url: 'https://dev-ar-auth.example.workers.dev/api/auth/health',
      },
      {
        workerName: 'dev-ar-token',
        url: 'https://dev-ar-token.example.workers.dev/api/health',
      },
      {
        workerName: 'dev-ar-saml',
        url: 'https://dev-ar-saml.example.workers.dev/saml/health',
      },
    ]);
  });

  it('skips workers.dev health check targets when workers.dev is disabled', () => {
    expect(
      buildWorkerHttpReadinessTargets(
        [{ workerName: 'dev-ar-auth' }, { workerName: 'dev-ar-router' }],
        'example',
        { workersDevEnabled: false }
      )
    ).toEqual([]);
  });

  it('returns ready when all worker health endpoints respond', async () => {
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ status: 'ok' }), 200));

    const result = await waitForWorkerHttpReady({
      targets: [
        {
          workerName: 'dev-ar-auth',
          url: 'https://dev-ar-auth.example.workers.dev/api/auth/health',
        },
        {
          workerName: 'dev-ar-token',
          url: 'https://dev-ar-token.example.workers.dev/api/health',
        },
      ],
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports failed worker health endpoints after timeout', async () => {
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ status: 'starting' }), 503));

    const result = await waitForWorkerHttpReady({
      targets: [
        {
          workerName: 'dev-ar-auth',
          url: 'https://dev-ar-auth.example.workers.dev/api/auth/health',
        },
      ],
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(false);
    expect(result.failedWorkers).toEqual([
      expect.objectContaining({
        workerName: 'dev-ar-auth',
        error: expect.stringContaining('HTTP 503'),
      }),
    ]);
    expect(result.error).toContain('dev-ar-auth');
  });
});
