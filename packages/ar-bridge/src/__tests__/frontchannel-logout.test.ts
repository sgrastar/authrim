import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  sessionFetch: vi.fn(),
  provider: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createDiagnosticLoggerFromContext: vi.fn(async () => null),
  getDiagnosticSessionId: () => undefined,
  getSessionStoreBySessionId: () => ({ stub: { fetch: mocks.sessionFetch } }),
  getTenantIdFromContext: () => 'tenant-1',
  isShardedSessionId: () => true,
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({
    query: mocks.query,
    execute: mocks.execute,
  })),
}));

vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.provider }));

import { handleFrontchannelLogout } from '../handlers/frontchannel-logout';

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/auth/external/:provider/frontchannel-logout', handleFrontchannelLogout);
  return instance;
}

describe('front-channel logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provider.mockResolvedValue({
      id: 'provider-1',
      issuer: 'https://op.example',
      clientId: 'upstream-client',
    });
    mocks.query.mockResolvedValue([{ id: '0_session-1' }]);
    mocks.execute.mockResolvedValue(undefined);
    mocks.sessionFetch.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it('terminates sessions matching the exact issuer and upstream sid', async () => {
    const response = await app().request(
      'https://tenant.example/auth/external/suite/frontchannel-logout?iss=https%3A%2F%2Fop.example&sid=op-session-1',
      {},
      {} as Env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('external_provider_sid = ?'), [
      'tenant-1',
      'provider-1',
      'op-session-1',
    ]);
    expect(mocks.sessionFetch).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects issuer substitution without touching session state', async () => {
    const response = await app().request(
      'https://tenant.example/auth/external/suite/frontchannel-logout?iss=https%3A%2F%2Fevil.example&sid=op-session-1',
      {},
      {} as Env
    );

    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.sessionFetch).not.toHaveBeenCalled();
  });
});
