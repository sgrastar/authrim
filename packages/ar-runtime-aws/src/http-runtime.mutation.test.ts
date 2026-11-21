/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LambdaEvent } from 'hono/aws-lambda';
import { fetchAwsPasskeyIdpAuth } from '@authrim/ar-auth/aws-passkey-idp';
import { createSAMLIdPApp } from '@authrim/ar-saml/idp-app';
import { renderAwsPasskeyLoginPage } from './ui/passkey-login';
import { createAwsSamlRuntime, type AwsTenantRuntime } from './http-runtime';

const mocks = vi.hoisted(() => ({
  idpFetch: vi.fn(),
  options: [] as Array<{ tenantMiddleware: (c: unknown, next: () => Promise<void>) => unknown }>,
}));
vi.mock('@authrim/ar-saml/idp-app', () => ({
  createSAMLIdPApp: vi.fn((options: { tenantMiddleware: never }) => {
    mocks.options.push(options);
    return { fetch: mocks.idpFetch };
  }),
}));
vi.mock('@authrim/ar-auth/aws-passkey-idp', () => ({
  isAwsPasskeyIdpAuthRoute: (method: string, path: string) =>
    method === 'GET' && path === '/api/auth/health',
  fetchAwsPasskeyIdpAuth: vi.fn(),
}));
vi.mock('./ui/passkey-login', () => ({ renderAwsPasskeyLoginPage: vi.fn() }));

const ORIGIN = 'https://a.example.test';
const makeTenant = (over: Partial<AwsTenantRuntime> = {}): AwsTenantRuntime => ({
  tenantId: 'tenant-a',
  origin: ORIGIN,
  env: {
    DEFAULT_TENANT_ID: 'tenant-a',
    ISSUER_URL: ORIGIN,
    SAML_RUNTIME_PORTS: {},
    AUTH_RUNTIME_PORTS: {},
    RUNTIME_DATA_PORTS: {},
    AUDIT_RUNTIME_PORTS: {},
    EVENT_RUNTIME_PORTS: {},
  } as Env,
  assertReady: vi.fn(async () => {}),
  ...over,
});
const event = (over: Record<string, unknown> = {}, path = '/api/auth/health'): LambdaEvent =>
  ({
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'a.example.test' },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      domainName: 'a.example.test',
      http: { method: 'GET', sourceIp: '203.0.113.8' },
    },
    ...over,
  }) as unknown as LambdaEvent;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options.length = 0;
  vi.mocked(fetchAwsPasskeyIdpAuth).mockImplementation(() => new Response('auth'));
  vi.mocked(renderAwsPasskeyLoginPage).mockImplementation(() => new Response('login-page'));
  mocks.idpFetch.mockImplementation(async () => new Response('idp'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AWS HTTP runtime construction (mutation hardening)', () => {
  it('rejects an empty inventory and malformed or duplicate tenants with exact codes', () => {
    expect(() => createAwsSamlRuntime({ tenants: [] })).toThrow('aws_tenant_inventory_required');
    for (const patch of [
      { origin: 'http://a.example.test' },
      { origin: `${ORIGIN}/` },
      { origin: `${ORIGIN}/path` },
      { origin: 'https://user:pw@a.example.test' },
      { origin: 'https://A.example.test' },
      { tenantId: 'Tenant' },
      { tenantId: '-tenant' },
      { tenantId: 'tenant-' },
      { tenantId: 'ten_ant' },
      { tenantId: '' },
    ])
      expect(
        () => createAwsSamlRuntime({ tenants: [makeTenant(patch)] }),
        JSON.stringify(patch)
      ).toThrow('aws_tenant_inventory_invalid');
    expect(() => createAwsSamlRuntime({ tenants: [makeTenant(), makeTenant()] })).toThrow(
      'aws_tenant_inventory_invalid'
    );
    expect(() =>
      createAwsSamlRuntime({
        tenants: [
          makeTenant(),
          makeTenant({
            tenantId: 'tenant-b',
            origin: 'https://b.example.test',
            env: {
              ...makeTenant().env,
              DEFAULT_TENANT_ID: 'tenant-b',
              ISSUER_URL: 'https://b.example.test',
            },
          }),
        ],
      })
    ).not.toThrow();
    for (const id of ['a', 'a1', '1a', 'a-b'])
      expect(() =>
        createAwsSamlRuntime({
          tenants: [
            makeTenant({
              tenantId: id,
              env: { ...makeTenant().env, DEFAULT_TENANT_ID: id },
            }),
          ],
        })
      ).not.toThrow();
  });

  it('requires every runtime port and a matching tenant/issuer pair', () => {
    for (const port of [
      'SAML_RUNTIME_PORTS',
      'AUTH_RUNTIME_PORTS',
      'RUNTIME_DATA_PORTS',
      'AUDIT_RUNTIME_PORTS',
      'EVENT_RUNTIME_PORTS',
    ]) {
      const tenant = makeTenant();
      delete (tenant.env as unknown as Record<string, unknown>)[port];
      expect(() => createAwsSamlRuntime({ tenants: [tenant] }), port).toThrow(
        'aws_runtime_ports_required'
      );
    }
    for (const env of [
      { DEFAULT_TENANT_ID: 'other' },
      { ISSUER_URL: 'https://b.example.test' },
      { ISSUER_URL: `${ORIGIN}/` },
    ])
      expect(() =>
        createAwsSamlRuntime({
          tenants: [makeTenant({ env: { ...makeTenant().env, ...env } })],
        })
      ).toThrow('aws_tenant_environment_conflict');
  });

  it('refuses an embedded login profile when the UI was not packaged', () => {
    vi.stubGlobal('AUTHRIM_AWS_EMBEDDED_UI', false);
    expect(() => createAwsSamlRuntime({ tenants: [makeTenant()] })).toThrow(
      'aws_embedded_ui_not_packaged'
    );
    expect(() =>
      createAwsSamlRuntime({
        tenants: [
          makeTenant({
            ui: {
              components: { loginUi: false, adminUi: false },
              ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
            },
          }),
        ],
      })
    ).not.toThrow();
    vi.stubGlobal('AUTHRIM_AWS_EMBEDDED_UI', true);
    expect(() => createAwsSamlRuntime({ tenants: [makeTenant()] })).not.toThrow();
    vi.unstubAllGlobals();
    expect(() => createAwsSamlRuntime({ tenants: [makeTenant()] })).not.toThrow();
  });
});

describe('AWS HTTP runtime tenant middleware (mutation hardening)', () => {
  const run = async (tenant: AwsTenantRuntime, url: string) => {
    createAwsSamlRuntime({ tenants: [tenant] });
    const set = vi.fn();
    const next = vi.fn(async () => undefined);
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
    const result = await mocks.options[0].tenantMiddleware({ req: { url }, json, set }, next);
    return { set, next, json, result };
  };
  const resolveTenant = vi.fn();
  const tenantWith = (data: unknown) =>
    makeTenant({ env: { ...makeTenant().env, RUNTIME_DATA_PORTS: data } as Env });

  it('hands the resolved portable tenant metadata to the IdP app', async () => {
    const metadata = { tenantId: 'tenant-a', runtimeKind: 'portable', coreDb: {}, route: {} };
    resolveTenant.mockResolvedValue(metadata);
    const { set, next } = await run(tenantWith({ resolveTenant }), `${ORIGIN}/saml/idp/metadata`);
    expect(resolveTenant).toHaveBeenCalledWith('tenant-a');
    expect(set.mock.calls).toEqual([
      ['tenantId', 'tenant-a'],
      ['tenantMetadataContext', metadata],
    ]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(createSAMLIdPApp).toHaveBeenCalledTimes(1);
  });

  it('refuses unknown hosts and unusable tenant metadata with fixed JSON errors', async () => {
    const unknown = await run(
      tenantWith({ resolveTenant }),
      'https://unknown.example.test/saml/idp/metadata'
    );
    expect(unknown.json).toHaveBeenCalledWith({ error: 'not_found' }, 404);
    expect(unknown.next).not.toHaveBeenCalled();
    expect(unknown.set).not.toHaveBeenCalled();

    const noData = makeTenant();
    const created = await (async () => {
      createAwsSamlRuntime({ tenants: [noData] });
      delete (noData.env as unknown as Record<string, unknown>).RUNTIME_DATA_PORTS;
      const json = vi.fn((b: unknown, s?: number) => ({ b, s }));
      const next = vi.fn();
      await mocks.options
        .at(-1)!
        .tenantMiddleware({ req: { url: `${ORIGIN}/x` }, json, set: vi.fn() }, next);
      return { json, next };
    })();
    expect(created.json).toHaveBeenCalledWith({ error: 'temporarily_unavailable' }, 503);
    expect(created.next).not.toHaveBeenCalled();

    for (const metadata of [
      { tenantId: 'other', runtimeKind: 'portable' },
      { tenantId: 'tenant-a', runtimeKind: 'cloudflare' },
      { tenantId: 'tenant-a' },
    ]) {
      resolveTenant.mockResolvedValue(metadata);
      const outcome = await run(tenantWith({ resolveTenant }), `${ORIGIN}/saml/idp/metadata`);
      expect(outcome.json).toHaveBeenCalledWith({ error: 'temporarily_unavailable' }, 503);
      expect(outcome.next).not.toHaveBeenCalled();
      expect(outcome.set).not.toHaveBeenCalled();
    }
  });
});

describe('AWS HTTP runtime routing (mutation hardening)', () => {
  it('serves the embedded login page only for GET /login and /reauth', async () => {
    const tenant = makeTenant();
    const { app } = createAwsSamlRuntime({ tenants: [tenant] });
    for (const path of ['/login', '/reauth']) {
      const response = await app.request(`${ORIGIN}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('login-page');
    }
    expect(renderAwsPasskeyLoginPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(renderAwsPasskeyLoginPage).mock.calls[0][0]).toBeInstanceOf(Request);
    expect(tenant.assertReady).toHaveBeenCalledTimes(2);
    for (const [method, path] of [
      ['POST', '/login'],
      ['GET', '/login/'],
      ['GET', '/Login'],
      ['GET', '/login2'],
    ] as const)
      expect((await app.request(`${ORIGIN}${path}`, { method })).status, `${method} ${path}`).toBe(
        404
      );
    // rendering is also available when the packaging flag is explicitly on
    vi.stubGlobal('AUTHRIM_AWS_EMBEDDED_UI', true);
    const packaged = createAwsSamlRuntime({ tenants: [makeTenant()] }).app;
    expect(await (await packaged.request(`${ORIGIN}/login`)).text()).toBe('login-page');
  });

  it('answers unauthenticated routes with exact JSON errors and honours a matching x-tenant-id', async () => {
    const tenant = makeTenant();
    const { app } = createAwsSamlRuntime({ tenants: [tenant] });
    const notFound = await app.request(`${ORIGIN}/nothing`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: 'not_found' });
    expect(
      (await app.request(`${ORIGIN}/health/ready`, { headers: { 'x-tenant-id': 'tenant-a' } }))
        .status
    ).toBe(200);
    expect(
      (await app.request(`${ORIGIN}/health/ready`, { headers: { host: 'A.EXAMPLE.TEST' } })).status
    ).toBe(200);
    expect(
      (await app.request(`${ORIGIN}/health/ready`, { headers: { 'x-tenant-id': 'other' } })).status
    ).toBe(404);
    expect((await app.request(`${ORIGIN}/health/ready`, { method: 'POST' })).status).toBe(404);
    vi.mocked(tenant.assertReady).mockRejectedValueOnce(new Error('offline'));
    const unavailable = await app.request(`${ORIGIN}/health/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(await (await app.request(`${ORIGIN}/health/ready`)).json()).toEqual({ status: 'ready' });
    const untrusted = await app.request(`${ORIGIN}/saml/idp/metadata`);
    expect(untrusted.status).toBe(400);
    expect(await untrusted.json()).toEqual({ error: 'untrusted_ingress' });
  });

  it('forwards sanitised requests to the IdP app and passes an execution context with waitUntil', async () => {
    const { handler } = createAwsSamlRuntime({ tenants: [makeTenant()] });
    const evt = event(
      { headers: { host: 'a.example.test', 'x-forwarded-for': '198.51.100.1' } },
      '/saml/idp/sso'
    );
    mocks.idpFetch.mockImplementation(async (_req: Request, _env: unknown, execution: any) => {
      execution.waitUntil(Promise.resolve('background'));
      return new Response('idp');
    });
    const response = await handler(evt);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('idp');
    const [request, env, execution] = mocks.idpFetch.mock.calls[0];
    expect(request.headers.get('x-forwarded-for')).toBe('203.0.113.8');
    expect(request.headers.get('x-forwarded-proto')).toBe('https');
    expect(env.DEFAULT_TENANT_ID).toBe('tenant-a');
    expect(execution.props).toEqual({});
    expect(() => execution.passThroughOnException()).toThrow('aws_pass_through_not_supported');
    expect(fetchAwsPasskeyIdpAuth).not.toHaveBeenCalled();
  });

  it('routes passkey auth endpoints to the auth handler, not the IdP', async () => {
    const { handler } = createAwsSamlRuntime({ tenants: [makeTenant()] });
    expect((await handler(event())).body).toBe('auth');
    expect(fetchAwsPasskeyIdpAuth).toHaveBeenCalledTimes(1);
    expect(mocks.idpFetch).not.toHaveBeenCalled();
  });

  it('answers 503 with a fixed body when the handler throws or a background write fails', async () => {
    const { handler } = createAwsSamlRuntime({ tenants: [makeTenant()] });
    mocks.idpFetch.mockImplementationOnce(async () => {
      throw new Error('private');
    });
    let response = await handler(event({}, '/saml/idp/sso'));
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'temporarily_unavailable' });
    mocks.idpFetch.mockImplementationOnce(async (_r: Request, _e: unknown, execution: any) => {
      execution.waitUntil(Promise.reject(new Error('write failed')));
      return new Response('idp');
    });
    response = await handler(event({}, '/saml/idp/sso'));
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'temporarily_unavailable' });
    mocks.idpFetch.mockImplementationOnce(async (_r: Request, _e: unknown, execution: any) => {
      execution.passThroughOnException();
      return new Response('idp');
    });
    expect((await handler(event({}, '/saml/idp/sso'))).statusCode).toBe(503);
  });
});

describe('AWS HTTP runtime Lambda ingress (mutation hardening)', () => {
  it('rejects every malformed API Gateway event with the fixed response', async () => {
    const { handler } = createAwsSamlRuntime({ tenants: [makeTenant()] });
    const good = event();
    const ctx = (over: Record<string, unknown>) => ({
      ...(good.requestContext as unknown as Record<string, unknown>),
      ...over,
    });
    const bad: Array<[string, unknown]> = [
      [
        'no version',
        (() => {
          const { version: _v, ...rest } = good as unknown as Record<string, unknown>;
          return rest;
        })(),
      ],
      ['version 1.0', event({ version: '1.0' })],
      [
        'no rawPath',
        (() => {
          const { rawPath: _r, ...rest } = good as unknown as Record<string, unknown>;
          return rest;
        })(),
      ],
      ['no http', event({ requestContext: { domainName: 'a.example.test' } })],
      ['domain missing', event({ requestContext: { http: { sourceIp: '203.0.113.8' } } })],
      ['domain empty', event({ requestContext: ctx({ domainName: '' }) })],
      ['domain number', event({ requestContext: ctx({ domainName: 5 }) })],
      ['source ip invalid', event({ requestContext: ctx({ http: { sourceIp: 'x' } }) })],
      ['source ip empty', event({ requestContext: ctx({ http: { sourceIp: '' } }) })],
    ];
    for (const [name, evt] of bad) {
      const response = await handler(evt as LambdaEvent);
      expect(response, name).toEqual({
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'untrusted_ingress' }),
        isBase64Encoded: false,
      });
    }
    expect(
      (
        await handler(
          event({ requestContext: ctx({ http: { method: 'GET', sourceIp: '2001:db8::1' } }) })
        )
      ).statusCode
    ).toBe(200);
  });
});
