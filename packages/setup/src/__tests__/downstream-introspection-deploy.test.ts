import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployResult } from '../core/deploy.js';
import {
  configureDownstreamIntrospectionDeployment,
  resolveDownstreamIntrospectionApiBaseUrl,
  resolveDownstreamIntrospectionKeysDir,
} from '../core/downstream-introspection-deploy.js';
import { getWorkersSubdomain } from '../core/cloudflare.js';
import { deployWorker, uploadSecrets } from '../core/deploy.js';
import {
  ensureDownstreamIntrospectionClient,
  loadDownstreamIntrospectionClientSecrets,
} from '../core/downstream-introspection-client.js';

vi.mock('../core/cloudflare.js', () => ({
  getWorkersSubdomain: vi.fn(),
}));

vi.mock('../core/deploy.js', () => ({
  uploadSecrets: vi.fn(),
  deployWorker: vi.fn(),
}));

vi.mock('../core/downstream-introspection-client.js', () => ({
  ensureDownstreamIntrospectionClient: vi.fn(),
  loadDownstreamIntrospectionClientSecrets: vi.fn(),
}));

const tempDirs: string[] = [];

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'authrim-downstream-deploy-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(getWorkersSubdomain).mockReset();
  vi.mocked(uploadSecrets).mockReset();
  vi.mocked(deployWorker).mockReset();
  vi.mocked(ensureDownstreamIntrospectionClient).mockReset();
  vi.mocked(loadDownstreamIntrospectionClientSecrets).mockReset();
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
    vi.mocked(uploadSecrets).mockResolvedValue({
      success: true,
      errors: [],
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
    expect(vi.mocked(ensureDownstreamIntrospectionClient)).toHaveBeenCalledWith({
      apiBaseUrl: 'https://single-ar-router.example.com',
      adminApiSecretPath: join(keysDir, 'admin_api_secret.txt'),
      keysDir,
      tenantId: 'tenant-a',
      onProgress: undefined,
    });
    expect(vi.mocked(uploadSecrets)).toHaveBeenCalledWith(
      {
        DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'client-123',
        DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'secret-123',
      },
      expect.objectContaining({
        env: 'single',
        rootDir,
        dryRun: undefined,
      }),
      ['ar-userinfo']
    );
    expect(vi.mocked(deployWorker)).toHaveBeenCalledWith(
      'ar-userinfo',
      expect.objectContaining({
        env: 'single',
        rootDir,
        dryRun: undefined,
      })
    );
  });

  it('returns a failure when secret upload fails', async () => {
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
    vi.mocked(uploadSecrets).mockResolvedValue({
      success: false,
      errors: ['wrangler secret put failed'],
    });

    const result = await configureDownstreamIntrospectionDeployment({
      env: 'single',
      rootDir,
      keysDir,
    });

    expect(result.success).toBe(false);
    expect(result.secretUploadErrors).toEqual(['wrangler secret put failed']);
    expect(vi.mocked(deployWorker)).not.toHaveBeenCalled();
  });
});
