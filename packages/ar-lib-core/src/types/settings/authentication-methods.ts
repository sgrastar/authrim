/**
 * Authentication Methods Settings Category
 *
 * Settings for public Login UI authentication method discovery.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/authentication-methods
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface AuthenticationMethodsSettings {
  'authentication-methods.email_otp.guest_upgrade_enabled': boolean;
  'authentication-methods.passkey.guest_upgrade_enabled': boolean;
  'authentication-methods.guest.login_enabled': boolean;
  'authentication-methods.cache_ttl': number;
  'authentication-methods.passkey.login_enabled': boolean;
  'authentication-methods.passkey.signup_enabled': boolean;
  'authentication-methods.passkey.reauth_enabled': boolean;
  'authentication-methods.passkey.account_link_enabled': boolean;
  'authentication-methods.email_otp.login_enabled': boolean;
  'authentication-methods.email_otp.signup_enabled': boolean;
  'authentication-methods.email_otp.reauth_enabled': boolean;
  'authentication-methods.email_otp.account_link_enabled': boolean;
  'authentication-methods.totp.login_enabled': boolean;
  'authentication-methods.totp.signup_enabled': boolean;
  'authentication-methods.totp.reauth_enabled': boolean;
  'authentication-methods.totp.account_link_enabled': boolean;
  'authentication-methods.did.login_enabled': boolean;
  'authentication-methods.totp.preset': string;
  'authentication-methods.totp.default_acr': string;
  'authentication-methods.totp.requirement_policy': string;
  'authentication-methods.human_verification.provider': string;
  'authentication-methods.human_verification.login_enabled': boolean;
  'authentication-methods.human_verification.signup_enabled': boolean;
  'authentication-methods.human_verification.reauth_enabled': boolean;
  'authentication-methods.human_verification.pow_max_number': number;
  'authentication-methods.human_verification.pow_challenge_ttl': number;
  'authentication-methods.human_verification.pow_issue_per_ip_per_minute': number;
  'authentication-methods.human_verification.pow_issue_per_tenant_per_minute': number;
  'authentication-methods.human_verification.lite_txn_per_ip_per_minute': number;
  'authentication-methods.human_verification.lite_txn_per_tenant_per_minute': number;
  'authentication-methods.human_verification.lite_txn_per_browser': number;
  'authentication-methods.external_provider_usage': string;
  'authentication-methods.external_providers': string;
  'authentication-methods.directory_password.enabled': boolean;
  'authentication-methods.invitation.email_verification': 'optional' | 'required';
  'authentication-methods.signup.flow_required': boolean;
}

export const AUTHENTICATION_METHODS_SETTINGS_META: Record<
  keyof AuthenticationMethodsSettings,
  SettingMeta
> = {
  'authentication-methods.email_otp.guest_upgrade_enabled': {
    key: 'authentication-methods.email_otp.guest_upgrade_enabled',
    type: 'boolean',
    default: true,
    label: 'Email OTP guest upgrade',
    description: 'Enable this use independently of other authentication uses.',
    visibility: 'page',
  },
  'authentication-methods.passkey.guest_upgrade_enabled': {
    key: 'authentication-methods.passkey.guest_upgrade_enabled',
    type: 'boolean',
    default: true,
    label: 'Passkey guest upgrade',
    description: 'Enable this use independently of other authentication uses.',
    visibility: 'page',
  },
  'authentication-methods.guest.login_enabled': {
    key: 'authentication-methods.guest.login_enabled',
    type: 'boolean',
    default: false,
    label: 'Guest login',
    description: 'Enable this use independently of other authentication uses.',
    visibility: 'page',
  },
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
    default: false,
    label: 'Email OTP Login',
    description: 'Enable email one-time-code login in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.email_otp.signup_enabled': {
    key: 'authentication-methods.email_otp.signup_enabled',
    type: 'boolean',
    default: false,
    label: 'Email OTP Signup',
    description: 'Enable email one-time-code signup in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.email_otp.reauth_enabled': {
    key: 'authentication-methods.email_otp.reauth_enabled',
    type: 'boolean',
    default: false,
    label: 'Email OTP Re-authentication',
    description: 'Enable email one-time-code re-authentication in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.email_otp.account_link_enabled': {
    key: 'authentication-methods.email_otp.account_link_enabled',
    type: 'boolean',
    default: false,
    label: 'Email OTP Account Linking',
    description: 'Enable email one-time-code use for account linking flows',
    visibility: 'page',
  },
  'authentication-methods.totp.login_enabled': {
    key: 'authentication-methods.totp.login_enabled',
    type: 'boolean',
    default: false,
    label: 'TOTP Login',
    description: 'Enable authenticator-app TOTP login in the public Login UI',
    visibility: 'page',
  },
  'authentication-methods.totp.signup_enabled': {
    key: 'authentication-methods.totp.signup_enabled',
    type: 'boolean',
    default: false,
    label: 'TOTP Signup',
    description: 'Enable authenticator-app TOTP enrollment during signup',
    visibility: 'page',
  },
  'authentication-methods.totp.reauth_enabled': {
    key: 'authentication-methods.totp.reauth_enabled',
    type: 'boolean',
    default: false,
    label: 'TOTP Re-authentication',
    description: 'Enable authenticator-app TOTP for recent-authentication checks',
    visibility: 'page',
  },
  'authentication-methods.totp.account_link_enabled': {
    key: 'authentication-methods.totp.account_link_enabled',
    type: 'boolean',
    default: false,
    label: 'TOTP Account Linking',
    description: 'Enable authenticator-app TOTP use for account linking flows',
    visibility: 'page',
  },
  'authentication-methods.did.login_enabled': {
    key: 'authentication-methods.did.login_enabled',
    type: 'boolean',
    default: false,
    label: 'DID Login',
    description:
      'Allow accounts with a linked DID (did:web, did:key) to sign in by signing a challenge. Off unless the tenant turns it on',
    visibility: 'page',
  },
  'authentication-methods.totp.preset': {
    key: 'authentication-methods.totp.preset',
    type: 'string',
    default: 'compatible',
    label: 'TOTP Preset',
    description: 'TOTP compatibility preset: compatible or strong',
    visibility: 'admin',
  },
  'authentication-methods.totp.default_acr': {
    key: 'authentication-methods.totp.default_acr',
    type: 'string',
    default: 'urn:authrim:aal:2',
    label: 'TOTP Default ACR',
    description: 'Authentication Context Class Reference emitted after TOTP authentication',
    visibility: 'admin',
  },
  'authentication-methods.totp.requirement_policy': {
    key: 'authentication-methods.totp.requirement_policy',
    type: 'json',
    default: '{"mode":"optional","user_ids":[],"group_ids":[]}',
    label: 'TOTP Requirement Policy',
    description: 'JSON policy for optional or required TOTP enrollment by tenant, user, or group',
    visibility: 'admin',
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
  // The lite Login UI's proof of work (used only while the tenant is in lite mode).
  'authentication-methods.human_verification.pow_max_number': {
    key: 'authentication-methods.human_verification.pow_max_number',
    type: 'number',
    default: 25_000,
    envKey: 'LITE_POW_MAX_NUMBER',
    label: 'Lite Proof of Work Difficulty',
    description:
      'The largest number a lite Login UI proof of work may hide: a browser tries about half of it on average. Provisional until measured on low-end phones',
    min: 1_000,
    max: 10_000_000,
    integer: true,
    envNumber: 'in-range',
    visibility: 'admin',
  },
  'authentication-methods.human_verification.pow_challenge_ttl': {
    key: 'authentication-methods.human_verification.pow_challenge_ttl',
    type: 'number',
    default: 600,
    envKey: 'LITE_POW_CHALLENGE_TTL',
    label: 'Lite Proof of Work Lifetime',
    description: 'How long a lite Login UI proof of work can be solved and used',
    unit: 'seconds',
    min: 60,
    max: 3600,
    integer: true,
    envNumber: 'in-range',
    visibility: 'admin',
  },
  'authentication-methods.human_verification.pow_issue_per_ip_per_minute': {
    key: 'authentication-methods.human_verification.pow_issue_per_ip_per_minute',
    type: 'number',
    default: 30,
    envKey: 'LITE_POW_ISSUE_PER_IP_PER_MINUTE',
    label: 'Lite Proof of Work Issues per IP',
    description: 'How many lite Login UI proofs of work one IP address may be given per minute',
    min: 1,
    max: 10_000,
    integer: true,
    envNumber: 'in-range',
    visibility: 'admin',
  },
  'authentication-methods.human_verification.pow_issue_per_tenant_per_minute': {
    key: 'authentication-methods.human_verification.pow_issue_per_tenant_per_minute',
    type: 'number',
    default: 3_000,
    envKey: 'LITE_POW_ISSUE_PER_TENANT_PER_MINUTE',
    label: 'Lite Proof of Work Issues per Tenant',
    description: 'How many lite Login UI proofs of work the tenant may give out per minute in all',
    min: 1,
    max: 1_000_000,
    integer: true,
    envNumber: 'in-range',
    visibility: 'admin',
  },
  'authentication-methods.human_verification.lite_txn_per_ip_per_minute': {
    key: 'authentication-methods.human_verification.lite_txn_per_ip_per_minute',
    type: 'number',
    default: 60,
    envKey: 'LITE_TXN_PER_IP_PER_MINUTE',
    label: 'Lite Transactions per IP',
    description:
      'How many lite Login UI transactions one IP address may start per minute (a page view can start one before any proof of work)',
    min: 1,
    max: 100_000,
    integer: true,
    envNumber: 'in-range',
    visibility: 'admin',
  },
  'authentication-methods.human_verification.lite_txn_per_tenant_per_minute': {
    key: 'authentication-methods.human_verification.lite_txn_per_tenant_per_minute',
    type: 'number',
    default: 6_000,
    envKey: 'LITE_TXN_PER_TENANT_PER_MINUTE',
    label: 'Lite Transactions per Tenant',
    description: 'How many lite Login UI transactions the tenant may start per minute in all',
    min: 1,
    max: 1_000_000,
    integer: true,
    envNumber: 'in-range',
    visibility: 'admin',
  },
  'authentication-methods.human_verification.lite_txn_per_browser': {
    key: 'authentication-methods.human_verification.lite_txn_per_browser',
    type: 'number',
    default: 8,
    envKey: 'LITE_TXN_PER_BROWSER',
    label: 'Lite Transactions per Browser',
    description: 'How many live lite Login UI transactions one browser may hold at a time',
    min: 1,
    max: 64,
    integer: true,
    envNumber: 'in-range',
    visibility: 'admin',
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
  'authentication-methods.invitation.email_verification': {
    key: 'authentication-methods.invitation.email_verification',
    type: 'enum',
    enum: ['optional', 'required'],
    default: 'optional',
    label: 'Invitation Email Verification',
    description:
      'For an invitation that names an email: optional accepts the email a sign-up gives; required has the person prove it (an email code before a passkey or authenticator-app sign-up, an external IdP that reports the email verified)',
    visibility: 'admin',
  },
  'authentication-methods.signup.flow_required': {
    key: 'authentication-methods.signup.flow_required',
    type: 'boolean',
    default: false,
    label: 'Sign-up Only Through a Flow',
    description:
      'Accept a passkey, email code or authenticator-app sign-up only from a live Flow interaction at a sign-in step, its values checked against the screen of that step. Off, such a sign-up that names no interaction (an app with its own form) is checked against the Identity Schema alone. External IdP sign-ups carry no attributes and are not affected',
    visibility: 'page',
  },
};

export const AUTHENTICATION_METHODS_CATEGORY_META: CategoryMeta = {
  category: 'authentication-methods',
  label: 'Authentication Methods',
  description: 'Authentication method discovery and custom external provider settings',
  settings: AUTHENTICATION_METHODS_SETTINGS_META,
};

export const AUTHENTICATION_METHODS_DEFAULTS: AuthenticationMethodsSettings = {
  'authentication-methods.email_otp.guest_upgrade_enabled': true,
  'authentication-methods.passkey.guest_upgrade_enabled': true,
  'authentication-methods.guest.login_enabled': false,
  'authentication-methods.cache_ttl': 180,
  'authentication-methods.passkey.login_enabled': true,
  'authentication-methods.passkey.signup_enabled': true,
  'authentication-methods.passkey.reauth_enabled': true,
  'authentication-methods.passkey.account_link_enabled': true,
  'authentication-methods.email_otp.login_enabled': false,
  'authentication-methods.email_otp.signup_enabled': false,
  'authentication-methods.email_otp.reauth_enabled': false,
  'authentication-methods.email_otp.account_link_enabled': false,
  'authentication-methods.totp.login_enabled': false,
  'authentication-methods.totp.signup_enabled': false,
  'authentication-methods.totp.reauth_enabled': false,
  'authentication-methods.totp.account_link_enabled': false,
  'authentication-methods.did.login_enabled': false,
  'authentication-methods.totp.preset': 'compatible',
  'authentication-methods.totp.default_acr': 'urn:authrim:aal:2',
  'authentication-methods.totp.requirement_policy':
    '{"mode":"optional","user_ids":[],"group_ids":[]}',
  'authentication-methods.human_verification.provider': 'human-verification-cloudflare-turnstile',
  'authentication-methods.human_verification.login_enabled': false,
  'authentication-methods.human_verification.signup_enabled': false,
  'authentication-methods.human_verification.reauth_enabled': false,
  'authentication-methods.human_verification.pow_max_number': 25_000,
  'authentication-methods.human_verification.pow_challenge_ttl': 600,
  'authentication-methods.human_verification.pow_issue_per_ip_per_minute': 30,
  'authentication-methods.human_verification.pow_issue_per_tenant_per_minute': 3_000,
  'authentication-methods.human_verification.lite_txn_per_ip_per_minute': 60,
  'authentication-methods.human_verification.lite_txn_per_tenant_per_minute': 6_000,
  'authentication-methods.human_verification.lite_txn_per_browser': 8,
  'authentication-methods.external_provider_usage': '[]',
  'authentication-methods.external_providers': '[]',
  'authentication-methods.directory_password.enabled': false,
  'authentication-methods.invitation.email_verification': 'optional',
  'authentication-methods.signup.flow_required': false,
};
