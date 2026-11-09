import { describe, expect, it } from 'vitest';
import { buildBrowserClientMetadata } from '../core/browser-client-metadata.js';

describe('buildBrowserClientMetadata', () => {
  it.each(['managed_browser_session', 'cookie_session'] as const)(
    'keeps %s as a PKCE public client without browser refresh tokens',
    (sessionProfile) => {
      const metadata = buildBrowserClientMetadata({
        clientName: 'Browser App',
        redirectUris: ['https://app.example.test/callback'],
        sessionProfile,
      });

      expect(metadata).toMatchObject({
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        require_pkce: true,
        browser_public_client_mode: 'cookie_fallback',
        browser_refresh_token_policy: 'disabled',
      });
      expect(metadata).not.toHaveProperty('dpop_bound_access_tokens');
    }
  );

  it('requires DPoP-bound access and refresh tokens for a token session', () => {
    const metadata = buildBrowserClientMetadata({
      clientName: 'Token App',
      redirectUris: ['https://app.example.test/callback'],
      sessionProfile: 'token_session',
    });

    expect(metadata).toMatchObject({
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      browser_public_client_mode: 'strict',
      browser_refresh_token_policy: 'dpop_bound',
      dpop_bound_access_tokens: true,
    });
  });

  it('registers each valid redirect origin once and keeps first-seen order', () => {
    const metadata = buildBrowserClientMetadata({
      clientName: 'Browser App',
      redirectUris: [
        'https://APP.example.test:443/callback',
        'https://second.example.test/return',
        'not a URI',
        'https://app.example.test/another-callback',
      ],
      allowedRedirectOrigins: [
        'https://second.example.test',
        'https://third.example.test/some/path',
      ],
      sessionProfile: 'cookie_session',
    });

    expect(metadata.allowed_redirect_origins).toEqual([
      'https://second.example.test',
      'https://third.example.test/some/path',
    ]);
    expect(metadata.web_origin_registry?.origins).toEqual(
      ['https://app.example.test', 'https://second.example.test', 'https://third.example.test'].map(
        (origin) => ({
          origin,
          cors: { allowed: true },
          handoff_allowed: true,
          iframe_allowed: false,
        })
      )
    );
  });

  it('does not create an origin registry from malformed redirects', () => {
    const metadata = buildBrowserClientMetadata({
      clientName: 'Browser App',
      redirectUris: ['invalid redirect'],
      allowedRedirectOrigins: [],
      sessionProfile: 'managed_browser_session',
      description: 'Example',
      scope: 'openid',
      trusted: false,
      skipConsent: false,
    });

    expect(metadata).toMatchObject({
      description: 'Example',
      scope: 'openid',
      is_trusted: false,
      skip_consent: false,
    });
    expect(metadata).not.toHaveProperty('allowed_redirect_origins');
    expect(metadata).not.toHaveProperty('web_origin_registry');
  });
});
