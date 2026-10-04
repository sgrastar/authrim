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
  // Email Code Settings
  'credentials.email_code_ttl': number;
}

/**
 * Credentials Settings Metadata
 */
export const CREDENTIALS_SETTINGS_META: Record<keyof CredentialsSettings, SettingMeta> = {
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
  'credentials.email_code_ttl': 300,
};
