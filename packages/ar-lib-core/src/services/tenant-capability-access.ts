/**
 * Who may manage something a capability covers (category `tenant-capabilities`), for the Admin
 * API: the one decision every Admin API surface shares (ar-management's route gate and handlers,
 * the SAML admin routes).
 *
 * - a caller with global platform authority (`hasGlobalPlatformAuthority(ctx, 'admin:*')`) is
 *   exempt: it may manage whatever the capability covers;
 * - while the capability is off, everyone else is refused: 403 `capability_disabled`;
 * - when the switch cannot be read, everyone else is refused: 503 `temporarily_unavailable`
 *   (never treated as on).
 *
 * This is about managing. Whether anything RUNS for a tenant is decided by the runtime entry
 * points.
 */

import { hasGlobalPlatformAuthority } from '../middleware/admin-auth';
import type { AdminAuthContext } from '../types/admin';
import type { TenantCapability } from '../types/settings/tenant-capabilities';
import type { EffectiveSettingsEnv } from './effective-settings';
import { getTenantCapabilityState, type TenantCapabilityState } from './tenant-capabilities';

export interface TenantCapabilityRefusal {
  status: 403 | 503;
  body: {
    error: 'capability_disabled' | 'temporarily_unavailable';
    error_description: string;
    capability: TenantCapability;
  };
}

export function tenantCapabilityDisabledRefusal(
  capability: TenantCapability
): TenantCapabilityRefusal {
  return {
    status: 403,
    body: {
      error: 'capability_disabled',
      error_description: 'This capability has been turned off for tenants by the platform.',
      capability,
    },
  };
}

export function tenantCapabilityUnavailableRefusal(
  capability: TenantCapability
): TenantCapabilityRefusal {
  return {
    status: 503,
    body: {
      error: 'temporarily_unavailable',
      error_description:
        'Whether this capability is available could not be determined. Retry later.',
      capability,
    },
  };
}

/**
 * The pure decision: 'allow', or how to refuse. `permitted` is whether the caller passed the
 * permission checks; an unreadable switch only refuses a caller who would otherwise be allowed
 * (the others get their own refusal).
 */
export function decideTenantCapabilityAccess(input: {
  state: TenantCapabilityState;
  globalPlatformAuthority: boolean;
  permitted?: boolean;
}): 'allow' | 'disabled' | 'unavailable' {
  if (input.globalPlatformAuthority) return 'allow';
  if (input.state === 'off') return 'disabled';
  if (input.state === 'unknown' && input.permitted !== false) return 'unavailable';
  return 'allow';
}

/** Null when the caller may manage the capability now, else how to refuse. */
export async function tenantCapabilityRefusal(
  env: EffectiveSettingsEnv,
  authContext: AdminAuthContext | undefined,
  capability: TenantCapability,
  options: { permitted?: boolean } = {}
): Promise<TenantCapabilityRefusal | null> {
  // Global platform authority is decided first: an exempt caller never reads the switch.
  if (hasGlobalPlatformAuthority(authContext, 'admin:*')) return null;
  const decision = decideTenantCapabilityAccess({
    state: await getTenantCapabilityState(env, capability),
    globalPlatformAuthority: false,
    permitted: options.permitted,
  });
  if (decision === 'disabled') return tenantCapabilityDisabledRefusal(capability);
  if (decision === 'unavailable') return tenantCapabilityUnavailableRefusal(capability);
  return null;
}

/**
 * Whether a stored or requested value counts as a SAML metadata URL the scheduled poller could act
 * on. Anything but undefined, null or a string that is empty after trim counts (arrays, objects,
 * numbers and booleans too): the poller reads the raw value and a non-string one can still be
 * coerced into a fetched URL, so the gates must not look at strings only.
 */
export function carriesMetadataUrl(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

/** Whether two metadata URL values are the same (strings by value, anything else by its JSON). */
export function sameMetadataUrlValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  try {
    return typeof a === typeof b && JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
