import { describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import {
  adminWebAuthnOriginMatchesRpId,
  getAdminWebAuthnAllowedOrigins,
  resolveAdminWebAuthnBrowserOrigin,
} from '../admin-webauthn-origin';

function env(overrides: Partial<Env> = {}): Env {
  return {
    ISSUER_URL: 'https://auth.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '60',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    REFRESH_TOKEN_EXPIRY: '7776000',
    ...overrides,
  } as Env;
}

describe('admin WebAuthn origin policy', () => {
  it('builds the Admin WebAuthn allowlist from dedicated admin settings', () => {
    expect(
      getAdminWebAuthnAllowedOrigins(
        env({
          ADMIN_UI_URL: 'https://admin.example.com/path',
          ADMIN_WEBAUTHN_ALLOWED_ORIGINS: 'https://ops.example.com, https://*.admin.example.net',
        })
      )
    ).toEqual([
      'https://ops.example.com',
      'https://*.admin.example.net',
      'https://admin.example.com',
      'https://auth.example.com',
    ]);
  });

  it('uses a configured forwarded browser origin for Admin UI BFF mode', () => {
    expect(
      resolveAdminWebAuthnBrowserOrigin({
        env: env({ ADMIN_UI_URL: 'https://admin.example.com' }),
        originHeader: 'https://auth.example.com',
        bffModeHeader: 'cross-site-proxy-bff',
        forwardedOriginHeader: 'https://admin.example.com',
      })
    ).toBe('https://admin.example.com');
  });

  it('rejects unconfigured forwarded browser origins', () => {
    expect(
      resolveAdminWebAuthnBrowserOrigin({
        env: env({ ADMIN_UI_URL: 'https://admin.example.com' }),
        originHeader: 'https://auth.example.com',
        bffModeHeader: 'cross-site-proxy-bff',
        forwardedOriginHeader: 'https://evil.example.com',
      })
    ).toBeNull();
  });

  it('requires the RP ID to match the approved browser origin host', () => {
    expect(adminWebAuthnOriginMatchesRpId('https://admin.example.com', 'admin.example.com')).toBe(
      true
    );
    expect(adminWebAuthnOriginMatchesRpId('https://admin.example.com', 'evil.example.com')).toBe(
      false
    );
  });
});
