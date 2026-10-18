/**
 * POST /device_authorization: the request body. application/x-www-form-urlencoded only, each
 * parameter at most once, as a string of a sane size; every refusal is an RFC 6749 section 5.2
 * error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { deviceAuthorizationHandler } from '../device-authorization';
import { deviceClients, harness, registerClient } from './device-authorization-harness';

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  const shared = globalThis as unknown as {
    __deviceClients: Map<string, Record<string, unknown>>;
    __deviceLogger: unknown;
  };
  return {
    ...actual,
    getClientCached: async (_c: unknown, _env: unknown, id: string) =>
      shared.__deviceClients.get(id) ?? null,
    getLogger: () => shared.__deviceLogger,
  };
});

beforeEach(async () => {
  deviceClients.clear();
  await registerClient('tv', { token_endpoint_auth_method: 'none' });
});

const expectInvalidRequest = (result: Awaited<ReturnType<ReturnType<typeof harness>['post']>>) => {
  expect(result.response.status).toBe(400);
  expect(result.body).toEqual({ error: 'invalid_request', error_description: expect.any(String) });
  expect(result.response.headers.get('Cache-Control')).toBe('no-store');
};

describe('the Content-Type', () => {
  it.each([
    ['application/json', JSON.stringify({ client_id: 'tv' })],
    ['text/plain', 'client_id=tv'],
    [
      'multipart/form-data; boundary=x',
      '--x\r\nContent-Disposition: form-data; name="client_id"\r\n\r\ntv\r\n--x--',
    ],
  ])('%s is refused', async (contentType, body) => {
    const h = harness();
    expectInvalidRequest(await h.post(body, { headers: { 'Content-Type': contentType } }));
    expect(h.stored).toHaveLength(0);
  });

  it('is refused when absent', async () => {
    const h = harness();
    const response = await (async () => {
      const { Hono } = await import('hono');
      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', 'default');
        await next();
      });
      app.post('/device_authorization', deviceAuthorizationHandler);
      // a Blob body has no implied Content-Type
      return app.request(
        'https://auth.example.com/device_authorization',
        { method: 'POST', body: new Blob(['client_id=tv']) },
        h.env
      );
    })();
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
  });

  it.each([
    'application/x-www-form-urlencoded; charset=UTF-8',
    'Application/X-WWW-Form-Urlencoded',
  ])('%s is accepted', async (contentType) => {
    const { response } = await harness().post('client_id=tv', {
      headers: { 'Content-Type': contentType },
    });
    expect(response.status).toBe(200);
  });
});

describe('the parameters', () => {
  it('is refused without a client_id', async () => {
    expectInvalidRequest(await harness().post({ scope: 'openid' }));
    expectInvalidRequest(await harness().post({ client_id: '' }));
  });

  it.each([
    ['a repeated client_id', 'client_id=tv&client_id=tv'],
    ['a repeated client_id naming two clients', 'client_id=tv&client_id=other'],
    ['a repeated scope', 'client_id=tv&scope=openid&scope=email'],
    ['a repeated client_secret', 'client_id=tv&client_secret=a&client_secret=b'],
    ['a repeated client_assertion', 'client_id=tv&client_assertion=a&client_assertion=b'],
  ])('is refused with %s', async (_label, body) => {
    const h = harness();
    expectInvalidRequest(await h.post(body));
    expect(h.stored).toHaveLength(0);
  });

  it.each([
    ['a client_id of 257 characters', { client_id: 'c'.repeat(257) }],
    ['a client_secret over 1024 characters', { client_id: 'tv', client_secret: 's'.repeat(1025) }],
    [
      'a client_assertion over 16 KiB',
      { client_id: 'tv', client_assertion: 'a'.repeat(16 * 1024 + 1) },
    ],
    ['a scope over 2048 characters', { client_id: 'tv', scope: 'a'.repeat(2049) }],
  ])('is refused with %s', async (_label, form) => {
    const h = harness();
    expectInvalidRequest(await h.post(form));
    expect(h.stored).toHaveLength(0);
  });

  it('is refused when the body is declared larger than 64 KiB', async () => {
    const h = harness();
    expectInvalidRequest(await h.post('client_id=tv', { headers: { 'Content-Length': '70000' } }));
  });

  it('ignores parameters it does not know, even repeated', async () => {
    const { response } = await harness().post('client_id=tv&x=1&x=2&scope=openid');
    expect(response.status).toBe(200);
  });
});

describe('the size of the body', () => {
  const LIMIT = 64 * 1024;
  /** A form of exactly this many bytes: client_id plus padding in an unknown parameter. */
  const formOfBytes = (bytes: number) => {
    const head = 'client_id=tv&x=';
    return head + 'a'.repeat(bytes - head.length);
  };
  const chunked = (total: number, chunk = 8 * 1024) => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        const size = Math.min(chunk, total - sent);
        sent += size;
        controller.enqueue(new TextEncoder().encode('a'.repeat(size)));
      },
    });
    return { stream, sent: () => sent };
  };

  it('accepts a body of exactly 64 KiB, and refuses one more byte', async () => {
    const h = harness();
    expect((await h.post(formOfBytes(LIMIT))).response.status).toBe(200);
    expectInvalidRequest(await h.post(formOfBytes(LIMIT + 1)));
  });

  it('refuses a large body that declares no Content-Length, unknown parameters included', async () => {
    const h = harness();
    // a registered public client, plus 1 MiB in a parameter the endpoint does not use
    expectInvalidRequest(await h.post(formOfBytes(1024 * 1024)));
    expect(h.stored).toHaveLength(0);
  });

  it('refuses a streamed (chunked) body, and stops reading it at the limit', async () => {
    const h = harness();
    const body = chunked(10 * 1024 * 1024);
    const result = await h.post('', { stream: body.stream });
    expectInvalidRequest(result);
    // it did not drain 10 MiB: at most the limit plus a chunk or two
    expect(body.sent()).toBeLessThanOrEqual(LIMIT + 2 * 8 * 1024);
    expect(h.stored).toHaveLength(0);
  });

  it('refuses a body larger than the Content-Length it declares', async () => {
    const h = harness();
    expectInvalidRequest(
      await h.post(formOfBytes(LIMIT * 2), { headers: { 'Content-Length': '12' } })
    );
    expect(h.stored).toHaveLength(0);
  });

  it('is a 400 invalid_request, not a 500, when the body cannot be read', async () => {
    const h = harness();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('Malformed body'));
      },
    });
    expectInvalidRequest(await h.post('', { stream: broken }));
  });
});

describe('the answers', () => {
  it('carry nothing but error and error_description, whatever the refusal', async () => {
    const answers = await Promise.all([
      harness().post({ scope: 'openid' }),
      harness().post({ client_id: 'nobody' }),
      harness().post({ client_id: 'tv', scope: 'admin' }),
      harness().post('client_id=tv', { headers: { 'Content-Type': 'application/json' } }),
    ]);
    for (const { response, body } of answers) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(body).sort()).toEqual(['error', 'error_description']);
    }
  });

  it('are never cached, the code response included', async () => {
    const { response } = await harness().post({ client_id: 'tv' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  });
});
