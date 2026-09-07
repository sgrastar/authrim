import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  getOptionalKVKeyByNamespaceId,
  listKVNamespaces,
  parseKVKeyListOutput,
  parseKVNamespaceListOutput,
} from '../core/cloudflare.js';

describe('Cloudflare KV namespace listing', () => {
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
    vi.unstubAllGlobals();
  });

  it('extracts a validated KV list from noisy Wrangler output', () => {
    const escape = String.fromCharCode(27);
    const output = [
      `${escape}[33m[wrangler:notice] A newer version is available${escape}[0m`,
      JSON.stringify([
        { title: 'TEST-AUTHRIM_CONFIG', id: 'config-id' },
        { title: 'TEST-SETTINGS', id: 'settings-id' },
      ]),
      'Wrangler command completed',
    ].join('\n');

    expect(parseKVNamespaceListOutput(output)).toEqual([
      { title: 'TEST-AUTHRIM_CONFIG', id: 'config-id' },
      { title: 'TEST-SETTINGS', id: 'settings-id' },
    ]);
  });

  it('rejects JSON arrays that do not have the KV namespace shape', () => {
    expect(() => parseKVNamespaceListOutput('["notice"]\n[{"title":"missing-id"}]')).toThrow(
      'valid KV namespace list'
    );
  });

  it('rejects duplicate Wrangler KV names or immutable IDs', () => {
    expect(() =>
      parseKVNamespaceListOutput(
        JSON.stringify([
          { title: 'SAME', id: 'first-id' },
          { title: 'SAME', id: 'second-id' },
        ])
      )
    ).toThrow('duplicate resource name');
    expect(() =>
      parseKVNamespaceListOutput(
        JSON.stringify([
          { title: 'FIRST', id: 'same-id' },
          { title: 'SECOND', id: 'same-id' },
        ])
      )
    ).toThrow('duplicate immutable resource ID');
  });

  it('parses exact KV key inventory and reads only an exact match', async () => {
    expect(parseKVKeyListOutput('[{"name":"region_shard_config:tenant-a"}]')).toEqual([
      { name: 'region_shard_config:tenant-a' },
    ]);
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'region_shard_config:tenant-a' },
          { name: 'region_shard_config:tenant-a:other' },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"version":2}', stderr: '' });

    await expect(
      getOptionalKVKeyByNamespaceId('namespace-a', 'region_shard_config:tenant-a')
    ).resolves.toBe('{"version":2}');
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      'npx',
      [
        'wrangler',
        'kv',
        'key',
        'list',
        '--namespace-id',
        'namespace-a',
        '--prefix',
        'region_shard_config:tenant-a',
        '--remote',
      ],
      expect.objectContaining({ reject: false, timeout: 60000 })
    );
  });

  it('returns null without issuing a value read when the exact KV key is absent', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([{ name: 'region_shard_config:tenant-a:other' }]),
      stderr: '',
    });
    await expect(
      getOptionalKVKeyByNamespaceId('namespace-a', 'region_shard_config:tenant-a')
    ).resolves.toBeNull();
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('prefers the Cloudflare API when CI credentials are available', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ title: 'TEST-AUTHRIM_CONFIG', id: 'current-config-id' }],
        result_info: { total_count: 1 },
      }),
    });

    await expect(listKVNamespaces()).resolves.toEqual([
      { title: 'TEST-AUTHRIM_CONFIG', id: 'current-config-id' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/storage/kv/namespaces?page=1&per_page=1000'
      ),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('falls back to noisy Wrangler JSON when the Cloudflare API is unavailable', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout:
        '[wrangler:notice] retrying with the CLI\n' +
        JSON.stringify([{ title: 'TEST-SETTINGS', id: 'current-settings-id' }]),
      stderr: '',
    });

    await expect(listKVNamespaces()).resolves.toEqual([
      { title: 'TEST-SETTINGS', id: 'current-settings-id' },
    ]);
    expect(execaMock).toHaveBeenCalledWith(
      'npx',
      ['wrangler', 'kv', 'namespace', 'list'],
      expect.objectContaining({ reject: false, timeout: 30000 })
    );
  });
});
