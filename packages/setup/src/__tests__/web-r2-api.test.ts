import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listR2BucketsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    listR2Buckets: listR2BucketsMock,
  };
});

import { createApiRoutes, generateSessionToken } from '../web/api.js';
import { getRequiredR2Buckets } from '../core/cloudflare.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

async function writeLock(
  env: string,
  r2: Record<
    string,
    {
      name: string;
      creationDate?: string;
      ownershipMarkerKey?: string;
      ownershipId?: string;
    }
  >,
  recordedEnv = env
) {
  const envDir = join(tempDir!, '.authrim', env);
  await mkdir(envDir, { recursive: true });
  await writeFile(
    join(envDir, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        env: recordedEnv,
        createdAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
        d1: {},
        kv: {},
        r2,
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
}

describe('setup web R2 API', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-web-r2-api-')));
    process.chdir(tempDir);
    listR2BucketsMock.mockReset();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reports recorded R2 buckets as missing when Cloudflare does not list them', async () => {
    await writeLock('prod', {
      PUBLIC_ASSETS: { name: 'prod-public-assets' },
    });
    listR2BucketsMock.mockResolvedValueOnce([]);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/r2/prod/status', {
      headers: { 'X-Session-Token': token },
    });
    const body = (await response.json()) as {
      success: boolean;
      enabled: boolean;
      configured: number;
      ownershipRecoveryRequired: number;
      ownershipRecoveryMode: string;
      requiredCommand?: string;
      missing: Array<{ binding: string; state: string; recorded: boolean; exists: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.configured).toBe(0);
    expect(body.ownershipRecoveryRequired).toBe(1);
    expect(body.ownershipRecoveryMode).toBe('environment_recreation_required');
    expect(body.requiredCommand).toBeUndefined();
    expect(body.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'PUBLIC_ASSETS',
          state: 'recorded_but_missing',
          recorded: true,
          exists: false,
        }),
      ])
    );
    expect(listR2BucketsMock).toHaveBeenCalledWith({
      throwOnError: true,
      requireIdentity: true,
    });
  });

  it('requires environment recreation when only part of the legacy R2 set can be adopted', async () => {
    await writeLock('prod', {
      PUBLIC_ASSETS: { name: 'prod-public-assets' },
    });
    listR2BucketsMock.mockResolvedValueOnce([
      { name: 'prod-public-assets', creationDate: '2026-05-18T00:00:00.000Z' },
    ]);

    const response = await createApiRoutes().request('/r2/prod/status');
    const body = (await response.json()) as {
      enabled: boolean;
      configured: number;
      ownershipRecoveryRequired: number;
      ownershipRecoveryMode: string;
      requiredCommand?: string;
      missing: Array<{ binding: string; state: string; exactOwnership: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.configured).toBe(0);
    expect(body.ownershipRecoveryRequired).toBe(1);
    expect(body.ownershipRecoveryMode).toBe('environment_recreation_required');
    expect(body.requiredCommand).toBeUndefined();
    expect(body.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'PUBLIC_ASSETS',
          state: 'ownership_unverified',
          exactOwnership: false,
        }),
      ])
    );
  });

  it('offers explicit adoption only when every required legacy R2 bucket exists', async () => {
    const requiredBuckets = getRequiredR2Buckets('prod');
    await writeLock(
      'prod',
      Object.fromEntries(requiredBuckets.map((bucket) => [bucket.binding, { name: bucket.name }]))
    );
    listR2BucketsMock.mockResolvedValueOnce(
      requiredBuckets.map((bucket) => ({
        name: bucket.name,
        creationDate: '2026-05-18T00:00:00.000Z',
      }))
    );

    const response = await createApiRoutes().request('/r2/prod/status');
    const body = (await response.json()) as {
      configured: number;
      ownershipRecoveryRequired: number;
      ownershipRecoveryMode: string;
      requiredCommand?: string;
    };

    expect(response.status).toBe(200);
    expect(body.configured).toBe(0);
    expect(body.ownershipRecoveryRequired).toBe(requiredBuckets.length);
    expect(body.ownershipRecoveryMode).toBe('explicit_adoption');
    expect(body.requiredCommand).toContain('--adopt-legacy-r2-ownership --yes');
  });

  it('rejects a lock stored under the wrong environment directory', async () => {
    await writeLock('prod', {}, 'other');
    listR2BucketsMock.mockResolvedValueOnce([]);

    const response = await createApiRoutes().request('/r2/prod/status');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Lock environment identity mismatch: expected prod, found other',
    });
    expect(listR2BucketsMock).not.toHaveBeenCalled();
  });
});
