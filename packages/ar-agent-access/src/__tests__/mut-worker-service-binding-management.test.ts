import { describe, expect, it, vi } from 'vitest';
import type { ManagementOperationRequest } from '../platform/ports';
import {
  CloudflareServiceBindingManagementApi,
  type ManagementOperationRoute,
} from '../platform/cloudflare/service-binding';

const MAX = 1024 * 1024;

function operationRequest(
  overrides: Partial<ManagementOperationRequest['authorization']> = {},
  extra: Partial<ManagementOperationRequest> = {}
): ManagementOperationRequest {
  return {
    operation: 'users.get',
    tenantId: 'tenant-1',
    authorization: {
      actor: {
        mode: 'mode_a',
        sub: 'client:client-1',
        assurance: 'public_client_transaction',
        tokenBinding: 'bearer',
        clientId: 'client-1',
      },
      grantId: 'grant-1',
      grantGeneration: 2,
      delegatorId: 'admin-1',
      consentVersion: 3,
      effectivePermissions: ['admin:users:read'],
      audience: 'authrim:admin-api',
      issuerOrigin: 'https://tenant-1.authrim.example',
      correlationId: 'correlation-1',
      ...overrides,
    },
    input: { user_id: 'user-1' },
    ...extra,
  };
}

function api(
  respond: () => Response,
  route: Partial<ManagementOperationRoute> = {}
): {
  execute: (request?: ManagementOperationRequest) => Promise<unknown>;
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn(async (_request: Request) => respond());
  const adapter = new CloudflareServiceBindingManagementApi(
    { fetch },
    { 'users.get': { method: 'POST', path: '/api/admin/users/get', ...route } },
    { getToken: async () => 'downscope-token' }
  );
  return { execute: (request = operationRequest()) => adapter.execute(request), fetch };
}

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers }
  );
}

describe('Management request construction', () => {
  it('sends JSON with an idempotency key only when one is supplied', async () => {
    const withKey = api(() => Response.json({}));
    await withKey.execute(operationRequest({}, { idempotencyKey: 'idem-1' }));
    const sent = withKey.fetch.mock.calls[0]?.[0] as Request;
    expect(sent.headers.get('content-type')).toBe('application/json');
    expect(sent.headers.get('idempotency-key')).toBe('idem-1');
    await expect(sent.json()).resolves.toEqual({ user_id: 'user-1' });

    const withoutKey = api(() => Response.json({}));
    await withoutKey.execute();
    expect((withoutKey.fetch.mock.calls[0]?.[0] as Request).headers.has('idempotency-key')).toBe(
      false
    );
  });

  it('reports an indeterminate execution only when the owner flags it', async () => {
    const indeterminate = api(() =>
      Response.json({}, { headers: { 'x-authrim-execution-indeterminate': 'true' } })
    );
    await expect(indeterminate.execute()).resolves.toMatchObject({
      executionStatus: 'indeterminate',
      requestId: undefined,
    });
    const other = api(() =>
      Response.json({}, { headers: { 'x-authrim-execution-indeterminate': 'false' } })
    );
    await expect(other.execute()).resolves.toMatchObject({ executionStatus: 'definite' });
  });

  it('refuses a route that resolves to another origin', async () => {
    const { execute, fetch } = api(() => Response.json({}), {
      path: 'https://evil.example/api/admin/users',
    });
    await expect(execute()).rejects.toThrow('Agent Management routes must stay under /api/admin/');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['not a url', 'http://tenant.example', 'https://tenant.example/path'])(
    'refuses issuer origin %s',
    async (issuerOrigin) => {
      const { execute, fetch } = api(() => Response.json({}));
      await expect(execute(operationRequest({ issuerOrigin }))).rejects.toThrow(
        new TypeError('Agent issuer origin is invalid')
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
    'allows the local development issuer %s',
    async (issuerOrigin) => {
      const { execute, fetch } = api(() => Response.json({ ok: true }));
      await expect(execute(operationRequest({ issuerOrigin }))).resolves.toMatchObject({
        body: { ok: true },
      });
      expect((fetch.mock.calls[0]?.[0] as Request).headers.get('x-authrim-forwarded-host')).toBe(
        new URL(issuerOrigin).host
      );
    }
  );
});

describe('bounded Management responses', () => {
  it.each(['-1', 'abc', '2.5', String(MAX + 1)])(
    'rejects a declared Content-Length of %s',
    async (length) => {
      const { execute } = api(() => new Response('{}', { headers: { 'content-length': length } }));
      await expect(execute()).rejects.toThrow(
        new RangeError('Management response size is invalid')
      );
    }
  );

  it('accepts declared lengths of zero and exactly the limit', async () => {
    for (const length of ['0', String(MAX)]) {
      const { execute } = api(
        () =>
          new Response('{"ok":true}', {
            headers: { 'content-length': length, 'content-type': 'application/json' },
          })
      );
      await expect(execute()).resolves.toMatchObject({ body: { ok: true } });
    }
  });

  it('accepts a streamed body of exactly the limit and rejects one byte more', async () => {
    const response = streamed([new Uint8Array(MAX).fill(0x61)]);
    const ok = api(() => response);
    const result = (await ok.execute()) as { body: { text: string } };
    expect(result.body.text).toHaveLength(MAX);
    expect(response.body?.locked).toBe(false);

    const tooLarge = api(() => streamed([new Uint8Array(MAX), new Uint8Array(1)]));
    await expect(tooLarge.execute()).rejects.toThrow(
      new RangeError('Management response is too large')
    );
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('é');
    const { execute } = api(() => streamed([bytes.slice(0, 1), bytes.slice(1)]));
    await expect(execute()).resolves.toMatchObject({ body: { text: 'é' } });
  });

  it('returns an empty text body for a body-less response', async () => {
    const { execute } = api(() => new Response(null, { status: 204 }));
    await expect(execute()).resolves.toMatchObject({ status: 204, body: { text: '' } });
  });

  it.each([
    ['json', true],
    ['application/json', true],
    ['application/problem+json; charset=utf-8', true],
    ['APPLICATION/JSON', true],
    ['application/jsonx', false],
    ['text/plain', false],
  ])('parses %s as JSON: %s', async (contentType, parsed) => {
    const { execute } = api(
      () => new Response('{"a":1}', { headers: { 'content-type': contentType } })
    );
    await expect(execute()).resolves.toMatchObject({
      body: parsed ? { a: 1 } : { text: '{"a":1}' },
    });
  });
});
