/**
 * Mutation-driven tests: optional service bindings (404 when absent), admin API routing,
 * rollout fallback, and CSRF exclusions for external provider callbacks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../index';
import { createMockEnv, isolateGlobalCaches, type MockEnv } from './helpers/router-env';

let env: MockEnv;
let restore: () => void;
beforeEach(() => {
  restore = isolateGlobalCaches();
  env = createMockEnv();
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const call = (e: Record<string, unknown>, method: string, path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`https://id.example.com${path}`, { method, ...init }), e);
const NOT_FOUND = { error: 'not_found', message: 'The requested resource was not found' };

describe('optional bindings', () => {
  const vcRoutes: Array<[string, string]> = [
    ['GET', '/.well-known/openid-credential-issuer'],
    ['GET', '/.well-known/openid-credential-verifier'],
    ['GET', '/.well-known/jwt-vc-issuer'],
    ['GET', '/.well-known/oauth-authorization-server/vci'],
    ['GET', '/.well-known/did.json'],
    ['POST', '/vci/credential'],
    ['GET', '/vp/request'],
    ['GET', '/did/web'],
  ];
  it.each(vcRoutes)('%s %s is 404 without OP_VC and forwarded with it', async (method, path) => {
    const missing = await call({ ...env, OP_VC: undefined }, method, path);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(NOT_FOUND);
    const present = await call(env, method, path);
    expect(await present.json()).toMatchObject({ worker: 'OP_VC', path });
    expect(env.OP_DISCOVERY.fetch).not.toHaveBeenCalled();
  });

  const asyncRoutes: Array<[string, string]> = [
    ['POST', '/device_authorization'],
    ['GET', '/device'],
    ['POST', '/device'],
    ['GET', '/api/devices/lookup'],
    ['POST', '/bc-authorize'],
    ['GET', '/api/ciba/pending'],
  ];
  it.each(asyncRoutes)(
    '%s %s is 404 without OP_ASYNC and forwarded with it',
    async (method, path) => {
      const init = method === 'POST' ? { headers: { Origin: 'https://id.example.com' } } : {};
      const missing = await call({ ...env, OP_ASYNC: undefined }, method, path, init);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(NOT_FOUND);
      const present = await call(env, method, path, init);
      expect(await present.json()).toMatchObject({ worker: 'OP_ASYNC', path });
    }
  );

  const samlRoutes: Array<[string, string]> = [
    ['GET', '/saml/idp/metadata'],
    ['GET', '/idp/profile/SAML2/POST/SSO'],
    ['GET', '/api/admin/saml-providers'],
    ['GET', '/api/admin/saml-settings/x'],
    ['GET', '/api/admin/saml-attribute-presets'],
    ['GET', '/api/admin/saml-metadata'],
    ['GET', '/api/admin/saml-federation-sources/s'],
  ];
  it.each(samlRoutes)(
    '%s %s is 404 without OP_SAML and forwarded with it',
    async (method, path) => {
      const missing = await call({ ...env, OP_SAML: undefined }, method, path);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(NOT_FOUND);
      const present = await call(env, method, path);
      expect(await present.json()).toMatchObject({ worker: 'OP_SAML', path });
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    }
  );

  it('does not serve other /idp/profile/SAML2 paths', async () => {
    const res = await call(env, 'GET', '/idp/profile/SAML2/Other/SSO');
    expect(res.status).toBe(404);
    expect(env.OP_SAML.fetch).not.toHaveBeenCalled();
  });

  it('answers /mcp with 404 without OP_AGENT_ACCESS', async () => {
    const res = await call({ ...env, OP_AGENT_ACCESS: undefined }, 'GET', '/mcp');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it('passes /mcp responses through with a mutable header set', async () => {
    env.OP_AGENT_ACCESS.fetch.mockResolvedValueOnce(
      new Response('stream', { status: 202, statusText: 'Accepted', headers: { 'X-Mcp': '1' } })
    );
    const res = await call(env, 'POST', '/mcp');
    expect(res.status).toBe(202);
    expect(res.statusText).toBe('Accepted');
    expect(res.headers.get('X-Mcp')).toBe('1');
    expect(await res.text()).toBe('stream');
  });

  it('answers 404 for a missing VC well-known binding without touching discovery', async () => {
    const res = await call(
      { ...env, OP_VC: undefined },
      'GET',
      '/.well-known/openid-configuration'
    );
    expect(await res.json()).toMatchObject({ worker: 'OP_DISCOVERY' });
  });
});

describe('admin API routing', () => {
  it.each([
    ['/api/admin/auth/login', 'OP_AUTH'],
    ['/api/admin/setup-token/x', 'OP_AUTH'],
    ['/api/admin/invitations/x', 'OP_AUTH'],
    ['/api/admin/users', 'OP_MANAGEMENT'],
    ['/api/admin/auth', 'OP_MANAGEMENT'],
    ['/api/admin/saml-providersx', 'OP_MANAGEMENT'],
    ['/api/admin/saml-settingsx', 'OP_MANAGEMENT'],
  ])('routes %s to %s', async (path, worker) => {
    const res = await call(env, 'GET', path);
    expect(await res.json()).toMatchObject({ worker });
  });

  it('answers a rollout 503 when Management is unavailable', async () => {
    env.OP_MANAGEMENT.fetch.mockRejectedValueOnce(new Error('rollout'));
    const res = await call(env, 'GET', '/api/admin/users');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
      error_description: 'Admin Management is temporarily unavailable during rollout',
    });
  });
});

describe('CSRF exclusions', () => {
  const evil = {
    Origin: 'https://evil.example',
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  it.each([
    '/api/external/google/callback',
    '/auth/external/google/callback',
    '/api/external/google/backchannel-logout',
    '/auth/external/google/data-deletion',
    '/api/external/google/deauthorize',
  ])('POST %s is exempt from the Origin check', async (path) => {
    const res = await call(env, 'POST', path, { headers: evil, body: 'a=1' });
    expect(res.status).toBe(200);
    expect(env.EXTERNAL_IDP.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another action', '/api/external/google/link'],
    ['an extra path segment', '/api/external/google/x/callback'],
    ['a trailing segment', '/api/external/google/callback/extra'],
    ['an empty provider', '/api/external//callback'],
    ['another namespace', '/x/api/external/google/callback'],
  ])('POST with %s is still checked', async (_label, path) => {
    const res = await call(env, 'POST', path, { headers: evil, body: 'a=1' });
    expect(res.status).toBe(403);
    expect(env.EXTERNAL_IDP.fetch).not.toHaveBeenCalled();
  });

  it('GET to a callback path is routed normally (CSRF only applies to unsafe methods)', async () => {
    const res = await call(env, 'GET', '/api/external/google/callback');
    expect(res.status).toBe(200);
  });

  it('exempts only POST /oauth/admin-agent/register', async () => {
    const post = await call(env, 'POST', '/oauth/admin-agent/register', {
      headers: evil,
      body: 'a=1',
    });
    expect(post.status).toBe(200);
    const put = await call(env, 'PUT', '/oauth/admin-agent/register', {
      headers: evil,
      body: 'a=1',
    });
    expect(put.status).toBe(403);
  });
});
