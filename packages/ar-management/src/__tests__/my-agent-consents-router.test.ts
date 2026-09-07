import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  getGrant: vi.fn(),
  invalidate: vi.fn(),
  revokeOauth: vi.fn(),
}));

vi.mock('@authrim/ar-agent-access/core', () => ({
  AdminAgentAccessRepository: class {
    listUserConsents = mocks.list;
    getGrant = mocks.getGrant;
    invalidateGrantAndQueueTokenRevocation = mocks.invalidate;
    revokeOauthClientConsentAndQueueTokenRevocation = mocks.revokeOauth;
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: () => async (c: any, next: () => Promise<void>) => {
      c.set('adminAuth', {
        userId: 'admin-1',
        actorType: 'human',
        authMethod: 'session',
        roles: ['admin'],
        tenantId: 'tenant-1',
        permissions: [],
      });
      await next();
    },
    requireDedicatedAdminDatabaseAdapter: () => ({}),
  };
});

import { myAgentConsentsRouter } from '../routes/admin-management/my-agent-consents';

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/me/agent-consents', myAgentConsentsRouter as any);
  return result;
}

describe('current Admin Agent consent routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invalidate.mockResolvedValue({ familyCount: 2, nextGeneration: 2 });
    mocks.revokeOauth.mockResolvedValue({ familyCount: 1 });
  });

  it('revokes OAuth client consent independently without suspending the Grant', async () => {
    mocks.list.mockResolvedValue([
      {
        id: 'consent-client',
        type: 'oauth_client',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        userId: 'admin-1',
        clientId: 'client-1',
        consentVersion: 1,
        scopes: ['agent:read'],
        grantedAt: 1,
        grantStatus: 'active',
        grantGeneration: 1,
      },
    ]);
    const response = await app().request(
      '/api/admin/me/agent-consents/consent-client',
      { method: 'DELETE' },
      { DB_ADMIN: {} } as Env
    );
    expect(response.status).toBe(200);
    expect(mocks.revokeOauth).toHaveBeenCalledWith(
      expect.objectContaining({ consentId: 'consent-client', grantId: 'grant-1' })
    );
    expect(mocks.invalidate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ grant_status: 'active' });
  });

  it('suspends the Grant when delegation consent is withdrawn', async () => {
    mocks.list.mockResolvedValue([
      {
        id: 'consent-delegation',
        type: 'delegation',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        userId: 'admin-1',
        clientId: 'client-1',
        consentVersion: 1,
        scopes: ['agent:read'],
        grantedAt: 1,
        grantStatus: 'active',
        grantGeneration: 1,
      },
    ]);
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      delegatorId: 'admin-1',
      generation: 1,
      status: 'active',
    });
    const response = await app().request(
      '/api/admin/me/agent-consents/consent-delegation',
      { method: 'DELETE' },
      { DB_ADMIN: {} } as Env
    );
    expect(response.status).toBe(200);
    expect(mocks.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'suspended', reason: 'user' })
    );
    expect(mocks.revokeOauth).not.toHaveBeenCalled();
  });
});
