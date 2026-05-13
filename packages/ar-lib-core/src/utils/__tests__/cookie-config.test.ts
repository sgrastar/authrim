import { describe, expect, it } from 'vitest';
import {
  getAdminCookieSameSite,
  getCookieOptions,
  getSessionCookieSameSite,
  isSameOrigin,
  type CookieSameSite,
} from '../cookie-config';
import type { Env } from '../../types/env';

function env(overrides: Partial<Env>): Env {
  return {
    ISSUER_URL: 'https://auth.example.com',
    UI_URL: 'https://login.example.com',
    ...overrides,
  } as Env;
}

describe('cookie config', () => {
  it('detects same-origin URLs by origin only', () => {
    expect(isSameOrigin('https://auth.example.com/a', 'https://auth.example.com/b')).toBe(true);
    expect(isSameOrigin('https://auth.example.com', 'https://login.example.com')).toBe(false);
  });

  it('uses Lax for same-origin session cookies', () => {
    expect(
      getSessionCookieSameSite(
        env({
          ISSUER_URL: 'https://auth.example.com',
          UI_URL: 'https://auth.example.com/login',
        })
      )
    ).toBe('Lax');
  });

  it('uses None for cross-origin session cookies unless explicitly overridden', () => {
    expect(getSessionCookieSameSite(env({}))).toBe('None');
    expect(getSessionCookieSameSite(env({ COOKIE_SAME_SITE: 'Lax' as CookieSameSite }))).toBe(
      'Lax'
    );
  });

  it('defaults admin cookies to Lax even when global cookie SameSite is None', () => {
    expect(
      getAdminCookieSameSite(
        env({
          COOKIE_SAME_SITE: 'None' as CookieSameSite,
          ADMIN_UI_URL: 'https://admin.example.com',
        })
      )
    ).toBe('Lax');
  });

  it('allows admin cookies to inherit stricter global SameSite values', () => {
    expect(getAdminCookieSameSite(env({ COOKIE_SAME_SITE: 'Strict' as CookieSameSite }))).toBe(
      'Strict'
    );
  });

  it('always emits Secure cookie options for SameSite=None compatibility', () => {
    expect(getCookieOptions(env({}), 'session')).toMatchObject({
      secure: true,
      sameSite: 'None',
      httpOnly: true,
    });
  });
});
