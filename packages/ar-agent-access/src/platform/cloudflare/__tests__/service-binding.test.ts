import { describe, expect, it, vi } from 'vitest';
import type { ManagementOperationRequest } from '../../ports';
import {
  CloudflareServiceBindingDownscopeTokenProvider,
  CloudflareServiceBindingManagementApi,
  createCloudflareRequestScopedDownscopeTokenProvider,
} from '../service-binding';
import { runWithCloudflareAgentAccessRequest } from '../mcp-request-context';

const request: ManagementOperationRequest = {
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
  },
  input: { user_id: 'user-1' },
};

describe('CloudflareServiceBindingManagementApi', () => {
  it('maps trusted operation IDs and sends a signed downscope token over the binding', async () => {
    const fetch = vi.fn(async (incoming: Request) => {
      expect(incoming.url).toBe('https://ar-management.internal/api/admin/users/get');
      expect(incoming.headers.get('authorization')).toBe('Bearer downscope-token');
      expect(incoming.headers.get('x-correlation-id')).toBe('correlation-1');
      expect(incoming.headers.get('x-authrim-forwarded-host')).toBe('tenant-1.authrim.example');
      expect(incoming.headers.get('x-tenant-id')).toBe('tenant-1');
      return Response.json({ id: 'user-1' }, { headers: { 'x-request-id': 'request-1' } });
    });
    const adapter = new CloudflareServiceBindingManagementApi(
      { fetch },
      { 'users.get': { method: 'POST', path: '/api/admin/users/get' } },
      { getToken: async () => 'downscope-token' }
    );

    await expect(adapter.execute(request)).resolves.toEqual({
      status: 200,
      body: { id: 'user-1' },
      requestId: 'request-1',
      executionStatus: 'definite',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('binds the Management tenant header to the verified request tenant', async () => {
    const fetch = vi.fn(async (incoming: Request) => {
      expect(incoming.headers.get('x-tenant-id')).toBe('tenant-1');
      expect(incoming.headers.get('authorization')).toBe('Bearer downscope-token');
      return Response.json({ id: 'user-1' });
    });
    const adapter = new CloudflareServiceBindingManagementApi(
      { fetch },
      {
        'users.get': {
          method: 'POST',
          path: '/api/admin/users/get',
          headers: () => ({
            authorization: 'Bearer route-supplied-token',
            'x-tenant-id': 'tenant-other',
          }),
        },
      },
      { getToken: async () => 'downscope-token' }
    );

    await adapter.execute(request);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects unknown operations and routes outside the Admin API namespace', async () => {
    const binding = { fetch: vi.fn(async () => Response.json({})) };
    const tokenProvider = { getToken: vi.fn(async () => 'token') };
    const unknown = new CloudflareServiceBindingManagementApi(binding, {}, tokenProvider);
    await expect(unknown.execute(request)).rejects.toThrow('Unknown Management operation');

    const unsafe = new CloudflareServiceBindingManagementApi(
      binding,
      { 'users.get': { method: 'POST', path: '/internal/arbitrary' } },
      tokenProvider
    );
    await expect(unsafe.execute(request)).rejects.toThrow('must stay under /api/admin/');
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('rejects an unverified or non-origin issuer value before invoking Management', async () => {
    const binding = { fetch: vi.fn(async () => Response.json({})) };
    const adapter = new CloudflareServiceBindingManagementApi(
      binding,
      { 'users.get': { method: 'POST', path: '/api/admin/users/get' } },
      { getToken: async () => 'token' }
    );
    await expect(
      adapter.execute({
        ...request,
        authorization: {
          ...request.authorization,
          issuerOrigin: 'https://tenant-1.authrim.example/not-an-origin',
        },
      })
    ).rejects.toThrow('issuer origin is invalid');
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('allows only a trusted route builder to encode operation-specific path parameters', async () => {
    const fetch = vi.fn(async (incoming: Request) => {
      expect(incoming.url).toBe(
        'https://ar-management.internal/api/admin/users/user%2Fwith%2Fslashes'
      );
      expect(incoming.body).toBeNull();
      return Response.json({ id: 'user/with/slashes' });
    });
    const adapter = new CloudflareServiceBindingManagementApi(
      { fetch },
      {
        'users.get': {
          method: 'GET',
          path: (input) => `/api/admin/users/${encodeURIComponent(String(input.user_id))}`,
        },
      },
      { getToken: async () => 'token' }
    );

    await adapter.execute({ ...request, input: { user_id: 'user/with/slashes' } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('applies the trusted owner-response projection before returning Tool data', async () => {
    const adapter = new CloudflareServiceBindingManagementApi(
      { fetch: vi.fn(async () => Response.json({ client_secret: 'hidden', enabled: true })) },
      {
        'users.get': {
          method: 'GET',
          path: '/api/admin/users/get',
          response: (body) => ({ snapshot: { enabled: (body as { enabled?: boolean }).enabled } }),
        },
      },
      { getToken: async () => 'token' }
    );
    await expect(adapter.execute(request)).resolves.toMatchObject({
      body: { snapshot: { enabled: true } },
    });
  });

  it('rejects oversized owner responses before projection', async () => {
    const responseProjection = vi.fn((body) => body);
    const adapter = new CloudflareServiceBindingManagementApi(
      {
        fetch: vi.fn(async () =>
          Response.json(
            { ignored: true },
            { headers: { 'content-length': String(1024 * 1024 + 1) } }
          )
        ),
      },
      {
        'users.get': {
          method: 'GET',
          path: '/api/admin/users/get',
          response: responseProjection,
        },
      },
      { getToken: async () => 'token' }
    );

    await expect(adapter.execute(request)).rejects.toThrow('response size is invalid');
    expect(responseProjection).not.toHaveBeenCalled();
  });

  it('cancels a chunked owner response as soon as the streaming limit is exceeded', async () => {
    const cancel = vi.fn();
    const responseProjection = vi.fn((body) => body);
    let emitted = 0;
    const adapter = new CloudflareServiceBindingManagementApi(
      {
        fetch: vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  emitted += 1;
                  controller.enqueue(new Uint8Array(600 * 1024));
                },
                cancel,
              }),
              { headers: { 'content-type': 'application/json' } }
            )
        ),
      },
      {
        'users.get': {
          method: 'GET',
          path: '/api/admin/users/get',
          response: responseProjection,
        },
      },
      { getToken: async () => 'token' }
    );

    await expect(adapter.execute(request)).rejects.toThrow('Management response is too large');
    expect(emitted).toBeGreaterThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(responseProjection).not.toHaveBeenCalled();
  });
});

describe('CloudflareServiceBindingDownscopeTokenProvider', () => {
  it('exchanges the current MCP token for only the effective operation permissions', async () => {
    const exchangeAgentAccessToken = vi.fn().mockResolvedValue({
      accessToken: 'admin-api-token',
      expiresAt: 160,
    });
    const provider = new CloudflareServiceBindingDownscopeTokenProvider(
      { exchangeAgentAccessToken },
      () => 'mcp-token',
      () => 100
    );

    await expect(provider.getToken(request)).resolves.toBe('admin-api-token');
    expect(exchangeAgentAccessToken).toHaveBeenCalledWith({
      subjectToken: 'mcp-token',
      tenantId: 'tenant-1',
      issuerOrigin: 'https://tenant-1.authrim.example',
      audience: 'authrim:admin-api',
      permissions: ['admin:users:read'],
      grantId: 'grant-1',
      grantGeneration: 2,
      delegatorId: 'admin-1',
      consentVersion: 3,
      actorSub: 'client:client-1',
      actorMode: 'mode_a',
      actorAssurance: 'public_client_transaction',
      clientId: 'client-1',
      correlationId: 'correlation-1',
    });
  });

  it('fails closed when request props have no source token or exchange returns an expired token', async () => {
    const binding = {
      exchangeAgentAccessToken: vi.fn().mockResolvedValue({
        accessToken: 'expired',
        expiresAt: 99,
      }),
    };
    const missing = new CloudflareServiceBindingDownscopeTokenProvider(binding, () => undefined);
    await expect(missing.getToken(request)).rejects.toThrow('source token is unavailable');
    expect(binding.exchangeAgentAccessToken).not.toHaveBeenCalled();

    const expired = new CloudflareServiceBindingDownscopeTokenProvider(
      binding,
      () => 'mcp-token',
      () => 100
    );
    await expect(expired.getToken(request)).rejects.toThrow('invalid token');
  });

  it('reads production source tokens only from the current request-local context', async () => {
    const exchangeAgentAccessToken = vi.fn().mockResolvedValue({
      accessToken: 'admin-api-token',
      expiresAt: 160,
    });
    const provider = createCloudflareRequestScopedDownscopeTokenProvider(
      { exchangeAgentAccessToken },
      () => 100
    );
    await expect(provider.getToken(request)).rejects.toThrow('source token is unavailable');

    await expect(
      runWithCloudflareAgentAccessRequest(
        {
          context: {
            actor: request.authorization.actor,
            grant: {
              grantId: 'grant-1',
              tenantId: 'tenant-1',
              clientId: 'client-1',
              grantorId: 'admin-1',
              delegatorId: 'admin-1',
              permissions: ['admin:users:read'],
              scopes: ['agent:read'],
              resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
              consentVersion: 3,
              generation: 2,
              status: 'active',
              delegationMode: 'user_consent',
            },
            resource: { tenantId: 'tenant-1' },
            issuerOrigin: 'https://tenant-1.authrim.example',
            correlationId: 'correlation-1',
          },
          sourceAccessToken: 'request-token',
        },
        () => provider.getToken(request)
      )
    ).resolves.toBe('admin-api-token');
    expect(exchangeAgentAccessToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ subjectToken: 'request-token' })
    );
  });
});
