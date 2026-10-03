import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccount: vi.fn(),
  getIdentity: vi.fn(),
  getIdentityForProvider: vi.fn(),
  hasRemaining: vi.fn(),
  revokeTokens: vi.fn(),
  readSession: vi.fn(),
  getProvider: vi.fn(),
  createIntent: vi.fn(),
  recordActivity: vi.fn(),
  withLock: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  ACCOUNT_REAUTH_REQUIRED_ERROR: {
    error: 'reauth_required',
    error_description: 'Recent authentication is required for this operation',
    reauth_required: true,
  },
  isAccountReauthFresh: (authTime: number) => Math.floor(Date.now() / 1000) < authTime + 300,
  readAccountSession: mocks.readSession,
  hasRemainingLoginMethod: mocks.hasRemaining,
  withLoginMethodRemovalLock: mocks.withLock,
  LoginMethodRemovalInProgressError: class LoginMethodRemovalInProgressError extends Error {},
  ensureDatabaseAdapter: vi.fn((source: unknown) => ({ source })),
  createErrorResponse: vi.fn((_c, code) =>
    Response.json(
      { error: code },
      { status: code === 'internal' ? 500 : code === 'admin_auth_required' ? 401 : 400 }
    )
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
  resolveAccountDataContext: mocks.resolveAccount,
}));

vi.mock('../services/linked-identity-store', () => ({
  getLinkedIdentityById: mocks.getIdentity,
  listLinkedIdentities: vi.fn(),
  getLinkedIdentityForUserAndProvider: mocks.getIdentityForProvider,
}));

vi.mock('../services/token-revocation', () => ({
  revokeLinkedIdentityTokens: mocks.revokeTokens,
}));

vi.mock('../services/provider-store', () => ({
  getProvider: vi.fn(),
  getProviderByIdOrSlug: mocks.getProvider,
}));

vi.mock('../services/link-intent', () => ({
  createLinkIntent: mocks.createIntent,
  recordSocialAccountActivity: mocks.recordActivity,
}));

import { handleLinkIdentity, handleUnlinkIdentity } from '../handlers/link';

function context(
  options: {
    provisioner?: {
      removeExternalIdpRoute?: ReturnType<typeof vi.fn>;
      getExternalIdpRouteRemovalStatus?: ReturnType<typeof vi.fn>;
    };
    body?: unknown;
  } = {}
) {
  const env = options.provisioner ? { EXTERNAL_IDP_ACCOUNT_PROVISIONER: options.provisioner } : {};
  return {
    env,
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'authrim_session=s_0_session-a' : undefined,
      param: (name: string) => (name === 'id' ? 'link-a' : undefined),
      json: async () => options.body,
    },
    header: vi.fn(),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  };
}

const freshSession = () => ({
  sessionId: 's_0_session-a',
  userId: 'user-a',
  createdAt: Date.now() - 60_000,
  expiresAt: Date.now() + 3_600_000,
  authTime: Math.floor(Date.now() / 1000) - 60,
});

const removal = () =>
  vi.fn().mockImplementation(async (request) => ({
    status: 202,
    operationId: request.operationId,
    accountId: request.accountId,
  }));

describe('routed-account external identity unlink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSession.mockResolvedValue(freshSession());
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
    mocks.hasRemaining.mockResolvedValue(true);
    mocks.withLock.mockImplementation(
      async (_env: unknown, _tenantId: string, _userId: string, removal: () => Promise<unknown>) =>
        removal()
    );
    mocks.revokeTokens.mockResolvedValue({
      success: true,
      accessTokenRevoked: true,
      refreshTokenRevoked: true,
      errors: [],
    });
  });

  it('uses the routed PII authority and schedules durable Lookup cleanup', async () => {
    const removeExternalIdpRoute = removal();
    const c = context({ provisioner: { removeExternalIdpRoute } });

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
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      c,
      'user-a',
      'account.social_account.unlinked',
      { linkedIdentityId: 'link-a', providerId: 'provider-a' }
    );
  });

  it('checks the remaining login methods on the routed account stores', async () => {
    const c = context({ provisioner: { removeExternalIdpRoute: removal() } });

    await handleUnlinkIdentity(c as never);

    expect(mocks.hasRemaining).toHaveBeenCalledWith(c.env, {
      tenantId: 'tenant-a',
      userId: 'user-a',
      coreAdapter: { source: { binding: 'core-a' } },
      piiAdapter: { source: { binding: 'pii-a' } },
      removing: { kind: 'linked_identity', id: 'link-a' },
    });
  });

  it('keeps the last way the account signs in', async () => {
    mocks.hasRemaining.mockResolvedValueOnce(false);
    const removeExternalIdpRoute = removal();

    const response = await handleUnlinkIdentity(
      context({ provisioner: { removeExternalIdpRoute } }) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'remaining_login_method_required',
    });
    expect(mocks.revokeTokens).not.toHaveBeenCalled();
    expect(removeExternalIdpRoute).not.toHaveBeenCalled();
  });

  it('removes under the account lease and answers 409 while another removal runs', async () => {
    const removeExternalIdpRoute = removal();
    const core = await import('@authrim/ar-lib-core');
    mocks.withLock.mockRejectedValueOnce(new core.LoginMethodRemovalInProgressError());

    const response = await handleUnlinkIdentity(
      context({ provisioner: { removeExternalIdpRoute } }) as never
    );

    expect(response.status).toBe(409);
    expect(mocks.withLock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'user-a',
      expect.any(Function)
    );
    expect(removeExternalIdpRoute).not.toHaveBeenCalled();
  });

  it('requires a recent authentication', async () => {
    mocks.readSession.mockResolvedValueOnce({
      ...freshSession(),
      authTime: Math.floor(Date.now() / 1000) - 301,
    });
    const removeExternalIdpRoute = removal();

    const response = await handleUnlinkIdentity(
      context({ provisioner: { removeExternalIdpRoute } }) as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'reauth_required' });
    expect(removeExternalIdpRoute).not.toHaveBeenCalled();
  });

  it('refuses guest sessions and missing sessions', async () => {
    mocks.readSession.mockResolvedValueOnce({ ...freshSession(), isGuestSession: true });
    const guest = await handleUnlinkIdentity(
      context({ provisioner: { removeExternalIdpRoute: removal() } }) as never
    );
    expect(guest.status).toBe(403);

    mocks.readSession.mockResolvedValueOnce(null);
    const signedOut = await handleUnlinkIdentity(
      context({ provisioner: { removeExternalIdpRoute: removal() } }) as never
    );
    expect(signedOut.status).toBe(401);
  });

  it('answers a session store failure as a server error', async () => {
    mocks.readSession.mockRejectedValueOnce(new Error('session store down'));

    const response = await handleUnlinkIdentity(context() as never);

    expect(response.status).toBe(500);
  });

  it('fails closed without the narrow Management binding', async () => {
    const response = await handleUnlinkIdentity(context() as never);

    expect(response.status).toBe(500);
  });

  it('adopts a prior unlink after the RPC response was lost', async () => {
    mocks.getIdentity.mockResolvedValueOnce(null);
    const getExternalIdpRouteRemovalStatus = vi.fn().mockImplementation(async (request) => ({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    }));
    const c = context({ provisioner: { getExternalIdpRouteRemovalStatus } });

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

describe('starting a link from the account page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSession.mockResolvedValue(freshSession());
    mocks.resolveAccount.mockResolvedValue({
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      coreDb: { binding: 'core-a' },
      piiDb: { binding: 'pii-a' },
    });
    mocks.getProvider.mockResolvedValue({
      id: 'provider-a',
      slug: 'google',
      enabled: true,
    });
    mocks.getIdentityForProvider.mockResolvedValue(null);
    mocks.createIntent.mockResolvedValue('intent-token');
  });

  it('returns the external start with a one-use intent for this session', async () => {
    const response = await handleLinkIdentity(
      context({ body: { provider_id: 'provider-a' } }) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authorization_url:
        'https://tenant-a.example.com/auth/external/google/start?link_intent=intent-token',
    });
    expect(mocks.createIntent).toHaveBeenCalledWith(expect.anything(), 'tenant-a', {
      userId: 'user-a',
      sessionId: 's_0_session-a',
      providerId: 'provider-a',
    });
  });

  it('requires a recent authentication', async () => {
    mocks.readSession.mockResolvedValueOnce({
      ...freshSession(),
      authTime: Math.floor(Date.now() / 1000) - 301,
    });

    const response = await handleLinkIdentity(
      context({ body: { provider_id: 'provider-a' } }) as never
    );

    expect(response.status).toBe(403);
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it('refuses a provider already linked to the account', async () => {
    mocks.getIdentityForProvider.mockResolvedValueOnce({ id: 'link-a' });

    const response = await handleLinkIdentity(
      context({ body: { provider_id: 'provider-a' } }) as never
    );

    expect(response.status).toBe(409);
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it('refuses unknown or disabled providers and malformed bodies', async () => {
    mocks.getProvider.mockResolvedValueOnce({ id: 'provider-a', enabled: false });
    const disabled = await handleLinkIdentity(
      context({ body: { provider_id: 'provider-a' } }) as never
    );
    expect(disabled.status).toBe(400);

    const malformed = await handleLinkIdentity(context({ body: { provider_id: 7 } }) as never);
    expect(malformed.status).toBe(400);
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });
});
