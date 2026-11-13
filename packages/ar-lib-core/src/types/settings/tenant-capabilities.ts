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
  'tenant_capabilities.admin_sent_email': boolean;
  'tenant_capabilities.machine_credentials': boolean;
  'tenant_capabilities.email_provider_config': boolean;
  'tenant_capabilities.directory_connectors': boolean;
  'tenant_capabilities.external_identity_providers': boolean;
  'tenant_capabilities.saml_metadata_url': boolean;
}

/** The capabilities the platform can turn off for tenants (the names clients see). */
export const TENANT_CAPABILITIES = [
  'webhooks',
  'dynamic_client_registration',
  'external_plugins',
  'bulk_jobs',
  'admin_sent_email',
  'machine_credentials',
  'email_provider_config',
  'directory_connectors',
  'external_identity_providers',
  'saml_metadata_url',
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
  'tenant_capabilities.admin_sent_email': {
    key: 'tenant_capabilities.admin_sent_email',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_ADMIN_SENT_EMAIL',
    label: 'Tenants may have admins send e-mail',
    description:
      'Off: an administrator of a tenant cannot make the deployment send e-mail on request: the send-email action for a user, sign-up invitations addressed to an e-mail address, admin invitations delivered by e-mail (create and resend) and the test e-mail of an e-mail provider plugin. Admin invitations whose code is handed back in the API response (code_delivery response) send no e-mail and are not affected. E-mail sent by end-user flows (sign-in codes, verification) is not affected. Platform administrators are exempt at the Admin API.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.machine_credentials': {
    key: 'tenant_capabilities.machine_credentials',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_MACHINE_CREDENTIALS',
    label: 'Tenants may issue machine credentials',
    description:
      'Off: tenant administrators cannot issue new long-lived machine credentials: creating, rotating or re-enabling machine access principals and credentials (and changing their permissions, tenants or validity), creating SCIM tokens, and creating or rotating Check API keys. Listing, revoking, disabling and deleting stay possible. Credentials already issued keep working until they are revoked or expire. Platform administrators are exempt at the Admin API.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.email_provider_config': {
    key: 'tenant_capabilities.email_provider_config',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_EMAIL_PROVIDER_CONFIG',
    label: 'Tenants may choose their e-mail provider',
    description:
      'Off: tenant administrators cannot change which provider or sender the tenant e-mail goes through: the tenant e-mail settings (provider order) and the configuration, reset and enabling of the built-in e-mail notifier plugins. Reading, and disabling a notifier plugin, stay possible. Platform administrators are exempt at the Admin API.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.directory_connectors': {
    key: 'tenant_capabilities.directory_connectors',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_DIRECTORY_CONNECTORS',
    label: 'Tenants may configure directory connectors',
    description:
      'Off: tenant administrators cannot make the platform reach a directory connector endpoint they chose: saving directory connector settings (except a save that only removes connectors, switches directory sign-in off or keeps the stored connectors as they are), issuing and rotating connector secrets, and the connector health check. Reading stays possible. Connectors already configured keep working. Platform administrators are exempt at the Admin API. A tenant backup restore does not bring back directory connector settings while it is off, unless a platform administrator asked for it.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.external_identity_providers': {
    key: 'tenant_capabilities.external_identity_providers',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_EXTERNAL_IDENTITY_PROVIDERS',
    label: 'Tenants may configure external identity providers',
    description:
      'Off: tenant administrators cannot add or change external identity providers (create, update, OIDC discovery and dynamic client registration at the provider). Reading and deleting stay possible. Providers already configured keep working. Platform administrators are exempt at the Admin API. A tenant backup restore does not bring back external identity providers while it is off, unless a platform administrator asked for it.',
    scopes: ['platform'],
    visibility: 'admin',
  },
  'tenant_capabilities.saml_metadata_url': {
    key: 'tenant_capabilities.saml_metadata_url',
    type: 'boolean',
    default: true,
    envKey: 'TENANT_CAPABILITIES_SAML_METADATA_URL',
    label: 'Tenants may fetch SAML metadata from a URL',
    description:
      'Off: tenant administrators cannot make the platform fetch SAML metadata from a URL they chose, or store a new URL for later fetching: metadata preview, import, refresh and certificate preview with a URL, and saving a SAML provider or a federation source with a new or changed metadata URL. Pasting metadata XML, keeping or clearing a stored URL, reading and deleting stay possible. URLs already stored keep being refreshed automatically. Platform administrators are exempt at the Admin API. A tenant backup restore does not bring back providers or sources that carry a metadata URL while it is off, unless a platform administrator asked for it.',
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
  'tenant_capabilities.admin_sent_email': true,
  'tenant_capabilities.machine_credentials': true,
  'tenant_capabilities.email_provider_config': true,
  'tenant_capabilities.directory_connectors': true,
  'tenant_capabilities.external_identity_providers': true,
  'tenant_capabilities.saml_metadata_url': true,
};
