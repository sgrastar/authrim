import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../types';

const service = vi.hoisted(() => ({
  acceptAdminResponse: vi.fn(),
  getAdminRequestObject: vi.fn(),
}));

vi.mock('../admin-vp-service', () => service);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-1',
}));

import { adminVPRequestObjectRoute, adminVPResponseRoute } from '../admin-vp-routes';

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.get('/vp/admin/request/:id', adminVPRequestObjectRoute);
  hono.post('/vp/admin/response', adminVPResponseRoute);
  return hono;
}

const form = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  app().request('/vp/admin/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
    // Node needs this for a streamed body.
    duplex: 'half',
  } as never);

describe('admin VP wallet routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.acceptAdminResponse.mockResolvedValue({ kind: 'verified' });
  });

  it('serves the signed request object as a JAR, uncached', async () => {
    service.getAdminRequestObject.mockResolvedValue('h.p.s');
    const response = await app().request('/vp/admin/request/g1%3Aapac%3A0%3Avp_x');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/oauth-authz-req+jwt');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('h.p.s');
    expect(service.getAdminRequestObject.mock.calls[0].slice(1)).toEqual([
      'tenant-1',
      'g1:apac:0:vp_x',
    ]);
  });

  it('answers invalid_request_uri for a request that can no longer be answered', async () => {
    service.getAdminRequestObject.mockResolvedValue(null);
    const response = await app().request('/vp/admin/request/x');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'invalid_request_uri' });
  });

  it('passes a form response on with its state', async () => {
    const response = await form('vp_token=%7B%7D&state=req-1');
    expect(response.status).toBe(200);
    expect(service.acceptAdminResponse.mock.calls[0].slice(1)).toEqual(['tenant-1', 'req-1', '{}']);
  });

  it('reports a refused presentation as access_denied with its reason', async () => {
    service.acceptAdminResponse.mockResolvedValue({
      kind: 'refused',
      error: 'match_code_mismatch',
    });
    const response = await form('vp_token=x&state=req-1');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'access_denied',
      error_description: 'match_code_mismatch',
    });
  });

  it('refuses a body over the limit without reading it all, with or without Content-Length', async () => {
    expect((await form('vp_token=x&state=y', { 'Content-Length': '999999' })).status).toBe(400);

    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1_000) return controller.close();
        controller.enqueue(new Uint8Array(1024).fill(97));
      },
    });
    const response = await form(stream);
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThan(100);
    expect(service.acceptAdminResponse).not.toHaveBeenCalled();
  });

  it('refuses another content type and a missing token or state', async () => {
    const json = await app().request('/vp/admin/response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(400);
    expect((await form('state=req-1')).status).toBe(400);
    expect((await form('vp_token=x')).status).toBe(400);
    expect(service.acceptAdminResponse).not.toHaveBeenCalled();
  });

  it('answers temporarily_unavailable when verification could not run', async () => {
    service.acceptAdminResponse.mockRejectedValue(new Error('key manager down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await form('vp_token=x&state=req-1');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});
