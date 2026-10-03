/**
 * Credentials Settings Category
 *
 * Settings related to user credentials (passwords, passkeys, email codes).
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/credentials
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Credentials Settings Interface
 */
export interface CredentialsSettings {
  // Passkey Settings
  'credentials.passkey_registration_ttl': number;
  'credentials.passkey_expiry': number;

  // Email Code Settings
  'credentials.email_code_ttl': number;
  'credentials.email_code_length': number;

  // DID Settings
  'credentials.did_link_ttl': number;
  'credentials.did_auth_ttl': number;
  'credentials.did_session_ttl': number;
}

/**
 * Credentials Settings Metadata
 */
export const CREDENTIALS_SETTINGS_META: Record<keyof CredentialsSettings, SettingMeta> = {
  'credentials.passkey_registration_ttl': {
    key: 'credentials.passkey_registration_ttl',
    type: 'duration',
    default: 300,
    envKey: 'PASSKEY_REGISTRATION_TTL',
    label: 'Passkey Registration TTL',
    description: 'Passkey registration challenge lifetime in seconds',
    min: 60,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'credentials.passkey_expiry': {
    key: 'credentials.passkey_expiry',
    type: 'duration',
    default: 2592000,
    envKey: 'PASSKEY_EXPIRY',
    label: 'Passkey Expiry',
    description: 'Passkey authenticator lifetime in seconds (default: 30 days)',
    min: 86400,
    max: 31536000,
    unit: 'seconds',
    visibility: 'admin',
  },
  'credentials.email_code_ttl': {
    key: 'credentials.email_code_ttl',
    integer: true,
    type: 'duration',
    default: 300,
    envKey: 'EMAIL_CODE_TTL',
    label: 'Email Code TTL',
    description:
      'Lifetime in seconds of emailed sign-in, sign-up (guest registration included) and re-authentication codes, never past the sign-in they continue (the email states it, rounded up to minutes)',
    min: 60,
    max: 900,
    unit: 'seconds',
    visibility: 'public',
  },
  'credentials.email_code_length': {
    key: 'credentials.email_code_length',
    type: 'number',
    default: 6,
    envKey: 'EMAIL_CODE_LENGTH',
    label: 'Email Code Length',
    description: 'Number of digits in email verification code',
    min: 4,
    max: 8,
    visibility: 'admin',
  },
  'credentials.did_link_ttl': {
    key: 'credentials.did_link_ttl',
    type: 'duration',
    default: 300,
    envKey: 'DID_LINK_TTL',
    label: 'DID Link TTL',
    description: 'DID link challenge lifetime in seconds',
    min: 60,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'credentials.did_auth_ttl': {
    key: 'credentials.did_auth_ttl',
    type: 'duration',
    default: 300,
    envKey: 'DID_AUTH_TTL',
    label: 'DID Auth TTL',
    description: 'DID authentication challenge lifetime in seconds',
    min: 60,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'credentials.did_session_ttl': {
    key: 'credentials.did_session_ttl',
    type: 'duration',
    default: 86400,
    envKey: 'DID_SESSION_TTL',
    label: 'DID Session TTL',
    description: 'DID session lifetime in seconds (default: 24 hours)',
    min: 3600,
    max: 604800,
    unit: 'seconds',
    visibility: 'admin',
  },
};

/**
 * Credentials Category Metadata
 */
export const CREDENTIALS_CATEGORY_META: CategoryMeta = {
  category: 'credentials',
  label: 'Credentials',
  description: 'User credential settings (passkeys, email codes, DID)',
  settings: CREDENTIALS_SETTINGS_META,
};

/**
 * Default Credentials settings values
 */
export const CREDENTIALS_DEFAULTS: CredentialsSettings = {
  'credentials.passkey_registration_ttl': 300,
  'credentials.passkey_expiry': 2592000,
  'credentials.email_code_ttl': 300,
  'credentials.email_code_length': 6,
  'credentials.did_link_ttl': 300,
  'credentials.did_auth_ttl': 300,
  'credentials.did_session_ttl': 86400,
};
