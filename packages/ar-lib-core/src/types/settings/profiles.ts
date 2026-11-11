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
  /** The platform's Default methods hold for every tenant (tenants' own values are set aside). */
  'profiles.method.default_locked': boolean;
  /** The platform's Default session rules hold for every tenant. */
  'profiles.session.default_locked': boolean;
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
  'profiles.method.default_locked': {
    key: 'profiles.method.default_locked',
    type: 'boolean',
    default: false,
    envKey: 'PROFILES_METHOD_DEFAULT_LOCKED',
    label: 'Lock the platform Default methods',
    description:
      "On: every tenant uses the platform's Default authentication methods; a tenant's own values are kept but do not apply, and tenants cannot change them",
    visibility: 'admin',
  },
  'profiles.session.default_locked': {
    key: 'profiles.session.default_locked',
    type: 'boolean',
    default: false,
    envKey: 'PROFILES_SESSION_DEFAULT_LOCKED',
    label: 'Lock the platform Default session rules',
    description:
      "On: every tenant uses the platform's Default session lifetimes and single sign-on; a tenant's own values are kept but do not apply, and tenants cannot change them",
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
  'profiles.method.default_locked': false,
  'profiles.session.default_locked': false,
};
