import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { mockReauthPolicy } = vi.hoisted(() => ({ mockReauthPolicy: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, readExternalProviderReauthPolicy: mockReauthPolicy };
});

import { provenSPReauthentication } from '../acs';

const env = {} as Env;
const requestedAt = Date.parse('2026-10-03T10:00:00Z');
const reauthentication = {
  authorizationChallengeId: 'reauth_1',
  requestedAt,
  providerId: 'idp-1',
  providerIds: ['saml:idp-1', 'idp-1'],
};

describe('provenSPReauthentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
  });

  it.each([
    ['after the request', '2026-10-03T10:00:05Z'],
    ['within the clock skew before it', '2026-10-03T09:59:00Z'],
  ])('accepts a login made %s, as proven when Authrim asked', async (_label, authnInstant) => {
    await expect(
      provenSPReauthentication(env, 'tenant-a', reauthentication, authnInstant)
    ).resolves.toBe(requestedAt);
    expect(mockReauthPolicy).toHaveBeenCalledWith(env, 'tenant-a', {
      providerId: 'idp-1',
      ids: ['saml:idp-1', 'idp-1'],
    });
  });

  it.each([
    ['made before the request (an IdP answering from its own session)', '2026-10-03T09:58:59Z'],
    ['without an AuthnInstant', undefined],
    ['with an unreadable AuthnInstant', 'not-a-time'],
  ])('refuses a login %s', async (_label, authnInstant) => {
    await expect(
      provenSPReauthentication(env, 'tenant-a', reauthentication, authnInstant)
    ).resolves.toBeNull();
  });

  it("refuses a request stored before the IdP's stable id was kept", async () => {
    const legacy = {
      authorizationChallengeId: 'reauth_1',
      requestedAt,
      providerKeys: ['saml:idp-1', 'idp-1'],
    } as unknown as typeof reauthentication;
    await expect(
      provenSPReauthentication(env, 'tenant-a', legacy, '2026-10-03T10:00:05Z')
    ).resolves.toBeNull();
    expect(mockReauthPolicy).not.toHaveBeenCalled();
  });

  it('refuses when the IdP can no longer re-authenticate or settings are unreadable', async () => {
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: false, acceptWithoutAuthTime: false });
    await expect(
      provenSPReauthentication(env, 'tenant-a', reauthentication, '2026-10-03T10:00:05Z')
    ).resolves.toBeNull();

    mockReauthPolicy.mockRejectedValue(new Error('kv unavailable'));
    await expect(
      provenSPReauthentication(env, 'tenant-a', reauthentication, '2026-10-03T10:00:05Z')
    ).resolves.toBeNull();
  });
});
