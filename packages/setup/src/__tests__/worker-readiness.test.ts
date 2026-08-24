import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWorkerDeployments: vi.fn(),
  fetchWithPublicDns: vi.fn(),
}));

vi.mock('../core/cloudflare.js', () => ({
  getWorkerDeployments: mocks.getWorkerDeployments,
}));

vi.mock('../core/public-dns-fetch.js', () => ({
  fetchWithPublicDns: mocks.fetchWithPublicDns,
  isDnsResolutionError: (error: unknown) =>
    (error as { cause?: { code?: string } })?.cause?.code === 'ENOTFOUND',
}));

import {
  buildWorkerHttpReadinessTargets,
  waitForRouterWorkerReady,
  waitForTenantRoutingReady,
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
    mocks.fetchWithPublicDns.mockReset();
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
      allowPublicDnsFallback: false,
      maxWaitMs: 0,
      initialDelayMs: 1,
    });

    expect(result.ready).toBe(false);
    expect(result.error).toContain('fetch failed');
    expect(result.error).toContain('ENOTFOUND');
    expect(result.error).toContain('api.example.com');
  });

  it('uses public DNS immediately after the system resolver misses the router hostname', async () => {
    const details: string[] = [];
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    );
    mocks.fetchWithPublicDns.mockResolvedValueOnce(
      textResponse(JSON.stringify({ status: 'ok' }), 200)
    );

    const result = await waitForRouterWorkerReady({
      apiBaseUrl: 'https://api.example.com',
      maxWaitMs: 0,
      onDetail: (message) => details.push(message),
    });

    expect(result).toMatchObject({ ready: true, attempts: 1 });
    expect(mocks.fetchWithPublicDns).toHaveBeenCalledWith(
      'https://api.example.com/api/health',
      expect.objectContaining({ method: 'GET' }),
      expect.any(Number)
    );
    expect(details.join('\n')).toContain('Cloudflare public DNS');
  });

  it('does not use public DNS to bypass an HTTP routing failure', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('not found', 404));

    const result = await waitForRouterWorkerReady({
      apiBaseUrl: 'https://api.example.com',
      maxWaitMs: 0,
    });

    expect(result).toMatchObject({ ready: false, attempts: 1 });
    expect(mocks.fetchWithPublicDns).not.toHaveBeenCalled();
  });
});

describe('waitForTenantRoutingReady', () => {
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

  it('waits through tenant directory propagation without exposing raw errors in progress', async () => {
    const progress: string[] = [];
    const details: string[] = [];
    fetchMock
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ error: 'not_found', message: 'Tenant not found' }), 404)
      )
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ issuer: 'https://first.example.com' }), 200)
      );

    const result = await waitForTenantRoutingReady({
      apiBaseUrl: 'https://first.example.com',
      maxWaitMs: 1_000,
      initialDelayMs: 1,
      maxDelayMs: 1,
      onProgress: (message) => progress.push(message),
      onDetail: (message) => details.push(message),
    });

    expect(result).toMatchObject({ ready: true, attempts: 2, issuer: 'https://first.example.com' });
    expect(progress.some((message) => message.includes('Waiting for tenant routing'))).toBe(true);
    expect(progress.join('\n')).not.toContain('Tenant not found');
    expect(details.join('\n')).toContain('Tenant not found');
  });

  it('rejects discovery metadata for a different issuer', async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(JSON.stringify({ issuer: 'https://other.example.com' }), 200)
    );

    const result = await waitForTenantRoutingReady({
      apiBaseUrl: 'https://first.example.com',
      maxWaitMs: 0,
    });

    expect(result).toMatchObject({ ready: false });
    expect(result.error).toContain('Unexpected issuer');
  });

  it('reads discovery metadata returned through public DNS fallback', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    );
    mocks.fetchWithPublicDns.mockResolvedValueOnce(
      textResponse(JSON.stringify({ issuer: 'https://first.example.com' }), 200)
    );

    const result = await waitForTenantRoutingReady({
      apiBaseUrl: 'https://first.example.com',
      maxWaitMs: 0,
    });

    expect(result).toMatchObject({
      ready: true,
      attempts: 1,
      issuer: 'https://first.example.com',
    });
    expect(mocks.fetchWithPublicDns).toHaveBeenCalledWith(
      'https://first.example.com/.well-known/openid-configuration',
      expect.objectContaining({ method: 'GET' }),
      expect.any(Number)
    );
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

  it('allows the initial tenant registry bootstrap gap only for dependent health checks', async () => {
    fetchMock
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ error: 'missing_snapshot', tenant_id: 'default' }), 409)
      )
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ error: 'missing_generation', tenant_id: 'default' }), 409)
      )
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ error: 'missing_generation', tenant_id: 'default' }), 409)
      );

    const result = await waitForWorkerHttpReady({
      targets: [
        {
          workerName: 'dev-ar-auth',
          url: 'https://dev-ar-auth.example.workers.dev/api/auth/health',
        },
        {
          workerName: 'dev-ar-policy',
          url: 'https://dev-ar-policy.example.workers.dev/api/check/health',
        },
        {
          workerName: 'dev-ar-saml',
          url: 'https://dev-ar-saml.example.workers.dev/saml/health',
        },
      ],
      allowTenantRegistryBootstrapGap: true,
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(true);
  });

  it('does not hide a tenant registry bootstrap gap for an unrelated worker', async () => {
    fetchMock.mockResolvedValue(
      textResponse(JSON.stringify({ error: 'missing_generation', tenant_id: 'default' }), 409)
    );

    const result = await waitForWorkerHttpReady({
      targets: [
        {
          workerName: 'dev-ar-token',
          url: 'https://dev-ar-token.example.workers.dev/api/health',
        },
      ],
      allowTenantRegistryBootstrapGap: true,
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(false);
    expect(result.error).toContain('missing_generation');
  });

  it('verifies a new custom domain through public DNS after a system DNS miss', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    );
    mocks.fetchWithPublicDns.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await waitForWorkerHttpReady({
      targets: [
        {
          workerName: 'dev-ar-admin-ui',
          url: 'https://admin.dev.example.com',
        },
      ],
      allowPublicDnsFallback: true,
      maxWaitMs: 0,
    });

    expect(result.ready).toBe(true);
    expect(mocks.fetchWithPublicDns).toHaveBeenCalledWith(
      'https://admin.dev.example.com',
      expect.objectContaining({ method: 'GET' }),
      expect.any(Number)
    );
  });

  it('does not hide a missing tenant snapshot outside the initial deploy gate', async () => {
    fetchMock.mockResolvedValue(
      textResponse(JSON.stringify({ error: 'missing_snapshot', tenant_id: 'default' }), 409)
    );

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
    expect(result.error).toContain('missing_snapshot');
  });
});
