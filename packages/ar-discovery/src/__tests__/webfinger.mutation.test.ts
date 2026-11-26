import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { webfingerHandler } from '../webfinger';

async function webfinger(query = ''): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'default');
    await next();
  });
  app.get('/.well-known/webfinger', webfingerHandler);
  return app.fetch(new Request(`https://op.example.com/.well-known/webfinger${query}`), {
    ISSUER_URL: 'https://op.example.com',
  });
}

describe('webfingerHandler (exact behaviour)', () => {
  it('is cacheable for five minutes and varies by encoding and host', async () => {
    const response = await webfinger();
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding, Host');
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('answers with the issuer relation and nothing else', async () => {
    expect(await (await webfinger('?resource=acct:a@op.example.com')).json()).toEqual({
      subject: 'acct:a@op.example.com',
      links: [
        { rel: 'http://openid.net/specs/connect/1.0/issuer', href: 'https://op.example.com' },
      ],
    });
  });

  it('falls back to the issuer as subject for an empty resource', async () => {
    const body = await (await webfinger('?resource=')).json<{ subject: string }>();
    expect(body.subject).toBe('https://op.example.com');
  });
});
