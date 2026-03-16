import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { webfingerHandler } from '../webfinger';
import type { Env } from '@authrim/ar-lib-core';

describe('webfingerHandler', () => {
  it('returns the current issuer link for the default tenant', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as any).set('tenantId', 'default');
      await next();
    });
    app.get('/.well-known/webfinger', webfingerHandler);

    const response = await app.fetch(
      new Request('https://router.example.com/.well-known/webfinger'),
      {
        ISSUER_URL: 'https://router.example.com',
      } as Env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      subject: string;
      links: Array<{ rel: string; href: string }>;
    };

    expect(body.subject).toBe('https://router.example.com');
    expect(body.links).toEqual([
      {
        rel: 'http://openid.net/specs/connect/1.0/issuer',
        href: 'https://router.example.com',
      },
    ]);
  });

  it('uses the provided resource parameter as the subject', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as any).set('tenantId', 'default');
      await next();
    });
    app.get('/.well-known/webfinger', webfingerHandler);

    const response = await app.fetch(
      new Request(
        'https://router.example.com/.well-known/webfinger?resource=acct%3Aalice%40router.example.com'
      ),
      {
        ISSUER_URL: 'https://router.example.com',
      } as Env
    );

    const body = (await response.json()) as {
      subject: string;
    };

    expect(body.subject).toBe('acct:alice@router.example.com');
  });
});
