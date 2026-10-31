/**
 * Identity Mapping Settings Category
 *
 * Where the platform and each tenant name the Mapping Set that applies to apps that choose none of
 * their own (the order is: the app's own choice, then the tenant's default, then the platform's).
 * API: GET/PATCH /api/admin/platform/settings/identity-mapping
 *      GET/PATCH /api/admin/tenants/:tenantId/settings/identity-mapping
 * Config Level: platform, tenant (never per app: an app's own choice lives on the app)
 *
 * The same category holds the limits of the search for the places that name a Mapping Set (platform
 * only, see `IDENTITY_MAPPING_SCAN_TENANT_LIMIT_KEY` and the keys beside it).
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

/**
 * How far the search for the places that name a Mapping Set looks (the usage API, and the
 * operations that delete or switch off a set and refuse while something names it). Platform
 * settings: they bound the work one request does, which no tenant may raise. A saved or
 * environment value outside the range is not used; the default is.
 */
export const IDENTITY_MAPPING_SCAN_TENANT_LIMIT_KEY =
  'identity_mapping.reference_scan_tenant_limit';
export const IDENTITY_MAPPING_SCAN_ROW_LIMIT_KEY = 'identity_mapping.reference_scan_row_limit';
export const IDENTITY_MAPPING_SCAN_CONCURRENCY_KEY = 'identity_mapping.reference_scan_concurrency';
export const IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT_KEY =
  'identity_mapping.reference_display_limit';

export const IDENTITY_MAPPING_SCAN_TENANT_LIMIT_DEFAULT = 200;
export const IDENTITY_MAPPING_SCAN_ROW_LIMIT_DEFAULT = 500;
export const IDENTITY_MAPPING_SCAN_CONCURRENCY_DEFAULT = 8;
export const IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT_DEFAULT = 20;

export interface IdentityMappingSettings {
  'identity_mapping.oidc_default_set_id': string;
  'identity_mapping.reference_scan_tenant_limit': number;
  'identity_mapping.reference_scan_row_limit': number;
  'identity_mapping.reference_scan_concurrency': number;
  'identity_mapping.reference_display_limit': number;
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
  'identity_mapping.reference_scan_tenant_limit': {
    key: 'identity_mapping.reference_scan_tenant_limit',
    type: 'number',
    default: IDENTITY_MAPPING_SCAN_TENANT_LIMIT_DEFAULT,
    envKey: 'IDENTITY_MAPPING_REFERENCE_SCAN_TENANT_LIMIT',
    label: 'Mapping Set Usage Search: Tenants',
    description:
      'The most tenants whose apps are read when looking for the places that use a Mapping Set the platform owns. Each tenant is a database read; when there are more tenants than this, the rest are reported as not looked at, and deleting or switching off the set is refused. Held between 1 and 1000.',
    min: 1,
    max: 1000,
    integer: true,
    envNumber: 'strict-in-range',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'identity_mapping.reference_scan_row_limit': {
    key: 'identity_mapping.reference_scan_row_limit',
    type: 'number',
    default: IDENTITY_MAPPING_SCAN_ROW_LIMIT_DEFAULT,
    envKey: 'IDENTITY_MAPPING_REFERENCE_SCAN_ROW_LIMIT',
    label: 'Mapping Set Usage Search: Rows per Place',
    description:
      'The most rows read from one place (a tenant default list, the apps of one tenant, the SAML providers of one tenant) when looking for the places that use a Mapping Set. A place with more is cut off and the count is given as a lower bound. Held between 10 and 5000.',
    min: 10,
    max: 5000,
    integer: true,
    envNumber: 'strict-in-range',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'identity_mapping.reference_scan_concurrency': {
    key: 'identity_mapping.reference_scan_concurrency',
    type: 'number',
    default: IDENTITY_MAPPING_SCAN_CONCURRENCY_DEFAULT,
    envKey: 'IDENTITY_MAPPING_REFERENCE_SCAN_CONCURRENCY',
    label: 'Mapping Set Usage Search: Concurrency',
    description:
      'How many tenants are read at the same time when looking for the places that use a Mapping Set the platform owns. Held between 1 and 16.',
    min: 1,
    max: 16,
    integer: true,
    envNumber: 'strict-in-range',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'identity_mapping.reference_display_limit': {
    key: 'identity_mapping.reference_display_limit',
    type: 'number',
    default: IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT_DEFAULT,
    envKey: 'IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT',
    label: 'Mapping Set Usage: References Shown',
    description:
      'How many references the usage answer and the refusal of a deletion list; the count is always the whole. Held between 1 and 100.',
    min: 1,
    max: 100,
    integer: true,
    envNumber: 'strict-in-range',
    scopes: ['platform'],
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
  'identity_mapping.reference_scan_tenant_limit': IDENTITY_MAPPING_SCAN_TENANT_LIMIT_DEFAULT,
  'identity_mapping.reference_scan_row_limit': IDENTITY_MAPPING_SCAN_ROW_LIMIT_DEFAULT,
  'identity_mapping.reference_scan_concurrency': IDENTITY_MAPPING_SCAN_CONCURRENCY_DEFAULT,
  'identity_mapping.reference_display_limit': IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT_DEFAULT,
};
