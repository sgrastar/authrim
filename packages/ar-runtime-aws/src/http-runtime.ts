import { Hono } from 'hono';
import { handle, type LambdaEvent, type LambdaContext } from 'hono/aws-lambda';
import { isIP } from 'node:net';
import type { Env } from '@authrim/ar-lib-core';
import { createSAMLIdPApp } from '@authrim/ar-saml/idp-app';
import { fetchAwsPasskeyIdpAuth, isAwsPasskeyIdpAuthRoute } from '@authrim/ar-auth/aws-passkey-idp';
import { normalizeAwsRuntimeUiConfig, type AwsRuntimeUiConfig } from './ui/runtime-ui-config';
import { runSamlDrCoveredOperation } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';

declare const AUTHRIM_AWS_EMBEDDED_UI: boolean;

export interface AwsTenantRuntime {
  tenantId: string;
  /** Canonical public HTTPS origin, also used by the imported SAML/WebAuthn configuration. */
  origin: string;
  env: Env;
  /** Undefined retains compatibility with the original embedded rehearsal profile. */
  ui?: AwsRuntimeUiConfig;
  /** Verify imported data/key generations and database availability before serving traffic. */
  assertReady(this: void): Promise<void>;
}

export interface AwsSamlRuntimeOptions {
  tenants: readonly AwsTenantRuntime[];
}

const PROTOCOL_PATHS = new Set([
  '/saml/idp/metadata',
  '/saml/idp/sso',
  '/saml/idp/attribute-release-consent',
  '/idp/profile/SAML2/Redirect/SSO',
  '/idp/profile/SAML2/POST/SSO',
]);

/** Compose real handlers; this factory does not create or seed authenticated sessions. */
export function createAwsSamlRuntime(options: AwsSamlRuntimeOptions) {
  if (options.tenants.length === 0) throw new Error('aws_tenant_inventory_required');
  const tenants = new Map<string, AwsTenantRuntime>();
  for (const tenant of options.tenants) {
    const ui = normalizeAwsRuntimeUiConfig(tenant.ui);
    if (
      typeof AUTHRIM_AWS_EMBEDDED_UI !== 'undefined' &&
      !AUTHRIM_AWS_EMBEDDED_UI &&
      ui.ui.login.mode === 'embedded-rehearsal'
    ) {
      throw new Error('aws_embedded_ui_not_packaged');
    }
    const url = new URL(tenant.origin);
    if (
      url.protocol !== 'https:' ||
      url.origin !== tenant.origin ||
      url.username ||
      url.password ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenant.tenantId) ||
      tenants.has(url.host)
    ) {
      throw new Error('aws_tenant_inventory_invalid');
    }
    if (
      !tenant.env.SAML_RUNTIME_PORTS ||
      !tenant.env.AUTH_RUNTIME_PORTS ||
      !tenant.env.RUNTIME_DATA_PORTS ||
      !tenant.env.AUDIT_RUNTIME_PORTS ||
      !tenant.env.EVENT_RUNTIME_PORTS
    ) {
      throw new Error('aws_runtime_ports_required');
    }
    if (tenant.env.DEFAULT_TENANT_ID !== tenant.tenantId || tenant.env.ISSUER_URL !== url.origin) {
      throw new Error('aws_tenant_environment_conflict');
    }
    tenants.set(url.host, tenant);
  }

  const idp = createSAMLIdPApp({
    tenantMiddleware: async (c, next) => {
      const tenant = tenants.get(new URL(c.req.url).host);
      if (!tenant) return c.json({ error: 'not_found' }, 404);
      // The outer app verified this origin against deployment-owned inventory.
      const data = tenant.env.RUNTIME_DATA_PORTS;
      if (!data) return c.json({ error: 'temporarily_unavailable' }, 503);
      const metadata = await data.resolveTenant(tenant.tenantId);
      if (metadata.tenantId !== tenant.tenantId || metadata.runtimeKind !== 'portable') {
        return c.json({ error: 'temporarily_unavailable' }, 503);
      }
      const context = c as unknown as { set(key: string, value: unknown): void };
      context.set('tenantId', tenant.tenantId);
      context.set('tenantMetadataContext', metadata);
      await next();
    },
  });

  const app = new Hono<{ Bindings: { requestContext?: { http?: { sourceIp?: string } } } }>();
  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const tenant = tenants.get(url.host);
    const host = c.req.header('host');
    const requestedTenant = c.req.header('x-tenant-id');
    if (
      !tenant ||
      url.origin !== tenant.origin ||
      (host !== undefined && host.toLowerCase() !== url.host.toLowerCase()) ||
      (requestedTenant !== undefined && requestedTenant !== tenant.tenantId)
    ) {
      return c.json({ error: 'not_found' }, 404);
    }
    const isReadyRoute = c.req.method === 'GET' && url.pathname === '/health/ready';
    const login = normalizeAwsRuntimeUiConfig(tenant.ui).ui.login;
    const isLoginRoute =
      login.mode === 'embedded-rehearsal' &&
      c.req.method === 'GET' &&
      ['/login', '/reauth'].includes(url.pathname);
    const isAuthRoute =
      login.mode !== 'disabled' && isAwsPasskeyIdpAuthRoute(c.req.method, url.pathname);
    const isProtocolRoute = PROTOCOL_PATHS.has(url.pathname);
    if (!isReadyRoute && !isLoginRoute && !isAuthRoute && !isProtocolRoute) {
      return c.json({ error: 'not_found' }, 404);
    }
    try {
      await tenant.assertReady();
    } catch {
      return c.json({ error: 'temporarily_unavailable' }, 503);
    }
    if (isReadyRoute) return c.json({ status: 'ready' });
    if (
      isLoginRoute &&
      (typeof AUTHRIM_AWS_EMBEDDED_UI === 'undefined' || AUTHRIM_AWS_EMBEDDED_UI)
    ) {
      const { renderAwsPasskeyLoginPage } = await import('./ui/passkey-login');
      return renderAwsPasskeyLoginPage(c.req.raw);
    }

    const sourceIp = c.env?.requestContext?.http?.sourceIp;
    if (!sourceIp || !isIP(sourceIp)) {
      return c.json({ error: 'untrusted_ingress' }, 400);
    }
    // Only API Gateway's integration context supplies the IP used by auth/rate limiting.
    const headers = new Headers(c.req.raw.headers);
    for (const header of [
      'cf-connecting-ip',
      'true-client-ip',
      'x-real-ip',
      'x-forwarded-for',
      'x-forwarded-host',
      'forwarded',
      'x-authrim-ui-proxy',
      'x-authrim-browser-origin',
      'x-authrim-forwarded-host',
    ])
      headers.delete(header);
    headers.set('x-forwarded-for', sourceIp);
    headers.set('x-forwarded-proto', 'https');
    const request = new Request(c.req.raw, { headers });

    // Lambda must await background auth/audit writes before the invocation ends.
    const pending: Promise<PromiseSettledResult<unknown>>[] = [];
    const execution = {
      waitUntil(promise: Promise<unknown>) {
        // Attach the rejection handler immediately: Node must not treat an early rejection
        // as unhandled while the main handler is still doing database work.
        pending.push(
          promise.then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason })
          )
        );
      },
      passThroughOnException() {
        throw new Error('aws_pass_through_not_supported');
      },
      props: {},
    } as unknown as ExecutionContext;
    try {
      return await runSamlDrCoveredOperation(tenant.env, execution, async (covered, tracked) => {
        try {
          if (!tracked) throw new Error('aws_execution_context_missing');
          const response = await (isAuthRoute
            ? fetchAwsPasskeyIdpAuth(request, covered, tracked)
            : idp.fetch(request, covered, tracked));
          for (let index = 0; index < pending.length; index += 1) {
            const result = await pending[index];
            if (result.status === 'rejected') throw result.reason;
          }
          return response;
        } finally {
          await Promise.allSettled(pending);
        }
      });
    } catch {
      await Promise.allSettled(pending);
      return c.json({ error: 'temporarily_unavailable' }, 503);
    }
  });
  const invoke = handle(app);
  const handler = async (event: LambdaEvent, context?: LambdaContext) => {
    if (
      !('version' in event) ||
      event.version !== '2.0' ||
      !('rawPath' in event) ||
      !('http' in event.requestContext) ||
      typeof event.requestContext.domainName !== 'string' ||
      event.requestContext.domainName.length === 0 ||
      !isIP(event.requestContext.http.sourceIp)
    ) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'untrusted_ingress' }),
        isBase64Encoded: false,
      };
    }
    return invoke(event, context);
  };
  return { app, handler };
}
