import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getChallengeStore: vi.fn(),
  completeJit: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getChallengeStoreByChallengeId: mocks.getChallengeStore,
    resolveAccountDataContextByIdentifier: vi.fn().mockResolvedValue({
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      coreDb: {},
      piiDb: {},
    }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../services/identity-stitching', () => ({
  completeExternalIdpJIT: mocks.completeJit,
  handleIdentity: vi.fn(),
}));

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mocks.getProvider,
}));

import {
  handleExternalProvisioningResume,
  handleExternalProvisioningStatus,
} from '../handlers/callback';
import { encrypt } from '../utils/crypto';

const ENCRYPTION_KEY = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const TOKEN = 'A'.repeat(43);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fixture(options: {
  status?: 'pending' | 'ready' | 'failed';
  returnedAccountId?: string;
  returnedOperationId?: string;
  includeCookie?: boolean;
  resume?: boolean;
  extraRequestField?: boolean;
}) {
  const digest = await sha256Hex(TOKEN);
  const challengeId = `external_idp_provisioning:${digest}`;
  const continuation = {
    schemaVersion: 1,
    authState: {
      id: 'auth-state-a',
      tenantId: 'tenant-a',
      clientId: 'client-a',
      providerId: 'provider-a',
      state: 'client-state-a',
      codeChallenge: 'code-challenge-a',
      redirectUri: 'https://login.example.com/callback',
      enableSso: false,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    },
    providerId: 'provider-a',
    userInfo: {
      sub: 'provider-user-a',
      email: 'person@example.com',
      email_verified: true,
    },
    result: {
      status: 'pending',
      userId: 'user-a',
      isNewUser: true,
      stitchedFromExisting: false,
      accountId: 'account:user-a',
      operationId: 'account-create-operation-a',
      providerId: 'provider-a',
      providerUserId: 'provider-user-a',
    },
  } as const;
  const consumeChallengeRpc = vi.fn().mockResolvedValue({ userId: 'user-a' });
  const storeChallengeRpc = vi.fn().mockResolvedValue(undefined);
  mocks.getChallengeStore.mockResolvedValue({
    getChallengeRpc: vi.fn().mockResolvedValue({
      id: challengeId,
      tenantId: 'tenant-a',
      type: 'external_idp_provisioning_resume',
      userId: 'user-a',
      challenge: digest,
      consumed: false,
      expiresAt: Date.now() + 60_000,
      metadata: {
        encrypted_payload: await encrypt(JSON.stringify(continuation), ENCRYPTION_KEY),
      },
    }),
    consumeChallengeRpc,
    storeChallengeRpc,
  });
  const getStatus = vi.fn().mockResolvedValue({
    status: options.status ?? 'pending',
    operationId: options.returnedOperationId ?? 'account-create-operation-a',
    accountId: options.returnedAccountId ?? 'account:user-a',
    userId: 'user-a',
  });
  const app = new Hono<{ Bindings: Env }>();
  app.post('/status', handleExternalProvisioningStatus);
  app.get('/resume', handleExternalProvisioningResume);
  const response = await app.request(
    options.resume ? `/resume?token=${TOKEN}&tenant=tenant-a` : '/status',
    {
      method: options.resume ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.includeCookie === false
          ? {}
          : { Cookie: `authrim_external_provisioning_${digest.slice(0, 24)}=${digest}` }),
      },
      ...(options.resume
        ? {}
        : {
            body: JSON.stringify({
              provisioning_token: TOKEN,
              tenant_id: 'tenant-a',
              ...(options.extraRequestField ? { unexpected: true } : {}),
            }),
          }),
    },
    {
      RP_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      ISSUER_URL: 'https://auth.example.com',
      EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
        getExternalIdpAccountProvisioningStatus: getStatus,
      },
    } as unknown as Env
  );
  return { response, getStatus, consumeChallengeRpc, storeChallengeRpc };
}

describe('external IdP durable provisioning status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completeJit.mockResolvedValue({
      linkedIdentityId: 'external-link-a',
      roles_assigned: [],
      orgs_joined: [],
    });
    mocks.getProvider.mockResolvedValue({
      id: 'provider-a',
      tenantId: 'tenant-a',
      name: 'Provider A',
      providerType: 'oidc',
      enabled: true,
      priority: 0,
      clientId: 'upstream-client-a',
      clientSecretEncrypted: 'encrypted-secret',
      scopes: 'openid',
      attributeMapping: {},
      autoLinkEmail: false,
      jitProvisioning: true,
      requireEmailVerified: true,
      providerQuirks: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  it('returns a bounded pending response for the exact browser-bound operation', async () => {
    const { response, getStatus, consumeChallengeRpc } = await fixture({ status: 'pending' });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'pending', retry_after_ms: 500 });
    expect(getStatus).toHaveBeenCalledWith({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      operationId: 'account-create-operation-a',
      flow: 'external_idp',
    });
    expect(consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('fails closed without the browser cookie or on an account mismatch', async () => {
    const withoutCookie = await fixture({ includeCookie: false });
    expect(withoutCookie.response.status).toBe(400);
    expect(withoutCookie.getStatus).not.toHaveBeenCalled();

    const mismatch = await fixture({ returnedAccountId: 'account:user-b' });
    expect(mismatch.response.status).toBe(400);
    expect(mismatch.consumeChallengeRpc).not.toHaveBeenCalled();

    const extraField = await fixture({ extraRequestField: true });
    expect(extraField.response.status).toBe(400);
    expect(extraField.getStatus).not.toHaveBeenCalled();
  });

  it('consumes a failed operation and expires its browser binding', async () => {
    const { response, consumeChallengeRpc } = await fixture({ status: 'failed' });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ status: 'failed' });
    expect(consumeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        type: 'external_idp_provisioning_resume',
      })
    );
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('does not resume when Management returns a different operation', async () => {
    const { response, consumeChallengeRpc } = await fixture({
      status: 'ready',
      returnedOperationId: 'account-create-operation-b',
      resume: true,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=callback_failed');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.completeJit).not.toHaveBeenCalled();
    expect(consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('completes JIT and consumes the continuation before issuing an auth code', async () => {
    const { response, consumeChallengeRpc, storeChallengeRpc } = await fixture({
      status: 'ready',
      resume: true,
    });

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location') ?? '');
    expect(redirect.origin + redirect.pathname).toBe('https://login.example.com/callback');
    expect(redirect.searchParams.get('code')).toBeTruthy();
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.completeJit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'user-a',
        providerId: 'provider-a',
        providerUserId: 'provider-user-a',
      })
    );
    expect(consumeChallengeRpc).toHaveBeenCalledOnce();
    expect(storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct_auth_code', userId: 'user-a' })
    );
    expect(mocks.completeJit.mock.invocationCallOrder[0]).toBeLessThan(
      consumeChallengeRpc.mock.invocationCallOrder[0]
    );
    expect(consumeChallengeRpc.mock.invocationCallOrder[0]).toBeLessThan(
      storeChallengeRpc.mock.invocationCallOrder[0]
    );
  });
});
