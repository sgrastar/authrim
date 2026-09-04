import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  buildR2BucketProvisioningStatus,
  adoptR2BucketOwnership,
  assertCloudflareOAuthRefreshAccount,
  assertR2BucketOwnershipForUse,
  createR2Bucket,
  deleteR2Bucket,
  getR2BucketDashboardUrl,
  getRequiredR2Buckets,
  getWorkerDeployments,
  getWorkerVersion,
  getR2ObjectBytes,
  listR2Objects,
  listR2Buckets,
  parseR2BucketRows,
  putR2Object,
  provisionResources,
  provisionR2Buckets,
  resolveR2ApiCredentials,
  shouldRefreshCloudflareOAuthCredential,
} from '../core/cloudflare.js';
import {
  beginOrResumeProvisioningIntent,
  loadProvisioningIntent,
  recordProvisionedResource,
  recordProvisioningResourceCreateIssued,
  recordProvisioningResourceCreateRejected,
  recordProvisioningResourceIdentified,
} from '../core/provisioning-intent.js';
import { createLockFile } from '../core/lock.js';

describe('Cloudflare R2 helpers', () => {
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const ownershipId = '11111111-1111-4111-8111-111111111111';
  const ownershipMarkerKey = `__authrim_setup__/ownership-v1-${ownershipId}.json`;
  const creationDate = '2026-08-31T00:00:00.000Z';
  const oauthAccountId = '0123456789abcdef0123456789abcdef';
  const r2AuthError =
    'Authentication error [code: 10000] while requesting ' +
    `https://api.cloudflare.com/client/v4/accounts/${oauthAccountId}/r2/buckets`;

  function ownedR2(name: string) {
    return { name, creationDate, ownershipMarkerKey, ownershipId };
  }

  function markerBytes(name: string, overrides: Record<string, unknown> = {}): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ version: 1, bucketName: name, ownershipId, ...overrides })
    );
  }

  function createOwnedR2ApiHandler(input: {
    name: string;
    objects?: string[];
    markerOverrides?: Record<string, unknown>;
    onObjectList?: (
      url: string,
      call: number
    ) => { result: unknown; resultInfo?: Record<string, unknown> } | undefined;
  }) {
    let bucketExists = true;
    let markerExists = true;
    const objects = new Set(input.objects ?? []);
    let objectListCalls = 0;
    return vi.fn(async (rawUrl: string | URL, init: FetchInit = {}) => {
      const url = String(rawUrl);
      const method = (init.method ?? 'GET').toUpperCase();
      if (url.includes('/r2/buckets?')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: {
              buckets: bucketExists ? [{ name: input.name, creation_date: creationDate }] : [],
            },
          }),
        };
      }
      if (new URL(url).pathname.endsWith(`/r2/buckets/${input.name}`) && method === 'GET') {
        return {
          ok: bucketExists,
          status: bucketExists ? 200 : 404,
          headers: new Headers(),
          json: async () => ({
            success: bucketExists,
            result: bucketExists ? { name: input.name, creation_date: creationDate } : undefined,
          }),
        };
      }
      if (url.includes('/objects?')) {
        objectListCalls += 1;
        const custom = input.onObjectList?.(url, objectListCalls);
        const result =
          custom?.result ??
          (url.includes('prefix=')
            ? markerExists
              ? [{ key: ownershipMarkerKey }]
              : []
            : [
                ...[...objects].map((key) => ({ key })),
                ...(markerExists ? [{ key: ownershipMarkerKey }] : []),
              ]);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result,
            result_info: custom?.resultInfo ?? { is_truncated: false },
          }),
        };
      }
      if (url.includes(`/objects/${ownershipMarkerKey}`) && method === 'GET') {
        const bytes = markerBytes(input.name, input.markerOverrides);
        return {
          ok: markerExists,
          status: markerExists ? 200 : 404,
          headers: new Headers({ 'content-length': String(bytes.byteLength) }),
          arrayBuffer: async () => bytes.buffer,
        };
      }
      if (url.includes('/objects/') && method === 'DELETE') {
        const encodedKey = url.split('/objects/')[1] ?? '';
        const key = decodeURIComponent(encodedKey);
        if (key === ownershipMarkerKey) markerExists = false;
        objects.delete(key);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ success: true }),
        };
      }
      if (url.includes(`/r2/buckets/${input.name}`) && method === 'DELETE') {
        bucketExists = false;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ success: true }),
        };
      }
      throw new Error(`unexpected Cloudflare R2 API request: ${method} ${url}`);
    });
  }

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
      source: 'oauth',
    });

    expect(calls).toEqual(['token', 'account', 'token']);
  });

  it('refreshes only cached OAuth on an explicit 401 or authentication code 10000', () => {
    expect(
      shouldRefreshCloudflareOAuthCredential({
        status: 401,
        source: 'oauth',
        attempt: 1,
      })
    ).toBe(true);
    expect(
      shouldRefreshCloudflareOAuthCredential({
        status: 403,
        errorCodes: [10_000],
        source: 'oauth',
        attempt: 1,
      })
    ).toBe(true);
    expect(
      shouldRefreshCloudflareOAuthCredential({
        status: 401,
        source: 'env',
        attempt: 1,
      })
    ).toBe(false);
    expect(
      shouldRefreshCloudflareOAuthCredential({
        status: 401,
        source: 'oauth',
        attempt: 2,
      })
    ).toBe(false);
  });

  it.each([
    {
      label: 'a different account',
      output: 'You are logged in.\nAccount ID: fedcba9876543210fedcba9876543210',
    },
    {
      label: 'multiple accounts',
      output:
        'Account ID: 0123456789abcdef0123456789abcdef\n' +
        'Account ID: fedcba9876543210fedcba9876543210',
    },
  ])('fails OAuth refresh closed for $label', ({ output }) => {
    expect(() =>
      assertCloudflareOAuthRefreshAccount('0123456789abcdef0123456789abcdef', output)
    ).toThrow('cloudflare_oauth_account_id_mismatch_after_refresh');
  });

  it('does not treat non-conflict R2 bucket creation failures as success', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Authentication error: missing permission',
    });

    await expect(createR2Bucket('prod-public-assets')).rejects.toThrow(/missing permission/);
  });

  it('retries Cloudflare authentication code 10000 for R2 create but not other failures', async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: r2AuthError,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'You are logged in with an OAuth Token.\n' +
          'Account ID: 0123456789abcdef0123456789abcdef',
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await expect(createR2Bucket('prod-public-assets')).resolves.toEqual({
      name: 'prod-public-assets',
    });
    expect(execaMock).toHaveBeenCalledTimes(3);
    expect(execaMock.mock.calls.map((call) => (call[1] as string[]).slice(0, 3).join(' '))).toEqual(
      ['wrangler r2 bucket', 'wrangler whoami', 'wrangler r2 bucket']
    );
  });

  it('shares one Wrangler OAuth refresh across concurrent R2 creates', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = oauthAccountId;
    const attempts = new Map<string, number>();
    let refreshes = 0;

    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(0, 2).join(' ') === 'wrangler whoami') {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          exitCode: 0,
          stdout: `You are logged in with an OAuth Token.\nAccount ID: ${oauthAccountId}`,
          stderr: '',
        };
      }
      if (args.slice(0, 4).join(' ') === 'wrangler r2 bucket create') {
        const bucketName = args[4]!;
        const attempt = (attempts.get(bucketName) ?? 0) + 1;
        attempts.set(bucketName, attempt);
        return attempt === 1
          ? { exitCode: 1, stdout: '', stderr: r2AuthError }
          : { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
    });

    await expect(
      Promise.all([createR2Bucket('prod-public-assets'), createR2Bucket('prod-audit-archive')])
    ).resolves.toEqual([{ name: 'prod-public-assets' }, { name: 'prod-audit-archive' }]);
    expect(refreshes).toBe(1);
    expect(attempts).toEqual(
      new Map([
        ['prod-public-assets', 2],
        ['prod-audit-archive', 2],
      ])
    );
  });

  it('preserves the provider cause when baseline R2 provisioning fails', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Authentication error: missing R2 permission',
      });

    let failure: unknown;
    try {
      await provisionResources({
        env: 'prod',
        createD1: false,
        createKV: false,
        createQueues: false,
        createR2: false,
        provisioningIntentResources: {},
        onProgress: () => {},
        onResourceCreateIssued: async () => undefined,
        onResourceCreateRejected: async () => undefined,
        onResourceIdentified: async () => undefined,
        onResourceProvisioned: async () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Failed to provision baseline R2 migration release bucket'
    );
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toContain('missing R2 permission');
  });

  it('lists R2 objects through the REST API with prefix and cursor pagination', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [
            {
              key: 'logs/v1/first.jsonl.gz',
              size: 123,
              last_modified: '2026-08-15T00:00:00Z',
              etag: 'etag-first',
            },
          ],
          result_info: { is_truncated: true, cursor: 'next-page' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ key: 'logs/v1/second.jsonl.gz', size: 456 }],
          result_info: { is_truncated: false },
        }),
      });

    await expect(
      listR2Objects({ bucketName: 'test-audit-archive', prefix: 'logs/v1/' })
    ).resolves.toEqual([
      {
        key: 'logs/v1/first.jsonl.gz',
        size: 123,
        lastModified: '2026-08-15T00:00:00Z',
        etag: 'etag-first',
      },
      {
        key: 'logs/v1/second.jsonl.gz',
        size: 456,
        lastModified: null,
        etag: null,
      },
    ]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('prefix=logs%2Fv1%2F');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=next-page');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('accepts the documented terminal object-list response when result_info is omitted', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ key: '__authrim_setup__/ownership-v1-marker.json', size: 123 }],
      }),
    });

    await expect(
      listR2Objects({
        bucketName: 'test-audit-archive',
        prefix: '__authrim_setup__/ownership-v1-marker.json',
      })
    ).resolves.toEqual([
      {
        key: '__authrim_setup__/ownership-v1-marker.json',
        size: 123,
        lastModified: null,
        etag: null,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed on a full R2 object page without pagination metadata', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: Array.from({ length: 1_000 }, (_, index) => ({ key: `object-${index}` })),
      }),
    });

    await expect(listR2Objects({ bucketName: 'test-audit-archive' })).rejects.toThrow(
      'cloudflare_r2_object_list_pagination_metadata_missing'
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a repeated R2 object cursor instead of looping', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ key: 'first' }],
          result_info: { is_truncated: true, cursor: 'repeated' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ key: 'second' }],
          result_info: { is_truncated: true, cursor: 'repeated' },
        }),
      });

    await expect(listR2Objects({ bucketName: 'test-audit-archive' })).rejects.toThrow(
      'cloudflare_r2_object_list_cursor_cycle'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized R2 object pagination before accumulating unbounded keys', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    for (let page = 0; page < 3; page++) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: Array.from({ length: page === 2 ? 501 : 1_000 }, (_, index) => ({
            key: `${page}/${index}`,
          })),
          result_info: { is_truncated: true, cursor: `cursor-${page}` },
        }),
      });
    }

    await expect(listR2Objects({ bucketName: 'test-audit-archive' })).rejects.toThrow(
      'cloudflare_r2_object_list_key_limit_exceeded'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('accepts an already-existing R2 bucket conflict as idempotent success', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'A bucket with this name already exists',
    });

    await expect(createR2Bucket('prod-public-assets')).resolves.toEqual({
      name: 'prod-public-assets',
    });
  });

  it('uploads R2 artifacts through a temporary file with explicit remote targeting', async () => {
    let temporaryPath = '';
    execaMock.mockImplementationOnce(async (_command: string, args: string[]) => {
      const fileIndex = args.indexOf('--file');
      temporaryPath = args[fileIndex + 1];
      const metadata = lstatSync(temporaryPath);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.nlink).toBe(1);
      if (process.platform !== 'win32') {
        expect(metadata.mode & 0o777).toBe(0o600);
        expect(lstatSync(dirname(temporaryPath)).mode & 0o777).toBe(0o700);
      }
      expect(readFileSync(temporaryPath, 'utf8')).toBe('{"formatVersion":1}');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

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
    expect(args[fileIndex + 1]).toBe(temporaryPath);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(dirname(temporaryPath))).toBe(false);
  });

  it.each([
    `Authentication error [code: 10000] at https://api.cloudflare.com/client/v4/accounts/${oauthAccountId}/r2/buckets`,
    `HTTP 401 at https://api.cloudflare.com/client/v4/accounts/${oauthAccountId}/r2/buckets`,
  ])('refreshes cached Wrangler OAuth once after an R2 object rejection: %s', async (stderr) => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    execaMock
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'You are logged in with an OAuth Token.\nAccount ID: 0123456789abcdef0123456789abcdef',
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await expect(
      putR2Object({
        bucketName: 'test-migration-releases',
        objectKey: 'ownership/marker.json',
        bytes: new TextEncoder().encode('{}'),
        contentType: 'application/json',
      })
    ).resolves.toBeUndefined();
    expect(
      execaMock.mock.calls.map(([, args]) => (args as string[]).slice(0, 4).join(' '))
    ).toEqual(['wrangler r2 object put', 'wrangler whoami', 'wrangler r2 object put']);
  });

  it('does not retry an R2 object mutation after OAuth refresh selects another account', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    execaMock
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Authentication error [code: 10000]',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'You are logged in with an OAuth Token.\n' +
          'Account ID: fedcba9876543210fedcba9876543210',
        stderr: '',
      });

    await expect(
      putR2Object({
        bucketName: 'test-migration-releases',
        objectKey: 'ownership/marker.json',
        bytes: new TextEncoder().encode('{}'),
        contentType: 'application/json',
      })
    ).rejects.toThrow('cloudflare_oauth_account_id_mismatch_after_refresh');
    expect(
      execaMock.mock.calls.map(([, args]) => (args as string[]).slice(0, 4).join(' '))
    ).toEqual(['wrangler r2 object put', 'wrangler whoami']);
  });

  it('downloads bounded R2 artifacts through a temporary file with explicit remote targeting', async () => {
    let temporaryPath = '';
    execaMock.mockImplementationOnce(async (_command: string, args: string[]) => {
      const fileIndex = args.indexOf('--file');
      temporaryPath = args[fileIndex + 1];
      const before = lstatSync(temporaryPath);
      expect(before.isFile()).toBe(true);
      expect(before.isSymbolicLink()).toBe(false);
      expect(before.nlink).toBe(1);
      if (process.platform !== 'win32') {
        expect(before.mode & 0o777).toBe(0o600);
        expect(lstatSync(dirname(temporaryPath)).mode & 0o777).toBe(0o700);
      }
      await writeFile(temporaryPath, 'artifact');
      const after = lstatSync(temporaryPath);
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(after.isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') expect(after.mode & 0o777).toBe(0o600);
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
    expect(args[args.indexOf('--file') + 1]).toBe(temporaryPath);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(dirname(temporaryPath))).toBe(false);
  });

  it('rejects oversized R2 output before reading it and still removes the private file', async () => {
    let temporaryPath = '';
    execaMock.mockImplementationOnce(async (_command: string, args: string[]) => {
      temporaryPath = args[args.indexOf('--file') + 1];
      await writeFile(temporaryPath, 'oversized');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      getR2ObjectBytes({
        bucketName: 'test-migration-releases',
        objectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
        maxBytes: 4,
      })
    ).rejects.toThrow('r2_object_size_limit_exceeded');
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(dirname(temporaryPath))).toBe(false);
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
          buckets: [{ name: 'test-public-assets' }, { name: 'test-sensitive-details' }],
        },
      }),
    });

    await expect(listR2Buckets({ throwOnError: true })).resolves.toEqual([
      { name: 'test-public-assets' },
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

  it('preserves creation dates from Wrangler 4.x plain-text bucket blocks', () => {
    expect(
      parseR2BucketRows(`
        ⛅️ wrangler 4.110.0
        Listing buckets...
        name:           conformance-public-assets
        creation_date:  2026-09-02T12:27:58.917Z

        name:           scaleout-public-assets
        creation_date:  2026-08-30T03:20:18.341Z
      `)
    ).toEqual([
      {
        name: 'conformance-public-assets',
        creationDate: '2026-09-02T12:27:58.917Z',
      },
      {
        name: 'scaleout-public-assets',
        creationDate: '2026-08-30T03:20:18.341Z',
      },
    ]);
  });

  it('uses Wrangler list identities without issuing one info request per bucket', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockRejectedValueOnce(new Error('Cloudflare R2 list temporarily unavailable'));
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: `
        Listing buckets...
        name:           conformance-public-assets
        creation_date:  2026-09-02T12:27:58.917Z

        name:           scaleout-public-assets
        creation_date:  2026-08-30T03:20:18.341Z
      `,
      stderr: '',
    });

    await expect(listR2Buckets({ throwOnError: true, requireIdentity: true })).resolves.toEqual([
      {
        name: 'conformance-public-assets',
        creationDate: '2026-09-02T12:27:58.917Z',
      },
      {
        name: 'scaleout-public-assets',
        creationDate: '2026-08-30T03:20:18.341Z',
      },
    ]);
    expect(execaMock).toHaveBeenCalledOnce();
    expect((execaMock.mock.calls[0]?.[1] as string[]).join(' ')).toBe('wrangler r2 bucket list');
  });

  it('lists every R2 bucket page using the returned cursor', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-first-page' }] },
          result_info: { cursor: 'next-page', per_page: 1_000 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-second-page' }] },
          result_info: { per_page: 1_000 },
        }),
      });

    await expect(listR2Buckets({ throwOnError: true })).resolves.toEqual([
      { name: 'test-first-page' },
      { name: 'test-second-page' },
    ]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/r2/buckets?per_page=1000&cursor=next-page'
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('fails closed when R2 bucket pagination repeats a cursor', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-first-page' }] },
          result_info: { cursor: 'repeated-cursor', per_page: 1_000 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-second-page' }] },
          result_info: { cursor: 'repeated-cursor', per_page: 1_000 },
        }),
      });
    execaMock.mockRejectedValueOnce(new Error('Wrangler R2 inventory unavailable'));

    await expect(listR2Buckets({ throwOnError: true })).rejects.toThrow(
      'R2 bucket inventory failed through both the Cloudflare API and Wrangler'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('fails closed when R2 bucket pages contain a duplicate bucket name', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-duplicate' }] },
          result_info: { cursor: 'next-page' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-duplicate' }] },
        }),
      });
    execaMock.mockRejectedValueOnce(new Error('Wrangler R2 inventory unavailable'));

    await expect(listR2Buckets({ throwOnError: true })).rejects.toThrow(
      'R2 bucket inventory failed through both the Cloudflare API and Wrangler'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient failure on a later R2 bucket page without losing earlier rows', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-first-page' }] },
          result_info: { cursor: 'next-page' },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({
          success: false,
          errors: [{ code: 1_000, message: 'Service temporarily unavailable' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-second-page' }] },
        }),
      });

    await expect(listR2Buckets({ throwOnError: true })).resolves.toEqual([
      { name: 'test-first-page' },
      { name: 'test-second-page' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(String(fetchMock.mock.calls[2]?.[0]));
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('bounds an endless stream of unique R2 bucket cursors', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    let page = 0;
    fetchMock.mockImplementation(async () => {
      page += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: `test-page-${page}` }] },
          result_info: { cursor: `cursor-${page}` },
        }),
      };
    });
    execaMock.mockRejectedValueOnce(new Error('Wrangler R2 inventory unavailable'));

    const failure = await listR2Buckets({ throwOnError: true }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({
      message: 'Cloudflare R2 bucket list exceeded the 1000-page safety limit',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1_000);
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('fails closed on invalid R2 pagination metadata without exposing the API token', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'sensitive-r2-api-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { buckets: [{ name: 'test-first-page' }] },
        result_info: { cursor: 42 },
      }),
    });
    execaMock.mockRejectedValueOnce(new Error('Wrangler R2 inventory unavailable'));

    const failure = await listR2Buckets({ throwOnError: true }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors[0]).toMatchObject({
      message: 'Cloudflare R2 bucket list returned an invalid pagination cursor',
    });
    expect([String(failure), ...errors.map(String)].join('\n')).not.toContain(
      'sensitive-r2-api-token'
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not return a partial R2 bucket inventory when a later page fails', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { buckets: [{ name: 'test-first-page' }] },
          result_info: { cursor: 'next-page' },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          success: false,
          errors: [{ code: 10_000, message: 'Authentication error' }],
        }),
      });
    execaMock.mockRejectedValueOnce(new Error('Wrangler R2 inventory unavailable'));

    await expect(listR2Buckets({ throwOnError: true })).rejects.toThrow(
      'R2 bucket inventory failed through both the Cloudflare API and Wrangler'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('builds a dashboard URL from the Cloudflare account ID and bucket name', () => {
    expect(getR2BucketDashboardUrl('0123456789abcdef0123456789abcdef', 'prod-audit-archive')).toBe(
      'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/r2/default/buckets/prod-audit-archive'
    );
    expect(getR2BucketDashboardUrl('not-an-account', 'prod-audit-archive')).toBeNull();
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
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([]),
        stderr: '',
      });

    await expect(provisionR2Buckets('prod', { includeFeatureBuckets: false })).rejects.toThrow(
      /was not visible after creation/
    );
  });

  it('provisions R2 buckets with bounded concurrency and serialized durable checkpoints', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    const requiredBuckets = getRequiredR2Buckets('prod');
    const bucketCreationDates = new Map(
      requiredBuckets.map((bucket, index) => [
        bucket.name,
        `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`,
      ])
    );
    const createdBuckets = new Set<string>();
    const markerPayloads = new Map<string, Uint8Array>();
    let activeCreates = 0;
    let maxActiveCreates = 0;
    let activeCheckpoints = 0;
    let maxActiveCheckpoints = 0;

    fetchMock.mockImplementation(async (rawUrl: string | URL) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith('/r2/buckets')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: {
              buckets: [...createdBuckets].map((name) => ({
                name,
                creation_date: bucketCreationDates.get(name),
              })),
            },
          }),
        };
      }

      const objectMatch = url.pathname.match(/\/r2\/buckets\/([^/]+)\/objects(?:\/(.*))?$/u);
      if (objectMatch) {
        const bucketName = decodeURIComponent(objectMatch[1]!);
        const encodedObjectKey = objectMatch[2];
        const markerPayload = markerPayloads.get(bucketName);
        if (encodedObjectKey === undefined) {
          const marker = markerPayload
            ? (JSON.parse(new TextDecoder().decode(markerPayload)) as { ownershipId: string })
            : null;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              success: true,
              result: marker
                ? [{ key: `__authrim_setup__/ownership-v1-${marker.ownershipId}.json` }]
                : [],
              result_info: { is_truncated: false },
            }),
          };
        }
        if (!markerPayload) {
          return { ok: false, status: 404, headers: new Headers() };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(markerPayload.byteLength) }),
          arrayBuffer: async () => markerPayload.buffer,
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(0, 4).join(' ') === 'wrangler r2 bucket create') {
        const bucketName = args[4]!;
        activeCreates += 1;
        maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
        await new Promise((resolve) =>
          setTimeout(resolve, bucketName.endsWith('releases') ? 8 : 2)
        );
        createdBuckets.add(bucketName);
        activeCreates -= 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.slice(0, 4).join(' ') === 'wrangler r2 object put') {
        const target = args[4]!;
        const separator = target.indexOf('/');
        const bucketName = target.slice(0, separator);
        const filePath = args[args.indexOf('--file') + 1]!;
        markerPayloads.set(bucketName, new Uint8Array(readFileSync(filePath)));
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
    });

    const checkpoint = async () => {
      activeCheckpoints += 1;
      maxActiveCheckpoints = Math.max(maxActiveCheckpoints, activeCheckpoints);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeCheckpoints -= 1;
    };
    const resources = await provisionR2Buckets('prod', {
      provisioningIntentResources: {},
      onResourceCreateIssued: checkpoint,
      onResourceCreateRejected: checkpoint,
      onResourceIdentified: checkpoint,
      onResourceProvisioned: checkpoint,
    });

    expect(maxActiveCreates).toBe(2);
    expect(maxActiveCheckpoints).toBe(1);
    expect(resources.map(({ binding, name }) => ({ binding, name }))).toEqual(requiredBuckets);
    expect(markerPayloads).toHaveLength(requiredBuckets.length);
  });

  it('does not start more R2 bucket creates after a concurrent create failure is observed', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const started: string[] = [];
    const rejected: string[] = [];
    let rejectFirst!: () => void;
    let rejectSecond!: () => void;
    const firstFailure = new Promise<void>((_resolve, reject) => {
      rejectFirst = () => reject(new Error('first R2 create permission denied'));
    });
    const secondFailure = new Promise<void>((_resolve, reject) => {
      rejectSecond = () => reject(new Error('second R2 create permission denied'));
    });

    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(0, 4).join(' ') === 'wrangler r2 bucket list') {
        return { exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (args.slice(0, 4).join(' ') === 'wrangler r2 bucket create') {
        started.push(args[4]!);
        return started.length === 1 ? firstFailure : secondFailure;
      }
      throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
    });

    const provisioning = provisionR2Buckets('prod', {
      provisioningIntentResources: {},
      onResourceCreateIssued: async () => undefined,
      onResourceCreateRejected: async (resource) => {
        rejected.push(resource.name);
      },
    });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    rejectFirst();
    await vi.waitFor(() => expect(rejected).toContain('prod-migration-releases'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(2);
    rejectSecond();

    await expect(provisioning).rejects.toThrow('first R2 create permission denied');
    expect(started).toEqual(['prod-migration-releases', 'prod-plugin-bundles']);
  });

  it('does not claim a same-name R2 bucket after an ambiguous create response', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const onResourceCreateIssued = vi.fn().mockResolvedValue(undefined);
    const onResourceCreateRejected = vi.fn().mockResolvedValue(undefined);
    const onResourceProvisioned = vi.fn().mockResolvedValue(undefined);
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP status 503: response lost after commit',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ name: 'prod-migration-releases', creation_date: creationDate }]),
        stderr: '',
      });

    await expect(
      provisionR2Buckets('prod', {
        includeFeatureBuckets: false,
        provisioningIntentResources: {},
        onResourceCreateIssued,
        onResourceCreateRejected,
        onResourceProvisioned,
      })
    ).rejects.toThrow('cannot prove ownership');
    expect(onResourceCreateIssued).toHaveBeenCalledOnce();
    expect(onResourceCreateRejected).not.toHaveBeenCalled();
    expect(onResourceProvisioned).not.toHaveBeenCalled();
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler r2 bucket create'
      )
    ).toHaveLength(1);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler r2 bucket list'
      )
    ).toHaveLength(3);
  });

  it('persists fresh R2 provider identity and marker through the real intent and lock path', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-r2-ownership-'));
    let bucketExists = false;
    let markerExists = false;
    let markerPayload = new Uint8Array();
    let liveMarkerKey = '';

    try {
      const attempt = await beginOrResumeProvisioningIntent({
        baseDir,
        environment: 'prod',
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        resourceSpec: { r2: true },
      });
      fetchMock.mockImplementation(async (rawUrl: string | URL) => {
        const url = String(rawUrl);
        if (url.includes('/r2/buckets?')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              success: true,
              result: {
                buckets: bucketExists
                  ? [{ name: 'prod-migration-releases', creation_date: creationDate }]
                  : [],
              },
            }),
          };
        }
        if (url.includes('/objects?')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              success: true,
              result: markerExists ? [{ key: liveMarkerKey }] : [],
              result_info: { is_truncated: false },
            }),
          };
        }
        if (url.includes('/objects/') && markerExists) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(markerPayload.byteLength) }),
            arrayBuffer: async () => markerPayload.buffer,
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      execaMock.mockImplementation(async (_command: string, args: string[]) => {
        if (args.slice(0, 4).join(' ') === 'wrangler r2 bucket create') {
          bucketExists = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args.slice(0, 4).join(' ') === 'wrangler r2 object put') {
          const filePath = args[args.indexOf('--file') + 1]!;
          markerPayload = new Uint8Array(readFileSync(filePath));
          const marker = JSON.parse(new TextDecoder().decode(markerPayload)) as {
            ownershipId: string;
          };
          expect(args[4]).toContain(`__authrim_setup__/ownership-v1-${marker.ownershipId}.json`);
          liveMarkerKey = args[4]!.slice('prod-migration-releases/'.length);
          markerExists = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
      });

      const checkpointStates: string[] = [];
      const resources = await provisionResources({
        env: 'prod',
        createD1: false,
        createKV: false,
        createQueues: false,
        createR2: false,
        provisioningIntentResources: attempt.intent.resources,
        onProgress: () => undefined,
        onResourceCreateIssued: (resource) =>
          recordProvisioningResourceCreateIssued({
            baseDir,
            environment: 'prod',
            expectedIntentId: attempt.intent.id,
            resource,
          }),
        onResourceCreateRejected: (resource) =>
          recordProvisioningResourceCreateRejected({
            baseDir,
            environment: 'prod',
            expectedIntentId: attempt.intent.id,
            resource,
          }),
        onResourceIdentified: async (resource) => {
          checkpointStates.push(resource.state);
          await recordProvisioningResourceIdentified({
            baseDir,
            environment: 'prod',
            expectedIntentId: attempt.intent.id,
            resource,
          });
        },
        onResourceProvisioned: async (resource) => {
          checkpointStates.push(resource.state);
          await recordProvisionedResource({
            baseDir,
            environment: 'prod',
            expectedIntentId: attempt.intent.id,
            resource,
          });
        },
      });
      const intent = await loadProvisioningIntent({ baseDir, environment: 'prod' });
      const lock = createLockFile('prod', resources);
      const bucket = resources.r2[0]!;

      expect(bucket).toMatchObject({
        name: 'prod-migration-releases',
        creationDate,
        ownershipMarkerKey: expect.stringMatching(/^__authrim_setup__\/ownership-v1-/u),
        ownershipId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      });
      expect(intent?.resources['r2:MIGRATION_RELEASES']).toMatchObject(bucket);
      expect(checkpointStates).toEqual(['identified', 'created']);
      expect(lock.r2?.MIGRATION_RELEASES).toEqual({
        name: bucket.name,
        creationDate: bucket.creationDate,
        ownershipMarkerKey: bucket.ownershipMarkerKey,
        ownershipId: bucket.ownershipId,
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects a copied ownership marker key whose JSON identity does not match', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockImplementation(
      createOwnedR2ApiHandler({
        name: 'prod-migration-releases',
        markerOverrides: { ownershipId: '22222222-2222-4222-8222-222222222222' },
      })
    );

    await expect(
      assertR2BucketOwnershipForUse({
        ...ownedR2('prod-migration-releases'),
        environment: 'prod',
        binding: 'MIGRATION_RELEASES',
      })
    ).rejects.toThrow('ownership marker does not match');
  });

  it('blocks name-only R2 artifact use before contacting Cloudflare', async () => {
    await expect(
      assertR2BucketOwnershipForUse({ name: 'prod-migration-releases' })
    ).rejects.toThrow('no exact creation_date and ownership marker');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('checkpoints an explicit legacy adoption before writing and verifying its marker', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    let markerKey = '';
    let markerPayload = new Uint8Array();
    const order: string[] = [];
    fetchMock.mockImplementation(async (rawUrl: string | URL) => {
      const url = String(rawUrl);
      if (url.includes('/r2/buckets?')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: {
              buckets: [{ name: 'prod-migration-releases', creation_date: creationDate }],
            },
          }),
        };
      }
      if (new URL(url).pathname.endsWith('/r2/buckets/prod-migration-releases')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: { name: 'prod-migration-releases', creation_date: creationDate },
          }),
        };
      }
      if (url.includes('/objects?')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: markerKey ? [{ key: markerKey }] : [],
            result_info: { is_truncated: false },
          }),
        };
      }
      if (url.includes('/objects/') && markerKey) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(markerPayload.byteLength) }),
          arrayBuffer: async () => markerPayload.buffer,
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(0, 4).join(' ') !== 'wrangler r2 object put') {
        throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
      }
      order.push('put');
      markerKey = args[4]!.slice('prod-migration-releases/'.length);
      markerPayload = new Uint8Array(readFileSync(args[args.indexOf('--file') + 1]!));
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const adopted = await adoptR2BucketOwnership({
      environment: 'prod',
      binding: 'MIGRATION_RELEASES',
      name: 'prod-migration-releases',
      onPrepared: async (identity) => {
        order.push('prepared');
        expect(markerKey).toBe('');
        expect(identity.creationDate).toBe(creationDate);
      },
    });

    expect(order).toEqual(['prepared', 'put']);
    expect(adopted).toMatchObject({
      name: 'prod-migration-releases',
      creationDate,
      ownershipMarkerKey: expect.stringMatching(/^__authrim_setup__\/ownership-v1-/u),
      ownershipId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
  });

  it('rejects a bucket replaced between fresh marker write and final provider readback', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    let bucketExists = false;
    let markerPayload = new Uint8Array();
    let markerKey = '';
    let bucketListCallsAfterCreate = 0;
    fetchMock.mockImplementation(async (rawUrl: string | URL) => {
      const url = String(rawUrl);
      if (url.includes('/r2/buckets?')) {
        if (!bucketExists) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ success: true, result: { buckets: [] } }),
          };
        }
        bucketListCallsAfterCreate += 1;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: {
              buckets: [
                {
                  name: 'prod-migration-releases',
                  creation_date:
                    bucketListCallsAfterCreate >= 2 ? '2026-08-31T00:01:00.000Z' : creationDate,
                },
              ],
            },
          }),
        };
      }
      if (url.includes('/objects?')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: markerKey ? [{ key: markerKey }] : [],
            result_info: { is_truncated: false },
          }),
        };
      }
      if (url.includes('/objects/') && markerKey) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(markerPayload.byteLength) }),
          arrayBuffer: async () => markerPayload.buffer,
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(0, 4).join(' ') === 'wrangler r2 bucket create') {
        bucketExists = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.slice(0, 4).join(' ') === 'wrangler r2 object put') {
        const path = args[args.indexOf('--file') + 1]!;
        markerPayload = new Uint8Array(readFileSync(path));
        markerKey = args[4]!.slice('prod-migration-releases/'.length);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
    });

    await expect(provisionR2Buckets('prod', { includeFeatureBuckets: false })).rejects.toThrow(
      'was replaced while Setup established its ownership marker'
    );
  });

  it('resumes a create_issued R2 checkpoint only with exact provider and marker identity', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockImplementation(
      createOwnedR2ApiHandler({
        name: 'prod-migration-releases',
        markerOverrides: { environment: 'prod', binding: 'MIGRATION_RELEASES' },
      })
    );
    const onResourceProvisioned = vi.fn().mockResolvedValue(undefined);
    const onResourceIdentified = vi.fn().mockResolvedValue(undefined);

    await expect(
      provisionR2Buckets('prod', {
        includeFeatureBuckets: false,
        provisioningIntentResources: {
          'r2:MIGRATION_RELEASES': {
            kind: 'r2',
            binding: 'MIGRATION_RELEASES',
            name: 'prod-migration-releases',
            state: 'create_issued',
            ownershipMarkerKey,
            ownershipId,
          },
        },
        onResourceCreateIssued: vi.fn().mockResolvedValue(undefined),
        onResourceCreateRejected: vi.fn().mockResolvedValue(undefined),
        onResourceIdentified,
        onResourceProvisioned,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        binding: 'MIGRATION_RELEASES',
        name: 'prod-migration-releases',
        creationDate,
        ownershipMarkerKey,
        ownershipId,
      }),
    ]);
    expect(onResourceProvisioned).toHaveBeenCalledOnce();
    expect(onResourceIdentified).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'identified', creationDate })
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('never reissues an interrupted create_issued R2 mutation while inventory is absent', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ success: true, result: { buckets: [] } }),
    });

    await expect(
      provisionR2Buckets('prod', {
        includeFeatureBuckets: false,
        provisioningIntentResources: {
          'r2:MIGRATION_RELEASES': {
            kind: 'r2',
            binding: 'MIGRATION_RELEASES',
            name: 'prod-migration-releases',
            state: 'create_issued',
            ownershipMarkerKey,
            ownershipId,
          },
        },
        onResourceCreateIssued: vi.fn().mockResolvedValue(undefined),
        onResourceCreateRejected: vi.fn().mockResolvedValue(undefined),
        onResourceIdentified: vi.fn().mockResolvedValue(undefined),
        onResourceProvisioned: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('Setup will not reissue the create');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('keeps a legacy name-only R2 lock usable as a non-destructive binding', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockImplementation(createOwnedR2ApiHandler({ name: 'prod-migration-releases' }));

    await expect(
      provisionR2Buckets('prod', {
        includeFeatureBuckets: false,
        existing: { MIGRATION_RELEASES: { name: 'prod-migration-releases' } },
      })
    ).resolves.toEqual([{ binding: 'MIGRATION_RELEASES', name: 'prod-migration-releases' }]);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('rejects an explicit R2 name collision instead of adopting another actor bucket', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const onResourceCreateIssued = vi.fn().mockResolvedValue(undefined);
    const onResourceCreateRejected = vi.fn().mockResolvedValue(undefined);
    const onResourceProvisioned = vi.fn().mockResolvedValue(undefined);
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'A bucket with this name already exists',
      });

    await expect(
      provisionR2Buckets('prod', {
        includeFeatureBuckets: false,
        provisioningIntentResources: {},
        onResourceCreateIssued,
        onResourceCreateRejected,
        onResourceProvisioned,
      })
    ).rejects.toThrow('already exists');
    expect(onResourceCreateIssued).toHaveBeenCalledOnce();
    expect(onResourceCreateRejected).toHaveBeenCalledOnce();
    expect(onResourceProvisioned).not.toHaveBeenCalled();
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler r2 bucket create'
      )
    ).toHaveLength(1);
  });

  it('marks recorded R2 buckets as unconfigured when Cloudflare no longer lists them', () => {
    const ownershipId = '00000000-0000-4000-8000-000000000123';
    const status = buildR2BucketProvisioningStatus(
      'prod',
      {
        DIAGNOSTIC_LOGS: {
          name: 'prod-diagnostic-logs',
          creationDate: '2026-05-18T00:00:00.000Z',
          ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
          ownershipId,
        },
      },
      []
    );

    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(0);
    expect(status.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'DIAGNOSTIC_LOGS',
          name: 'prod-diagnostic-logs',
          recorded: true,
          exists: false,
          configured: false,
          state: 'recorded_but_missing',
        }),
      ])
    );
  });

  it('reports R2 enabled only when every exact recorded identity exists in Cloudflare', () => {
    const creationDate = '2026-05-18T00:00:00.000Z';
    const exact = (name: string, index: number) => {
      const ownershipId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      return {
        name,
        creationDate,
        ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
        ownershipId,
      };
    };
    const status = buildR2BucketProvisioningStatus(
      'prod',
      {
        MIGRATION_RELEASES: exact('prod-migration-releases', 1),
        PLUGIN_BUNDLES: exact('prod-plugin-bundles', 2),
        PUBLIC_ASSETS: exact('prod-public-assets', 3),
        DIAGNOSTIC_LOGS: exact('prod-diagnostic-logs', 4),
        AUDIT_ARCHIVE: exact('prod-audit-archive', 5),
        IMPORT_ARTIFACTS: exact('prod-import-artifacts', 6),
        EXPORT_ARTIFACTS: exact('prod-export-artifacts', 7),
        SENSITIVE_DETAILS: exact('prod-sensitive-details', 8),
      },
      [
        { name: 'prod-migration-releases', creationDate },
        { name: 'prod-plugin-bundles', creationDate },
        { name: 'prod-public-assets', creationDate },
        { name: 'prod-diagnostic-logs', creationDate },
        { name: 'prod-audit-archive', creationDate },
        { name: 'prod-import-artifacts', creationDate },
        { name: 'prod-export-artifacts', creationDate },
        { name: 'prod-sensitive-details', creationDate },
      ]
    );

    expect(status.enabled).toBe(true);
    expect(status.required).toBe(8);
    expect(status.configured).toBe(8);
    expect(status.missing).toEqual([]);
    expect(status.buckets.every((bucket) => bucket.state === 'configured')).toBe(true);
  });

  it('does not configure a same-name replacement with a different provider identity', () => {
    const ownershipId = '00000000-0000-4000-8000-000000000123';
    const status = buildR2BucketProvisioningStatus(
      'prod',
      {
        MIGRATION_RELEASES: {
          name: 'prod-migration-releases',
          creationDate: '2026-05-18T00:00:00.000Z',
          ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
          ownershipId,
        },
      },
      [{ name: 'prod-migration-releases', creationDate: '2026-05-19T00:00:00.000Z' }]
    );

    expect(status.configured).toBe(0);
    expect(status.buckets[0]).toMatchObject({
      state: 'identity_mismatch',
      exactOwnership: true,
      providerIdentityMatches: false,
      configured: false,
    });
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
      source: 'Upload',
    });
  });

  it('retries transient Worker deployment inventory failures', async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 429 Too Many Requests',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `
Created:     2026-05-18T07:36:06.414Z
Author:      new@example.com
Source:      Upload
Version(s):  (100%) 22222222-2222-4222-8222-222222222222
`.trim(),
        stderr: '',
      });

    await expect(getWorkerDeployments('test-ar-lib-core')).resolves.toMatchObject({
      exists: true,
      versionId: '22222222-2222-4222-8222-222222222222',
    });
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('retries the exact transient Wrangler authentication code 10000 inventory failure', async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Authentication error [code: 10000]',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `
Created:     2026-05-18T07:36:06.414Z
Author:      new@example.com
Source:      Upload
Version(s):  (100%) 22222222-2222-4222-8222-222222222222
`.trim(),
        stderr: '',
      });

    await expect(getWorkerDeployments('test-ar-lib-core')).resolves.toMatchObject({
      exists: true,
      versionId: '22222222-2222-4222-8222-222222222222',
    });
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('reports only an exact Worker not-found response as absent', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Worker does not exist [code: 10007]',
    });

    await expect(getWorkerDeployments('test-ar-missing')).resolves.toMatchObject({
      name: 'test-ar-missing',
      exists: false,
    });
  });

  it('verifies an uploaded Worker version without requiring it to be active', async () => {
    const versionId = '22222222-2222-4222-8222-222222222222';
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ id: versionId, resources: { bindings: [] } }),
      stderr: '',
    });

    await expect(getWorkerVersion('test-ar-lib-core', versionId)).resolves.toEqual({
      name: 'test-ar-lib-core',
      exists: true,
      versionId,
    });
    expect(execaMock).toHaveBeenCalledWith(
      'npx',
      ['wrangler', 'versions', 'view', versionId, '--name', 'test-ar-lib-core', '--json'],
      expect.objectContaining({ env: expect.objectContaining({ WRANGLER_LOG: 'log' }) })
    );
  });

  it('reports a definitely missing uploaded Worker version as absent', async () => {
    const versionId = '22222222-2222-4222-8222-222222222222';
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: `Worker version ${versionId} not found`,
    });

    await expect(getWorkerVersion('test-ar-lib-core', versionId)).resolves.toEqual({
      name: 'test-ar-lib-core',
      exists: false,
      versionId: null,
    });
  });

  it('fails closed when uploaded Worker version output is malformed', async () => {
    const versionId = '22222222-2222-4222-8222-222222222222';
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' });

    await expect(getWorkerVersion('test-ar-lib-core', versionId)).rejects.toThrow(
      'Worker version inventory unavailable'
    );
  });

  it('fails closed when Worker inventory is unavailable due to permissions', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 403 permission denied',
    });

    await expect(getWorkerDeployments('test-ar-lib-core')).rejects.toThrow(
      'Worker deployment inventory unavailable'
    );
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('fails closed when successful Wrangler output has no parseable deployment evidence', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'Deployment inventory format changed',
      stderr: '',
    });

    await expect(getWorkerDeployments('test-ar-lib-core')).rejects.toThrow(
      'Worker deployment inventory unavailable'
    );
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('blocks name-only legacy R2 deletion before invoking Cloudflare', async () => {
    await expect(
      deleteR2Bucket('prod-sensitive-details', {
        objectKeys: ['objects/one.json'],
      })
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringContaining('no exact creation_date and ownership marker'),
    });
    expect(execaMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('empties R2 objects listed by Cloudflare API before deleting the bucket', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

    fetchMock.mockImplementation(
      createOwnedR2ApiHandler({
        name: 'prod-audit-archive',
        objects: ['logs/v1/a.json', 'logs/v1/b.json'],
      })
    );

    await expect(
      deleteR2Bucket('prod-audit-archive', { ownership: ownedR2('prod-audit-archive') })
    ).resolves.toEqual({ status: 'deleted' });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/objects/logs/v1/a.json'),
        expect.stringContaining('/objects/logs/v1/b.json'),
      ])
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/r2/buckets/prod-audit-archive',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('rejects repeated R2 deletion-list cursors without deleting objects or the bucket', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    let dataPage = 0;
    fetchMock.mockImplementation(
      createOwnedR2ApiHandler({
        name: 'prod-audit-archive',
        onObjectList: (url) => {
          if (url.includes('prefix=')) return undefined;
          dataPage += 1;
          return {
            result: [{ key: dataPage === 1 ? 'first' : 'second' }],
            resultInfo: { is_truncated: true, cursor: 'repeated' },
          };
        },
      })
    );

    await expect(
      deleteR2Bucket('prod-audit-archive', { ownership: ownedR2('prod-audit-archive') })
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringContaining('cloudflare_r2_object_list_cursor_cycle'),
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as FetchInit | undefined)?.method === 'DELETE')
    ).toBe(false);
  });

  it('rejects a truncated empty R2 deletion-list page as incomplete', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockImplementation(
      createOwnedR2ApiHandler({
        name: 'prod-audit-archive',
        onObjectList: (url) =>
          url.includes('prefix=')
            ? undefined
            : {
                result: [],
                resultInfo: { is_truncated: true, cursor: 'next' },
              },
      })
    );

    await expect(
      deleteR2Bucket('prod-audit-archive', { ownership: ownedR2('prod-audit-archive') })
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringContaining('cloudflare_r2_object_list_truncated_empty_page'),
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as FetchInit | undefined)?.method === 'DELETE')
    ).toBe(false);
  });

  it('skips large R2 buckets and returns a dashboard cleanup target', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockImplementation(
      createOwnedR2ApiHandler({
        name: 'prod-audit-archive',
        objects: Array.from({ length: 2_000 }, (_, index) => `logs/${index}.json`),
      })
    );

    await expect(
      deleteR2Bucket('prod-audit-archive', { ownership: ownedR2('prod-audit-archive') })
    ).resolves.toEqual({
      status: 'manual_cleanup_required',
      target: {
        bucketName: 'prod-audit-archive',
        objectCount: 2_000,
        dashboardUrl:
          'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/r2/default/buckets/prod-audit-archive',
      },
    });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('never refreshes or replaces an explicitly supplied R2 API credential after 401', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'inventory-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    const handler = createOwnedR2ApiHandler({ name: 'prod-audit-archive' });
    fetchMock.mockImplementation(async (url: string | URL, init: FetchInit = {}) => {
      if (String(url).includes(`/objects/${ownershipMarkerKey}`)) {
        const response = await handler(url, init);
        const originalRead = response.arrayBuffer;
        return {
          ...response,
          arrayBuffer: async () => {
            const bytes = await originalRead();
            delete process.env.CLOUDFLARE_API_TOKEN;
            delete process.env.CLOUDFLARE_ACCOUNT_ID;
            return bytes;
          },
        };
      }
      if (String(url).includes('/objects?') && !String(url).includes('prefix=')) {
        return {
          ok: false,
          status: 401,
          headers: new Headers(),
          json: async () => ({
            success: false,
            errors: [{ code: 10_000, message: 'Authentication error' }],
          }),
        };
      }
      return handler(url, init);
    });

    await expect(
      deleteR2Bucket('prod-audit-archive', {
        ownership: ownedR2('prod-audit-archive'),
        apiCredentials: {
          accountId: '0123456789abcdef0123456789abcdef',
          token: 'explicit-delete-token',
          source: 'env',
        },
      })
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringContaining('401'),
    });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('deletes Cloudflare API R2 objects concurrently without exceeding the cap', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

    let activeObjectDeletes = 0;
    let maxActiveObjectDeletes = 0;
    const handler = createOwnedR2ApiHandler({
      name: 'prod-audit-archive',
      objects: Array.from({ length: 12 }, (_, index) => `logs/${index}.json`),
    });
    fetchMock.mockImplementation(async (url: string | URL, init: FetchInit = {}) => {
      if (
        String(url).includes('/objects/logs/') &&
        (init.method ?? 'GET').toUpperCase() === 'DELETE'
      ) {
        activeObjectDeletes += 1;
        maxActiveObjectDeletes = Math.max(maxActiveObjectDeletes, activeObjectDeletes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeObjectDeletes -= 1;
      }
      return handler(url, init);
    });

    await expect(
      deleteR2Bucket('prod-audit-archive', { ownership: ownedR2('prod-audit-archive') })
    ).resolves.toEqual({ status: 'deleted' });

    expect(maxActiveObjectDeletes).toBe(5);
  });

  it('does not blindly retry a name-addressed R2 DELETE after a transient response', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    const handler = createOwnedR2ApiHandler({
      name: 'prod-audit-archive',
      objects: ['logs/a.json'],
    });
    let deleteAttempts = 0;
    fetchMock.mockImplementation(async (url: string | URL, init: FetchInit = {}) => {
      if (
        String(url).includes('/objects/logs/a.json') &&
        (init.method ?? 'GET').toUpperCase() === 'DELETE'
      ) {
        deleteAttempts += 1;
        return {
          ok: false,
          status: 429,
          headers: new Headers(),
          json: async () => ({
            success: false,
            errors: [{ code: 971, message: 'Please throttle' }],
          }),
        };
      }
      return handler(url, init);
    });

    await expect(
      deleteR2Bucket('prod-audit-archive', { ownership: ownedR2('prod-audit-archive') })
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringContaining('429'),
    });

    expect(deleteAttempts).toBe(1);
    expect(execaMock).not.toHaveBeenCalled();
  });
});
