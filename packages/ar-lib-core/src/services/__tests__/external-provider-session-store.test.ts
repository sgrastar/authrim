import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listExternalProviderSessions,
  registerExternalProviderSession,
} from '../external-provider-session-store';

describe('external-provider-session-store', () => {
  const registerExternalProviderSessionRpc = vi.fn();
  const listExternalProviderSessionsRpc = vi.fn();
  const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId);
  const get = vi.fn(() => ({
    registerExternalProviderSessionRpc,
    listExternalProviderSessionsRpc,
  }));
  const env = {
    SESSION_REVOCATION_STORE: { idFromName, get },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    registerExternalProviderSessionRpc.mockResolvedValue(undefined);
    listExternalProviderSessionsRpc.mockResolvedValue([]);
  });

  it('never places the raw provider subject or sid in a Durable Object name or RPC identity', async () => {
    await registerExternalProviderSession(env, {
      tenantId: 'tenant-a',
      providerId: 'provider-a',
      providerSub: 'raw-provider-subject',
      providerSid: 'raw-provider-session-id',
      sessionId: 'session-1',
      userId: 'user-a',
      expiresAtMs: 3_000,
    });

    expect(idFromName).toHaveBeenCalledTimes(2);
    for (const [name] of idFromName.mock.calls) {
      expect(name).not.toContain('raw-provider-subject');
      expect(name).not.toContain('raw-provider-session-id');
      expect(name).toMatch(/:[a-f0-9]{64}$/u);
    }
    for (const call of registerExternalProviderSessionRpc.mock.calls) {
      expect(call[3]).toMatch(/^[a-f0-9]{64}$/u);
      expect(call.join(':')).not.toContain('raw-provider-subject');
      expect(call.join(':')).not.toContain('raw-provider-session-id');
    }
  });

  it('uses the same digest identity for registration and lookup', async () => {
    await registerExternalProviderSession(env, {
      tenantId: 'tenant-a',
      providerId: 'provider-a',
      providerSub: 'provider-subject',
      sessionId: 'session-1',
      userId: 'user-a',
      expiresAtMs: 3_000,
    });
    const registeredDigest = registerExternalProviderSessionRpc.mock.calls[0]?.[3];

    await listExternalProviderSessions(env, {
      tenantId: 'tenant-a',
      providerId: 'provider-a',
      claimKind: 'sub',
      claim: 'provider-subject',
      nowMs: 1_000,
    });

    expect(listExternalProviderSessionsRpc).toHaveBeenCalledWith(
      'tenant-a',
      'provider-a',
      'sub',
      registeredDigest,
      1_000
    );
  });

  it('fails with a typed error when the DO namespace is unavailable', async () => {
    await expect(
      listExternalProviderSessions({} as never, {
        tenantId: 'tenant-a',
        providerId: 'provider-a',
        claimKind: 'sub',
        claim: 'provider-subject',
      })
    ).rejects.toThrow('external_provider_session_store_unavailable');
  });
});
