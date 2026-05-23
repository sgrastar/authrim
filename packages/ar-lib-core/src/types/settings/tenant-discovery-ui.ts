/**
 * Tenant Discovery UI Settings Category
 *
 * Settings related to the tenant discovery screen appearance.
 * API: GET/PATCH /api/admin/platform/settings/tenant-discovery-ui
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/tenant-discovery-ui
 * Config Level: platform + tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface TenantDiscoveryUISettings {
  'tenant-discovery-ui.override_enabled': boolean;
  'tenant-discovery-ui.inherit_from_login_ui': boolean;
  'tenant-discovery-ui.theme': string;
  'tenant-discovery-ui.variant': string;
  'tenant-discovery-ui.brand_name': string;
  'tenant-discovery-ui.logo_url': string;
  'tenant-discovery-ui.page_title': string;
  'tenant-discovery-ui.kicker_text': string;
  'tenant-discovery-ui.title_text': string;
  'tenant-discovery-ui.subtitle_text': string;
}

export const TENANT_DISCOVERY_UI_SETTINGS_META: Record<
  keyof TenantDiscoveryUISettings,
  SettingMeta
> = {
  'tenant-discovery-ui.override_enabled': {
    key: 'tenant-discovery-ui.override_enabled',
    type: 'boolean',
    default: false,
    label: 'Tenant Override Enabled',
    description:
      'Enables tenant-scoped discovery screen content overrides. When disabled, common discovery UI settings apply.',
    visibility: 'admin',
  },
  'tenant-discovery-ui.inherit_from_login_ui': {
    key: 'tenant-discovery-ui.inherit_from_login_ui',
    type: 'boolean',
    default: true,
    label: 'Inherit From Login UI',
    description:
      'Use Login UI theme and branding values when discovery-specific overrides are not set.',
    visibility: 'public',
  },
  'tenant-discovery-ui.theme': {
    key: 'tenant-discovery-ui.theme',
    type: 'enum',
    default: '',
    label: 'Theme Mode',
    description: 'Optional theme mode override for the tenant discovery screen.',
    enum: ['', 'light', 'dark'],
    visibility: 'public',
  },
  'tenant-discovery-ui.variant': {
    key: 'tenant-discovery-ui.variant',
    type: 'enum',
    default: '',
    label: 'Theme Variant',
    description: 'Optional theme variant override for the tenant discovery screen.',
    enum: ['', 'beige', 'blue-gray', 'green', 'brown', 'navy', 'slate'],
    visibility: 'public',
  },
  'tenant-discovery-ui.brand_name': {
    key: 'tenant-discovery-ui.brand_name',
    type: 'string',
    default: '',
    label: 'Brand Name',
    description: 'Optional brand name override for the tenant discovery screen.',
    visibility: 'public',
  },
  'tenant-discovery-ui.logo_url': {
    key: 'tenant-discovery-ui.logo_url',
    type: 'string',
    default: '',
    label: 'Logo URL',
    description: 'Optional logo URL override for the tenant discovery screen.',
    visibility: 'public',
  },
  'tenant-discovery-ui.page_title': {
    key: 'tenant-discovery-ui.page_title',
    type: 'string',
    default: '',
    label: 'Page Title',
    description: 'Optional browser title override for the tenant discovery screen.',
    visibility: 'public',
  },
  'tenant-discovery-ui.kicker_text': {
    key: 'tenant-discovery-ui.kicker_text',
    type: 'string',
    default: '',
    label: 'Kicker Text',
    description: 'Optional kicker text shown above the main discovery title.',
    visibility: 'public',
  },
  'tenant-discovery-ui.title_text': {
    key: 'tenant-discovery-ui.title_text',
    type: 'string',
    default: '',
    label: 'Title Text',
    description: 'Optional main heading override for the tenant discovery screen.',
    visibility: 'public',
  },
  'tenant-discovery-ui.subtitle_text': {
    key: 'tenant-discovery-ui.subtitle_text',
    type: 'string',
    default: '',
    label: 'Subtitle Text',
    description: 'Optional supporting text shown under the main discovery title.',
    visibility: 'public',
  },
};

export const TENANT_DISCOVERY_UI_CATEGORY_META: CategoryMeta = {
  category: 'tenant-discovery-ui',
  label: 'Tenant Discovery UI',
  description: 'Tenant discovery screen appearance, theme, and branding settings',
  settings: TENANT_DISCOVERY_UI_SETTINGS_META,
};

export const TENANT_DISCOVERY_UI_DEFAULTS: TenantDiscoveryUISettings = {
  'tenant-discovery-ui.override_enabled': false,
  'tenant-discovery-ui.inherit_from_login_ui': true,
  'tenant-discovery-ui.theme': '',
  'tenant-discovery-ui.variant': '',
  'tenant-discovery-ui.brand_name': '',
  'tenant-discovery-ui.logo_url': '',
  'tenant-discovery-ui.page_title': '',
  'tenant-discovery-ui.kicker_text': '',
  'tenant-discovery-ui.title_text': '',
  'tenant-discovery-ui.subtitle_text': '',
};
