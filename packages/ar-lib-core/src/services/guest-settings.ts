import type { Env } from '../types/env';
import { createSettingsManager } from '../utils/settings-manager';
import { ACCOUNT_LIFECYCLE_CATEGORY_META } from '../types/settings/account-lifecycle';
import { AUTHENTICATION_METHODS_CATEGORY_META } from '../types/settings/authentication-methods';
import { validateGuestLifecyclePolicy, type GuestLifecyclePolicy } from './guest-lifecycle';

export interface GuestSettings {
  loginEnabled: boolean;
  policy: GuestLifecyclePolicy;
  policyVersion: string;
  upgradeMethods: ('email' | 'passkey')[];
}

/** Read afresh for each start/complete request; a cached allow must not survive an operator stop. */
export async function resolveGuestSettings(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string
): Promise<GuestSettings> {
  const manager = createSettingsManager({
    env: {},
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
    strictReads: true,
  });
  manager.registerCategory(ACCOUNT_LIFECYCLE_CATEGORY_META);
  manager.registerCategory(AUTHENTICATION_METHODS_CATEGORY_META);
  const scope = { type: 'tenant' as const, id: tenantId };
  const [lifecycle, methods] = await Promise.all([
    manager.getAll('account-lifecycle', scope),
    manager.getAll('authentication-methods', scope),
  ]);
  const values = lifecycle.values;
  const days = values['account-lifecycle.guest.deletion_after_days'];
  const minutes = values['account-lifecycle.guest.upgrade_hold_minutes'];
  if (typeof days !== 'number' || typeof minutes !== 'number')
    throw new Error('invalid_guest_policy');
  // Validate even when disabled, so invalid persisted settings cannot turn into destructive defaults.
  const policy: GuestLifecyclePolicy = {
    deletionAfterDays: days,
    upgradeHoldMinutes: minutes,
    upgradeEnabled: values['account-lifecycle.guest.upgrade_enabled'] === true,
  };
  validateGuestLifecyclePolicy(policy);
  if (values['account-lifecycle.guest.deletion_enabled'] !== true) policy.deletionAfterDays = null;
  const upgradeMethods: GuestSettings['upgradeMethods'] = [];
  if (methods.values['authentication-methods.email_otp.guest_upgrade_enabled'] === true)
    upgradeMethods.push('email');
  if (methods.values['authentication-methods.passkey.guest_upgrade_enabled'] === true)
    upgradeMethods.push('passkey');
  return {
    loginEnabled: methods.values['authentication-methods.guest.login_enabled'] === true,
    policy,
    policyVersion: lifecycle.version,
    upgradeMethods,
  };
}
