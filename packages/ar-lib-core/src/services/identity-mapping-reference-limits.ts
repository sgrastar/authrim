/**
 * The limits of the search for the places that name a Mapping Set, as the platform has them set:
 * the platform's saved value, else the environment variable, else the built-in default (the values
 * the search always used). A value outside the range of its setting is not used, and a settings
 * document that cannot be read leaves the defaults, so an outage of the settings store neither
 * widens a search nor ends it early.
 */
import {
  IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT_KEY,
  IDENTITY_MAPPING_SCAN_CONCURRENCY_KEY,
  IDENTITY_MAPPING_SCAN_ROW_LIMIT_KEY,
  IDENTITY_MAPPING_SCAN_TENANT_LIMIT_KEY,
  IDENTITY_MAPPING_SETTINGS_META,
} from '../types/settings/identity-mapping';
import {
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';
import {
  DEFAULT_MAPPING_SET_REFERENCE_LIMITS,
  type MappingSetReferenceLimits,
} from './identity-mapping-set-references';
import { isWithinSettingRange } from './setting-range';

const KEYS: ReadonlyArray<
  readonly [keyof MappingSetReferenceLimits, keyof typeof IDENTITY_MAPPING_SETTINGS_META]
> = [
  ['tenantLimit', IDENTITY_MAPPING_SCAN_TENANT_LIMIT_KEY],
  ['rowLimit', IDENTITY_MAPPING_SCAN_ROW_LIMIT_KEY],
  ['concurrency', IDENTITY_MAPPING_SCAN_CONCURRENCY_KEY],
  ['displayLimit', IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT_KEY],
];

export async function resolveMappingSetReferenceLimits(
  env: EffectiveSettingsEnv
): Promise<MappingSetReferenceLimits> {
  try {
    // Fresh: a change made in the admin console is the next search's, not the next minute's.
    const { values } = await resolvePlatformSettingsWithSources(env, 'identity-mapping', {
      fresh: true,
    });
    const limits = { ...DEFAULT_MAPPING_SET_REFERENCE_LIMITS };
    for (const [field, key] of KEYS) {
      const value = values[key];
      if (isWithinSettingRange(value, IDENTITY_MAPPING_SETTINGS_META[key])) limits[field] = value;
    }
    return limits;
  } catch {
    return { ...DEFAULT_MAPPING_SET_REFERENCE_LIMITS };
  }
}
