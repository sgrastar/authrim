/**
 * DCR Settings Category
 *
 * Settings related to RFC 7591 Dynamic Client Registration.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/dcr
 * Config Level: tenant
 *
 * DCR allows OAuth clients to register dynamically without pre-registration.
 * These settings control DCR endpoint behavior and security policies.
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * DCR Settings Interface
 */
export interface DCRSettings {
  // Master switch
  'dcr.enabled': boolean;

  // Authentication
  'dcr.require_initial_access_token': boolean;

  // Scope restriction
  'dcr.scope_restriction_enabled': boolean;

  // Software ID handling
  'dcr.allow_duplicate_software_id': boolean;

  // Default access token target of newly registered clients
  'dcr.default_audience': string;
  'dcr.default_resource': string;
}

/**
 * DCR Settings Metadata
 *
 * Security considerations:
 * - dcr.enabled defaults to false: DCR must be explicitly enabled
 * - dcr.require_initial_access_token defaults to true: Protect against unauthorized registrations
 * - dcr.allow_duplicate_software_id defaults to false: Prevent client spoofing
 * - dcr.default_audience / dcr.default_resource default to '' (no default target): a target is only
 *   ever copied into a new client when the tenant sets one, and never overrides the issuer URL
 *   that authorization code clients get (see services/dcr-default-target.ts)
 */
export const DCR_SETTINGS_META: Record<keyof DCRSettings, SettingMeta> = {
  'dcr.enabled': {
    key: 'dcr.enabled',
    type: 'boolean',
    default: false, // Secure default: DCR disabled, must be explicitly enabled
    envKey: 'DCR_ENABLED',
    label: 'Enable Dynamic Client Registration',
    description:
      'Allow clients to register dynamically via /register endpoint. When disabled, all DCR requests return 403.',
    visibility: 'admin',
  },
  'dcr.require_initial_access_token': {
    key: 'dcr.require_initial_access_token',
    type: 'boolean',
    default: true, // Secure default: IAT required
    envKey: 'DCR_REQUIRE_INITIAL_ACCESS_TOKEN',
    label: 'Require Initial Access Token',
    description:
      'Require a valid Initial Access Token for client registration. When false, allows open registration.',
    visibility: 'admin',
  },
  'dcr.scope_restriction_enabled': {
    key: 'dcr.scope_restriction_enabled',
    type: 'boolean',
    default: false, // Default: no restriction (standard OIDC behavior)
    envKey: 'DCR_SCOPE_RESTRICTION_ENABLED',
    label: 'Enable Scope Restriction',
    description:
      "When enabled, clients can only request scopes specified during registration. The 'scope' parameter in registration becomes a whitelist.",
    visibility: 'admin',
  },
  'dcr.allow_duplicate_software_id': {
    key: 'dcr.allow_duplicate_software_id',
    type: 'boolean',
    default: false, // Secure default: prevent duplicate software_id
    envKey: 'DCR_ALLOW_DUPLICATE_SOFTWARE_ID',
    label: 'Allow Duplicate Software ID',
    description:
      'Allow multiple clients to register with the same software_id. When false, duplicate software_id registrations are rejected.',
    visibility: 'admin',
  },
  'dcr.default_audience': {
    key: 'dcr.default_audience',
    type: 'string',
    default: '',
    envKey: 'DCR_DEFAULT_AUDIENCE',
    label: 'Default Audience for New Apps',
    description:
      "Access token audience given to apps that register after this is set and have no default target: apps that register with a grant that uses a default target and not the authorization code grant, and send neither default_audience nor default_resource. Dynamic registration currently registers client credentials and CIBA apps from that set (device and token exchange apps are created through the admin API, which does not copy this default). It is copied into the app when it registers, so changing it later does not retarget apps already registered. Apps that use the authorization code grant keep their default (the issuer URL), and an app's own value always wins. An absolute URI or an opaque identifier, 2048 characters at most, without spaces; it cannot be an issuer URL of this tenant or its /userinfo URL (every issuer host the tenant's host and identifier policy allows is reserved, whether or not a custom domain or lookup routes it today). Empty: no default.",
    visibility: 'admin',
  },
  'dcr.default_resource': {
    key: 'dcr.default_resource',
    type: 'string',
    default: '',
    envKey: 'DCR_DEFAULT_RESOURCE',
    label: 'Default Resource for New Apps',
    description:
      "Resource indicator (RFC 8707) given to apps that register after this is set and have no default target: apps that register with a grant that uses a default target and not the authorization code grant, and send neither default_audience nor default_resource. Dynamic registration currently registers client credentials and CIBA apps from that set (device and token exchange apps are created through the admin API, which does not copy this default). It is copied into the app when it registers, so changing it later does not retarget apps already registered. Apps that use the authorization code grant keep their default (the issuer URL), and an app's own value always wins. An absolute https URI without a fragment (http only for localhost), 2048 characters at most; it cannot be an issuer URL of this tenant or its /userinfo URL (every issuer host the tenant's host and identifier policy allows is reserved, whether or not a custom domain or lookup routes it today). Empty: no default.",
    visibility: 'admin',
  },
};

/**
 * DCR Category Metadata
 */
export const DCR_CATEGORY_META: CategoryMeta = {
  category: 'dcr',
  label: 'Dynamic Client Registration',
  description: 'Configure RFC 7591 Dynamic Client Registration endpoint behavior and security',
  settings: DCR_SETTINGS_META,
};

/**
 * Default DCR settings values
 */
export const DCR_DEFAULTS: DCRSettings = {
  'dcr.enabled': false,
  'dcr.require_initial_access_token': true,
  'dcr.scope_restriction_enabled': false,
  'dcr.allow_duplicate_software_id': false,
  'dcr.default_audience': '',
  'dcr.default_resource': '',
};
