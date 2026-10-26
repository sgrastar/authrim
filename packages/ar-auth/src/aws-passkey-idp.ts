import type { Env } from '@authrim/ar-lib-core';
import app from './index';

/**
 * Public ar-auth routes required by the AWS SAML IdP passkey login profile.
 *
 * The existing Hono app still owns request context, CSRF, origin checks, rate
 * limits, Flow policy, WebAuthn verification, and managed session creation.
 * This entrypoint only narrows which of its routes the AWS ingress can expose.
 */
const EXACT_ROUTES = new Set([
  'GET /api/auth/health',
  'GET /auth/login-challenge',
  'GET /api/sessions/status',
  'POST /api/v1/auth/direct/passkey/login/start',
  'POST /api/v1/auth/direct/passkey/login/finish',
  'POST /api/v1/auth/direct/session',
  'POST /api/v1/login/interactions/start',
]);

const FLOW_SUBMIT_ROUTE = /^\/api\/v1\/login\/interactions\/[^/]+\/submit$/u;

export function isAwsPasskeyIdpAuthRoute(method: string, pathname: string): boolean {
  if (method.toUpperCase() === 'OPTIONS') {
    return (
      EXACT_ROUTES.has(`GET ${pathname}`) ||
      EXACT_ROUTES.has(`POST ${pathname}`) ||
      FLOW_SUBMIT_ROUTE.test(pathname)
    );
  }
  if (EXACT_ROUTES.has(`${method.toUpperCase()} ${pathname}`)) return true;
  return method.toUpperCase() === 'POST' && FLOW_SUBMIT_ROUTE.test(pathname);
}

/**
 * The caller supplies an Env backed by durable AWS services and a waitUntil
 * context. Ingress must pass the original HTTPS URL and trusted tenant host.
 */
export function fetchAwsPasskeyIdpAuth(
  request: Request,
  env: Env,
  context: ExecutionContext
): Response | Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (!isAwsPasskeyIdpAuthRoute(request.method, pathname)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return app.fetch(request, env, context);
}
