/**
 * Unfinished sign-ups (account-registration-pending.ts): the tenant's lifetime of a mark (KV, env,
 * then 72 h; a stored value out of range refuses), a mark's shape, and its clear.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import type { Env } from '../../types/env';
import {
  clearAccountRegistrationPending,
  isValidAccountRegistrationPendingMark,
  newAccountRegistrationPendingMark,
  resolveAccountRegistrationPendingTtlHours,
} from '../account-registration-pending';

function envWith(kv: Record<string, string> = {}, vars: Record<string, string> = {}): Env {
  return {
    ...vars,
    SETTINGS: {
      get: vi.fn(async (key: string) => kv[key] ?? null),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
      getWithMetadata: vi.fn(async (key: string) => ({ value: kv[key] ?? null, metadata: null })),
    },
  } as unknown as Env;
}

describe('unfinished sign-up marks', () => {
  it('lasts 72 hours by default, or what the env says', async () => {
    await expect(resolveAccountRegistrationPendingTtlHours(envWith(), 't1')).resolves.toBe(72);
    await expect(
      resolveAccountRegistrationPendingTtlHours(
        envWith({}, { ACCOUNT_REGISTRATION_PENDING_TTL_HOURS: '24' }),
        't1'
      )
    ).resolves.toBe(24);
    // An env value not a whole number of hours within range is not taken.
    for (const value of ['1.5', '72junk', '0', '721', '']) {
      await expect(
        resolveAccountRegistrationPendingTtlHours(
          envWith({}, { ACCOUNT_REGISTRATION_PENDING_TTL_HOURS: value }),
          't1'
        )
      ).resolves.toBe(72);
    }
    const mark = await newAccountRegistrationPendingMark(envWith(), 't1', 'passkey', 1_000);
    expect(mark).toEqual({ flow: 'passkey', createdAt: 1_000, expiresAt: 1_000 + 72 * 3600 });
  });

  it('takes only marks of the sign-ups that make an account before it is proven', () => {
    expect(
      isValidAccountRegistrationPendingMark({ flow: 'email_code', createdAt: 1, expiresAt: 2 })
    ).toBe(true);
    for (const bad of [
      { flow: 'totp', createdAt: 1, expiresAt: 2 },
      { flow: 'passkey', createdAt: 3, expiresAt: 2 },
      { flow: 'passkey', createdAt: -1, expiresAt: 2 },
      { flow: 'passkey', createdAt: 1.5, expiresAt: 2 },
      { flow: 'passkey', createdAt: 1, expiresAt: 2, extra: true },
      null,
    ]) {
      expect(isValidAccountRegistrationPendingMark(bad)).toBe(false);
    }
  });

  it('clears the mark of one account', async () => {
    const execute = vi.fn(async () => ({ success: true, rowsAffected: 1 }));
    await clearAccountRegistrationPending(
      { execute } as unknown as DatabaseAdapter,
      't1',
      'user-1'
    );
    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM account_registration_pending WHERE tenant_id = ? AND user_id = ?',
      ['t1', 'user-1']
    );
  });
});
