import type { DatabaseAdapter } from '../db/adapter';
import { GuestLifecycleRepository } from '../repositories/guest-lifecycle';

/** A credential staged during guest registration cannot authenticate before commit. */
export async function assertGuestCredentialAuthenticationAllowed(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  const lifecycle = await new GuestLifecycleRepository(adapter, tenantId).get(userId);
  if (lifecycle && lifecycle.phase !== 'registered')
    throw new Error('account_authentication_not_allowed');
}

/** Existing guest sessions remain usable until the deletion compare-and-set wins. */
export async function assertGuestSessionAuthenticationAllowed(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  const lifecycle = await new GuestLifecycleRepository(adapter, tenantId).get(userId);
  if (lifecycle && !['active', 'upgrading', 'registered'].includes(lifecycle.phase))
    throw new Error('account_authentication_not_allowed');
}
