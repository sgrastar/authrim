/**
 * Identity Mapping Settings Category
 *
 * Where the platform and each tenant name the Mapping Set that applies to apps that choose none of
 * their own (the order is: the app's own choice, then the tenant's default, then the platform's).
 * API: GET/PATCH /api/admin/platform/settings/identity-mapping
 *      GET/PATCH /api/admin/tenants/:tenantId/settings/identity-mapping
 * Config Level: platform, tenant (never per app: an app's own choice lives on the app)
 *
 * The default itself is not read by the release of claims yet (the key is `in_development`). It is
 * read by the shadow comparison only: while `identity_mapping.shadow_compare_enabled` is on, each
 * OIDC resolution is also run through the new selection and a difference from what the request
 * used is logged as a warning. The release of claims is unchanged.
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * The value that says "no default here". For a tenant it means: do not take the platform's default
 * either. The platform has no further level, so it says "none" by leaving the key unset.
 */
export const IDENTITY_MAPPING_NONE = 'none';

/** The longest Mapping Set ID an app's own choice can hold (login-runtime-flow reads 200). */
export const IDENTITY_MAPPING_SET_ID_MAX_LENGTH = 200;

export interface IdentityMappingSettings {
  'identity_mapping.oidc_default_set_id': string;
  'identity_mapping.shadow_compare_enabled': boolean;
}

export const IDENTITY_MAPPING_SETTINGS_META: Record<keyof IdentityMappingSettings, SettingMeta> = {
  'identity_mapping.oidc_default_set_id': {
    key: 'identity_mapping.oidc_default_set_id',
    type: 'string',
    // Unset: no default, so no mapping is applied. (Not a string: nothing names a set by default.)
    default: null,
    // No environment variable: a Mapping Set ID means nothing outside the database it lives in.
    label: 'Default Mapping Set (OIDC)',
    description:
      'The ID of the Mapping Set that applies to apps of this scope that choose none of their own. Unset means no default: no mapping is applied. For a tenant, the value none means: do not use the platform default either. The Mapping Set must be active; a tenant may name one it owns or one the platform owns, the platform only one the platform owns.',
    visibility: 'admin',
    status: 'in_development',
  },
  'identity_mapping.shadow_compare_enabled': {
    key: 'identity_mapping.shadow_compare_enabled',
    // The comparison runs before the request's own settings are looked at, for every tenant: the
    // platform decides whether it runs (it costs a settings read and, for a set, a database read).
    scopes: ['platform'],
    type: 'boolean',
    default: false,
    envKey: 'IDENTITY_MAPPING_SHADOW_COMPARE',
    label: 'Compare Mapping Set Selection (shadow)',
    description:
      'While on, each OIDC identity mapping resolution is also run through the new selection (the app, then the tenant default, then the platform default) and a difference from what the request used is logged as a warning (identity_mapping_resolution_diff). It changes nothing in the response. It adds a settings read and, when the new selection names a Mapping Set, an Admin database read to each resolution, so turn it on only where the comparison is wanted. Off by default.',
    visibility: 'admin',
  },
};

export const IDENTITY_MAPPING_CATEGORY_META: CategoryMeta = {
  category: 'identity-mapping',
  label: 'Identity Mapping',
  description:
    'Default Mapping Sets for platform and tenant (not yet applied at runtime), and the shadow comparison of their selection',
  settings: IDENTITY_MAPPING_SETTINGS_META,
};

export const IDENTITY_MAPPING_DEFAULTS: {
  [K in keyof IdentityMappingSettings]: IdentityMappingSettings[K] | null;
} = {
  'identity_mapping.oidc_default_set_id': null,
  'identity_mapping.shadow_compare_enabled': false,
};

/** The setting that turns the shadow comparison of the Mapping Set selection on. */
export const IDENTITY_MAPPING_SHADOW_COMPARE_KEY = 'identity_mapping.shadow_compare_enabled';
