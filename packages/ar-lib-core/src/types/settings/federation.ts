/**
 * Federation Settings Category
 *
 * Settings related to identity federation (SAML, SCIM, etc.).
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/federation
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Federation Settings Interface
 */
export interface FederationSettings {
  // SAML Settings
  'federation.saml_enabled': boolean;
  'federation.saml_assertion_ttl': number;
  'federation.saml_request_ttl': number;
  'federation.saml_artifact_ttl': number;
  'federation.saml_artifact_resolution_timeout': number;
  'federation.saml_sso_binding': 'HTTP-POST' | 'HTTP-Redirect';
  'federation.saml_slo_binding': 'HTTP-POST' | 'HTTP-Redirect';
  'federation.saml_nameid_format': 'emailAddress' | 'persistent' | 'transient' | 'unspecified';

  'federation.scim_token_max_expiry': number;
  'federation.scim_token_default_expiry': number;
}

/**
 * Federation Settings Metadata
 */
export const FEDERATION_SETTINGS_META: Record<keyof FederationSettings, SettingMeta> = {
  'federation.saml_enabled': {
    key: 'federation.saml_enabled',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_SAML',
    label: 'SAML Enabled',
    description:
      'Whether this tenant answers SAML 2.0 requests: the IdP and SP endpoints and the metadata. Off refuses them all; registered providers are kept. The health check and the SAML admin API stay available.',
    visibility: 'public',
  },
  'federation.saml_assertion_ttl': {
    key: 'federation.saml_assertion_ttl',
    type: 'duration',
    default: 300,
    envKey: 'SAML_ASSERTION_TTL',
    label: 'SAML Assertion TTL',
    description:
      'How long a SAML assertion issued by Authrim is valid (NotOnOrAfter), in seconds. A service provider with its own assertion lifetime keeps it. Applies to assertions issued after the change.',
    min: 60,
    max: 600,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'federation.saml_request_ttl': {
    key: 'federation.saml_request_ttl',
    type: 'duration',
    default: 300,
    envKey: 'SAML_REQUEST_TTL',
    label: 'SAML Request TTL',
    description:
      'How long a SAML request (sign-in and logout) stays valid, in seconds: the age Authrim accepts of an incoming request, and how long the requests it sends are kept to match their responses. A change applies to the lifetime of requests made after it; the age of a request is also checked against the current value when a sign-in in progress resumes, so shortening it can reject sign-ins that have already started.',
    min: 60,
    max: 600,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'federation.saml_artifact_ttl': {
    key: 'federation.saml_artifact_ttl',
    type: 'duration',
    default: 120,
    envKey: 'SAML_ARTIFACT_TTL',
    label: 'SAML Artifact TTL',
    description: 'SAML artifact lifetime in seconds',
    min: 30,
    max: 300,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
    status: 'in_development',
  },
  'federation.saml_artifact_resolution_timeout': {
    key: 'federation.saml_artifact_resolution_timeout',
    type: 'duration',
    default: 5000,
    envKey: 'SAML_ARTIFACT_RESOLUTION_TIMEOUT',
    label: 'SAML Artifact Resolution Timeout',
    description: 'Timeout for SAML artifact resolution request in milliseconds',
    min: 1000,
    max: 30000,
    unit: 'ms',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
    status: 'in_development',
  },
  'federation.saml_sso_binding': {
    key: 'federation.saml_sso_binding',
    type: 'enum',
    default: 'HTTP-Redirect',
    envKey: 'SAML_SSO_BINDING',
    label: 'SAML SSO Binding',
    description:
      'The sign-in request binding a new identity provider gets when its metadata offers both or its settings name none. HTTP-Redirect carries a signed request; HTTP-POST carries an unsigned one. Existing providers are not changed.',
    enum: ['HTTP-POST', 'HTTP-Redirect'],
    visibility: 'admin',
  },
  'federation.saml_slo_binding': {
    key: 'federation.saml_slo_binding',
    type: 'enum',
    default: 'HTTP-Redirect',
    envKey: 'SAML_SLO_BINDING',
    label: 'SAML SLO Binding',
    description:
      'The logout request binding a new provider gets when its metadata offers both or its settings name none. A provider profile with its own logout binding (legacy: HTTP-POST) keeps it. Existing providers are not changed.',
    enum: ['HTTP-POST', 'HTTP-Redirect'],
    visibility: 'admin',
  },
  'federation.saml_nameid_format': {
    key: 'federation.saml_nameid_format',
    type: 'enum',
    default: 'emailAddress',
    envKey: 'SAML_NAMEID_FORMAT',
    label: 'SAML NameID Format',
    description:
      'The NameID format a new provider gets when its metadata names none (persistent gives each service its own identifier and protects privacy). A provider profile with its own NameID format keeps it. Existing providers are not changed.',
    enum: ['emailAddress', 'persistent', 'transient', 'unspecified'],
    visibility: 'admin',
  },

  'federation.scim_token_max_expiry': {
    key: 'federation.scim_token_max_expiry',
    type: 'duration',
    default: 31536000,
    envKey: 'SCIM_TOKEN_MAX_EXPIRY',
    label: 'SCIM Token Max Expiry',
    description:
      'The longest lifetime a new SCIM token can be given, in seconds (default and highest: 1 year). Tokens already issued keep their lifetime.',
    min: 86400,
    max: 31536000,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'federation.scim_token_default_expiry': {
    key: 'federation.scim_token_default_expiry',
    type: 'duration',
    default: 31536000,
    envKey: 'SCIM_TOKEN_DEFAULT_EXPIRY',
    label: 'SCIM Token Default Expiry',
    description:
      'The lifetime of a new SCIM token when the request names none, in seconds (default: 1 year, as before this setting applied). Never longer than the maximum. Tokens already issued keep their lifetime.',
    min: 86400,
    max: 31536000,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
};

/**
 * Federation Category Metadata
 */
export const FEDERATION_CATEGORY_META: CategoryMeta = {
  category: 'federation',
  label: 'Federation',
  description: 'Identity federation settings (SAML, account linking)',
  settings: FEDERATION_SETTINGS_META,
};

/**
 * Default Federation settings values
 */
export const FEDERATION_DEFAULTS: FederationSettings = {
  // SAML
  'federation.saml_enabled': true,
  'federation.saml_assertion_ttl': 300,
  'federation.saml_request_ttl': 300,
  'federation.saml_artifact_ttl': 120,
  'federation.saml_artifact_resolution_timeout': 5000,
  'federation.saml_sso_binding': 'HTTP-Redirect',
  'federation.saml_slo_binding': 'HTTP-Redirect',
  'federation.saml_nameid_format': 'emailAddress',
  'federation.scim_token_max_expiry': 31536000,
  'federation.scim_token_default_expiry': 31536000,
};
