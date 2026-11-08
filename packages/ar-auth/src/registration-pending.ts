/**
 * An unfinished sign-up's account, once proven (its code verified, its passkey registered): the
 * clean-up's mark is removed (lite plan PR6b; ar-lib-core account-registration-pending). It is
 * awaited where the sign-up completes, in the account's own core store. A clear that fails is
 * logged and the sign-in goes on: the clean-up checks again that an account is unfinished before
 * it deletes one.
 */
import {
  clearAccountRegistrationPending,
  createLogger,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

const log = createLogger().module('REGISTRATION-PENDING');

export async function settleRegistrationPending(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  try {
    await clearAccountRegistrationPending(adapter, tenantId, userId);
  } catch (error) {
    log.error(
      'Failed to clear an unfinished sign-up mark',
      { action: 'registration_pending_clear' },
      error instanceof Error ? error : undefined
    );
  }
}
