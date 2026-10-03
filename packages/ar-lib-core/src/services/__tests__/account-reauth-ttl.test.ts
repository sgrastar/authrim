import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));

vi.mock('../effective-settings', () => ({
  resolveEffectiveSettings: mockResolve,
}));

import {
  ACCOUNT_REAUTH_TTL_SECONDS,
  isAccountReauthFresh,
  resolveAccountReauthTtlSeconds,
} from '../account-session';

const env = {} as never;

describe('resolveAccountReauthTtlSeconds', () => {
  beforeEach(() => {
    mockResolve.mockReset();
  });

  it('reads the self-service setting of the tenant', async () => {
    mockResolve.mockResolvedValueOnce({ 'self-service.reauth_ttl_seconds': 120 });

    await expect(resolveAccountReauthTtlSeconds(env, 'tenant-a')).resolves.toBe(120);
    expect(mockResolve).toHaveBeenCalledWith(env, 'self-service', { tenantId: 'tenant-a' });
  });

  it.each([
    ['below the minimum', 30],
    ['above the maximum', 7200],
    ['not a whole number', 90.5],
    ['not a number', '600'],
  ])('falls back to the default for a value %s', async (_label, value) => {
    mockResolve.mockResolvedValueOnce({ 'self-service.reauth_ttl_seconds': value });

    await expect(resolveAccountReauthTtlSeconds(env, 'tenant-a')).resolves.toBe(
      ACCOUNT_REAUTH_TTL_SECONDS
    );
  });

  it('falls back to the default when the settings cannot be read', async () => {
    mockResolve.mockRejectedValueOnce(new Error('kv down'));

    await expect(resolveAccountReauthTtlSeconds(env, 'tenant-a')).resolves.toBe(300);
  });
});

describe('isAccountReauthFresh', () => {
  it('measures the window it is given', () => {
    expect(isAccountReauthFresh(1_000, 1_100, 120)).toBe(true);
    expect(isAccountReauthFresh(1_000, 1_120, 120)).toBe(false);
    expect(isAccountReauthFresh(1_000, 1_299)).toBe(true);
    expect(isAccountReauthFresh(1_000, 1_300)).toBe(false);
  });
});
