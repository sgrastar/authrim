/**
 * Machine Access Settings Category
 *
 * The platform's list of tenants that a machine principal's ALL-tenants scope does not include.
 * For a listed tenant, a machine token is accepted only when the principal and its credential
 * name that tenant in their own allow-list; an all-tenants scope alone is refused there. The
 * setup tool, the Admin console relay and internal services (the platform principal types) and
 * human sessions are not affected. Empty by default: nothing changes until a tenant is listed.
 * Platform only: a tenant can neither see this as its own nor change it. Removing a tenant from
 * the list (loosening) needs a human admin step-up (`machine_access.excluded_tenants.relax`),
 * through every settings write path; adding one does not. Environment variable and KV value are
 * the usual hybrid (KV, then env, then code default).
 * API: GET/PATCH /api/admin/platform/settings/machine-access
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface MachineAccessSettings {
  'machine_access.all_scope_excluded_tenants': string;
}

export const MACHINE_ACCESS_CATEGORY = 'machine-access';

/** The settings key of the excluded-tenants list. */
export const MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY =
  'machine_access.all_scope_excluded_tenants';

/** The most tenants the list may name. */
export const MAX_MACHINE_ACCESS_EXCLUDED_TENANTS = 50;

export const MACHINE_ACCESS_SETTINGS_META: Record<keyof MachineAccessSettings, SettingMeta> = {
  'machine_access.all_scope_excluded_tenants': {
    key: MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY,
    type: 'string',
    default: '',
    envKey: 'MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS',
    label: 'Machine access: tenants an all-tenants scope does not include',
    description:
      'Comma-separated tenant IDs (lowercase, at most 50), for example the primary tenant "default". A machine token whose tenant scope is "all" is refused for a listed tenant, for its Admin API routes and for the routes that name it in the path; it is accepted there only when its principal and credential list that tenant in their own allow-list (an allow entry next to the all entry counts). Operations on the platform itself (creating a tenant, reading another tenant, platform settings) are not affected, nor are the setup tool, the Admin console relay, internal services and signed-in admins. Empty (the default) changes nothing. A value that cannot be read refuses all-tenants machine tokens everywhere until it is fixed. Machine access management gets stricter (platform principals are out of reach of such machines) from the moment a tenant is listed. Removing a tenant needs a human admin step-up; adding one does not.',
    scopes: ['platform'],
    visibility: 'admin',
  },
};

export const MACHINE_ACCESS_CATEGORY_META: CategoryMeta = {
  category: MACHINE_ACCESS_CATEGORY,
  label: 'Machine Access',
  description: 'Tenants that a machine principal with an all-tenants scope does not reach',
  settings: MACHINE_ACCESS_SETTINGS_META,
};

export const MACHINE_ACCESS_DEFAULTS: MachineAccessSettings = {
  'machine_access.all_scope_excluded_tenants': '',
};
