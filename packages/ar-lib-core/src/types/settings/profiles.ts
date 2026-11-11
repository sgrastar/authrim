/**
 * Profiles Settings Category
 *
 * What tenants may do with the platform's authentication method profiles and session profiles
 * (see services/platform-profiles.ts). Each switch is platform-wide: it holds for every tenant.
 * API: GET/PATCH /api/admin/platform/settings/profiles
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface ProfilesSettings {
  /** Tenants may change (override) the platform's method profiles. */
  'profiles.method.tenant_change_allowed': boolean;
  /** Tenants may create method profiles of their own. */
  'profiles.method.tenant_create_allowed': boolean;
  /** Tenants may change (override) the platform's session profiles. */
  'profiles.session.tenant_change_allowed': boolean;
  /** Tenants may create session profiles of their own. */
  'profiles.session.tenant_create_allowed': boolean;
}

export const PROFILES_SETTINGS_META: Record<keyof ProfilesSettings, SettingMeta> = {
  'profiles.method.tenant_change_allowed': {
    key: 'profiles.method.tenant_change_allowed',
    type: 'boolean',
    default: true,
    envKey: 'PROFILES_METHOD_TENANT_CHANGE_ALLOWED',
    label: 'Tenants may change platform method profiles',
    description:
      "Off: a tenant's change to a platform authentication method profile no longer applies (it is kept, and applies again when this is turned back on), and tenants cannot change them",
    visibility: 'admin',
  },
  'profiles.method.tenant_create_allowed': {
    key: 'profiles.method.tenant_create_allowed',
    type: 'boolean',
    default: true,
    envKey: 'PROFILES_METHOD_TENANT_CREATE_ALLOWED',
    label: 'Tenants may create method profiles',
    description:
      'Off: tenants cannot add authentication method profiles of their own; the ones they have stay usable and editable',
    visibility: 'admin',
  },
  'profiles.session.tenant_change_allowed': {
    key: 'profiles.session.tenant_change_allowed',
    type: 'boolean',
    default: true,
    envKey: 'PROFILES_SESSION_TENANT_CHANGE_ALLOWED',
    label: 'Tenants may change platform session profiles',
    description:
      "Off: a tenant's change to a platform session profile no longer applies (it is kept, and applies again when this is turned back on), and tenants cannot change them",
    visibility: 'admin',
  },
  'profiles.session.tenant_create_allowed': {
    key: 'profiles.session.tenant_create_allowed',
    type: 'boolean',
    default: true,
    envKey: 'PROFILES_SESSION_TENANT_CREATE_ALLOWED',
    label: 'Tenants may create session profiles',
    description:
      'Off: tenants cannot add session profiles of their own; the ones they have stay usable and editable',
    visibility: 'admin',
  },
};

export const PROFILES_CATEGORY_META: CategoryMeta = {
  category: 'profiles',
  label: 'Profiles',
  description: "What tenants may do with the platform's authentication method and session profiles",
  settings: PROFILES_SETTINGS_META,
};

export const PROFILES_DEFAULTS: ProfilesSettings = {
  'profiles.method.tenant_change_allowed': true,
  'profiles.method.tenant_create_allowed': true,
  'profiles.session.tenant_change_allowed': true,
  'profiles.session.tenant_create_allowed': true,
};
