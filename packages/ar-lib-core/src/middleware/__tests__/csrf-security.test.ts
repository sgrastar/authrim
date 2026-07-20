import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types/env';

const mocks = vi.hoisted(() => ({
  tenantSettings: null as Record<string, unknown> | null,
  getTenantSettings: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../utils/tenant-settings', () => ({
  getTenantSettings: mocks.getTenantSettings,
}));

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    module: () => ({ info: mocks.logInfo, warn: mocks.logWarn }),
  }),
}));

import { csrfProtectionMiddleware } from '../csrf';

function app(options: Parameters<typeof csrfProtectionMiddleware>[0] = {}, path = '/resource') {
  const instance = new Hono<{ Bindings: Env }>();
  const reached = vi.fn();
  instance.use('*', csrfProtectionMiddleware(options));
  instance.all(path, (c) => {
    reached();
    return c.json({ ok: true });
  });
  return { instance, reached };
}

async function request(
  instance: Hono<{ Bindings: Env }>,
  method: string,
  headers: Record<string, string> = {},
  env: Partial<Env> = {},
  path = '/resource'
) {
  return instance.request(path, { method, headers }, env as Env);
}

describe('CSRF middleware security decision table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantSettings = null;
    mocks.getTenantSettings.mockImplementation(async () => mocks.tenantSettings);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'allows safe method %s without resolving origins',
    async (method) => {
      const resolver = vi.fn(() => ['https://app.example.test']);
      const { instance, reached } = app({ resolveAllowedOrigins: resolver });
      const response = await request(instance, method);
      expect(response.status).toBe(200);
      expect(reached).toHaveBeenCalledOnce();
      expect(resolver).not.toHaveBeenCalled();
    }
  );

  it('excludes only exact paths and their descendants, not lookalike prefixes', async () => {
    const resolver = vi.fn(() => ['https://app.example.test']);
    const exact = app({ excludePaths: ['/token'], resolveAllowedOrigins: resolver }, '/token');
    expect((await request(exact.instance, 'POST', {}, {}, '/token')).status).toBe(200);
    expect(exact.reached).toHaveBeenCalledOnce();

    const child = app(
      { excludePaths: ['/token'], resolveAllowedOrigins: resolver },
      '/token/rotate'
    );
    expect((await request(child.instance, 'POST', {}, {}, '/token/rotate')).status).toBe(200);

    const lookalike = app(
      { excludePaths: ['/token'], resolveAllowedOrigins: resolver },
      '/tokenize'
    );
    expect((await request(lookalike.instance, 'POST', {}, {}, '/tokenize')).status).toBe(403);
    expect(lookalike.reached).not.toHaveBeenCalled();
  });

  it('supports a narrow request-level protocol exclusion without excluding sibling mutations', async () => {
    const resolver = vi.fn(() => ['https://app.example.test']);
    const excludeRequest = vi.fn(
      (input: Request) => new URL(input.url).pathname === '/protocol/provider/callback'
    );
    const callback = app(
      { excludeRequest, resolveAllowedOrigins: resolver },
      '/protocol/provider/callback'
    );
    expect(
      (await request(callback.instance, 'POST', {}, {}, '/protocol/provider/callback')).status
    ).toBe(200);

    const sibling = app({ excludeRequest, resolveAllowedOrigins: resolver }, '/protocol/links');
    expect((await request(sibling.instance, 'POST', {}, {}, '/protocol/links')).status).toBe(403);
    expect(sibling.reached).not.toHaveBeenCalled();
  });

  it('skips browser-origin checks only for a proper Bearer authorization scheme', async () => {
    const resolver = vi.fn(() => ['https://app.example.test']);
    const allowed = app({ resolveAllowedOrigins: resolver });
    expect(
      (
        await request(allowed.instance, 'POST', {
          Authorization: 'Bearer server-token',
        })
      ).status
    ).toBe(200);
    expect(resolver).not.toHaveBeenCalled();

    const malformed = app({ resolveAllowedOrigins: resolver });
    expect(
      (
        await request(malformed.instance, 'POST', {
          Authorization: 'bearer server-token',
        })
      ).status
    ).toBe(403);

    const disabled = app({ skipForBearerToken: false, resolveAllowedOrigins: resolver });
    expect(
      (
        await request(disabled.instance, 'POST', {
          Authorization: 'Bearer server-token',
        })
      ).status
    ).toBe(403);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'allows %s only from an exact configured Origin',
    async (method) => {
      const { instance, reached } = app({
        resolveAllowedOrigins: async () => ['https://app.example.test'],
      });
      const response = await request(instance, method, { Origin: 'https://app.example.test' });
      expect(response.status).toBe(200);
      expect(reached).toHaveBeenCalledOnce();
    }
  );

  it.each([
    'https://evil.example.test',
    'https://app.example.test.evil.test',
    'http://app.example.test',
    'null',
  ])('rejects untrusted Origin %s without invoking the protected handler', async (origin) => {
    const { instance, reached } = app({
      resolveAllowedOrigins: () => ['https://app.example.test'],
    });
    const response = await request(instance, 'POST', { Origin: origin });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'csrf_validation_failed',
      error_description: 'Origin not allowed',
    });
    expect(reached).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalled();
  });

  it('uses Referer origin only when Origin is absent', async () => {
    const { instance, reached } = app({
      resolveAllowedOrigins: () => ['https://app.example.test'],
    });
    expect(
      (
        await request(instance, 'POST', {
          Referer: 'https://app.example.test/settings?tab=security',
        })
      ).status
    ).toBe(200);
    expect(reached).toHaveBeenCalledOnce();

    const precedence = app({ resolveAllowedOrigins: () => ['https://app.example.test'] });
    expect(
      (
        await request(precedence.instance, 'POST', {
          Origin: 'https://evil.example.test',
          Referer: 'https://app.example.test/settings',
        })
      ).status
    ).toBe(403);
    expect(precedence.reached).not.toHaveBeenCalled();
  });

  it.each(['not a URL', 'https://evil.example.test/page'])(
    'rejects invalid Referer %s',
    async (referer) => {
      const { instance, reached } = app({
        resolveAllowedOrigins: () => ['https://app.example.test'],
      });
      const response = await request(instance, 'POST', { Referer: referer });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error_description: 'Referer origin not allowed',
      });
      expect(reached).not.toHaveBeenCalled();
    }
  );

  it('fails closed when neither Origin nor Referer is present', async () => {
    const { instance, reached } = app({
      resolveAllowedOrigins: () => ['https://app.example.test'],
    });
    const response = await request(instance, 'POST');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error_description: 'Origin or Referer header is required for state-changing requests',
    });
    expect(reached).not.toHaveBeenCalled();
  });

  it('combines tenant settings and environment origins without weakening exact matching', async () => {
    mocks.tenantSettings = {
      'tenant.allowed_origins': 'https://tenant-ui.example.test, https://shared.example.test',
    };
    const { instance } = app();
    const env = {
      ALLOWED_ORIGINS: 'https://admin.example.test,https://shared.example.test',
      ISSUER_URL: 'https://issuer.example.test',
    };
    for (const origin of [
      'https://tenant-ui.example.test',
      'https://admin.example.test',
      'https://issuer.example.test',
    ]) {
      expect((await request(instance, 'POST', { Origin: origin }, env)).status).toBe(200);
    }
    expect(
      (await request(instance, 'POST', { Origin: 'https://shared.example.test.evil.test' }, env))
        .status
    ).toBe(403);
  });

  it.each([
    ['https://authrim.example.test/resource', 'https://authrim.example.test', true],
    ['https://tenant.authrim.example.test/resource', 'https://tenant.authrim.example.test', true],
    [
      'https://nested.tenant.authrim.example.test/resource',
      'https://nested.tenant.authrim.example.test',
      false,
    ],
    ['https://evil.example.test/resource', 'https://evil.example.test', false],
  ])('derives only safe BASE_DOMAIN origin for %s', async (path, origin, allowed) => {
    const instance = new Hono<{ Bindings: Env }>();
    const reached = vi.fn();
    instance.use('*', csrfProtectionMiddleware());
    instance.post('*', (c) => {
      reached();
      return c.json({ ok: true });
    });
    const response = await instance.request(path, { method: 'POST', headers: { Origin: origin } }, {
      BASE_DOMAIN: 'authrim.example.test',
    } as Env);
    expect(response.status).toBe(allowed ? 200 : 403);
    expect(reached).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('adds diagnostic Server-Timing only for the configured login path', async () => {
    const { instance } = app(
      { resolveAllowedOrigins: () => ['https://app.example.test'] },
      '/api/v1/login/interactions/start'
    );
    const response = await request(
      instance,
      'POST',
      { Origin: 'https://app.example.test' },
      { AUTHRIM_FLOW_RUNTIME_TIMING: 'YES' },
      '/api/v1/login/interactions/start'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('server-timing')).toContain('csrf_allowed_origins');
    expect(response.headers.get('server-timing')).toContain('csrf_total');
    expect(mocks.logInfo).toHaveBeenCalledWith(
      'CSRF timing',
      expect.objectContaining({ result: 'origin_allowed' })
    );
  });
});
