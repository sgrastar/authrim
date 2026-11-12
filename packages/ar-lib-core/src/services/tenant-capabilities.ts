/**
 * The platform's switches for what tenants may use (category `tenant-capabilities`).
 *
 * This is the only way code asks whether a capability is on. The answer distinguishes 'on', 'off'
 * and 'unknown' (the settings could not be read): the Admin API gate refuses on 'unknown', a
 * runtime entry point keeps its earlier behaviour (and logs a warning) so that a deployment that
 * never switched anything off does not lose sign-in or webhook delivery to a settings outage.
 * Reads use the short per-isolate cache of the runtime settings (about a minute), so a change
 * reaches a running Worker within that time.
 */

import {
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';
import {
  TENANT_CAPABILITIES,
  TENANT_CAPABILITIES_CATEGORY,
  tenantCapabilitySettingKey,
  type TenantCapability,
} from '../types/settings/tenant-capabilities';
import { createLogger } from '../utils/logger';

export type TenantCapabilityState = 'on' | 'off' | 'unknown';

const log = createLogger().module('TENANT_CAPABILITIES');

/**
 * The state of every capability, or null when the settings could not be read. A value that is not
 * a boolean is read as unknown for that capability (never as on).
 */
export async function readTenantCapabilityStates(
  env: EffectiveSettingsEnv,
  options: { fresh?: boolean } = {}
): Promise<Record<TenantCapability, TenantCapabilityState> | null> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(
      env,
      TENANT_CAPABILITIES_CATEGORY,
      options.fresh ? { fresh: true } : {}
    );
    const states = {} as Record<TenantCapability, TenantCapabilityState>;
    for (const capability of TENANT_CAPABILITIES) {
      const value = values[tenantCapabilitySettingKey(capability)];
      states[capability] = value === true ? 'on' : value === false ? 'off' : 'unknown';
    }
    return states;
  } catch {
    return null;
  }
}

/** Whether one capability is on, off, or unknown (unreadable). Nothing from the settings is logged. */
export async function getTenantCapabilityState(
  env: EffectiveSettingsEnv,
  capability: TenantCapability,
  options: { fresh?: boolean } = {}
): Promise<TenantCapabilityState> {
  const states = await readTenantCapabilityStates(env, options);
  return states ? states[capability] : 'unknown';
}

/** The capabilities that are off (unknown ones are not listed). Null when unreadable. */
export async function listDisabledTenantCapabilities(
  env: EffectiveSettingsEnv,
  options: { fresh?: boolean } = {}
): Promise<TenantCapability[] | null> {
  const states = await readTenantCapabilityStates(env, options);
  if (!states) return null;
  return TENANT_CAPABILITIES.filter((capability) => states[capability] === 'off');
}

/**
 * For a runtime entry point: false only when the switch was read and is off. When it cannot be
 * read the capability is treated as on (the earlier behaviour) and a warning is logged.
 */
export async function isTenantCapabilityEnabledAtRuntime(
  env: EffectiveSettingsEnv,
  capability: TenantCapability
): Promise<boolean> {
  const state = await getTenantCapabilityState(env, capability);
  if (state === 'unknown') {
    log.warn('Tenant capability switch could not be read; treating the capability as enabled', {
      capability,
    });
  }
  return state !== 'off';
}

/** The body (status 403) the dynamic client registration endpoints answer while the capability is off. */
export const DCR_CAPABILITY_DISABLED_BODY = {
  error: 'access_denied',
  error_description: 'Dynamic Client Registration is disabled for this tenant',
} as const;

/**
 * Null when dynamic client registration may be used, else the refusal body of the registration
 * endpoints (`/register`, the RFC 7592 client configuration endpoints, the initial access token
 * check). An unreadable switch is not a refusal (see isTenantCapabilityEnabledAtRuntime).
 */
export async function dynamicClientRegistrationRefusal(
  env: EffectiveSettingsEnv
): Promise<typeof DCR_CAPABILITY_DISABLED_BODY | null> {
  return (await isTenantCapabilityEnabledAtRuntime(env, 'dynamic_client_registration'))
    ? null
    : DCR_CAPABILITY_DISABLED_BODY;
}
