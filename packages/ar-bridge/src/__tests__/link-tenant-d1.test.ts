import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccount: vi.fn(),
  getIdentity: vi.fn(),
  countIdentities: vi.fn(),
  deleteIdentity: vi.fn(),
  hasPasskey: vi.fn(),
  revokeTokens: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  getSessionStoreBySessionId: vi.fn(() => ({
    stub: {
      fetch: vi
        .fn()
        .mockResolvedValue(Response.json({ sessionId: 's_0_session-a', userId: 'user-a' })),
    },
  })),
  isShardedSessionId: vi.fn(() => true),
  createErrorResponse: vi.fn((_c, code) =>
    Response.json({ error: code }, { status: code === 'internal' ? 500 : 400 })
  ),
  AR_ERROR_CODES: {
    ADMIN_AUTH_REQUIRED: 'admin_auth_required',
    ADMIN_RESOURCE_NOT_FOUND: 'not_found',
    VALIDATION_REQUIRED_FIELD: 'required',
    VALIDATION_INVALID_VALUE: 'invalid',
    INTERNAL_ERROR: 'internal',
  },
  buildIssuerUrl: vi.fn(() => 'https://tenant-a.example.com'),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  getLogger: vi.fn(() => ({
    module: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  })),
  getCachedAuthCorePersistenceContextFromEnv: vi.fn().mockResolvedValue({
    storageProfileId: 'builtin:storage:tenant-d1',
  }),
  resolveAccountDataContext: mocks.resolveAccount,
}));

vi.mock('../services/linked-identity-store', () => ({
  getLinkedIdentityById: mocks.getIdentity,
  listLinkedIdentities: vi.fn(),
  deleteLinkedIdentity: mocks.deleteIdentity,
  countLinkedIdentities: mocks.countIdentities,
  getLinkedIdentityForUserAndProvider: vi.fn(),
}));

vi.mock('../services/identity-stitching', () => ({
  hasPasskeyCredential: mocks.hasPasskey,
}));

vi.mock('../services/token-revocation', () => ({
  revokeLinkedIdentityTokens: mocks.revokeTokens,
}));

vi.mock('../services/provider-store', () => ({
  getProvider: vi.fn(),
}));

import { handleUnlinkIdentity } from '../handlers/link';

function context(provisioner?: {
  removeExternalIdpRoute?: ReturnType<typeof vi.fn>;
  getExternalIdpRouteRemovalStatus?: ReturnType<typeof vi.fn>;
}) {
  const env = provisioner ? { EXTERNAL_IDP_ACCOUNT_PROVISIONER: provisioner } : {};
  return {
    env,
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'authrim_session=s_0_session-a' : undefined,
      param: (name: string) => (name === 'id' ? 'link-a' : undefined),
    },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  };
}

describe('tenant-D1 external identity unlink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccount.mockResolvedValue({
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      coreDb: { binding: 'core-a' },
      piiDb: { binding: 'pii-a' },
    });
    mocks.getIdentity.mockResolvedValue({
      id: 'link-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      providerId: 'provider-a',
      providerUserId: 'provider-user-a',
      linkedAt: Date.now(),
      updatedAt: Date.now(),
    });
    mocks.countIdentities.mockResolvedValue(2);
    mocks.hasPasskey.mockResolvedValue(false);
    mocks.revokeTokens.mockResolvedValue({
      success: true,
      accessTokenRevoked: true,
      refreshTokenRevoked: true,
      errors: [],
    });
  });

  it('uses the routed PII authority and schedules durable Lookup cleanup', async () => {
    const removeExternalIdpRoute = vi.fn().mockImplementation(async (request) => ({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    }));
    const c = context({ removeExternalIdpRoute });

    const response = await handleUnlinkIdentity(c as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      cleanup_pending: true,
    });
    expect(mocks.getIdentity).toHaveBeenCalledWith(
      c.env,
      'tenant-a',
      'link-a',
      expect.objectContaining({ binding: 'pii-a' })
    );
    expect(removeExternalIdpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-a',
        linkedIdentityId: 'link-a',
        providerId: 'provider-a',
        providerUserId: 'provider-user-a',
      })
    );
    expect(mocks.deleteIdentity).not.toHaveBeenCalled();
  });

  it('fails closed without the narrow Management binding', async () => {
    const response = await handleUnlinkIdentity(context() as never);

    expect(response.status).toBe(500);
    expect(mocks.deleteIdentity).not.toHaveBeenCalled();
  });

  it('adopts a prior unlink after the RPC response was lost', async () => {
    mocks.getIdentity.mockResolvedValueOnce(null);
    const getExternalIdpRouteRemovalStatus = vi.fn().mockImplementation(async (request) => ({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    }));
    const c = context({ getExternalIdpRouteRemovalStatus });

    const response = await handleUnlinkIdentity(c as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      cleanup_pending: true,
      token_revocation: { attempted: false },
    });
    expect(getExternalIdpRouteRemovalStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-a',
      })
    );
    expect(mocks.revokeTokens).not.toHaveBeenCalled();
  });
});
