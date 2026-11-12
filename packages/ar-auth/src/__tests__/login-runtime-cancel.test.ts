import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { oidcCancelAnswer, runtimeCancelAvailable, cancelAppKind } from '../login-runtime-cancel';

const runtimeOf = (config: Record<string, unknown>, flowKind = 'login') => ({
  flow_kind: flowKind,
  ui: { steps: [{ id: 's', component: 'authentication_method_selector', config }] },
});
const oidc = {
  protocol: 'oidc',
  authorizationChallengeId: 'c1',
  samlRequestId: null,
  clientId: 'rp',
  samlSpId: null,
};
const saml = {
  protocol: 'saml',
  authorizationChallengeId: null,
  samlRequestId: 'r1',
  clientId: null,
  samlSpId: 'sp',
  samlLoginNonceHash: 'h',
};

describe('when cancelling a sign-in is offered', () => {
  it('is offered for a live sign-in Flow that says error, started for an app request', () => {
    const runtime = runtimeOf({ on_cancel: 'error' });
    expect(runtimeCancelAvailable({ runtime, state: 'active', target: oidc })).toBe(true);
    expect(runtimeCancelAvailable({ runtime, state: 'created', target: saml })).toBe(true);
  });

  it.each([
    ['the option is the default', runtimeOf({}), 'active', oidc],
    ['the option is stay', runtimeOf({ on_cancel: 'stay' }), 'active', oidc],
    [
      'the Flow is not a sign-in',
      runtimeOf({ on_cancel: 'error' }, 'registration'),
      'active',
      oidc,
    ],
    ['the interaction is not live', runtimeOf({ on_cancel: 'error' }), 'completed', oidc],
    ['the interaction failed', runtimeOf({ on_cancel: 'error' }), 'failed', saml],
    [
      'no app request started it',
      runtimeOf({ on_cancel: 'error' }),
      'active',
      { ...oidc, authorizationChallengeId: null },
    ],
  ])('is not offered when %s', (_label, runtime, state, target) => {
    expect(runtimeCancelAvailable({ runtime, state, target })).toBe(false);
  });

  it('offers a SAML cancel only to an interaction started with the login nonce', () => {
    const runtime = runtimeOf({ on_cancel: 'error' });
    expect(
      runtimeCancelAvailable({
        runtime,
        state: 'active',
        target: { ...saml, samlLoginNonceHash: null },
      })
    ).toBe(false);
    // An OIDC request needs no nonce.
    expect(runtimeCancelAvailable({ runtime, state: 'active', target: oidc })).toBe(true);
  });

  it('reads a SAML request before an OIDC one, and needs the app for each', () => {
    expect(cancelAppKind({ ...oidc, samlRequestId: 'r1', samlSpId: 'sp' })).toBeNull();
    expect(cancelAppKind({ ...saml, samlSpId: null })).toBeNull();
    expect(cancelAppKind({ ...oidc, clientId: null })).toBeNull();
  });
});

interface AnswerBody {
  redirect_url: string;
  form_post: { action: string; fields: [string, string][] };
}

describe('what the app is answered', () => {
  const answer = async (
    metadata: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: string): void }).set('tenantId', 'tenant-a');
      await next();
    });
    app.post('/x', (c) => oidcCancelAnswer(c, 'tenant-a', metadata));
    const response = await app.request('/x', { method: 'POST', headers }, {});
    return { response, body: await response.json<AnswerBody>() };
  };
  const base = {
    client_id: 'rp',
    redirect_uri: 'https://rp.example.test/cb',
    state: 's-1',
    response_type: 'code',
  };

  it('puts the error, state and issuer in the query', async () => {
    const { body } = await answer(base);
    const url = new URL(body.redirect_url);
    expect(`${url.origin}${url.pathname}`).toBe('https://rp.example.test/cb');
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('s-1');
    expect(url.searchParams.get('iss')).toBeTruthy();
  });

  it('puts them in the fragment for an implicit response type', async () => {
    const { body } = await answer({ ...base, response_type: 'id_token' });
    const url = new URL(body.redirect_url);
    expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('error')).toBe('access_denied');
  });

  it('redirects a form post the caller cannot send, and answers data to one that can', async () => {
    const plain = await answer({ ...base, response_mode: 'form_post' });
    expect(new URL(plain.body.redirect_url).searchParams.get('error')).toBe('access_denied');
    const data = await answer(
      { ...base, response_mode: 'form_post' },
      { 'X-Authrim-Relay': 'structured' }
    );
    expect(data.body.form_post.action).toBe('https://rp.example.test/cb');
    expect(Object.fromEntries(data.body.form_post.fields)).toMatchObject({
      error: 'access_denied',
      state: 's-1',
    });
  });
});
