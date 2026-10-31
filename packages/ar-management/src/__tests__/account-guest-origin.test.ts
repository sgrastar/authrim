import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { getAccountWebAuthnOrigin } from '../account-passkeys';

const app = new Hono<{ Bindings: Env }>();
app.all('/api/account/guest-upgrade', (c) =>
  c.json({
    eligibility: getAccountWebAuthnOrigin(c, true),
    proof: getAccountWebAuthnOrigin(c),
  })
);

describe('guest upgrade browser origin readiness', () => {
  it('supports same-origin GET without weakening proof origin requirements', async () => {
    const response = await app.request('https://login.example.org/api/account/guest-upgrade');
    expect(await response.json()).toEqual({
      eligibility: 'https://login.example.org',
      proof: null,
    });
  });
  it('uses the trusted Login UI proxy browser origin on GET', async () => {
    const response = await app.request('https://auth.example.org/api/account/guest-upgrade', {
      headers: {
        Referer: 'https://auth.example.org/account',
        'x-authrim-ui-proxy': 'login-ui',
        'x-authrim-browser-origin': 'https://login.example.org',
      },
    });
    expect(await response.json()).toEqual({
      eligibility: 'https://login.example.org',
      proof: null,
    });
  });
  it.each(['http://insecure.example.org', 'https://login.example.org'])(
    'does not infer a POST proof origin from %s',
    async (origin) => {
      const response = await app.request(origin + '/api/account/guest-upgrade', {
        method: 'POST',
        headers: { Referer: origin + '/account' },
      });
      expect(await response.json()).toEqual({ eligibility: null, proof: null });
    }
  );
  it('does not offer passkeys on an insecure public origin', async () => {
    const response = await app.request('http://insecure.example.org/api/account/guest-upgrade');
    expect(await response.json()).toEqual({ eligibility: null, proof: null });
  });
  it('does not override an explicitly invalid origin using a valid referrer', async () => {
    const response = await app.request('https://login.example.org/api/account/guest-upgrade', {
      headers: { Origin: 'null', Referer: 'https://login.example.org/account' },
    });
    expect(await response.json()).toEqual({ eligibility: null, proof: null });
  });
});
