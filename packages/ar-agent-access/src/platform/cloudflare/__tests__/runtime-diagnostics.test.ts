import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigurationOperationRequest } from '../../ports';
import { CloudflareAgentRuntimeDiagnostics } from '../runtime-diagnostics';

const request: AgentConfigurationOperationRequest = {
  operation: 'admin.read.runtime.diagnostics',
  actor: {
    mode: 'mode_a',
    sub: 'client:client-1',
    assurance: 'public_client_transaction',
    tokenBinding: 'bearer',
    clientId: 'client-1',
  },
  grant: {
    grantId: 'grant-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    grantorId: 'admin-1',
    delegatorId: 'admin-1',
    permissions: ['admin:settings:read'],
    scopes: ['agent:read'],
    resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
    consentVersion: 1,
    generation: 1,
    status: 'active',
    delegationMode: 'user_consent',
  },
  issuerOrigin: 'https://tenant.example',
  correlationId: 'correlation-1',
  input: {},
};

describe('Cloudflare runtime diagnostics adapter', () => {
  it('uses fixed service-binding targets and returns only public key metadata', async () => {
    const discovery = {
      fetch: vi.fn(async (incoming: Request) => {
        const path = new URL(incoming.url).pathname;
        expect(incoming.headers.get('x-authrim-forwarded-host')).toBe('tenant.example');
        return path.endsWith('openid-configuration')
          ? Response.json({
              issuer: 'https://tenant.example',
              token_endpoint: 'https://tenant.example/token',
            })
          : Response.json({
              keys: [
                { kid: 'key-1', kty: 'RSA', alg: 'RS256', use: 'sig', n: 'public', d: 'private' },
              ],
            });
      }),
    };
    const management = { fetch: vi.fn(async () => Response.json({ status: 'ok' })) };
    const result = await new CloudflareAgentRuntimeDiagnostics(discovery, management).inspect(
      request
    );
    expect(result).toEqual({
      status: 200,
      body: {
        snapshot: {
          issuer: 'https://tenant.example',
          discovery_status: 200,
          issuer_matches: true,
          reported_issuer: 'https://tenant.example',
          jwks_status: 200,
          signing_keys: [{ kid: 'key-1', kty: 'RSA', alg: 'RS256', use: 'sig' }],
          management_health_status: 200,
          healthy: true,
        },
      },
    });
    expect(discovery.fetch).toHaveBeenCalledTimes(2);
    expect(management.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://ar-management.internal/api/health' })
    );
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('fails closed without following a caller-selected URL', async () => {
    const unavailable = { fetch: vi.fn(async () => Promise.reject(new Error('offline'))) };
    await expect(
      new CloudflareAgentRuntimeDiagnostics(unavailable, unavailable).inspect(request)
    ).resolves.toMatchObject({
      status: 503,
      body: { error: 'AGENT_RUNTIME_DIAGNOSTICS_UNAVAILABLE' },
    });
  });

  it('rejects oversized internal discovery documents', async () => {
    const discovery = {
      fetch: vi.fn(async (incoming: Request) => {
        const path = new URL(incoming.url).pathname;
        if (path.endsWith('openid-configuration')) {
          return new Response('{}', { headers: { 'content-length': '262145' } });
        }
        return Response.json({ keys: [] });
      }),
    };
    const management = { fetch: vi.fn(async () => Response.json({ status: 'ok' })) };
    await expect(
      new CloudflareAgentRuntimeDiagnostics(discovery, management).inspect(request)
    ).resolves.toMatchObject({
      status: 503,
      body: { error: 'AGENT_RUNTIME_DIAGNOSTICS_UNAVAILABLE' },
    });
  });
});
