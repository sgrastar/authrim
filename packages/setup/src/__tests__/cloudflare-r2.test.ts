import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  buildR2BucketProvisioningStatus,
  createR2Bucket,
  deleteR2Bucket,
  getWorkerDeployments,
  provisionR2Buckets,
} from '../core/cloudflare.js';

describe('Cloudflare R2 helpers', () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it('does not treat non-conflict R2 bucket creation failures as success', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Authentication error: missing permission',
    });

    await expect(createR2Bucket('prod-authrim-avatars')).rejects.toThrow(
      /missing permission/
    );
  });

  it('accepts an already-existing R2 bucket conflict as idempotent success', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'A bucket with this name already exists',
    });

    await expect(createR2Bucket('prod-authrim-avatars')).resolves.toEqual({
      name: 'prod-authrim-avatars',
    });
  });

  it('refuses to record provisioned R2 buckets until Cloudflare lists them', async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([]),
        stderr: '',
      });

    await expect(provisionR2Buckets('prod')).rejects.toThrow(/was not visible after creation/);
  });

  it('marks recorded R2 buckets as unconfigured when Cloudflare no longer lists them', () => {
    const status = buildR2BucketProvisioningStatus(
      'prod',
      {
        AVATARS: { name: 'prod-authrim-avatars' },
      },
      []
    );

    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(0);
    expect(status.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'AVATARS',
          name: 'prod-authrim-avatars',
          recorded: true,
          exists: false,
          configured: false,
          state: 'recorded_but_missing',
        }),
      ])
    );
  });

  it('reports R2 enabled only when every recorded bucket exists in Cloudflare', () => {
    const status = buildR2BucketProvisioningStatus(
      'prod',
      {
        AVATARS: { name: 'prod-authrim-avatars' },
        DIAGNOSTIC_LOGS: { name: 'prod-diagnostic-logs' },
        IMPORT_ARTIFACTS: { name: 'prod-import-artifacts' },
        EXPORT_ARTIFACTS: { name: 'prod-export-artifacts' },
        SENSITIVE_DETAILS: { name: 'prod-sensitive-details' },
      },
      [
        'prod-authrim-avatars',
        'prod-diagnostic-logs',
        'prod-import-artifacts',
        'prod-export-artifacts',
        'prod-sensitive-details',
      ]
    );

    expect(status.enabled).toBe(true);
    expect(status.required).toBe(5);
    expect(status.configured).toBe(5);
    expect(status.missing).toEqual([]);
    expect(status.buckets.every((bucket) => bucket.state === 'configured')).toBe(true);
  });

  it('uses the newest worker deployment when wrangler lists older secret changes first', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: `
Created:     2026-05-18T07:34:18.333Z
Author:      old@example.com
Source:      Secret Change
Version(s):  (100%) 11111111-1111-4111-8111-111111111111

Created:     2026-05-18T07:36:06.414Z
Author:      new@example.com
Source:      Upload
Version(s):  (100%) 22222222-2222-4222-8222-222222222222
`.trim(),
      stderr: '',
    });

    await expect(getWorkerDeployments('test-ar-lib-core')).resolves.toEqual({
      name: 'test-ar-lib-core',
      exists: true,
      lastDeployedAt: '2026-05-18T07:36:06.414Z',
      author: 'new@example.com',
      versionId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('deletes known R2 objects with concurrency capped at five before deleting the bucket', async () => {
    let activeObjectDeletes = 0;
    let maxActiveObjectDeletes = 0;
    let activeObjectDeletesWhenBucketDeleted = -1;

    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('object') && args.includes('delete')) {
        activeObjectDeletes += 1;
        maxActiveObjectDeletes = Math.max(maxActiveObjectDeletes, activeObjectDeletes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeObjectDeletes -= 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('bucket') && args.includes('delete')) {
        activeObjectDeletesWhenBucketDeleted = activeObjectDeletes;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
    });

    const success = await deleteR2Bucket('prod-sensitive-details', {
      objectKeys: Array.from({ length: 12 }, (_, index) => `objects/${index}.json`),
    });

    expect(success).toBe(true);
    expect(maxActiveObjectDeletes).toBe(5);
    expect(activeObjectDeletesWhenBucketDeleted).toBe(0);
    expect(
      execaMock.mock.calls.filter(([, args]) => args.includes('object') && args.includes('delete'))
    ).toHaveLength(12);
  });
});
