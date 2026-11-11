/**
 * A tenant's Default profile as its admin sees it, with the platform layer under it
 * (ar-lib-core default-profile-layer.ts): what holds now, whether the tenant keeps its own copy,
 * whether that copy applies, and whether the platform changed its Default since the copy was made.
 * Shared by the method and session profile routes.
 *
 * All of it is read from the canonical settings store (the store the Admin API decides on), not
 * the runtime cache.
 */
import {
  defaultProfileLayerFrom,
  layerResolvedSettings,
  type DefaultLayerCategory,
  type DefaultProfileLayer,
  type SettingScope,
  type SettingsGetResult,
  DEFAULT_LAYER_KEYS,
  LEGACY_METHOD_SWITCHES,
  withLegacyMethodSwitches,
} from '@authrim/ar-lib-core';

/** The settings manager the profile routes use (canonical store). */
interface DefaultReader {
  getAll(category: string, scope: SettingScope): Promise<SettingsGetResult>;
}

/** Where the tenant keeps the platform version its copy was made from. */
export const DEFAULT_BASE_VERSION_KEY = {
  method: 'authentication-methods.default_profile.base_version',
  session: 'session.default_profile.base_version',
} as const;

/** One category of a Default, read with the platform layer. */
export interface DefaultCategoryRead {
  category: DefaultLayerCategory;
  /** The tenant's document as stored (sources `kv` are its own values). */
  tenant: SettingsGetResult;
  /** The platform's document of the category. */
  platform: SettingsGetResult;
  layer: DefaultProfileLayer;
  /** What holds for the tenant: the tenant's values where they apply, else the platform's. */
  effective: { values: Record<string, unknown>; sources: Record<string, string> };
  /** The Default's settings the tenant's document holds itself. */
  storedKeys: string[];
}

export async function readDefaultCategory(
  manager: DefaultReader,
  category: DefaultLayerCategory,
  tenantId: string
): Promise<DefaultCategoryRead> {
  const [tenant, platform, profiles] = await Promise.all([
    manager.getAll(category, { type: 'tenant', id: tenantId }),
    manager.getAll(category, { type: 'platform' }),
    manager.getAll('profiles', { type: 'platform' }),
  ]);
  const layer = defaultProfileLayerFrom(category, platform, profiles);
  const own = category === 'authentication-methods' ? withLegacyMethodSwitches(tenant) : tenant;
  return {
    category,
    tenant,
    platform,
    layer,
    effective: layerResolvedSettings(own, layer, 'tenant'),
    storedKeys: [
      ...DEFAULT_LAYER_KEYS[category].filter((key) => tenant.sources[key] === 'kv'),
      // A method's older single switch is the tenant's too: "back to the platform's" removes it.
      ...Object.keys(LEGACY_METHOD_SWITCHES).filter((key) => tenant.sources[key] === 'kv'),
    ],
  };
}

/**
 * What the Default's answer says about the platform layer, in the terms of a platform profile's
 * entry (tenant-platform-profiles.ts):
 * - `overridden`: the tenant keeps values of its own for the Default, and they apply;
 * - `override_inactive` / `override_inactive_reason`: it keeps some, set aside now, and why;
 * - `editable`: whether the tenant may change the Default's settings now;
 * - `platform_updated`: the platform's Default changed since the tenant saved its copy.
 */
export function defaultLayerStatus(
  reads: readonly DefaultCategoryRead[],
  platformValues: Record<string, unknown>,
  platformVersion: string,
  baseVersion: string | null
) {
  const setAside = reads.find((read) => read.layer.tenantSetAside)?.layer.tenantSetAside ?? null;
  const holds = reads.some((read) => read.storedKeys.length > 0);
  return {
    scope: 'tenant' as const,
    overridden: holds && setAside === null,
    override_inactive: holds && setAside !== null,
    override_inactive_reason: holds ? setAside : null,
    locked: setAside === 'locked',
    editable: setAside === null,
    platform_values: platformValues,
    platform_version: platformVersion,
    base_version: baseVersion,
    platform_updated: holds && baseVersion !== null && baseVersion !== platformVersion,
  };
}

/** The base version stored in a tenant document, or null when none. */
export function storedBaseVersion(tenant: SettingsGetResult, key: string): string | null {
  const value = tenant.values[key];
  return tenant.sources[key] === 'kv' && typeof value === 'string' && value ? value : null;
}

/** The values of the Default's settings the platform resolves (its own, else env, else default). */
export function platformValuesOf(read: DefaultCategoryRead): Record<string, unknown> {
  return Object.fromEntries(
    DEFAULT_LAYER_KEYS[read.category].map((key) => [key, read.layer.platformValues[key]])
  );
}
