/**
 * Contract: every device flow and CIBA approval call the Login UI makes reaches a route ar-async
 * serves and documents, through ar-router.
 *
 * The Login UI once called /api/devices/verify-code, /api/devices/approve,
 * /api/ciba/requests/pending and /api/ciba/requests/:id/approve|reject, none of which any worker
 * served, and ar-router forwarded /api/device/* while ar-async served /api/devices/*. The Login UI
 * client builds its requests from APPROVAL_ENDPOINTS (its own unit test pins that), and this test
 * holds that table against the ar-async route table, its OpenAPI document and the router.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import asyncApp from '../../packages/ar-async/src/index';
import routerApp from '../../packages/ar-router/src/index';
import {
  APPROVAL_ENDPOINTS,
  approvalEndpointPath,
} from '../../packages/ar-login-ui/src/lib/api/approval-endpoints';

const endpoints = Object.entries(APPROVAL_ENDPOINTS);

function sampleParams(template: string): Record<string, string> {
  return Object.fromEntries(
    [...template.matchAll(/:([a-z_]+)/g)].map(([, name]) => [name, 'id-1'])
  );
}

function openApiPath(template: string): string {
  return template.replace(/:([a-z_]+)/g, '{$1}');
}

function createFetcher(name: string) {
  return {
    fetch: vi.fn(async (request: Request) =>
      Response.json({ worker: name, path: new URL(request.url).pathname })
    ),
  };
}

function createRouterEnv() {
  return {
    ISSUER_URL: 'https://auth.example.com',
    OP_DISCOVERY: createFetcher('OP_DISCOVERY'),
    OP_AUTH: createFetcher('OP_AUTH'),
    OP_TOKEN: createFetcher('OP_TOKEN'),
    OP_USERINFO: createFetcher('OP_USERINFO'),
    OP_MANAGEMENT: createFetcher('OP_MANAGEMENT'),
    OP_CONTROL: createFetcher('OP_CONTROL'),
    OP_ASYNC: createFetcher('OP_ASYNC'),
    OP_SAML: createFetcher('OP_SAML'),
    EXTERNAL_IDP: createFetcher('EXTERNAL_IDP'),
  };
}

describe('Login UI device and CIBA approval route contract', () => {
  it.each(endpoints)('ar-async serves %s', (_name, endpoint) => {
    const served = asyncApp.routes.filter(
      (route) => route.method === endpoint.method && route.path === endpoint.path
    );
    expect(served, `${endpoint.method} ${endpoint.path}`).toHaveLength(1);
  });

  it.each(endpoints)('ar-async documents %s in its OpenAPI contract', (_name, endpoint) => {
    const spec = parse(
      readFileSync(
        path.resolve(__dirname, '../../packages/ar-async/openapi/async.openapi.yaml'),
        'utf8'
      )
    ) as {
      paths: Record<string, Record<string, { security?: Array<Record<string, unknown>> }>>;
    };
    const operation = spec.paths[openApiPath(endpoint.path)]?.[endpoint.method.toLowerCase()];

    expect(operation, `${endpoint.method} ${endpoint.path}`).toBeDefined();
    // Every approval call acts for the signed-in user: the contract names the session.
    expect(operation?.security).toEqual([{ sessionCookie: [] }, { sessionHeader: [] }]);
  });

  it('documents the CIBA pending timestamps in the unit the Login UI converts from', () => {
    // The Login UI client turns these epoch milliseconds into the seconds its page counts in
    // (packages/ar-login-ui/src/lib/api/client.approval.test.ts).
    const spec = parse(
      readFileSync(
        path.resolve(__dirname, '../../packages/ar-async/openapi/async.openapi.yaml'),
        'utf8'
      )
    ) as {
      components: {
        schemas: Record<string, { properties: Record<string, { description?: string }> }>;
      };
    };
    const pending = spec.components.schemas.CibaPendingRequest.properties;

    expect(pending.created_at.description).toBe('Epoch milliseconds.');
    expect(pending.expires_at.description).toBe('Epoch milliseconds.');
  });

  it.each(endpoints)(
    'ar-router forwards %s from the Login UI origin to ar-async with the session',
    async (_name, endpoint) => {
      const env = createRouterEnv();
      const requestPath = approvalEndpointPath(endpoint, sampleParams(endpoint.path));
      const response = await routerApp.fetch(
        new Request(`https://auth.example.com${requestPath}`, {
          method: endpoint.method,
          headers: {
            Origin: 'https://auth.example.com',
            Cookie: 'authrim_session=session-1',
            ...(endpoint.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(endpoint.method === 'POST' ? { body: '{}' } : {}),
        }),
        env as never
      );

      expect(response.status).toBe(200);
      expect(env.OP_ASYNC.fetch).toHaveBeenCalledTimes(1);
      const forwarded = env.OP_ASYNC.fetch.mock.calls[0][0] as Request;
      expect(forwarded.method).toBe(endpoint.method);
      expect(new URL(forwarded.url).pathname).toBe(requestPath);
      expect(forwarded.headers.get('Cookie')).toBe('authrim_session=session-1');
    }
  );

  it.each(endpoints.filter(([, endpoint]) => endpoint.method === 'POST'))(
    'ar-router refuses a cross-site %s before it reaches ar-async',
    async (_name, endpoint) => {
      const env = createRouterEnv();
      const response = await routerApp.fetch(
        new Request(`https://auth.example.com${endpoint.path}`, {
          method: 'POST',
          headers: {
            Origin: 'https://attacker.example',
            Cookie: 'authrim_session=session-1',
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
        env as never
      );

      expect(response.status).toBe(403);
      expect(env.OP_ASYNC.fetch).not.toHaveBeenCalled();
    }
  );
});
