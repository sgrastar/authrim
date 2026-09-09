import type { GuestAuthConfig } from '../types/contracts/client';
import { GUEST_LIFECYCLE_SCOPE } from './guest-lifecycle';

export function createDefaultGuestClientPolicy(): GuestAuthConfig {
  return {
    enabled: false,
    expiresInDays: null,
    allowedScopes: ['openid', GUEST_LIFECYCLE_SCOPE],
    preserveSubOnUpgrade: true,
    deviceStability: 'installation',
    allowPromptNone: false,
    allowedUpgradeMethods: ['email', 'passkey'],
  };
}

/** Validate administrator input; do not coerce booleans or silently widen missing scopes. */
export function isValidGuestClientPolicy(value: unknown): value is GuestAuthConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  const keys = new Set([
    'enabled',
    'expiresInDays',
    'allowedScopes',
    'preserveSubOnUpgrade',
    'deviceStability',
    'allowPromptNone',
    'allowedUpgradeMethods',
  ]);
  if (Object.keys(policy).some((key) => !keys.has(key))) return false;
  return (
    typeof policy.enabled === 'boolean' &&
    policy.preserveSubOnUpgrade === true &&
    typeof policy.allowPromptNone === 'boolean' &&
    ['session', 'installation', 'device'].includes(String(policy.deviceStability)) &&
    (policy.expiresInDays === undefined ||
      policy.expiresInDays === null ||
      (Number.isSafeInteger(policy.expiresInDays) &&
        Number(policy.expiresInDays) >= 1 &&
        Number(policy.expiresInDays) <= 3650)) &&
    Array.isArray(policy.allowedScopes) &&
    policy.allowedScopes.length <= 100 &&
    policy.allowedScopes.includes('openid') &&
    new Set(policy.allowedScopes).size === policy.allowedScopes.length &&
    policy.allowedScopes.every(
      (scope) => typeof scope === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope)
    ) &&
    Array.isArray(policy.allowedUpgradeMethods) &&
    policy.allowedUpgradeMethods.length <= 2 &&
    new Set(policy.allowedUpgradeMethods).size === policy.allowedUpgradeMethods.length &&
    policy.allowedUpgradeMethods.every((method) => method === 'email' || method === 'passkey')
  );
}

/** Applies on every authorization/token grant, including an already established guest session. */
export function areGuestScopesAllowed(policy: GuestAuthConfig | undefined, scope: string): boolean {
  if (policy?.enabled !== true || !Array.isArray(policy.allowedScopes)) return false;
  const requested = scope.split(' ').filter(Boolean);
  return requested.every((value) => policy.allowedScopes.includes(value));
}
