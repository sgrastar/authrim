import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  buildR2BucketProvisioningStatus,
  createR2Bucket,
  deleteR2Bucket,
  getWorkerDeployments,
  getR2ObjectBytes,
  listR2Buckets,
  putR2Object,
  provisionR2Buckets,
  resolveR2ApiCredentials,
} from '../core/cloudflare.js';

describe('Cloudflare R2 helpers', () => {
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  beforeEach(() => {
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    vi.unstubAllGlobals();
  });

  it('refreshes Wrangler account authentication before reading its OAuth token', async () => {
    const calls: string[] = [];

    await expect(
      resolveR2ApiCredentials({
        resolveAccountId: async () => {
          calls.push('account');
          return '0123456789abcdef0123456789abcdef';
        },
        readToken: async () => {
          calls.push('token');
          return { token: 'refreshed-oauth-token', source: 'oauth' };
        },
        inferSingleAccountId: async () => {
          calls.push('infer');
          return null;
        },
      })
    ).resolves.toEqual({
      accountId: '0123456789abcdef0123456789abcdef',
      token: 'refreshed-oauth-token',
    });

    expect(calls).toEqual(['account', 'token']);
  });

  it('does not treat non-conflict R2 bucket creation failures as success', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Authentication error: missing permission',
    });

    await expect(createR2Bucket('prod-authrim-avatars')).rejects.toThrow(/missing permission/);
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

  it('uploads R2 artifacts through a temporary file with explicit remote targeting', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await putR2Object({
      bucketName: 'test-migration-releases',
      objectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
      bytes: new TextEncoder().encode('{"formatVersion":1}'),
      contentType: 'application/json',
    });

    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(
      expect.arrayContaining([
        'wrangler',
        'r2',
        'object',
        'put',
        `test-migration-releases/releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
        '--remote',
        '--file',
        '--content-type',
        'application/json',
      ])
    );
    const fileIndex = args.indexOf('--file');
    expect(fileIndex).toBeGreaterThan(0);
    expect(existsSync(args[fileIndex + 1])).toBe(false);
  });

  it('downloads bounded R2 artifacts through a temporary file with explicit remote targeting', async () => {
    execaMock.mockImplementationOnce(async (_command: string, args: string[]) => {
      const fileIndex = args.indexOf('--file');
      await writeFile(args[fileIndex + 1], 'artifact');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      getR2ObjectBytes({
        bucketName: 'test-migration-releases',
        objectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
        maxBytes: 1024,
      })
    ).resolves.toEqual(new TextEncoder().encode('artifact'));

    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(
      expect.arrayContaining([
        'wrangler',
        'r2',
        'object',
        'get',
        `test-migration-releases/releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
        '--remote',
        '--file',
      ])
    );
    expect(existsSync(args[args.indexOf('--file') + 1])).toBe(false);
  });

  it('rejects unsafe R2 artifact locations before invoking Wrangler', async () => {
    await expect(
      putR2Object({
        bucketName: 'test-migration-releases',
        objectKey: '../manifest.json',
        bytes: new Uint8Array([1]),
        contentType: 'application/json',
      })
    ).rejects.toThrow('invalid_r2_object_key');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('lists R2 buckets through the Cloudflare API when API credentials are available', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          buckets: [{ name: 'test-authrim-avatars' }, { name: 'test-sensitive-details' }],
        },
      }),
    });

    await expect(listR2Buckets({ throwOnError: true })).resolves.toEqual([
      { name: 'test-authrim-avatars' },
      { name: 'test-sensitive-details' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/r2/buckets?per_page=1000',
      expect.objectContaining({
        headers: { Authorization: expect.stringMatching(/^Bearer /) },
      })
    );
    expect(execaMock).not.toHaveBeenCalled();
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
        MIGRATION_RELEASES: { name: 'prod-migration-releases' },
        PLUGIN_BUNDLES: { name: 'prod-plugin-bundles' },
        PUBLIC_ASSETS: { name: 'prod-public-assets' },
        AVATARS: { name: 'prod-authrim-avatars' },
        DIAGNOSTIC_LOGS: { name: 'prod-diagnostic-logs' },
        AUDIT_ARCHIVE: { name: 'prod-audit-archive' },
        IMPORT_ARTIFACTS: { name: 'prod-import-artifacts' },
        EXPORT_ARTIFACTS: { name: 'prod-export-artifacts' },
        SENSITIVE_DETAILS: { name: 'prod-sensitive-details' },
      },
      [
        'prod-migration-releases',
        'prod-plugin-bundles',
        'prod-public-assets',
        'prod-authrim-avatars',
        'prod-diagnostic-logs',
        'prod-audit-archive',
        'prod-import-artifacts',
        'prod-export-artifacts',
        'prod-sensitive-details',
      ]
    );

    expect(status.enabled).toBe(true);
    expect(status.required).toBe(9);
    expect(status.configured).toBe(9);
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

  it('empties R2 objects listed by Cloudflare API before deleting the bucket', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ key: 'logs/v1/a.json' }],
          result_info: { is_truncated: true, cursor: 'next-page' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ key: 'logs/v1/b.json' }],
          result_info: { is_truncated: false },
        }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

    await expect(deleteR2Bucket('prod-audit-archive')).resolves.toBe(true);

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('/r2/buckets/prod-audit-archive/objects?per_page=1000');
    expect(urls[1]).toContain('cursor=next-page');
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/objects/logs%2Fv1%2Fa.json'),
        expect.stringContaining('/objects/logs%2Fv1%2Fb.json'),
      ])
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/r2/buckets/prod-audit-archive',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('backs off and retries Cloudflare 971 responses without falling back to Wrangler', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ key: 'logs/a.json' }],
          result_info: { is_truncated: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
        json: async () => ({
          success: false,
          errors: [
            { code: 971, message: 'Please wait and consider throttling your request speed' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

    await expect(deleteR2Bucket('prod-audit-archive')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(execaMock).not.toHaveBeenCalled();
  });
});
