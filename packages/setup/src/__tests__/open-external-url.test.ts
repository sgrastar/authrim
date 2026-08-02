import { describe, expect, it, vi } from 'vitest';
import { openExternalHttpsUrl } from '../core/open-external-url.js';

describe('openExternalHttpsUrl', () => {
  it('opens the exact HTTPS URL with the platform browser command', async () => {
    const runner = vi.fn(async () => undefined);
    await expect(
      openExternalHttpsUrl('https://dash.cloudflare.com/profile/api-tokens?name=authrim', {
        platform: 'darwin',
        runner,
      })
    ).resolves.toBe(true);
    expect(runner).toHaveBeenCalledWith('open', [
      'https://dash.cloudflare.com/profile/api-tokens?name=authrim',
    ]);
  });

  it('rejects non-HTTPS URLs before invoking a command', async () => {
    const runner = vi.fn(async () => undefined);
    await expect(
      openExternalHttpsUrl('http://localhost/token', { platform: 'darwin', runner })
    ).rejects.toThrow('external_url_must_be_https');
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns false when the browser command is unavailable', async () => {
    await expect(
      openExternalHttpsUrl('https://dash.cloudflare.com/', {
        platform: 'linux',
        runner: async () => {
          throw new Error('missing');
        },
      })
    ).resolves.toBe(false);
  });
});
