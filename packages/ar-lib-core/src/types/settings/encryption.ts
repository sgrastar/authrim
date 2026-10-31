/**
 * Encryption Settings Category (Platform)
 *
 * Platform-level encryption and key management settings (read-only via API).
 * API: GET /api/admin/platform/settings/encryption
 * Config Level: platform (read-only)
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Encryption Settings Interface
 */
export interface EncryptionSettings {}

/**
 * Encryption Settings Metadata
 */
export const ENCRYPTION_SETTINGS_META: Record<keyof EncryptionSettings, SettingMeta> = {};

/**
 * Encryption Category Metadata
 */
export const ENCRYPTION_CATEGORY_META: CategoryMeta = {
  category: 'encryption',
  label: 'Encryption',
  description:
    'Holds no settings: PII encryption is chosen at deployment (ENABLE_PII_ENCRYPTION and the key environment variables) and keys are managed with the key tools. To build elsewhere: scheduled signing-key rotation belongs to key management, not to this category.',
  settings: ENCRYPTION_SETTINGS_META,
};

/**
 * Default Encryption settings values
 */
export const ENCRYPTION_DEFAULTS: EncryptionSettings = {};
