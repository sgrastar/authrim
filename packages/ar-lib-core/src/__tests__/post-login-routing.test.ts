import { describe, expect, it } from 'vitest';
import {
  parseTrustedRedirectOrigins,
  resolvePostLoginRedirectUrl,
  validateAccountPagePath,
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
});
