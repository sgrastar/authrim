import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployResult } from '../core/deploy.js';
import {
  configureDownstreamIntrospectionDeployment,
  createDownstreamIntrospectionFailure,
  resolveDownstreamIntrospectionApiBaseUrl,
  resolveDownstreamIntrospectionKeysDir,
} from '../core/downstream-introspection-deploy.js';
import { getWorkersSubdomain } from '../core/cloudflare.js';
import { deployWorker } from '../core/deploy.js';
import {
  ensureDownstreamIntrospectionClient,
  loadDownstreamIntrospectionClientSecrets,
} from '../core/downstream-introspection-client.js';
import { waitForRouterWorkerReady, waitForTenantRoutingReady } from '../core/worker-readiness.js';

vi.mock('../core/cloudflare.js', () => ({
  getWorkersSubdomain: vi.fn(),
}));

vi.mock('../core/deploy.js', () => ({
  deployWorker: vi.fn(),
}));

vi.mock('../core/downstream-introspection-client.js', () => ({
  ensureDownstreamIntrospectionClient: vi.fn(),
  loadDownstreamIntrospectionClientSecrets: vi.fn(),
}));

vi.mock('../core/worker-readiness.js', () => ({
  waitForRouterWorkerReady: vi.fn(),
  waitForTenantRoutingReady: vi.fn(),
}));

const tempDirs: string[] = [];

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'authrim-downstream-deploy-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(getWorkersSubdomain).mockReset();
  vi.mocked(deployWorker).mockReset();
  vi.mocked(ensureDownstreamIntrospectionClient).mockReset();
  vi.mocked(loadDownstreamIntrospectionClientSecrets).mockReset();
  vi.mocked(waitForRouterWorkerReady).mockReset();
  vi.mocked(waitForTenantRoutingReady).mockReset();
  vi.mocked(waitForRouterWorkerReady).mockResolvedValue({
    ready: true,
    attempts: 3,
    elapsedMs: 3000,
    checkedUrl: 'https://single-ar-router.example.com/api/health',
  });
  vi.mocked(waitForTenantRoutingReady).mockResolvedValue({
    ready: true,
    attempts: 1,
    elapsedMs: 10,
    checkedUrl: 'https://single-ar-router.example.com/.well-known/openid-configuration',
    issuer: 'https://single-ar-router.example.com',
  });
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('resolveDownstreamIntrospectionKeysDir', () => {
  it('prefers an explicit keysDir', () => {
    const rootDir = createTempRoot();
    const keysDir = join(rootDir, 'custom-keys');

    expect(
      resolveDownstreamIntrospectionKeysDir({
        env: 'single',
        rootDir,
        keysDir,
      })
    ).toBe(keysDir);
  });
});

describe('resolveDownstreamIntrospectionApiBaseUrl', () => {
  it('uses the explicit API base URL when provided', async () => {
    await expect(
      resolveDownstreamIntrospectionApiBaseUrl('single', 'https://api.example.com')
    ).resolves.toBe('https://api.example.com');
  });

  it('builds a workers.dev URL from the current subdomain', async () => {
    vi.mocked(getWorkersSubdomain).mockResolvedValue('sgrastar');

    await expect(resolveDownstreamIntrospectionApiBaseUrl('single')).resolves.toBe(
      'https://single-ar-router.sgrastar.workers.dev'
    );
  });
});

describe('configureDownstreamIntrospectionDeployment', () => {
  it('uses one complete operator contract for unexpected optional failures', () => {
    expect(createDownstreamIntrospectionFailure('unexpected provider failure')).toMatchObject({
      success: false,
      deferred: true,
      error: 'unexpected provider failure',
      retryable: true,
      impact: expect.stringContaining('Core login'),
      nextAction: expect.stringContaining('Rerun deploy'),
    });
  });

  it('provisions secrets and redeploys ar-userinfo', async () => {
    const rootDir = createTempRoot();
    const keysDir = join(rootDir, '.authrim-keys', 'single');
    const redeployResult: DeployResult = {
      component: 'ar-userinfo',
      workerName: 'single-ar-userinfo',
      success: true,
      deployedAt: new Date().toISOString(),
      version: '1.2.3',
    };

    vi.mocked(ensureDownstreamIntrospectionClient).mockResolvedValue({
      success: true,
      clientId: 'client-123',
      clientSecret: 'secret-123',
    });
    vi.mocked(loadDownstreamIntrospectionClientSecrets).mockResolvedValue({
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-123',
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-123',
    });
    vi.mocked(deployWorker).mockResolvedValue(redeployResult);

    const result = await configureDownstreamIntrospectionDeployment({
      env: 'single',
      rootDir,
      keysDir,
      apiBaseUrl: 'https://single-ar-router.example.com',
      tenantId: 'tenant-a',
    });

    expect(result.success).toBe(true);
    expect(result.clientId).toBe('client-123');
    expect(result.redeployResult).toEqual(redeployResult);
    expect(vi.mocked(ensureDownstreamIntrospectionClient)).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: 'https://single-ar-router.example.com',
        keysDir,
        tenantId: 'tenant-a',
        maxRetries: 24,
        deadlineAt: expect.any(Number),
        allowPublicDnsFallback: true,
        onProgress: undefined,
        onDetail: undefined,
      })
    );
    expect(vi.mocked(deployWorker)).toHaveBeenCalledWith(
      'ar-userinfo',
      expect.objectContaining({
        env: 'single',
        rootDir,
        dryRun: undefined,
        deploymentStrategy: 'staged',
        existingComponents: ['ar-userinfo'],
        secrets: {
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-123',
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-123',
        },
      })
    );
  });

  it('returns a failure when the deployment carrying the secrets fails', async () => {
    const rootDir = createTempRoot();
    const keysDir = join(rootDir, '.authrim-keys', 'single');

    vi.mocked(ensureDownstreamIntrospectionClient).mockResolvedValue({
      success: true,
      clientId: 'client-123',
      clientSecret: 'secret-123',
    });
    vi.mocked(loadDownstreamIntrospectionClientSecrets).mockResolvedValue({
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-123',
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-123',
    });
    vi.mocked(deployWorker).mockResolvedValue({
      component: 'ar-userinfo',
      workerName: 'single-ar-userinfo',
      success: false,
      error: 'version upload failed',
    });

    const result = await configureDownstreamIntrospectionDeployment({
      env: 'single',
      rootDir,
      keysDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('version upload failed');
    expect(result).toMatchObject({
      retryable: true,
      impact: expect.stringContaining('Core login'),
      nextAction: expect.stringContaining('Rerun deploy'),
    });
    expect(vi.mocked(deployWorker)).toHaveBeenCalledOnce();
  });

  it('returns complete operator guidance when generated secrets are missing', async () => {
    const rootDir = createTempRoot();
    const keysDir = join(rootDir, '.authrim-keys', 'single');

    vi.mocked(ensureDownstreamIntrospectionClient).mockResolvedValue({
      success: true,
      clientId: 'client-123',
      clientSecret: 'secret-123',
    });
    vi.mocked(loadDownstreamIntrospectionClientSecrets).mockResolvedValue(null);

    await expect(
      configureDownstreamIntrospectionDeployment({ env: 'single', rootDir, keysDir })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('secrets were not written'),
      retryable: true,
      impact: expect.stringContaining('Core login'),
      nextAction: expect.stringContaining('Rerun deploy'),
    });
    expect(vi.mocked(deployWorker)).not.toHaveBeenCalled();
  });

  it('falls back to the next API base URL candidate when readiness fails', async () => {
    const rootDir = createTempRoot();
    const keysDir = join(rootDir, '.authrim-keys', 'single');
    const redeployResult: DeployResult = {
      component: 'ar-userinfo',
      workerName: 'single-ar-userinfo',
      success: true,
      deployedAt: new Date().toISOString(),
      version: '1.2.3',
    };

    vi.mocked(waitForRouterWorkerReady)
      .mockResolvedValueOnce({
        ready: false,
        attempts: 12,
        elapsedMs: 300000,
        checkedUrl: 'https://first.example.com/api/health',
        error: 'HTTP 530: Error 1016',
      })
      .mockResolvedValueOnce({
        ready: true,
        attempts: 3,
        elapsedMs: 3000,
        checkedUrl: 'https://example.com/api/health',
      });
    vi.mocked(ensureDownstreamIntrospectionClient).mockResolvedValue({
      success: true,
      clientId: 'client-123',
      clientSecret: 'secret-123',
    });
    vi.mocked(loadDownstreamIntrospectionClientSecrets).mockResolvedValue({
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-123',
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-123',
    });
    vi.mocked(deployWorker).mockResolvedValue(redeployResult);

    const result = await configureDownstreamIntrospectionDeployment({
      env: 'single',
      rootDir,
      keysDir,
      apiBaseUrls: ['https://first.example.com', 'https://example.com'],
      tenantId: 'tenant-a',
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(ensureDownstreamIntrospectionClient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureDownstreamIntrospectionClient)).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: 'https://example.com',
      })
    );
    const routerCalls = vi.mocked(waitForRouterWorkerReady).mock.calls;
    expect(routerCalls).toHaveLength(3);
    expect(new Set(routerCalls.map(([options]) => options.deadlineAt)).size).toBe(1);
    expect(routerCalls[0]?.[0]).toMatchObject({
      maxWaitMs: 60_000,
      allowPublicDnsFallback: true,
    });
  });

  it('does not wait for a slow candidate after another candidate becomes ready', async () => {
    const rootDir = createTempRoot();
    const keysDir = join(rootDir, '.authrim-keys', 'single');

    vi.mocked(waitForRouterWorkerReady).mockImplementation(async ({ apiBaseUrl }) => {
      if (apiBaseUrl === 'https://slow.example.com') {
        return await new Promise(() => {});
      }
      return {
        ready: true,
        attempts: 1,
        elapsedMs: 1,
        checkedUrl: `${apiBaseUrl}/api/health`,
      };
    });
    vi.mocked(ensureDownstreamIntrospectionClient).mockResolvedValue({
      success: true,
      clientId: 'client-123',
      clientSecret: 'secret-123',
    });
    vi.mocked(loadDownstreamIntrospectionClientSecrets).mockResolvedValue({
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-123',
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-123',
    });
    vi.mocked(deployWorker).mockResolvedValue({
      component: 'ar-userinfo',
      workerName: 'single-ar-userinfo',
      success: true,
      deployedAt: new Date().toISOString(),
    });

    await expect(
      configureDownstreamIntrospectionDeployment({
        env: 'single',
        rootDir,
        keysDir,
        apiBaseUrls: ['https://slow.example.com', 'https://ready.example.com'],
      })
    ).resolves.toMatchObject({ success: true });
    expect(vi.mocked(ensureDownstreamIntrospectionClient)).toHaveBeenCalledWith(
      expect.objectContaining({ apiBaseUrl: 'https://ready.example.com' })
    );
  });

  it('reuses a router readiness success from the core deployment gate', async () => {
    const rootDir = createTempRoot();
    const keysDir = join(rootDir, '.authrim-keys', 'single');

    vi.mocked(ensureDownstreamIntrospectionClient).mockResolvedValue({
      success: true,
      clientId: 'client-123',
      clientSecret: 'secret-123',
    });
    vi.mocked(loadDownstreamIntrospectionClientSecrets).mockResolvedValue({
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-123',
      DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-123',
    });
    vi.mocked(deployWorker).mockResolvedValue({
      component: 'ar-userinfo',
      workerName: 'single-ar-userinfo',
      success: true,
      deployedAt: new Date().toISOString(),
    });

    await expect(
      configureDownstreamIntrospectionDeployment({
        env: 'single',
        rootDir,
        keysDir,
        apiBaseUrl: 'https://api.example.com/',
        knownRouterReadyBaseUrls: ['https://api.example.com'],
      })
    ).resolves.toMatchObject({ success: true });

    expect(vi.mocked(waitForRouterWorkerReady)).not.toHaveBeenCalled();
    expect(vi.mocked(waitForTenantRoutingReady)).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: 'https://api.example.com',
        maxWaitMs: 60_000,
        allowPublicDnsFallback: true,
      })
    );
  });
});
