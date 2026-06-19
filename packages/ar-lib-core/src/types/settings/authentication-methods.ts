/**
 * Authentication Methods Settings Category
 *
 * Settings for public Login UI authentication method discovery.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/authentication-methods
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface AuthenticationMethodsSettings {
  'authentication-methods.cache_ttl': number;
  'authentication-methods.passkey.login_enabled': boolean;
  'authentication-methods.passkey.signup_enabled': boolean;
  'authentication-methods.passkey.reauth_enabled': boolean;
  'authentication-methods.passkey.account_link_enabled': boolean;
  'authentication-methods.email_otp.login_enabled': boolean;
  'authentication-methods.email_otp.signup_enabled': boolean;
  'authentication-methods.email_otp.reauth_enabled': boolean;
  'authentication-methods.email_otp.account_link_enabled': boolean;
  'authentication-methods.human_verification.provider': string;
  'authentication-methods.human_verification.login_enabled': boolean;
  'authentication-methods.human_verification.signup_enabled': boolean;
  'authentication-methods.human_verification.reauth_enabled': boolean;
  'authentication-methods.external_provider_usage': string;
  'authentication-methods.external_providers': string;
  'authentication-methods.directory_password.enabled': boolean;
  'authentication-methods.directory_password.connector_id': string;
  'authentication-methods.directory_password.label': string;
  'authentication-methods.directory_password.auto_provision': boolean;
}

export const AUTHENTICATION_METHODS_SETTINGS_META: Record<
  keyof AuthenticationMethodsSettings,
  SettingMeta
> = {
  'authentication-methods.cache_ttl': {
    key: 'authentication-methods.cache_ttl',
    type: 'duration',
    default: 180,
    envKey: 'AUTHENTICATION_METHODS_CACHE_TTL',
    label: 'Cache TTL',
    description: 'Cache lifetime for the public authentication methods response',
    min: 0,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'authentication-methods.external_providers': {
    key: 'authentication-methods.external_providers',
    type: 'string',
    default: '[]',
    label: 'External Providers',
    description: 'JSON array of custom external login providers displayed by Login UI',
    visibility: 'page',
  },
  'authentication-methods.passkey.login_enabled': {
    key: 'authentication-methods.passkey.login_enabled',
    type: 'boolean',
    default: true,
    label: 'Passkey Login',
    description: 'Enable passkey login in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.passkey.signup_enabled': {
    key: 'authentication-methods.passkey.signup_enabled',
    type: 'boolean',
    default: true,
    label: 'Passkey Signup',
    description: 'Enable passkey signup in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.passkey.reauth_enabled': {
    key: 'authentication-methods.passkey.reauth_enabled',
    type: 'boolean',
    default: true,
    label: 'Passkey Re-authentication',
    description: 'Enable passkey re-authentication in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.passkey.account_link_enabled': {
    key: 'authentication-methods.passkey.account_link_enabled',
    type: 'boolean',
    default: true,
    label: 'Passkey Account Linking',
    description: 'Enable passkey use for account linking flows',
    visibility: 'page',
  },
  'authentication-methods.email_otp.login_enabled': {
    key: 'authentication-methods.email_otp.login_enabled',
    type: 'boolean',
    default: true,
    label: 'Email OTP Login',
    description: 'Enable email one-time-code login in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.email_otp.signup_enabled': {
    key: 'authentication-methods.email_otp.signup_enabled',
    type: 'boolean',
    default: true,
    label: 'Email OTP Signup',
    description: 'Enable email one-time-code signup in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.email_otp.reauth_enabled': {
    key: 'authentication-methods.email_otp.reauth_enabled',
    type: 'boolean',
    default: true,
    label: 'Email OTP Re-authentication',
    description: 'Enable email one-time-code re-authentication in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.email_otp.account_link_enabled': {
    key: 'authentication-methods.email_otp.account_link_enabled',
    type: 'boolean',
    default: true,
    label: 'Email OTP Account Linking',
    description: 'Enable email one-time-code use for account linking flows',
    visibility: 'page',
  },
  'authentication-methods.human_verification.provider': {
    key: 'authentication-methods.human_verification.provider',
    type: 'string',
    default: 'human-verification-cloudflare-turnstile',
    label: 'Human Verification Provider',
    description: 'Plugin provider used for Login UI human verification',
    visibility: 'admin',
  },
  'authentication-methods.human_verification.login_enabled': {
    key: 'authentication-methods.human_verification.login_enabled',
    type: 'boolean',
    default: false,
    label: 'Human Verification Login',
    description: 'Require human verification before login actions',
    visibility: 'page',
  },
  'authentication-methods.human_verification.signup_enabled': {
    key: 'authentication-methods.human_verification.signup_enabled',
    type: 'boolean',
    default: false,
    label: 'Human Verification Signup',
    description: 'Require human verification before signup actions',
    visibility: 'page',
  },
  'authentication-methods.human_verification.reauth_enabled': {
    key: 'authentication-methods.human_verification.reauth_enabled',
    type: 'boolean',
    default: false,
    label: 'Human Verification Re-authentication',
    description: 'Require human verification before re-authentication actions',
    visibility: 'page',
  },
  'authentication-methods.external_provider_usage': {
    key: 'authentication-methods.external_provider_usage',
    type: 'json',
    default: '[]',
    label: 'External Provider Usage',
    description: 'JSON array of per-provider authentication flow enablement settings',
    visibility: 'page',
  },
  'authentication-methods.directory_password.enabled': {
    key: 'authentication-methods.directory_password.enabled',
    type: 'boolean',
    default: false,
    label: 'Directory Password',
    description: 'Enable organization directory password login via Authrim Wordwarden',
    visibility: 'admin',
  },
  'authentication-methods.directory_password.connector_id': {
    key: 'authentication-methods.directory_password.connector_id',
    type: 'string',
    default: 'default',
    label: 'Directory Connector ID',
    description: 'Tenant-scoped Wordwarden connector ID used for directory password login',
    visibility: 'admin',
  },
  'authentication-methods.directory_password.label': {
    key: 'authentication-methods.directory_password.label',
    type: 'string',
    default: 'Organization ID',
    label: 'Directory Password Label',
    description: 'Public label shown for directory password login',
    visibility: 'page',
  },
  'authentication-methods.directory_password.auto_provision': {
    key: 'authentication-methods.directory_password.auto_provision',
    type: 'boolean',
    default: false,
    label: 'Directory Password Auto Provision',
    description:
      'Create an Authrim user automatically after successful directory verification when no mapped user exists',
    visibility: 'admin',
  },
};

export const AUTHENTICATION_METHODS_CATEGORY_META: CategoryMeta = {
  category: 'authentication-methods',
  label: 'Authentication Methods',
  description: 'Authentication method discovery and custom external provider settings',
  settings: AUTHENTICATION_METHODS_SETTINGS_META,
};

export const AUTHENTICATION_METHODS_DEFAULTS: AuthenticationMethodsSettings = {
  'authentication-methods.cache_ttl': 180,
  'authentication-methods.passkey.login_enabled': true,
  'authentication-methods.passkey.signup_enabled': true,
  'authentication-methods.passkey.reauth_enabled': true,
  'authentication-methods.passkey.account_link_enabled': true,
  'authentication-methods.email_otp.login_enabled': true,
  'authentication-methods.email_otp.signup_enabled': true,
  'authentication-methods.email_otp.reauth_enabled': true,
  'authentication-methods.email_otp.account_link_enabled': true,
  'authentication-methods.human_verification.provider': 'human-verification-cloudflare-turnstile',
  'authentication-methods.human_verification.login_enabled': false,
  'authentication-methods.human_verification.signup_enabled': false,
  'authentication-methods.human_verification.reauth_enabled': false,
  'authentication-methods.external_provider_usage': '[]',
  'authentication-methods.external_providers': '[]',
  'authentication-methods.directory_password.enabled': false,
  'authentication-methods.directory_password.connector_id': 'default',
  'authentication-methods.directory_password.label': 'Organization ID',
  'authentication-methods.directory_password.auto_provision': false,
};
