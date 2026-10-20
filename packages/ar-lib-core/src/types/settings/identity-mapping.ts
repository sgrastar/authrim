/**
 * Identity Mapping Settings Category
 *
 * Where the platform and each tenant name the Mapping Set that applies to apps that choose none of
 * their own (the order is: the app's own choice, then the tenant's default, then the platform's).
 * API: GET/PATCH /api/admin/platform/settings/identity-mapping
 *      GET/PATCH /api/admin/tenants/:tenantId/settings/identity-mapping
 * Config Level: platform, tenant (never per app: an app's own choice lives on the app)
 *
 * The release of claims reads the default (ID token, UserInfo and the consent screen) through the
 * selection in services/identity-mapping-selection.ts; an app that names nothing and a tenant
 * and platform that set nothing are given no mapping.
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
  },
};

export const IDENTITY_MAPPING_CATEGORY_META: CategoryMeta = {
  category: 'identity-mapping',
  label: 'Identity Mapping',
  description:
    'The Mapping Set that applies to apps that choose none of their own, for the platform and for each tenant',
  settings: IDENTITY_MAPPING_SETTINGS_META,
};

export const IDENTITY_MAPPING_DEFAULTS: {
  [K in keyof IdentityMappingSettings]: IdentityMappingSettings[K] | null;
} = {
  'identity_mapping.oidc_default_set_id': null,
};
