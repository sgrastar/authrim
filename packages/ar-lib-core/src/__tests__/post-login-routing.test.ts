import { describe, expect, it } from 'vitest';
import {
  parseTrustedRedirectOrigins,
  resolvePostLoginRedirectUrl,
  resolveRegistrationCompletionRedirectUrl,
  validateServiceSitePath,
  validateAccountPagePath,
  validateLoginEntryPostLoginSettings,
  validateTrustedRedirectOrigins,
} from '../utils/post-login-routing';

function createSettingsKV(records: Record<string, unknown>) {
  return {
    async get(key: string): Promise<string | null> {
      const value = records[key];
      return value === undefined ? null : JSON.stringify(value);
    },
  };
}

describe('post-login routing helpers', () => {
  it('accepts an empty trusted redirect origin array', () => {
    expect(validateTrustedRedirectOrigins('[]')).toBe(true);
    expect(parseTrustedRedirectOrigins('[]')).toEqual([]);
  });

  it('rejects trusted redirect origin lists that contain invalid entries', () => {
    expect(validateTrustedRedirectOrigins('["https://app.example","http://app.example"]')).toBe(
      false
    );
    expect(validateTrustedRedirectOrigins('https://app.example,notaurl')).toBe(false);
  });

  it('normalizes valid trusted redirect origins', () => {
    expect(parseTrustedRedirectOrigins('["https://app.example/","https://app.example"]')).toEqual([
      'https://app.example',
    ]);
  });

  it('rejects trusted redirect origin entries with paths, queries, or fragments', () => {
    expect(validateTrustedRedirectOrigins('["https://app.example/path"]')).toBe(false);
    expect(validateTrustedRedirectOrigins('["https://app.example?next=/"]')).toBe(false);
    expect(validateTrustedRedirectOrigins('["https://app.example#section"]')).toBe(false);
  });

  it('rejects reserved Account Page paths', () => {
    expect(validateAccountPagePath('/account')).toBe(true);
    expect(validateAccountPagePath('/mypage')).toBe(true);
    expect(validateAccountPagePath('/admin')).toBe(false);
    expect(validateAccountPagePath('/accountant')).toBe(true);
  });

  it('resolves the default direct login destination to Account Page', async () => {
    const kv = createSettingsKV({});

    await expect(resolvePostLoginRedirectUrl({ SETTINGS: kv }, 'tenant_123')).resolves.toEqual({
      redirectUrl: '/account',
      behavior: 'account',
    });
  });

  it('resolves configured custom URL redirects from AUTHRIM_CONFIG fallback', async () => {
    const kv = createSettingsKV({
      'settings:tenant:tenant_123:login-entry': {
        'login-entry.post_login_behavior': 'custom_url',
        'login-entry.post_login_redirect_url': 'https://app.example/mypage',
      },
      'settings:tenant:tenant_123:security': {
        'security.trusted_redirect_origins': '["https://app.example"]',
      },
    });

    await expect(
      resolvePostLoginRedirectUrl({ AUTHRIM_CONFIG: kv }, 'tenant_123')
    ).resolves.toEqual({
      redirectUrl: 'https://app.example/mypage',
      behavior: 'custom_url',
    });
  });

  it('falls back to home when Account Page behavior is not backed by an enabled account page', async () => {
    const kv = createSettingsKV({
      'settings:tenant:tenant_123:login-entry': {
        'login-entry.post_login_behavior': 'account',
      },
      'settings:tenant:tenant_123:self-service': {
        'self-service.account_page_enabled': false,
        'self-service.account_page_path': '/account',
      },
    });

    await expect(resolvePostLoginRedirectUrl({ SETTINGS: kv }, 'tenant_123')).resolves.toEqual({
      redirectUrl: '/',
      behavior: 'home',
    });
  });

  it('resolves App Login behavior to an authorize request', async () => {
    const kv = createSettingsKV({
      'settings:tenant:tenant_123:login-entry': {
        'login-entry.post_login_behavior': 'app_login',
        'login-entry.app_login_client_id': 'service_app',
        'login-entry.app_login_redirect_uri': 'https://service.example/callback',
        'login-entry.app_login_final_return_to': '/mypage',
        'login-entry.app_login_scope': 'openid profile email',
      },
    });

    const result = await resolvePostLoginRedirectUrl({ SETTINGS: kv }, 'tenant_123');
    expect(result.behavior).toBe('app_login');
    expect(result.redirectUrl).toMatch(/^\/authorize\?/);

    const parsed = new URL(result.redirectUrl, 'https://login.example');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('service_app');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://service.example/callback');
    expect(parsed.searchParams.get('scope')).toBe('openid profile email');
    expect(parsed.searchParams.has('prompt')).toBe(false);
    const state = parsed.searchParams.get('state') ?? '';
    expect(state).toMatch(/^ar_app_login\./);
    const encodedState = state.slice('ar_app_login.'.length);
    const decodedState = JSON.parse(Buffer.from(encodedState, 'base64url').toString('utf8')) as {
      return_to?: string;
    };
    expect(decodedState.return_to).toBe('/mypage');
    expect(parsed.searchParams.get('nonce')).toBeTruthy();
    expect(parsed.searchParams.has('ar_return_to')).toBe(false);
  });

  it('falls back to home when App Login is missing its target client', async () => {
    const kv = createSettingsKV({
      'settings:tenant:tenant_123:login-entry': {
        'login-entry.post_login_behavior': 'app_login',
      },
    });

    await expect(resolvePostLoginRedirectUrl({ SETTINGS: kv }, 'tenant_123')).resolves.toEqual({
      redirectUrl: '/',
      behavior: 'home',
    });
  });

  it('signs in to a SAML service provider through the IdP-initiated entry', async () => {
    const kv = createSettingsKV({
      'settings:tenant:tenant_123:login-entry': {
        'login-entry.post_login_behavior': 'saml_login',
        'login-entry.saml_login_sp_entity_id': 'https://sp.example.com/metadata',
        'login-entry.saml_login_relay_state': '/dashboard',
      },
    });

    await expect(resolvePostLoginRedirectUrl({ SETTINGS: kv }, 'tenant_123')).resolves.toEqual({
      redirectUrl:
        '/saml/idp/init?sp=https%3A%2F%2Fsp.example.com%2Fmetadata&relay_state=%2Fdashboard',
      behavior: 'saml_login',
    });
  });

  it('leaves out a RelayState it cannot send, and goes home without a provider', async () => {
    const tooLong = createSettingsKV({
      'settings:tenant:tenant_123:login-entry': {
        'login-entry.post_login_behavior': 'saml_login',
        'login-entry.saml_login_sp_entity_id': 'urn:sp',
        'login-entry.saml_login_relay_state': 'x'.repeat(81),
      },
    });
    await expect(resolvePostLoginRedirectUrl({ SETTINGS: tooLong }, 'tenant_123')).resolves.toEqual(
      { redirectUrl: '/saml/idp/init?sp=urn%3Asp', behavior: 'saml_login' }
    );

    const missing = createSettingsKV({
      'settings:tenant:tenant_123:login-entry': { 'login-entry.post_login_behavior': 'saml_login' },
    });
    await expect(resolvePostLoginRedirectUrl({ SETTINGS: missing }, 'tenant_123')).resolves.toEqual(
      { redirectUrl: '/', behavior: 'home' }
    );
  });
});

describe('validateLoginEntryPostLoginSettings', () => {
  it('takes saml_login, and refuses a RelayState over 80 bytes or a broken entity ID', () => {
    expect(
      validateLoginEntryPostLoginSettings({
        'login-entry.post_login_behavior': 'saml_login',
        'login-entry.saml_login_sp_entity_id': 'urn:sp',
        'login-entry.saml_login_relay_state': '',
      })
    ).toEqual({});
    expect(
      Object.keys(
        validateLoginEntryPostLoginSettings({
          'login-entry.post_login_behavior': 'teleport',
          'login-entry.saml_login_sp_entity_id': 'urn:\nsp',
          'login-entry.saml_login_relay_state': 'é'.repeat(41),
        })
      ).sort()
    ).toEqual([
      'login-entry.post_login_behavior',
      'login-entry.saml_login_relay_state',
      'login-entry.saml_login_sp_entity_id',
    ]);
  });
});

describe('a registration Flow’s own completion', () => {
  it('goes where the Flow says, checked as the tenant’s destination is', async () => {
    const kv = createSettingsKV({
      'settings:tenant:tenant_123:self-service': {
        'self-service.account_page_enabled': true,
        'self-service.account_page_path': '/my',
      },
      'settings:tenant:tenant_123:security': {
        'security.trusted_redirect_origins': '["https://app.example.com"]',
      },
    });
    const go = (completion: Parameters<typeof resolveRegistrationCompletionRedirectUrl>[2]) =>
      resolveRegistrationCompletionRedirectUrl({ SETTINGS: kv }, 'tenant_123', completion);
    await expect(go({ behavior: 'account' })).resolves.toEqual({
      redirectUrl: '/my',
      behavior: 'account',
    });
    await expect(
      go({ behavior: 'custom_url', redirect_url: 'https://app.example.com/welcome' })
    ).resolves.toMatchObject({ redirectUrl: 'https://app.example.com/welcome' });
    // An origin the tenant does not trust: home.
    await expect(
      go({ behavior: 'custom_url', redirect_url: 'https://evil.example/' })
    ).resolves.toEqual({ redirectUrl: '/', behavior: 'home' });
    await expect(
      go({ behavior: 'saml_login', saml_login_sp_entity_id: 'urn:sp' })
    ).resolves.toEqual({ redirectUrl: '/saml/idp/init?sp=urn%3Asp', behavior: 'saml_login' });
  });

  it('goes to a service Worker path only while the router passes such paths to it', async () => {
    const on = createSettingsKV({
      'settings:tenant:tenant_123:service-site': { 'service-site.fallback_enabled': true },
    });
    const off = createSettingsKV({});
    const completion = { behavior: 'service_site' as const, service_site_path: '/app/start' };
    await expect(
      resolveRegistrationCompletionRedirectUrl({ SETTINGS: on }, 'tenant_123', completion)
    ).resolves.toEqual({ redirectUrl: '/app/start', behavior: 'service_site' });
    await expect(
      resolveRegistrationCompletionRedirectUrl({ SETTINGS: off }, 'tenant_123', completion)
    ).resolves.toEqual({ redirectUrl: '/', behavior: 'home' });
    expect(validateServiceSitePath('/api/x')).toBe(false);
    expect(validateServiceSitePath('/\\evil.example/landing')).toBe(false);
    expect(validateServiceSitePath('/app\nx')).toBe(false);
    expect(validateServiceSitePath('//evil.example')).toBe(false);
    expect(validateServiceSitePath('https://app.example.com')).toBe(false);
  });
});
