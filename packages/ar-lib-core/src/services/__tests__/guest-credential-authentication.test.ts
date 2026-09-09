import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  assertGuestCredentialAuthenticationAllowed,
  assertGuestSessionAuthenticationAllowed,
} from '../guest-credential-authentication';
describe('guest credential authentication fence', () => {
  it.each(['active', 'upgrading', 'deleting', 'deleted'])(
    'rejects credentials for a %s guest',
    async (phase) => {
      const queryOne = vi.fn(async () => ({ phase }));
      await expect(
        assertGuestCredentialAuthenticationAllowed(
          { queryOne } as unknown as DatabaseAdapter,
          'tenant',
          'user'
        )
      ).rejects.toThrow('account_authentication_not_allowed');
      expect(queryOne).toHaveBeenCalledWith(expect.any(String), ['tenant', 'user'], {
        consistencyClass: 'primary_required',
      });
    }
  );
  it.each([null, { phase: 'registered' }])(
    'allows committed and non-guest accounts (%j)',
    async (row) => {
      await expect(
        assertGuestCredentialAuthenticationAllowed(
          { queryOne: vi.fn(async () => row) } as unknown as DatabaseAdapter,
          'tenant',
          'user'
        )
      ).resolves.toBeUndefined();
    }
  );
  it('does not treat a failed database read as absence of a guest fence', async () => {
    await expect(
      assertGuestCredentialAuthenticationAllowed(
        {
          queryOne: vi.fn(async () => {
            throw new Error('unavailable');
          }),
        } as unknown as DatabaseAdapter,
        'tenant',
        'user'
      )
    ).rejects.toThrow('unavailable');
  });
});

describe('guest session authentication fence', () => {
  it.each(['active', 'upgrading', 'registered', null])(
    'permits %s before deletion admission',
    async (phase) => {
      await expect(
        assertGuestSessionAuthenticationAllowed(
          { queryOne: vi.fn(async () => (phase ? { phase } : null)) } as unknown as DatabaseAdapter,
          'tenant',
          'user'
        )
      ).resolves.toBeUndefined();
    }
  );
  it.each(['deleting', 'deleted'])('denies %s sessions and grants', async (phase) => {
    await expect(
      assertGuestSessionAuthenticationAllowed(
        { queryOne: vi.fn(async () => ({ phase })) } as unknown as DatabaseAdapter,
        'tenant',
        'user'
      )
    ).rejects.toThrow('account_authentication_not_allowed');
  });
});
