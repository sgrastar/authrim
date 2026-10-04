/**
 * External IdP Settings Category
 *
 * Settings related to external identity provider federation.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/external-idp
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';
import { DEFAULT_PROFILE_UPDATE_FIELDS } from '../../services/profile-update-fields';

/**
 * External IdP Settings Interface
 */
/**
 * An `external_idp.jit_allowed_provider_ids` entry that names no provider (IDs are UUIDs): a list
 * of only this allows none.
 */
export const NO_JIT_PROVIDER = '-';

export interface ExternalIdPSettings {
  // JIT Provisioning
  'external_idp.jit_provisioning_enabled': boolean;
  'external_idp.jit_update_on_login': boolean;
  'external_idp.jit_update_fields': string[];

  'external_idp.jit_require_verified_email': boolean;
  'external_idp.jit_allowed_provider_ids': string;
  'external_idp.jit_join_all_matching_orgs': boolean;
  'external_idp.jit_allow_user_without_org': boolean;
  'external_idp.jit_default_role_id': string;
  'external_idp.jit_allow_unverified_domain_mappings': boolean;
}

/**
 * External IdP Settings Metadata
 */
export const EXTERNAL_IDP_SETTINGS_META: Record<keyof ExternalIdPSettings, SettingMeta> = {
  'external_idp.jit_provisioning_enabled': {
    key: 'external_idp.jit_provisioning_enabled',
    type: 'boolean',
    // As the bridge has always behaved without a saved configuration. Each provider must also
    // enable JIT provisioning, so this alone creates no accounts.
    default: true,
    envKey: 'ENABLE_JIT_PROVISIONING',
    label: 'JIT Provisioning',
    description:
      'Enable Just-In-Time user provisioning from external IdPs (for providers that also enable it)',
    visibility: 'public',
  },
  'external_idp.jit_update_on_login': {
    key: 'external_idp.jit_update_on_login',
    type: 'boolean',
    // Off unless set: logins have never changed the user's profile, which may be edited locally.
    default: false,
    envKey: 'JIT_UPDATE_ON_LOGIN',
    label: 'Update on Login',
    description:
      "Update the user's profile from the external IdP on each login: the fields chosen in Fields to Update (an IdP may choose its own)",
    visibility: 'public',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
  },
  'external_idp.jit_update_fields': {
    key: 'external_idp.jit_update_fields',
    type: 'json',
    // What a login has always updated.
    default: [...DEFAULT_PROFILE_UPDATE_FIELDS],
    label: 'Fields to Update',
    description:
      'Profile fields a login updates for IdPs without their own list: any of name, given_name, family_name, middle_name, nickname, profile, picture, website, gender, birthdate, zoneinfo, locale (only those the IdP sends; [] updates none)',
    visibility: 'public',
    dependsOn: [{ key: 'external_idp.jit_update_on_login', value: true }],
  },

  'external_idp.jit_require_verified_email': {
    key: 'external_idp.jit_require_verified_email',
    type: 'boolean',
    label: 'JIT: Verified Email Only',
    description: 'Create an account only when the identity provider reports the email as verified',
    visibility: 'admin',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
    default: true,
  },
  'external_idp.jit_allowed_provider_ids': {
    key: 'external_idp.jit_allowed_provider_ids',
    type: 'string',
    label: 'JIT: Allowed Providers',
    description:
      'Comma-separated identity provider IDs that may create accounts; empty allows all, and an entry that names no provider (such as -) on its own allows none',
    visibility: 'admin',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
    default: '',
  },
  'external_idp.jit_join_all_matching_orgs': {
    key: 'external_idp.jit_join_all_matching_orgs',
    type: 'boolean',
    label: 'JIT: Join All Matching Organizations',
    description: 'Add a new account to every organization whose domain matches, not only the first',
    visibility: 'admin',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
    default: false,
  },
  'external_idp.jit_allow_user_without_org': {
    key: 'external_idp.jit_allow_user_without_org',
    type: 'boolean',
    label: 'JIT: Allow Accounts Without Organization',
    description: 'Create an account even when no organization domain matches',
    visibility: 'admin',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
    default: true,
  },
  'external_idp.jit_default_role_id': {
    key: 'external_idp.jit_default_role_id',
    type: 'string',
    label: 'JIT: Default Role',
    description:
      'Role given to a new account when no role assignment rule matches; empty gives none',
    visibility: 'admin',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
    default: 'role_end_user',
  },
  'external_idp.jit_allow_unverified_domain_mappings': {
    key: 'external_idp.jit_allow_unverified_domain_mappings',
    type: 'boolean',
    label: 'JIT: Unverified Domains',
    description: 'Use organization domain mappings that are not verified',
    visibility: 'admin',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
    default: false,
  },
};

/**
 * External IdP Category Metadata
 */
export const EXTERNAL_IDP_CATEGORY_META: CategoryMeta = {
  category: 'external-idp',
  label: 'External IdP',
  description: 'External identity provider federation settings',
  settings: EXTERNAL_IDP_SETTINGS_META,
};

/**
 * Default External IdP settings values
 */
export const EXTERNAL_IDP_DEFAULTS: ExternalIdPSettings = {
  'external_idp.jit_provisioning_enabled': true,
  'external_idp.jit_update_on_login': false,
  'external_idp.jit_update_fields': [...DEFAULT_PROFILE_UPDATE_FIELDS],
  'external_idp.jit_require_verified_email': true,
  'external_idp.jit_allowed_provider_ids': '',
  'external_idp.jit_join_all_matching_orgs': false,
  'external_idp.jit_allow_user_without_org': true,
  'external_idp.jit_default_role_id': 'role_end_user',
  'external_idp.jit_allow_unverified_domain_mappings': false,
};
