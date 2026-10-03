/**
 * A sign-in answering an Authrim re-authentication proves one only when the provider shows a new
 * login made after Authrim asked for it: the validated ID token's auth_time (within the clock
 * skew), or, where the tenant accepts that for the provider, the request alone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { UpstreamProvider } from '../types';

const mocks = vi.hoisted(() => ({ reauthPolicy: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, readExternalProviderReauthPolicy: mocks.reauthPolicy };
});

import { provenUpstreamReauthentication } from '../handlers/callback';

const env = {} as Env;
const provider = { id: 'provider-a', slug: 'corp' } as UpstreamProvider;
const requestedAt = 1_700_000_000_000;
const requestedSecond = requestedAt / 1000;

function prove(input: { idTokenValidated?: boolean; idTokenAuthTime?: number }) {
  return provenUpstreamReauthentication(env, {
    tenantId: 'default',
    provider,
    requestedAt,
    idTokenValidated: input.idTokenValidated ?? true,
    ...(input.idTokenAuthTime === undefined ? {} : { idTokenAuthTime: input.idTokenAuthTime }),
  });
}

describe('provenUpstreamReauthentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
  });

  it.each([
    ['after the request', requestedSecond + 5],
    ['within the clock skew before it', requestedSecond - 60],
  ])('accepts a login made %s, as proven when Authrim asked', async (_label, authTime) => {
    // Not when the answer arrived: a re-authentication asked for after that is not completed.
    await expect(prove({ idTokenAuthTime: authTime })).resolves.toBe(requestedAt);
    expect(mocks.reauthPolicy).toHaveBeenCalledWith(env, 'default', {
      providerId: 'provider-a',
      ids: ['provider-a', 'corp'],
    });
  });

  it('refuses a login made before the request (an IdP answering from its own session)', async () => {
    await expect(prove({ idTokenAuthTime: requestedSecond - 61 })).rejects.toMatchObject({
      code: 'reauth_not_proven',
    });
  });

  it('refuses without a validated ID token', async () => {
    await expect(
      prove({ idTokenValidated: false, idTokenAuthTime: requestedSecond })
    ).rejects.toMatchObject({ code: 'reauth_not_proven' });
  });

  it('refuses a login the provider did not date unless the tenant accepts that', async () => {
    await expect(prove({})).rejects.toMatchObject({ code: 'reauth_not_proven' });

    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: true });
    await expect(prove({})).resolves.toBe(requestedAt);
  });

  it('refuses when the provider can no longer re-authenticate or settings are unreadable', async () => {
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: false, acceptWithoutAuthTime: true });
    await expect(prove({ idTokenAuthTime: requestedSecond })).rejects.toMatchObject({
      code: 'reauth_not_proven',
    });

    mocks.reauthPolicy.mockRejectedValue(new Error('kv unavailable'));
    await expect(prove({ idTokenAuthTime: requestedSecond })).rejects.toMatchObject({
      code: 'reauth_not_proven',
    });
  });
});
