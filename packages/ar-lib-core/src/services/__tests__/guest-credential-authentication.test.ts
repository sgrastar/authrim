import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { GuestLifecycleRow } from '../../repositories/guest-lifecycle';
import {
  assertGuestCredentialAuthenticationAllowed,
  assertGuestSessionAuthenticationAllowed,
} from '../guest-credential-authentication';

/** Query doubles return the same complete storage row as GuestLifecycleRepository.get. */
function lifecycleRow(phase: GuestLifecycleRow['phase']): GuestLifecycleRow {
  return {
    tenant_id: 'tenant',
    user_id: 'user',
    client_id: 'client',
    phase,
    created_at: 1,
    deletion_due_at: null,
    policy_version: 'policy:1',
    retention_application_id: null,
    upgrade_hold_until: null,
    upgrade_operation_id: null,
    upgrade_admission_floor: 0,
    upgraded_at: null,
    upgrade_finalized_at: null,
    deletion_operation_id: null,
    deletion_route_json: null,
    deletion_started_at_ms: null,
    deleted_at: null,
    revision: 1,
    updated_at: 1,
  };
}

describe('guest credential authentication fence', () => {
  it.each(['active', 'upgrading', 'deleting', 'deleted'] as const)(
    'rejects credentials for a %s guest',
    async (phase) => {
      const queryOne = vi.fn(async () => lifecycleRow(phase));
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
  it.each([null, 'registered'] as const)(
    'allows committed and non-guest accounts (%j)',
    async (phase) => {
      await expect(
        assertGuestCredentialAuthenticationAllowed(
          {
            queryOne: vi.fn(async () => (phase ? lifecycleRow(phase) : null)),
          } as unknown as DatabaseAdapter,
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
  it.each(['active', 'upgrading', 'registered', null] as const)(
    'permits %s before deletion admission',
    async (phase) => {
      await expect(
        assertGuestSessionAuthenticationAllowed(
          {
            queryOne: vi.fn(async () => (phase ? lifecycleRow(phase) : null)),
          } as unknown as DatabaseAdapter,
          'tenant',
          'user'
        )
      ).resolves.toBeUndefined();
    }
  );
  it.each(['deleting', 'deleted'] as const)('denies %s sessions and grants', async (phase) => {
    await expect(
      assertGuestSessionAuthenticationAllowed(
        { queryOne: vi.fn(async () => lifecycleRow(phase)) } as unknown as DatabaseAdapter,
        'tenant',
        'user'
      )
    ).rejects.toThrow('account_authentication_not_allowed');
  });
});
