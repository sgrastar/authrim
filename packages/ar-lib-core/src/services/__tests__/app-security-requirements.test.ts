import { describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';
import {
  redirectUriSchemeAllowed,
  resolveAppSecurityRequirements,
} from '../app-security-requirements';

function envWith(documents: Record<string, Record<string, unknown>>): EffectiveSettingsEnv {
  return {
    SETTINGS: {
      get: vi.fn(async (key: string) =>
        documents[key] === undefined ? null : JSON.stringify(documents[key])
      ),
    },
  } as unknown as EffectiveSettingsEnv;
}

describe('resolveAppSecurityRequirements', () => {
  it('is HTTPS-only and requires nothing else by default', async () => {
    expect(await resolveAppSecurityRequirements(envWith({}), 'tenant-a', 'app-1')).toEqual({
      pkceRequired: false,
      httpsRedirectOnly: true,
      dpopBoundAccessTokens: false,
      requireEncryptedRequestObject: false,
    });
  });

  it('takes a requirement from the tenant or the app, and the app cannot waive the tenant’s', async () => {
    const env = envWith({
      'settings:tenant:tenant-a:security': {
        'security.pkce_required': true,
        'security.https_redirect_only': false,
      },
      'settings:client:tenant-a:app-1:security': {
        'security.pkce_required': false,
        'security.dpop_bound_access_tokens': true,
      },
    });
    const app = await resolveAppSecurityRequirements(env, 'tenant-a', 'app-1');
    expect(app.pkceRequired).toBe(true);
    expect(app.dpopBoundAccessTokens).toBe(true);
    // The tenant allows a web app's http loopback; the app did not ask for HTTPS only.
    expect(app.httpsRedirectOnly).toBe(false);

    const other = await resolveAppSecurityRequirements(env, 'tenant-a', 'app-2');
    expect(other.dpopBoundAccessTokens).toBe(false);
  });

  it('lets an app keep HTTPS only where the tenant allows http loopback', async () => {
    const env = envWith({
      'settings:tenant:tenant-a:security': { 'security.https_redirect_only': false },
      'settings:client:tenant-a:app-1:security': { 'security.https_redirect_only': true },
    });
    expect((await resolveAppSecurityRequirements(env, 'tenant-a', 'app-1')).httpsRedirectOnly).toBe(
      true
    );
  });
});

describe('redirectUriSchemeAllowed', () => {
  const strict = { nativeApp: false, httpsRedirectOnly: true };
  it('always allows HTTPS and never http off a loopback host', () => {
    expect(redirectUriSchemeAllowed('https://app.example/cb', strict)).toBe(true);
    expect(
      redirectUriSchemeAllowed('http://app.example/cb', {
        nativeApp: true,
        httpsRedirectOnly: false,
      })
    ).toBe(false);
  });

  it('allows http loopback for a native app, and for a web app only when the tenant does', () => {
    for (const uri of ['http://localhost:8080/cb', 'http://127.0.0.1/cb', 'http://[::1]:9/cb']) {
      expect(redirectUriSchemeAllowed(uri, { nativeApp: true, httpsRedirectOnly: true })).toBe(
        true
      );
      expect(redirectUriSchemeAllowed(uri, strict)).toBe(false);
      expect(redirectUriSchemeAllowed(uri, { nativeApp: false, httpsRedirectOnly: false })).toBe(
        true
      );
    }
  });
});
