import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getSessionRpc: vi.fn(),
  sessionFetch: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  execute: vi.fn(),
  findByClientId: vi.fn(),
  discover: vi.fn(),
  provider: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  buildIssuerUrl: () => 'https://tenant.example',
  createAuthContextFromHono: () => ({
    repositories: { client: { findByClientId: mocks.findByClientId } },
  }),
  createDiagnosticLoggerFromContext: vi.fn(async () => null),
  getChallengeStoreByChallengeId: () => ({
    storeChallengeRpc: mocks.storeChallengeRpc,
    consumeChallengeRpc: mocks.consumeChallengeRpc,
  }),
  getDiagnosticSessionId: () => undefined,
  getSessionStoreBySessionId: () => ({
    stub: { getSessionRpc: mocks.getSessionRpc, fetch: mocks.sessionFetch },
  }),
  getTenantIdFromContext: () => 'tenant-1',
  isShardedSessionId: () => true,
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({ execute: mocks.execute })),
}));

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mocks.provider,
}));

vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: {
    fromProvider: () => ({ discover: mocks.discover }),
  },
}));

vi.mock('../utils/crypto', () => ({
  decrypt: mocks.decrypt,
  getEncryptionKeyOrUndefined: () => 'encryption-key',
}));

import {
  handleRpInitiatedLogout,
  handleRpInitiatedLogoutCallback,
} from '../handlers/rp-initiated-logout';

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/auth/external/:provider/logout', handleRpInitiatedLogout);
  instance.get('/auth/external/:provider/logout/callback', handleRpInitiatedLogoutCallback);
  return instance;
}

describe('RP-initiated upstream logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provider.mockResolvedValue({
      id: 'provider-1',
      slug: 'suite',
      issuer: 'https://op.example',
      clientId: 'upstream-client',
    });
    mocks.getSessionRpc.mockResolvedValue({
      id: '0_session-1',
      userId: 'user-1',
      data: {
        client_id: 'downstream-client',
        external_provider_id: 'provider-1',
        upstream_id_token_encrypted: 'encrypted-id-token',
      },
    });
    mocks.findByClientId.mockResolvedValue({
      redirect_uris: JSON.stringify(['https://rp.example/callback']),
    });
    mocks.decrypt.mockResolvedValue('upstream.id.token');
    mocks.discover.mockResolvedValue({
      end_session_endpoint: 'https://op.example/end-session',
    });
    mocks.sessionFetch.mockResolvedValue(new Response(null, { status: 204 }));
    mocks.execute.mockResolvedValue(undefined);
    mocks.storeChallengeRpc.mockResolvedValue(undefined);
  });

  it('terminates the local session and redirects to the discovered end_session_endpoint', async () => {
    const response = await app().request(
      'https://tenant.example/auth/external/suite/logout?post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fcallback&state=app-state',
      { headers: { Cookie: 'authrim_session=0_session-1' } },
      {} as Env
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://op.example/end-session');
    expect(location.searchParams.get('id_token_hint')).toBe('upstream.id.token');
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://tenant.example/auth/external/suite/logout/callback'
    );
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(mocks.sessionFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
    expect(response.headers.get('set-cookie')).toContain('authrim_upstream_logout=');
  });

  it('rejects an unregistered post-logout target without terminating the session', async () => {
    const response = await app().request(
      'https://tenant.example/auth/external/suite/logout?post_logout_redirect_uri=https%3A%2F%2Fevil.example%2F',
      { headers: { Cookie: 'authrim_session=0_session-1' } },
      {} as Env
    );

    expect(response.status).toBe(400);
    expect(mocks.sessionFetch).not.toHaveBeenCalled();
    expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('uses the one-time browser cookie when the OP omits or changes state', async () => {
    mocks.consumeChallengeRpc.mockResolvedValue({
      metadata: {
        provider_id: 'provider-1',
        target_uri: 'https://rp.example/callback',
        application_state: 'app-state',
        op_state: 'expected-state',
      },
    });

    const response = await app().request(
      'https://tenant.example/auth/external/suite/logout/callback?state=different-state',
      { headers: { Cookie: 'authrim_upstream_logout=logout-1' } },
      {} as Env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://rp.example/callback?state=app-state');
    expect(mocks.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'upstream_logout:logout-1',
      tenantId: 'tenant-1',
      type: 'upstream_logout',
      challenge: 'logout-1',
    });
  });
});
