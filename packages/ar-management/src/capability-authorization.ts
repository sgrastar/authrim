/**
 * Who may use a capability the platform can turn off for tenants (category `tenant-capabilities`),
 * for the Admin API. One rule for every place that asks (the route gate, the common tenant
 * settings writer, the per-plugin handlers):
 *
 * - a caller with global platform authority (`hasGlobalPlatformAuthority(ctx, 'admin:*')`) is
 *   exempt: it may manage whatever the capability covers;
 * - while the capability is off, everyone else is refused: 403 `capability_disabled`;
 * - when the switch cannot be read, everyone else is refused: 503 `temporarily_unavailable`
 *   (never treated as on).
 *
 * This is about managing. Whether anything RUNS for a tenant is decided by the runtime entry
 * points, which stay closed while the capability is off, for every caller.
 */
import {
  getTenantCapabilityState,
  hasGlobalPlatformAuthority,
  type AdminAuthContext,
  type EffectiveSettingsEnv,
  type TenantCapability,
} from '@authrim/ar-lib-core';

/** The settings categories whose writes belong to a capability. */
export const SETTINGS_CATEGORY_CAPABILITY: Readonly<Record<string, TenantCapability>> = {
  dcr: 'dynamic_client_registration',
  plugin: 'external_plugins',
};

export interface CapabilityRefusal {
  status: 403 | 503;
  body: {
    error: 'capability_disabled' | 'temporarily_unavailable';
    error_description: string;
    capability: TenantCapability;
  };
}

export function capabilityDisabledRefusal(capability: TenantCapability): CapabilityRefusal {
  return {
    status: 403,
    body: {
      error: 'capability_disabled',
      error_description: 'This capability has been turned off for tenants by the platform.',
      capability,
    },
  };
}

export function capabilityUnavailableRefusal(capability: TenantCapability): CapabilityRefusal {
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

/** Null when the caller may manage the capability now, else how to refuse. */
export async function capabilityRefusal(
  env: EffectiveSettingsEnv,
  authContext: AdminAuthContext | undefined,
  capability: TenantCapability,
  options: {
    /**
     * Whether the caller passed the permission checks. An unreadable switch only refuses a caller
     * who would otherwise be allowed (the others get their own refusal).
     */
    permitted?: boolean;
  } = {}
): Promise<CapabilityRefusal | null> {
  if (hasGlobalPlatformAuthority(authContext, 'admin:*')) return null;
  const state = await getTenantCapabilityState(env, capability);
  if (state === 'off') return capabilityDisabledRefusal(capability);
  if (state === 'unknown' && options.permitted !== false) {
    return capabilityUnavailableRefusal(capability);
  }
  return null;
}
