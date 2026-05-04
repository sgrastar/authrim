import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupGeneratedApprovalSmokeClient,
  resolveGeneratedApprovalSmokeClient,
} from '../core/generated-approvals-smoke-client.js';

describe('generated approvals smoke client helper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses provided client credentials', async () => {
    const result = await resolveGeneratedApprovalSmokeClient({
      baseUrl: 'https://example.workers.dev',
      timeoutMs: 5_000,
      adminSecret: 'admin-secret',
      tenantId: 'tenant-a',
      clientId: 'svc-client-1',
      clientSecret: 'svc-secret-1',
      defaultAudience: 'svc://op-userinfo/customer-profile',
    });

    expect(result.clientId).toBe('svc-client-1');
    expect(result.clientSecret).toBe('svc-secret-1');
    expect(result.temporaryClientId).toBeUndefined();
    expect(result.checks[0]?.status).toBe('pass');
  });

  it('creates and cleans up a temporary service client when credentials are missing', async () => {
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/admin/clients') && method === 'POST') {
        return new Response(
          JSON.stringify({
            client: {
              client_id: 'temp-client-1',
              client_secret: 'temp-secret-1',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/admin/clients/temp-client-1') && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const result = await resolveGeneratedApprovalSmokeClient({
      baseUrl: 'https://example.workers.dev',
      timeoutMs: 5_000,
      adminSecret: 'admin-secret',
      tenantId: 'tenant-a',
      defaultAudience: 'svc://op-userinfo/customer-profile',
    });

    expect(result.clientId).toBe('temp-client-1');
    expect(result.clientSecret).toBe('temp-secret-1');
    expect(result.temporaryClientId).toBe('temp-client-1');
    expect(result.checks[0]?.status).toBe('pass');

    const checks = [...result.checks];
    await cleanupGeneratedApprovalSmokeClient({
      checks,
      baseUrl: 'https://example.workers.dev',
      timeoutMs: 5_000,
      adminSecret: 'admin-secret',
      tenantId: 'tenant-a',
      clientId: result.temporaryClientId,
    });

    expect(checks.at(-1)?.id).toBe('approval-smoke-client-delete');
    expect(checks.at(-1)?.status).toBe('pass');
  });
});
