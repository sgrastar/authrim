import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LambdaEvent } from 'hono/aws-lambda';
import { fetchAwsPasskeyIdpAuth } from '@authrim/ar-auth/aws-passkey-idp';
import { createAwsSamlRuntime, type AwsTenantRuntime } from './http-runtime';

vi.mock('@authrim/ar-auth/aws-passkey-idp', () => ({
  isAwsPasskeyIdpAuthRoute: (method: string, path: string) =>
    method === 'GET' && path === '/api/auth/health',
  fetchAwsPasskeyIdpAuth: vi.fn((request: Request) => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return Response.json(headers);
  }),
}));

function gatewayEvent(sourceIp = '203.0.113.8'): LambdaEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/api/auth/health',
    rawQueryString: '',
    headers: {
      host: 'a.example.test',
      'cf-connecting-ip': '198.51.100.99',
      'x-forwarded-for': '198.51.100.99',
      'x-real-ip': '198.51.100.99',
      'true-client-ip': '198.51.100.99',
      'x-forwarded-host': 'b.example.test',
      'x-forwarded-proto': 'http',
      forwarded: 'for=198.51.100.99',
      'x-authrim-ui-proxy': 'login-ui',
      'x-authrim-browser-origin': 'https://b.example.test',
      'x-authrim-forwarded-host': 'b.example.test',
    },
    body: null,
    isBase64Encoded: false,
    requestContext: { domainName: 'a.example.test', http: { method: 'GET', sourceIp } },
  } as unknown as LambdaEvent;
}

function tenant(): AwsTenantRuntime {
  return {
    tenantId: 'tenant-a',
    origin: 'https://a.example.test',
    env: {
      DEFAULT_TENANT_ID: 'tenant-a',
      ISSUER_URL: 'https://a.example.test',
      SAML_RUNTIME_PORTS: {},
      AUTH_RUNTIME_PORTS: {},
      RUNTIME_DATA_PORTS: {},
      AUDIT_RUNTIME_PORTS: {},
      EVENT_RUNTIME_PORTS: {},
    } as Env,
    assertReady: vi.fn(async () => {}),
  };
}

describe('AWS trusted runtime ingress', () => {
  it.each(['disabled', 'external'] as const)(
    'does not serve embedded login or admin assets for %s login',
    async (mode) => {
      const configured = tenant();
      configured.ui = {
        components: { loginUi: false, adminUi: false },
        ui: {
          login:
            mode === 'external'
              ? {
                  mode,
                  baseUrl: 'https://login.example.test',
                  clientId: 'custom-login',
                  paths: { login: '/sign-in', reauth: '/reauth' },
                }
              : { mode },
          admin: { mode: 'external', baseUrl: 'https://admin.example.test' },
        },
      };
      const { app } = createAwsSamlRuntime({ tenants: [configured] });
      for (const path of ['/login', '/reauth', '/admin', '/sign-in']) {
        expect((await app.request(`https://a.example.test${path}`)).status).toBe(404);
      }
      expect(configured.assertReady).not.toHaveBeenCalled();
      expect((await app.request('https://a.example.test/health/ready')).status).toBe(200);
      if (mode === 'disabled')
        expect((await app.request('https://a.example.test/api/auth/health')).status).toBe(404);
    }
  );
  it('requires explicit adapters and matching issuer identity', () => {
    const missing = tenant();
    delete missing.env.RUNTIME_DATA_PORTS;
    expect(() => createAwsSamlRuntime({ tenants: [missing] })).toThrow(
      'aws_runtime_ports_required'
    );
    const mismatch = tenant();
    mismatch.env.ISSUER_URL = 'https://b.example.test';
    expect(() => createAwsSamlRuntime({ tenants: [mismatch] })).toThrow(
      'aws_tenant_environment_conflict'
    );
  });

  it('checks readiness before reporting ready and fails closed on unavailable data', async () => {
    const configured = tenant();
    const { app } = createAwsSamlRuntime({ tenants: [configured] });
    expect((await app.request('https://a.example.test/health/ready')).status).toBe(200);
    vi.mocked(configured.assertReady).mockRejectedValueOnce(new Error('database_offline'));
    const response = await app.request('https://a.example.test/health/ready');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('database_offline');
  });

  it.each([
    ['https://unknown.example.test/health/ready', {}],
    ['http://a.example.test/health/ready', {}],
    ['https://a.example.test/health/ready', { 'x-tenant-id': 'tenant-b' }],
    ['https://a.example.test/health/ready', { host: 'b.example.test' }],
    ['https://a.example.test/api/admin/users', {}],
    ['https://a.example.test/saml/sp/acs', {}],
    ['https://a.example.test/saml/idp/slo', {}],
    ['https://a.example.test/token', {}],
  ])('rejects unsupported or untrusted request %s %j', async (url, headers) => {
    const configured = tenant();
    const { app } = createAwsSamlRuntime({ tenants: [configured] });
    expect((await app.request(url, { headers })).status).toBe(404);
    expect(configured.assertReady).not.toHaveBeenCalled();
  });

  it('ignores forwarded host headers for tenant selection', async () => {
    const { app } = createAwsSamlRuntime({ tenants: [tenant()] });
    expect(
      (
        await app.request('https://unknown.example.test/health/ready', {
          headers: { 'x-forwarded-host': 'a.example.test' },
        })
      ).status
    ).toBe(404);
  });

  it('replaces browser-supplied IP/proxy headers using the API Gateway integration context', async () => {
    const { handler } = createAwsSamlRuntime({ tenants: [tenant()] });
    const response = await handler(gatewayEvent());
    expect(response.statusCode).toBe(200);
    const headers = JSON.parse(response.body) as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('203.0.113.8');
    expect(headers['x-forwarded-proto']).toBe('https');
    for (const header of [
      'cf-connecting-ip',
      'x-real-ip',
      'true-client-ip',
      'x-forwarded-host',
      'forwarded',
      'x-authrim-ui-proxy',
      'x-authrim-browser-origin',
      'x-authrim-forwarded-host',
    ]) {
      expect(headers).not.toHaveProperty(header);
    }
  });

  it.each(['', 'not-an-ip', '203.0.113.8, 198.51.100.99'])(
    'rejects invalid gateway IP %s',
    async (ip) => {
      const { handler } = createAwsSamlRuntime({ tenants: [tenant()] });
      expect((await handler(gatewayEvent(ip))).statusCode).toBe(400);
    }
  );

  it('requires Gateway domain provenance instead of falling back to a supplied Host', async () => {
    const { handler } = createAwsSamlRuntime({ tenants: [tenant()] });
    const event = gatewayEvent();
    Reflect.deleteProperty(event.requestContext, 'domainName');
    expect((await handler(event)).statusCode).toBe(400);
  });

  it('does not trust headers when invoking the app outside the Gateway adapter', async () => {
    const { app } = createAwsSamlRuntime({ tenants: [tenant()] });
    expect(
      (
        await app.request('https://a.example.test/api/auth/health', {
          headers: { 'x-forwarded-for': '203.0.113.8' },
        })
      ).status
    ).toBe(400);
  });

  it('awaits background writes, including work queued by other writes', async () => {
    let completed = false;
    vi.mocked(fetchAwsPasskeyIdpAuth).mockImplementationOnce((_request, _env, execution) => {
      execution.waitUntil(
        Promise.resolve().then(() => {
          execution.waitUntil(
            new Promise<void>((resolve) =>
              setTimeout(() => {
                completed = true;
                resolve();
              }, 1)
            )
          );
        })
      );
      return new Response('accepted');
    });
    const { handler } = createAwsSamlRuntime({ tenants: [tenant()] });
    expect((await handler(gatewayEvent())).statusCode).toBe(200);
    expect(completed).toBe(true);
  });

  it('fails the invocation when a background durable write fails', async () => {
    vi.mocked(fetchAwsPasskeyIdpAuth).mockImplementationOnce(async (_request, _env, execution) => {
      execution.waitUntil(Promise.reject(new Error('private database error')));
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      return new Response('accepted');
    });
    const { handler } = createAwsSamlRuntime({ tenants: [tenant()] });
    const response = await handler(gatewayEvent());
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private database');
  });
});
