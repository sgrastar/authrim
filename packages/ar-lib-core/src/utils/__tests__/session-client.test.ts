import { describe, expect, it } from 'vitest';
import { describeSessionClient, getSessionClientMetadata } from '../session-client';

describe('session client metadata', () => {
  it('describes iPhone Safari without relying on Cloudflare metadata', () => {
    expect(
      describeSessionClient(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
      )
    ).toEqual({ browser: 'Safari', os: 'iOS', deviceType: 'mobile' });
  });

  it('describes desktop Chrome', () => {
    expect(
      describeSessionClient(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      )
    ).toEqual({ browser: 'Google Chrome', os: 'macOS', deviceType: 'desktop' });
  });

  it('returns nulls instead of guessing when User-Agent is unavailable', () => {
    expect(describeSessionClient(undefined)).toEqual({
      browser: null,
      os: null,
      deviceType: null,
    });
  });

  it('captures country only from valid Cloudflare request metadata', () => {
    const request = new Request('https://example.com', {
      headers: { 'User-Agent': 'Example Browser' },
    }) as Request & { cf?: { country?: string } };
    request.cf = { country: 'jp' };

    expect(getSessionClientMetadata(request)).toEqual({
      userAgent: 'Example Browser',
      countryCode: 'JP',
    });
  });

  it('does not trust a country header outside Cloudflare', () => {
    const request = new Request('https://example.com', {
      headers: { 'CF-IPCountry': 'JP' },
    });

    expect(getSessionClientMetadata(request)).toEqual({});
  });
});
