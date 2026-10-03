/**
 * Infrastructure Settings Category (Platform)
 *
 * Platform-level infrastructure settings (read-only via API).
 * API: GET /api/admin/platform/settings/infrastructure
 * Config Level: platform (read-only)
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';
import { DEFAULT_AUDIT_PROFILE_ID, DEFAULT_RESIDENCY_PROFILE_ID } from '../runtime-profile';

/**
 * Infrastructure Settings Interface
 *
 * Note: Sharding settings (code_shards, session_shards, challenge_shards,
 * revocation_shards, region_*) are managed in the
 * dedicated Sharding Configuration page (/admin/settings/sharding).
 */
export interface InfrastructureSettings {
  // Runtime Profile Defaults
  'infra.default_audit_profile_id': string;
  'infra.default_residency_profile_id': string;
}

/**
 * Infrastructure Settings Metadata
 *
 * Note: Sharding settings are managed in the dedicated Sharding Configuration page.
 */
export const INFRASTRUCTURE_SETTINGS_META: Record<keyof InfrastructureSettings, SettingMeta> = {
  'infra.default_audit_profile_id': {
    key: 'infra.default_audit_profile_id',
    type: 'string',
    default: DEFAULT_AUDIT_PROFILE_ID,
    envKey: 'DEFAULT_AUDIT_PROFILE_ID',
    label: 'Default Audit Profile',
    description: 'Environment default audit profile ID used when tenant overrides are empty.',
    visibility: 'admin',
  },
  'infra.default_residency_profile_id': {
    key: 'infra.default_residency_profile_id',
    type: 'string',
    default: DEFAULT_RESIDENCY_PROFILE_ID,
    envKey: 'DEFAULT_RESIDENCY_PROFILE_ID',
    label: 'Default Residency Profile',
    description: 'Environment default residency profile ID used when tenant overrides are empty.',
    visibility: 'admin',
  },
};

/**
 * Infrastructure Category Metadata
 */
export const INFRASTRUCTURE_CATEGORY_META: CategoryMeta = {
  category: 'infrastructure',
  label: 'Infrastructure',
  description: 'Platform-level infrastructure settings (read-only)',
  settings: INFRASTRUCTURE_SETTINGS_META,
};

/**
 * Default Infrastructure settings values
 *
 * Note: Sharding defaults are managed in the Sharding Configuration page.
 */
export const INFRASTRUCTURE_DEFAULTS: InfrastructureSettings = {
  'infra.default_audit_profile_id': DEFAULT_AUDIT_PROFILE_ID,
  'infra.default_residency_profile_id': DEFAULT_RESIDENCY_PROFILE_ID,
};
