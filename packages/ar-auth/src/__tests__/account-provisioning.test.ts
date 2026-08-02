import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env, StoreChallengeRequest } from '@authrim/ar-lib-core';
import {
  accountProvisioningStatusHandler,
  publishTenantD1PasskeyRoute,
  provisionTenantD1AnonymousAccount,
  provisionTenantD1EmailAccount,
  removeTenantD1AnonymousDeviceRoute,
} from '../account-provisioning';

const TENANT_ID = 'tenant-a';
const OPERATION_ID = 'account-create-11111111-1111-4111-8111-111111111111';

function context(options: {
  provision?: ReturnType<typeof vi.fn>;
  publishPasskey?: ReturnType<typeof vi.fn>;
  removeAnonymous?: ReturnType<typeof vi.fn>;
  status?: ReturnType<typeof vi.fn>;
  store?: ReturnType<typeof vi.fn>;
  getChallenge?: ReturnType<typeof vi.fn>;
  body?: unknown;
  tenantId?: string;
  tenantD1?: boolean;
}) {
  const challenge = {
    storeChallengeRpc: options.store ?? vi.fn().mockResolvedValue({ success: true }),
    getChallengeRpc: options.getChallenge ?? vi.fn().mockResolvedValue(null),
  };
  const env = {
    ACCOUNT_PROVISIONER: {
      provisionAuthAccount:
        options.provision ??
        vi.fn().mockResolvedValue({
          status: 202,
          operationId: OPERATION_ID,
          accountId: 'account:user-a',
          userId: 'user-a',
        }),
      getAuthAccountProvisioningStatus:
        options.status ??
        vi.fn().mockResolvedValue({
          status: 'pending',
          operationId: OPERATION_ID,
          accountId: 'account:user-a',
          userId: 'user-a',
        }),
      publishAuthPasskeyRoute:
        options.publishPasskey ??
        vi.fn().mockResolvedValue({
          status: 201,
          operationId: 'passkey-route-passkey-a',
          accountId: 'account:user-a',
        }),
      removeAuthAnonymousDeviceRoute:
        options.removeAnonymous ??
        vi.fn().mockResolvedValue({
          status: 201,
          operationId: 'anonymous-route-remove-device-a',
          accountId: 'account:user-a',
        }),
    },
    CHALLENGE_STORE: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => challenge),
    },
  } as unknown as Env;
  const c = {
    env,
    req: { json: vi.fn().mockResolvedValue(options.body ?? {}) },
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return options.tenantId ?? TENANT_ID;
      if (key === 'tenantMetadataContext' && options.tenantD1) {
        return { storageProfileId: 'builtin:storage:tenant-d1' };
      }
      if (key === 'accountDataContext' && options.tenantD1) {
        return {
          tenantId: options.tenantId ?? TENANT_ID,
          accountId: 'account:user-a',
          legacyUserId: 'user-a',
        };
      }
      return undefined;
    }),
    set: vi.fn(),
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status: status as number })),
  } as unknown as Context<{ Bindings: Env }>;
  return { c, env, challenge };
}

function provisioningInput() {
  return {
    tenantId: TENANT_ID,
    candidateUserId: 'user-a',
    flow: 'email_code' as const,
    email: 'person@example.com',
    runtimeUser: {
      active: true,
      emailVerified: false,
      userType: 'end_user',
      displayName: 'Person',
      sourceRef: 'auth:email_code',
      piiFields: { email: true, name: true },
      sensitiveValues: { email: 'person@example.com', name: 'Person' },
    },
  };
}

describe('tenant-D1 account provisioning resume boundary', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns a ready account without creating a resume challenge for synchronous publication', async () => {
    const provision = vi.fn().mockResolvedValue({
      status: 201,
      operationId: OPERATION_ID,
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    const { c, challenge } = context({ provision });

    await expect(provisionTenantD1EmailAccount(c, provisioningInput())).resolves.toEqual({
      status: 'ready',
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    expect(challenge.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('reconciles one internal RPC response loss with the same idempotent request', async () => {
    const provision = vi
      .fn()
      .mockRejectedValueOnce(new Error('auth_account_provisioning_internal_error'))
      .mockResolvedValueOnce({
        status: 201,
        operationId: OPERATION_ID,
        accountId: 'account:user-a',
        userId: 'user-a',
      });
    const { c } = context({ provision });

    await expect(provisionTenantD1EmailAccount(c, provisioningInput())).resolves.toMatchObject({
      status: 'ready',
      accountId: 'account:user-a',
    });
    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision.mock.calls[1][0]).toEqual(provision.mock.calls[0][0]);
  });

  it('does not retry non-reconcilable provisioning errors', async () => {
    const provision = vi
      .fn()
      .mockRejectedValue(new Error('auth_account_provisioning_input_invalid'));
    const { c } = context({ provision });

    await expect(provisionTenantD1EmailAccount(c, provisioningInput())).rejects.toThrow(
      'auth_account_provisioning_input_invalid'
    );
    expect(provision).toHaveBeenCalledOnce();
  });

  it('stores only opaque routing metadata and exposes only a random resume token on 202', async () => {
    const store = vi.fn().mockResolvedValue({ success: true });
    const { c } = context({ store });

    const result = await provisionTenantD1EmailAccount(c, provisioningInput());
    expect(result.status).toBe('pending');
    if (result.status !== 'pending') throw new Error('expected pending result');
    const body = (await result.response.json()) as Record<string, unknown>;
    expect(result.response.status).toBe(202);
    expect(body).toMatchObject({
      status: 'provisioning',
      status_endpoint: '/api/v1/auth/account-provisioning/status',
      retry_after_ms: 500,
    });
    expect(body.provisioning_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(body)).not.toContain('person@example.com');
    expect(JSON.stringify(body)).not.toContain(OPERATION_ID);

    const stored = store.mock.calls[0][0] as StoreChallengeRequest;
    expect(stored).toMatchObject({
      tenantId: TENANT_ID,
      type: 'account_provisioning_resume',
      userId: 'user-a',
      ttl: 300,
      metadata: {
        schema_version: 1,
        operation_id: OPERATION_ID,
        flow: 'email_code',
        account_id: 'account:user-a',
        user_id: 'user-a',
      },
    });
    expect(stored.challenge).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.id).toBe(`account_provisioning:${stored.challenge}`);
    expect(JSON.stringify(stored)).not.toContain('person@example.com');
    expect(JSON.stringify(stored)).not.toContain('Person');
  });

  it('derives a stable idempotency key while keeping candidate operation IDs unique', async () => {
    const provision = vi.fn().mockResolvedValue({
      status: 201,
      operationId: OPERATION_ID,
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    const { c } = context({ provision });
    await provisionTenantD1EmailAccount(c, provisioningInput());
    await provisionTenantD1EmailAccount(c, provisioningInput());

    expect(provision.mock.calls[0][0].idempotencyKey).toBe(
      provision.mock.calls[1][0].idempotencyKey
    );
    expect(provision.mock.calls[0][0].operationId).not.toBe(provision.mock.calls[1][0].operationId);
  });

  it('provisions anonymous devices with only HMAC authority and stable routing identity', async () => {
    const provision = vi.fn().mockResolvedValue({
      status: 201,
      operationId: OPERATION_ID,
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    const { c } = context({ provision });
    const device = {
      deviceIdHash: 'd'.repeat(64),
      installationIdHash: null,
      fingerprintHash: null,
      platform: 'web' as const,
      stability: 'installation' as const,
      expiresInDays: 30,
    };

    await provisionTenantD1AnonymousAccount(c, {
      tenantId: TENANT_ID,
      candidateUserId: 'candidate-a',
      device,
    });
    await provisionTenantD1AnonymousAccount(c, {
      tenantId: TENANT_ID,
      candidateUserId: 'candidate-b',
      device,
    });

    expect(provision.mock.calls[0][0]).toMatchObject({
      flow: 'anonymous',
      email: null,
      externalSubject: {
        issuer: 'urn:authrim:anonymous-device:v1',
        subject: device.deviceIdHash,
      },
      anonymousDevice: {
        id: `anonymous-device-${device.deviceIdHash.slice(0, 32)}`,
        ...device,
      },
      runtimeUser: {
        active: true,
        userType: 'anonymous',
        sourceRef: 'auth:anonymous',
        piiFields: {},
        sensitiveValues: {},
      },
    });
    expect(provision.mock.calls[0][0].idempotencyKey).toBe(
      provision.mock.calls[1][0].idempotencyKey
    );
    expect(provision.mock.calls[0][0].idempotencyKey).not.toContain(device.deviceIdHash);
  });

  it('publishes a stable tenant-D1 passkey route without exposing credential data in the key', async () => {
    const publishPasskey = vi.fn().mockResolvedValue({
      status: 202,
      operationId: 'passkey-route-passkey-a',
      accountId: 'account:user-a',
    });
    const { c } = context({ publishPasskey, tenantD1: true });

    await expect(
      publishTenantD1PasskeyRoute(c, {
        tenantId: TENANT_ID,
        userId: 'user-a',
        passkeyId: 'passkey-a',
        credentialId: 'credential_A-1',
        rpId: 'login.example.com',
      })
    ).resolves.toBe(202);
    expect(publishPasskey).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'passkey-route-passkey-a',
        idempotencyKey: expect.stringMatching(/^auth-passkey-route:[a-f0-9]{64}$/u),
        accountId: 'account:user-a',
        credentialId: 'credential_A-1',
      })
    );
    expect(publishPasskey.mock.calls[0][0].idempotencyKey).not.toContain('credential_A-1');
  });

  it('removes an anonymous route through the narrow destination-verified RPC', async () => {
    const removeAnonymous = vi.fn().mockResolvedValue({
      status: 202,
      operationId: 'anonymous-route-remove-device-a',
      accountId: 'account:user-a',
    });
    const { c } = context({ removeAnonymous, tenantD1: true });

    await expect(
      removeTenantD1AnonymousDeviceRoute(c, {
        tenantId: TENANT_ID,
        userId: 'user-a',
        deviceId: 'device-a',
        deviceIdHash: 'd'.repeat(64),
      })
    ).resolves.toBe(202);
    expect(removeAnonymous).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'anonymous-route-remove-device-a',
        idempotencyKey: expect.stringMatching(/^auth-anonymous-route-remove:[a-f0-9]{64}$/u),
        accountId: 'account:user-a',
        deviceIdHash: 'd'.repeat(64),
      })
    );
    expect(removeAnonymous.mock.calls[0][0].idempotencyKey).not.toContain('d'.repeat(64));
  });

  it('polls a valid tenant-bound challenge without returning account identifiers', async () => {
    const token = 'A'.repeat(43);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const status = vi.fn().mockResolvedValue({
      status: 'ready',
      operationId: OPERATION_ID,
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    const { c } = context({
      body: { provisioning_token: token },
      status,
      getChallenge: vi.fn().mockResolvedValue({
        id: `account_provisioning:${tokenHash}`,
        tenantId: TENANT_ID,
        type: 'account_provisioning_resume',
        userId: 'user-a',
        challenge: tokenHash,
        metadata: {
          schema_version: 1,
          operation_id: OPERATION_ID,
          flow: 'email_code',
          account_id: 'account:user-a',
          user_id: 'user-a',
        },
        consumed: false,
      }),
    });

    const response = await accountProvisioningStatusHandler(c);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
    expect(status).toHaveBeenCalledWith({
      schemaVersion: 1,
      tenantId: TENANT_ID,
      operationId: OPERATION_ID,
      flow: 'email_code',
    });
  });

  it('fails closed for malformed, cross-tenant, or mismatched operation state', async () => {
    const malformed = context({ body: { provisioning_token: 'short' } });
    expect((await accountProvisioningStatusHandler(malformed.c)).status).toBe(400);
    expect(
      malformed.env.ACCOUNT_PROVISIONER?.getAuthAccountProvisioningStatus
    ).not.toHaveBeenCalled();

    const token = 'B'.repeat(43);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const mismatched = context({
      body: { provisioning_token: token },
      getChallenge: vi.fn().mockResolvedValue({
        tenantId: TENANT_ID,
        type: 'account_provisioning_resume',
        userId: 'user-a',
        challenge: tokenHash,
        metadata: {
          schema_version: 1,
          operation_id: OPERATION_ID,
          flow: 'email_code',
          account_id: 'account:user-a',
          user_id: 'user-a',
        },
        consumed: false,
      }),
      status: vi.fn().mockResolvedValue({
        status: 'ready',
        operationId: OPERATION_ID,
        accountId: 'account:other-user',
        userId: 'other-user',
      }),
    });
    expect((await accountProvisioningStatusHandler(mismatched.c)).status).toBe(500);

    const mismatchedResumeIdentity = context({
      body: { provisioning_token: token },
      getChallenge: vi.fn().mockResolvedValue({
        tenantId: TENANT_ID,
        type: 'account_provisioning_resume',
        userId: 'user-a',
        challenge: tokenHash,
        metadata: {
          schema_version: 1,
          operation_id: OPERATION_ID,
          flow: 'email_code',
          account_id: 'account:other-user',
          user_id: 'user-a',
        },
        consumed: false,
      }),
    });
    expect((await accountProvisioningStatusHandler(mismatchedResumeIdentity.c)).status).toBe(400);
    expect(
      mismatchedResumeIdentity.env.ACCOUNT_PROVISIONER?.getAuthAccountProvisioningStatus
    ).not.toHaveBeenCalled();

    const crossTenant = context({
      tenantId: 'tenant-b',
      body: { provisioning_token: token },
      getChallenge: vi.fn().mockResolvedValue({
        tenantId: TENANT_ID,
        type: 'account_provisioning_resume',
        userId: 'user-a',
        challenge: tokenHash,
        metadata: {},
        consumed: false,
      }),
    });
    expect((await accountProvisioningStatusHandler(crossTenant.c)).status).toBe(400);
  });
});
