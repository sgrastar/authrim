import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAuth, getAccountId, getCloudflareApiToken } from '../core/cloudflare.js';

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
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-api-token',
        },
        signal: expect.any(AbortSignal),
      })
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

  it('accepts an account-owned token through the pinned account verification route', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      return url.includes('/user/tokens/verify')
        ? new Response(JSON.stringify({ success: false }), { status: 403 })
        : new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    await expect(checkAuth()).resolves.toEqual({
      isLoggedIn: true,
      accountId: '0123456789abcdef0123456789abcdef',
      email: 'api-token',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/tokens/verify',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-api-token' },
      })
    );
  });

  it('uses an explicit API token instead of a stored Wrangler OAuth session', async () => {
    await expect(getCloudflareApiToken()).resolves.toEqual({
      token: 'test-api-token',
      source: 'env',
    });
  });

  it('uses Wranglers supported resolver for Keychain-backed OAuth credentials', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ type: 'oauth', token: 'wrangler-oauth-token' }),
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(getCloudflareApiToken()).resolves.toEqual({
      token: 'wrangler-oauth-token',
      source: 'oauth',
    });
    expect(execa).toHaveBeenCalledWith(
      'npx',
      ['wrangler', 'auth', 'token', '--json'],
      expect.objectContaining({ reject: false, timeout: 30_000 })
    );
  });

  it('accepts an API token resolved by Wrangler without treating it as refreshable OAuth', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ type: 'api_token', token: 'wrangler-api-token' }),
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(getCloudflareApiToken()).resolves.toEqual({
      token: 'wrangler-api-token',
      source: 'env',
    });
  });

  it('uses an explicit API token before a cached Wrangler OAuth session', async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout:
        'You are logged in with an OAuth Token.\nAccount ID: fedcba9876543210fedcba9876543210',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(checkAuth()).resolves.toEqual({
      isLoggedIn: true,
      accountId: '0123456789abcdef0123456789abcdef',
      email: 'api-token',
    });
    expect(execa).not.toHaveBeenCalled();
  });

  it('does not fall back to cached OAuth when the explicit API token is invalid', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ success: false }), { status: 403 });
    }) as typeof fetch;
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout:
        'You are logged in with an OAuth Token.\nAccount ID: fedcba9876543210fedcba9876543210',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(checkAuth()).resolves.toEqual({ isLoggedIn: false });
    expect(execa).not.toHaveBeenCalled();
  });

  it('does not borrow an OAuth account ID for an explicit token without an account ID', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout:
        'You are logged in with an OAuth Token.\nAccount ID: fedcba9876543210fedcba9876543210',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(getAccountId()).resolves.toBeNull();
    expect(execa).not.toHaveBeenCalled();
  });

  it('uses the explicitly selected account for a Wrangler OAuth session', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout:
        'You are logged in with an OAuth Token.\nAccount A: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAccount B: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(checkAuth()).resolves.toMatchObject({
      isLoggedIn: true,
      accountId: '0123456789abcdef0123456789abcdef',
    });
  });

  it('refuses to guess between multiple Wrangler OAuth accounts', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout:
        'You are logged in with an OAuth Token.\nAccount A: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAccount B: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(checkAuth()).resolves.toMatchObject({
      isLoggedIn: true,
      accountId: undefined,
    });
    await expect(getAccountId()).resolves.toBeNull();
  });
});
