/**
 * Service Site Settings Category
 *
 * Tenant-scoped settings for routing non-Authrim paths to an attached service app.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/service-site
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface ServiceSiteSettings {
  'service-site.fallback_enabled': boolean;
}

export const SERVICE_SITE_SETTINGS_META: Record<keyof ServiceSiteSettings, SettingMeta> = {
  'service-site.fallback_enabled': {
    key: 'service-site.fallback_enabled',
    type: 'boolean',
    default: false,
    label: 'Service Site Fallback Enabled',
    description:
      'Route non-Authrim paths to the service app Worker attached to the router through the SERVICE_SITE binding.',
    visibility: 'admin',
  },
};

export const SERVICE_SITE_CATEGORY_META: CategoryMeta = {
  category: 'service-site',
  label: 'Service Site',
  description: 'Service app fallback routing settings',
  settings: SERVICE_SITE_SETTINGS_META,
};

export const SERVICE_SITE_DEFAULTS: ServiceSiteSettings = {
  'service-site.fallback_enabled': false,
};
