import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { listD1Databases, parseD1DatabaseListOutput } from '../core/cloudflare.js';

describe('Cloudflare D1 database listing', () => {
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

  it('extracts a validated D1 list from noisy Wrangler output', () => {
    const escape = String.fromCharCode(27);
    const output = [
      `${escape}[33m[wrangler:notice] A newer version is available${escape}[0m`,
      JSON.stringify([
        { name: 'test-authrim-core-db', uuid: 'core-id' },
        { name: 'test-authrim-admin-db', uuid: 'admin-id' },
      ]),
      'Wrangler command completed',
    ].join('\n');

    expect(parseD1DatabaseListOutput(output)).toEqual([
      { name: 'test-authrim-core-db', uuid: 'core-id' },
      { name: 'test-authrim-admin-db', uuid: 'admin-id' },
    ]);
  });

  it('rejects JSON arrays that do not have the D1 database shape', () => {
    expect(() => parseD1DatabaseListOutput('["notice"]\n[{"name":"missing-uuid"}]')).toThrow(
      'valid D1 database list'
    );
  });

  it('prefers the Cloudflare API when CI credentials are available', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ name: 'test-authrim-core-db', uuid: 'current-core-id' }],
        result_info: { total_count: 1 },
      }),
    });

    await expect(listD1Databases()).resolves.toEqual([
      { name: 'test-authrim-core-db', uuid: 'current-core-id' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database?page=1&per_page=1000'
      ),
      { headers: { Authorization: 'Bearer test-token' } }
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
        JSON.stringify([{ name: 'test-authrim-admin-db', uuid: 'current-admin-id' }]),
      stderr: '',
    });

    await expect(listD1Databases()).resolves.toEqual([
      { name: 'test-authrim-admin-db', uuid: 'current-admin-id' },
    ]);
    expect(execaMock).toHaveBeenCalledWith(
      'npx',
      ['wrangler', 'd1', 'list', '--json'],
      expect.objectContaining({ reject: false, timeout: 30000 })
    );
  });
});
