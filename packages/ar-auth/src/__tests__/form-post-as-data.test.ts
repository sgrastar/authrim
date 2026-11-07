/**
 * A form post response answered as data (the lite Login UI's relay sends the form itself): the
 * destination and the fields the auto-submitting page would hold, and only for a request that
 * asked for it.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { answerFormPostAsData, redirectWithError } from '../authorize';

function app(asData: boolean) {
  const hono = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  hono.use(async (c, next) => {
    c.set('tenantId', 'default');
    await next();
  });
  hono.post('/deny', async (c) => {
    if (asData) answerFormPostAsData(c as never);
    return redirectWithError(
      c as never,
      'https://rp.example/cb',
      'access_denied',
      'denied',
      'st-1',
      {
        responseMode: 'form_post',
      }
    );
  });
  return hono;
}

const env = { ISSUER_URL: 'https://id.example' } as unknown as Env;

describe('answerFormPostAsData', () => {
  it('answers the form post as its destination and fields', async () => {
    const response = await app(true).request('/deny', { method: 'POST' }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json<{ form_post: { action: string; fields: string[][] } }>();
    expect(body.form_post.action).toBe('https://rp.example/cb');
    expect(Object.fromEntries(body.form_post.fields)).toMatchObject({
      error: 'access_denied',
      error_description: 'denied',
      state: 'st-1',
    });
  });

  it('keeps the auto-submitting page for any other request', async () => {
    const response = await app(false).request('/deny', { method: 'POST' }, env);
    expect(response.headers.get('content-type') ?? '').toContain('text/html');
  });
});
