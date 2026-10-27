import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LambdaEvent } from 'hono/aws-lambda';
import type { AwsTenantRuntime } from '../http-runtime';
import { createLazyAwsSamlLambdaHandler } from './lazy-lambda-handler';

function gatewayEvent(): LambdaEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/health/ready',
    rawQueryString: '',
    headers: { host: 'tenant-a.example.test' },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      domainName: 'tenant-a.example.test',
      http: { method: 'GET', sourceIp: '203.0.113.8' },
    },
  } as unknown as LambdaEvent;
}

function tenant(): AwsTenantRuntime {
  return {
    tenantId: 'tenant-a',
    origin: 'https://tenant-a.example.test',
    env: {
      DEFAULT_TENANT_ID: 'tenant-a',
      ISSUER_URL: 'https://tenant-a.example.test',
      SAML_RUNTIME_PORTS: {},
      AUTH_RUNTIME_PORTS: {},
      RUNTIME_DATA_PORTS: {},
      AUDIT_RUNTIME_PORTS: {},
      EVENT_RUNTIME_PORTS: {},
    } as Env,
    assertReady: vi.fn(async () => undefined),
  };
}

describe('lazy AWS SAML Lambda handler', () => {
  it('loads once for concurrent invocations and closes its tenant resources', async () => {
    const closeTenants = vi.fn(async () => undefined);
    const loadTenants = vi.fn(async () => ({ tenants: [tenant()], close: closeTenants }));
    const runtime = createLazyAwsSamlLambdaHandler({ loadTenants });
    const responses = await Promise.all([
      runtime.handler(gatewayEvent()),
      runtime.handler(gatewayEvent()),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(loadTenants).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(closeTenants).toHaveBeenCalledTimes(1);
    expect((await runtime.handler(gatewayEvent())).statusCode).toBe(503);
  });

  it('fails closed on loader error and retries a later invocation', async () => {
    const loadTenants = vi
      .fn()
      .mockRejectedValueOnce(new Error('private_connector_detail'))
      .mockResolvedValue({ tenants: [tenant()], close: async () => undefined });
    const runtime = createLazyAwsSamlLambdaHandler({ loadTenants });
    const rejected = await runtime.handler(gatewayEvent());
    expect(rejected.statusCode).toBe(503);
    expect(rejected.body).not.toContain('private_connector_detail');
    expect((await runtime.handler(gatewayEvent())).statusCode).toBe(200);
    expect(loadTenants).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it('closes resources when the loaded tenant inventory is invalid', async () => {
    const closeTenants = vi.fn(async () => undefined);
    const runtime = createLazyAwsSamlLambdaHandler({
      loadTenants: async () => ({ tenants: [], close: closeTenants }),
    });
    const response = await runtime.handler(gatewayEvent());
    expect(response.statusCode).toBe(503);
    expect(closeTenants).toHaveBeenCalledOnce();
    await runtime.close();
  });
});
