/**
 * Explicit linking in handleIdentity: the directory route of the external subject decides whose
 * it is before anything is written, so an external account that signs in to another Authrim
 * account (whose data may live in another shard) is never attached a second time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  ExternalIdPError,
  ExternalIdPErrorCode,
  type TokenResponse,
  type UpstreamProvider,
  type UserInfo,
} from '../types';

const mocks = vi.hoisted(() => ({
  resolveAccountDataContext: vi.fn(),
  resolveByIdentifier: vi.fn(),
  findLinkedIdentity: vi.fn(),
  createLinkedIdentity: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantUserStoreSourcesFromEnv: vi.fn(async () => ({
      coreDb: { name: 'default-core' },
      piiDb: { name: 'default-pii' },
    })),
    resolveAccountDataContext: mocks.resolveAccountDataContext,
    resolveAccountDataContextByIdentifier: mocks.resolveByIdentifier,
    createAuditLog: mocks.createAuditLog,
  };
});

vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentity: mocks.findLinkedIdentity,
  createLinkedIdentity: mocks.createLinkedIdentity,
  updateLinkedIdentity: vi.fn(),
  activatePendingLinkedIdentity: vi.fn(),
  findPendingLinkedIdentityProvisioning: vi.fn(),
}));

import { handleIdentity } from '../services/identity-stitching';

const provider: UpstreamProvider = {
  id: 'provider-a',
  tenantId: 'default',
  name: 'Corp IdP',
  providerType: 'oidc',
  enabled: true,
  priority: 0,
  clientId: 'upstream-client',
  clientSecretEncrypted: 'encrypted-secret',
  scopes: 'openid email',
  attributeMapping: {},
  autoLinkEmail: false,
  jitProvisioning: false,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

const userInfo: UserInfo = {
  sub: 'external-subject-a',
  email: 'person@example.com',
  email_verified: true,
};

const tokens: TokenResponse = { access_token: 'upstream-access', token_type: 'Bearer' };

function accountContext(userId: string, shard: string) {
  return {
    tenantId: 'default',
    accountId: `account:${userId}`,
    legacyUserId: userId,
    coreDb: { name: `${shard}-core` },
    piiDb: { name: `${shard}-pii` },
  };
}

const ownContext = accountContext('user-a', 'shard-1');

function makeEnv() {
  const publishExternalIdpRoute = vi.fn(
    async (request: { operationId: string; accountId: string }) => ({
      status: 201,
      operationId: request.operationId,
      accountId: request.accountId,
    })
  );
  const env = {
    ISSUER_URL: 'https://auth.example.com',
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: { publishExternalIdpRoute },
  } as unknown as Env;
  return { env, publishExternalIdpRoute };
}

function link(env: Env) {
  return handleIdentity(env, {
    provider,
    userInfo,
    tokens,
    tenantId: 'default',
    linkingUserId: 'user-a',
  });
}

describe('handleIdentity: explicit linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccountDataContext.mockResolvedValue(ownContext);
    mocks.resolveByIdentifier.mockRejectedValue(new Error('account_data_route_not_found'));
    mocks.findLinkedIdentity.mockResolvedValue(null);
    mocks.createLinkedIdentity.mockResolvedValue('linked-identity-new');
    mocks.createAuditLog.mockResolvedValue(undefined);
  });

  it('refuses an external subject routed to another account, writing nothing', async () => {
    mocks.resolveByIdentifier.mockResolvedValue(accountContext('user-b', 'shard-2'));
    const { env, publishExternalIdpRoute } = makeEnv();

    const error = await link(env).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExternalIdPError);
    expect((error as ExternalIdPError).code).toBe(ExternalIdPErrorCode.ACCOUNT_ALREADY_LINKED);
    expect(mocks.resolveByIdentifier).toHaveBeenCalledWith(env, {
      tenantId: 'default',
      indexKind: 'external_subject',
      identifier: { issuer: 'provider-a', subject: 'external-subject-a' },
    });
    expect(mocks.createLinkedIdentity).not.toHaveBeenCalled();
    expect(publishExternalIdpRoute).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses when this account's store already links the subject to another user", async () => {
    mocks.findLinkedIdentity.mockResolvedValue({
      id: 'linked-identity-b',
      userId: 'user-b',
      tenantId: 'default',
    });
    const { env, publishExternalIdpRoute } = makeEnv();

    await expect(link(env)).rejects.toMatchObject({
      code: ExternalIdPErrorCode.ACCOUNT_ALREADY_LINKED,
    });
    expect(mocks.createLinkedIdentity).not.toHaveBeenCalled();
    expect(publishExternalIdpRoute).not.toHaveBeenCalled();
  });

  it('creates the link in the account shard and publishes the route when nobody owns it', async () => {
    const { env, publishExternalIdpRoute } = makeEnv();

    const result = await link(env);

    expect(result).toEqual({
      status: 'ready',
      userId: 'user-a',
      isNewUser: false,
      linkedIdentityId: 'linked-identity-new',
      stitchedFromExisting: false,
    });
    expect(mocks.findLinkedIdentity).toHaveBeenCalledWith(
      env,
      'default',
      'provider-a',
      'external-subject-a',
      ownContext.piiDb
    );
    expect(mocks.createLinkedIdentity).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        userId: 'user-a',
        providerId: 'provider-a',
        providerUserId: 'external-subject-a',
      }),
      ownContext.piiDb
    );
    expect(publishExternalIdpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'default',
        accountId: 'account:user-a',
        userId: 'user-a',
        linkedIdentityId: 'linked-identity-new',
        providerId: 'provider-a',
        providerUserId: 'external-subject-a',
      })
    );
    expect(mocks.resolveByIdentifier.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createLinkedIdentity.mock.invocationCallOrder[0]
    );
  });

  it('proceeds when the route already points at the linking account', async () => {
    mocks.resolveByIdentifier.mockResolvedValue(ownContext);
    mocks.findLinkedIdentity.mockResolvedValue({
      id: 'linked-identity-existing',
      userId: 'user-a',
      tenantId: 'default',
    });
    const { env, publishExternalIdpRoute } = makeEnv();

    const result = await link(env);

    expect(result).toMatchObject({
      status: 'ready',
      userId: 'user-a',
      linkedIdentityId: 'linked-identity-existing',
    });
    // The existing row is reused rather than duplicated.
    expect(mocks.createLinkedIdentity).not.toHaveBeenCalled();
    expect(publishExternalIdpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ linkedIdentityId: 'linked-identity-existing' })
    );
  });

  it('does not treat a directory failure as "no owner"', async () => {
    mocks.resolveByIdentifier.mockRejectedValue(new Error('directory_unavailable'));
    const { env, publishExternalIdpRoute } = makeEnv();

    await expect(link(env)).rejects.toThrow('directory_unavailable');
    expect(mocks.createLinkedIdentity).not.toHaveBeenCalled();
    expect(publishExternalIdpRoute).not.toHaveBeenCalled();
  });

  it('refuses an unverified provider email before consulting the directory', async () => {
    const { env } = makeEnv();

    await expect(
      handleIdentity(env, {
        provider,
        userInfo: { ...userInfo, email_verified: false },
        tokens,
        tenantId: 'default',
        linkingUserId: 'user-a',
      })
    ).rejects.toMatchObject({ code: ExternalIdPErrorCode.EMAIL_NOT_VERIFIED });
    expect(mocks.resolveByIdentifier).not.toHaveBeenCalled();
    expect(mocks.createLinkedIdentity).not.toHaveBeenCalled();
  });
});
