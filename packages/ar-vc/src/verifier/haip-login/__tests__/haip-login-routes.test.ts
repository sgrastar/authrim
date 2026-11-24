import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../types';

const service = vi.hoisted(() => ({
  acceptHaipLoginResponse: vi.fn(),
  getHaipLoginRequestObject: vi.fn(),
}));
vi.mock('../haip-login-service', () => service);

import { haipLoginRequestObjectRoute, haipLoginResponseRoute } from '../haip-login-routes';

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', 'tenant-1');
    await next();
  });
  hono.get('/vp/login/request/:id', haipLoginRequestObjectRoute);
  hono.post('/vp/login/response', haipLoginResponseRoute);
  return hono;
}

const post = (body: string, headers: Record<string, string> = {}) =>
  app().request(
    '/vp/login/response',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    },
    {} as Env
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /vp/login/request/:id', () => {
  it('serves the signed request object, never cached', async () => {
    service.getHaipLoginRequestObject.mockResolvedValue('header.payload.sig');
    const response = await app().request('/vp/login/request/g1%3Aapac%3A0%3Avp_1', {}, {} as Env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/oauth-authz-req+jwt');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('header.payload.sig');
    expect(service.getHaipLoginRequestObject).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'g1:apac:0:vp_1'
    );
  });

  it('answers invalid_request_uri when it cannot be answered any more, 503 on a failure', async () => {
    service.getHaipLoginRequestObject.mockResolvedValue(null);
    const gone = await app().request('/vp/login/request/x', {}, {} as Env);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'invalid_request_uri' });
    service.getHaipLoginRequestObject.mockRejectedValue(new Error('down'));
    expect((await app().request('/vp/login/request/x', {}, {} as Env)).status).toBe(503);
  });
});

describe('POST /vp/login/response', () => {
  it('answers 200 with the redirect of a same-device login and with nothing for a cross-device one', async () => {
    service.acceptHaipLoginResponse.mockResolvedValue({
      kind: 'verified',
      redirectUri: 'https://idp.example.com/login/wallet?response_code=abc',
    });
    const same = await post('response=a.b.c.d.e');
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({
      redirect_uri: 'https://idp.example.com/login/wallet?response_code=abc',
    });
    expect(service.acceptHaipLoginResponse).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'a.b.c.d.e'
    );
    service.acceptHaipLoginResponse.mockResolvedValue({ kind: 'verified' });
    expect(await (await post('response=x')).json()).toEqual({});
  });

  it('refuses without saying why', async () => {
    service.acceptHaipLoginResponse.mockResolvedValue({ kind: 'refused', error: 'wrong_tenant' });
    const refused = await post('response=x');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'access_denied' });
    for (const kind of ['unknown', 'replayed']) {
      service.acceptHaipLoginResponse.mockResolvedValue({ kind });
      expect((await post('response=x')).status).toBe(400);
    }
    service.acceptHaipLoginResponse.mockResolvedValue({ kind: 'unavailable' });
    expect((await post('response=x')).status).toBe(503);
    service.acceptHaipLoginResponse.mockRejectedValue(new Error('down'));
    expect((await post('response=x')).status).toBe(503);
  });

  it('refuses other content types, a missing response and an oversized body before any work', async () => {
    expect((await post('response=x', { 'content-type': 'application/json' })).status).toBe(400);
    expect((await post('state=only')).status).toBe(400);
    expect((await post('response=x', { 'content-length': String(200 * 1024) })).status).toBe(400);
    expect(service.acceptHaipLoginResponse).not.toHaveBeenCalled();
  });
});
