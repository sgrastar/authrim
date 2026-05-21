import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAuth } from '../core/cloudflare.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalFetch = globalThis.fetch;

describe('checkAuth', () => {
  beforeEach(() => {
    vi.mocked(execa).mockReset();
    process.env.CLOUDFLARE_API_TOKEN = 'test-api-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;
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

    globalThis.fetch = originalFetch;
  });

  it('accepts verified Cloudflare API token auth when wrangler whoami has no login session', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'Not logged in. Run `wrangler login`.',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(checkAuth()).resolves.toEqual({
      isLoggedIn: true,
      accountId: '0123456789abcdef0123456789abcdef',
      email: 'api-token',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      {
        headers: {
          Authorization: 'Bearer test-api-token',
        },
      }
    );
  });

  it('rejects Cloudflare API token auth when token verification fails', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'Not logged in. Run `wrangler login`.',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ success: false }), { status: 403 });
    }) as typeof fetch;

    await expect(checkAuth()).resolves.toEqual({ isLoggedIn: false });
  });
});
