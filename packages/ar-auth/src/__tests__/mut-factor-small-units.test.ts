import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { verifyHumanVerificationForAction } from '../human-verification';
import {
  getAccountExistsHtml,
  getAccountExistsText,
  getEmailCodeHtml,
} from '../utils/email/templates';
import { hashEmailCode, verifyEmailCodeHash } from '../utils/email-code-utils';

describe('account-exists notice', () => {
  const data = { email: 'a<b>@example.com', appName: 'Acme & Co' };

  it('tells the owner in HTML, escaped and trimmed', () => {
    const html = getAccountExistsHtml(data);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.endsWith('</html>')).toBe(true);
    expect(html).toContain('<title>You already have an account with Acme &amp; Co</title>');
    expect(html).toContain('(a&lt;b&gt;@example.com)');
    expect(html).not.toContain('a<b>@');
  });

  it('tells the owner in text, trimmed', () => {
    const text = getAccountExistsText(data);
    expect(text.startsWith('Someone tried to sign up to Acme & Co')).toBe(true);
    expect(text).toContain('(a<b>@example.com)');
    expect(text.endsWith('This email was sent by Acme & Co')).toBe(true);
  });
});

describe('email code HTML logo', () => {
  const base = { email: 'a@example.com', code: '123456', expiresInMinutes: 5, appName: 'Acme' };

  it.each([['not a url'], ['http://cdn.example/logo.png']])('drops the logo %j', (logoUrl) => {
    expect(getEmailCodeHtml({ ...base, logoUrl })).not.toContain('<img');
  });

  it('keeps an HTTPS logo', () => {
    expect(getEmailCodeHtml({ ...base, logoUrl: 'https://cdn.example/logo.png' })).toContain(
      'https://cdn.example/logo.png'
    );
  });
});

describe('email code hash comparison', () => {
  it('refuses a stored hash that only starts with the right one', async () => {
    const hash = await hashEmailCode('123456', 'a@example.com', 'otp-1', 1, 'secret');
    await expect(
      verifyEmailCodeHash('123456', 'a@example.com', 'otp-1', 1, `${hash}0`, 'secret')
    ).resolves.toBe(false);
    await expect(
      verifyEmailCodeHash('123456', 'a@example.com', 'otp-1', 1, hash, 'secret')
    ).resolves.toBe(true);
  });
});

describe('human verification request details', () => {
  function kv(values: Record<string, string>): KVNamespace {
    return { get: vi.fn(async (key: string) => values[key] ?? null) } as unknown as KVNamespace;
  }
  const runHumanVerification = vi.fn();
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    SETTINGS: kv({
      'settings:tenant:tenant-a:authentication-methods': JSON.stringify({
        'authentication-methods.human_verification.provider':
          'human-verification-cloudflare-turnstile',
        'authentication-methods.human_verification.login_enabled': true,
      }),
      'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant-a': 'true',
    }),
    PLUGIN_RUNNER: { runHumanVerification },
  } as unknown as Env;
  function request(
    action: 'login' | 'signup',
    also: ('login' | 'signup')[],
    headers: Record<string, string>
  ) {
    const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.post('/', async (c) => {
      const res = await verifyHumanVerificationForAction(c, action, 'browser-token', also);
      return res ?? c.text('ok');
    });
    return app.request('/', { method: 'POST', headers }, env);
  }

  it('passes the first trimmed forwarded address', async () => {
    runHumanVerification.mockReset().mockResolvedValue({ decision: 'allow', reasonCode: 'ok' });
    const res = await request('login', [], { 'X-Forwarded-For': ' 198.51.100.1 , 10.0.0.1' });
    expect(res.status).toBe(200);
    expect(runHumanVerification.mock.calls[0][0]).toMatchObject({ remoteIp: '198.51.100.1' });
  });

  it('passes no address when there is none', async () => {
    runHumanVerification.mockReset().mockResolvedValue({ decision: 'allow', reasonCode: 'ok' });
    await request('login', [], {});
    expect(runHumanVerification.mock.calls[0][0]).not.toHaveProperty('remoteIp');
  });

  it('requires verification for an action another enabled one stands for', async () => {
    runHumanVerification.mockReset().mockResolvedValue({ decision: 'deny', reasonCode: 'no' });
    const res = await request('signup', ['login'], {});
    expect(res.status).toBe(400);
    expect((await res.json<{ error_code: string }>()).error_code).toBe('AR130003');
    const alone = await request('signup', [], {});
    expect(alone.status).toBe(200);
  });
});
