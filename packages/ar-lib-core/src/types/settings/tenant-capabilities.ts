/**
 * Tenant Capabilities Settings Category
 *
 * One switch for each capability the platform can turn off for tenants. Off: tenant-scoped callers
 * cannot use the capability's Admin API routes, and its runtime entry points stop working for
 * tenants. Callers with global platform authority are exempt at the Admin API. Platform only: a
 * tenant can neither see these as its own nor change them. Every capability is on by default.
 * API: GET/PATCH /api/admin/platform/settings/tenant-capabilities
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface TenantCapabilitiesSettings {
  'tenant_capabilities.webhooks': boolean;
  'tenant_capabilities.dynamic_client_registration': boolean;
  'tenant_capabilities.external_plugins': boolean;
  'tenant_capabilities.bulk_jobs': boolean;
}

/** The capabilities the platform can turn off for tenants (the names clients see). */
export const TENANT_CAPABILITIES = [
  'webhooks',
  'dynamic_client_registration',
  'external_plugins',
  'bulk_jobs',
] as const;

export type TenantCapability = (typeof TENANT_CAPABILITIES)[number];

export const TENANT_CAPABILITIES_CATEGORY = 'tenant-capabilities';

/** The settings key of a capability's switch. */
export function tenantCapabilitySettingKey(
  capability: TenantCapability
): keyof TenantCapabilitiesSettings {
  return `tenant_capabilities.${capability}`;
}

export function isTenantCapability(value: unknown): value is TenantCapability {
  return typeof value === 'string' && (TENANT_CAPABILITIES as readonly string[]).includes(value);
}

export const TENANT_CAPABILITIES_SETTINGS_META: Record<
  keyof TenantCapabilitiesSettings,
  SettingMeta
> = {
  'tenant_capabilities.webhooks': {
    key: 'tenant_capabilities.webhooks',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_WEBHOOKS',
    label: 'Tenants may use webhooks',
    description:
      'Off: tenants cannot manage webhooks through the Admin API, and no webhook is delivered for a tenant. Events that occur while it is off are discarded and not delivered later. Due account webhook events waiting in the queue are discarded as they are processed and recorded in the audit log (webhook.outbox.dropped); events still waiting at the moment it is turned back on are delivered. Platform administrators are exempt at the Admin API.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.dynamic_client_registration': {
    key: 'tenant_capabilities.dynamic_client_registration',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_DYNAMIC_CLIENT_REGISTRATION',
    label: 'Tenants may use dynamic client registration',
    description:
      'Off: public registration (POST /register), the client configuration endpoints and initial access tokens refuse, discovery stops advertising the registration endpoint, and tenants cannot change their dynamic client registration settings.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.external_plugins': {
    key: 'tenant_capabilities.external_plugins',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_EXTERNAL_PLUGINS',
    label: 'Tenants may use external plugins',
    description:
      'Off: nothing executes from external plugins for tenants, and no one can enable one (platform administrators included). Tenants cannot change their credentials or plugin settings; platform administrators can still manage credentials and settings, but nothing runs for tenants. Built-in plugins (e-mail notifiers, CAPTCHA, TOTP) are not affected. A tenant backup restore does not restore external plugin installations.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.bulk_jobs': {
    key: 'tenant_capabilities.bulk_jobs',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_BULK_JOBS',
    label: 'Tenants may run bulk jobs',
    description:
      'Off: tenants cannot create bulk jobs (user import, bulk update, report generation, bulk organization members), nor can platform administrators. Queued jobs do not start: they end as blocked and must be created again once it is back on. Existing jobs and results stay readable.',
    scopes: ['platform'],
    visibility: 'admin',
  },
};

export const TENANT_CAPABILITIES_CATEGORY_META: CategoryMeta = {
  category: TENANT_CAPABILITIES_CATEGORY,
  label: 'Tenant Capabilities',
  description: 'Capabilities the platform can turn off for tenants',
  settings: TENANT_CAPABILITIES_SETTINGS_META,
};

export const TENANT_CAPABILITIES_DEFAULTS: TenantCapabilitiesSettings = {
  'tenant_capabilities.webhooks': true,
  'tenant_capabilities.dynamic_client_registration': true,
  'tenant_capabilities.external_plugins': true,
  'tenant_capabilities.bulk_jobs': true,
};
