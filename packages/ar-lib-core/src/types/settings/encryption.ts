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
export interface EncryptionSettings {
  // Key Management
  'encryption.key_rotation_enabled': boolean;
  'encryption.key_rotation_interval': number;
  'encryption.key_overlap_period': number;

  // Algorithm Settings
  'encryption.default_signing_alg': string;
  'encryption.default_encryption_alg': string;
  'encryption.default_encryption_enc': string;

  // PII Encryption
  'encryption.pii_encryption_enabled': boolean;
  'encryption.pii_key_derivation': string;
  'encryption.pii_algorithm': string;
  'encryption.pii_fields': string;
  'encryption.pii_key_version': string;

  // RP Token Encryption
  'encryption.rp_token_encryption_enabled': boolean;

  // Domain Hash
  'encryption.domain_hash_enabled': boolean;
  'encryption.domain_hash_salt_rotation': number;

  // Password Hashing (read-only, informational)
  'encryption.password_iterations': number;
  'encryption.password_version': string;
}

/**
 * Encryption Settings Metadata
 */
export const ENCRYPTION_SETTINGS_META: Record<keyof EncryptionSettings, SettingMeta> = {
  'encryption.key_rotation_enabled': {
    key: 'encryption.key_rotation_enabled',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_KEY_ROTATION',
    label: 'Key Rotation Enabled',
    description: 'Enable automatic key rotation',
    visibility: 'admin',
  },
  'encryption.key_rotation_interval': {
    key: 'encryption.key_rotation_interval',
    type: 'duration',
    default: 7776000,
    envKey: 'KEY_ROTATION_INTERVAL',
    label: 'Key Rotation Interval',
    description: 'Key rotation interval in seconds (default: 90 days)',
    min: 86400,
    max: 31536000,
    unit: 'seconds',
    visibility: 'admin',
  },
  'encryption.key_overlap_period': {
    key: 'encryption.key_overlap_period',
    type: 'duration',
    default: 604800,
    envKey: 'KEY_OVERLAP_PERIOD',
    label: 'Key Overlap Period',
    description: 'Period during which old key remains valid (default: 7 days)',
    min: 3600,
    max: 2592000,
    unit: 'seconds',
    visibility: 'admin',
  },
  'encryption.default_signing_alg': {
    key: 'encryption.default_signing_alg',
    type: 'string',
    default: 'RS256',
    envKey: 'DEFAULT_SIGNING_ALG',
    label: 'Default Signing Algorithm',
    description: 'Default JWT signing algorithm',
    visibility: 'admin',
  },
  'encryption.default_encryption_alg': {
    key: 'encryption.default_encryption_alg',
    type: 'string',
    default: 'RSA-OAEP-256',
    envKey: 'DEFAULT_ENCRYPTION_ALG',
    label: 'Default Encryption Algorithm',
    description: 'Default JWE key encryption algorithm',
    visibility: 'admin',
  },
  'encryption.default_encryption_enc': {
    key: 'encryption.default_encryption_enc',
    type: 'string',
    default: 'A256GCM',
    envKey: 'DEFAULT_ENCRYPTION_ENC',
    label: 'Default Encryption Encoding',
    description: 'Default JWE content encryption algorithm',
    visibility: 'admin',
  },
  'encryption.pii_encryption_enabled': {
    key: 'encryption.pii_encryption_enabled',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_PII_ENCRYPTION',
    label: 'PII Encryption Enabled',
    description: 'Enable encryption of personally identifiable information',
    visibility: 'admin',
  },
  'encryption.pii_key_derivation': {
    key: 'encryption.pii_key_derivation',
    type: 'string',
    default: 'HKDF-SHA256',
    envKey: 'PII_KEY_DERIVATION',
    label: 'PII Key Derivation',
    description: 'Key derivation function for PII encryption',
    visibility: 'internal',
  },
  'encryption.domain_hash_enabled': {
    key: 'encryption.domain_hash_enabled',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_DOMAIN_HASH',
    label: 'Domain Hash Enabled',
    description: 'Enable email domain hashing for privacy',
    visibility: 'admin',
  },
  'encryption.domain_hash_salt_rotation': {
    key: 'encryption.domain_hash_salt_rotation',
    type: 'duration',
    default: 2592000,
    envKey: 'DOMAIN_HASH_SALT_ROTATION',
    label: 'Domain Hash Salt Rotation',
    description: 'Salt rotation interval for domain hashing (default: 30 days)',
    min: 86400,
    max: 31536000,
    unit: 'seconds',
    visibility: 'internal',
  },

  // PII Encryption Extended
  'encryption.pii_algorithm': {
    key: 'encryption.pii_algorithm',
    type: 'enum',
    default: 'AES-256-GCM',
    envKey: 'PII_ENCRYPTION_ALGORITHM',
    label: 'PII Encryption Algorithm',
    description: 'Algorithm for PII field encryption',
    enum: ['AES-256-GCM'],
    visibility: 'admin',
  },
  'encryption.pii_fields': {
    key: 'encryption.pii_fields',
    type: 'string',
    default: 'email,phone_number,name,given_name,family_name',
    envKey: 'PII_ENCRYPTION_FIELDS',
    label: 'PII Encrypted Fields',
    description: 'Comma-separated list of fields to encrypt (email, phone_number, name, etc.)',
    visibility: 'admin',
  },
  'encryption.pii_key_version': {
    key: 'encryption.pii_key_version',
    type: 'string',
    default: '1',
    envKey: 'PII_ENCRYPTION_KEY_VERSION',
    label: 'PII Key Version',
    description: 'Current encryption key version for key rotation tracking',
    visibility: 'admin',
  },

  // RP Token Encryption
  'encryption.rp_token_encryption_enabled': {
    key: 'encryption.rp_token_encryption_enabled',
    type: 'boolean',
    default: true,
    envKey: 'RP_TOKEN_ENCRYPTION_ENABLED',
    label: 'RP Token Encryption Enabled',
    description: 'Enable encryption of external IdP tokens at rest',
    visibility: 'admin',
  },

  // Password Hashing (informational, internal)
  'encryption.password_iterations': {
    key: 'encryption.password_iterations',
    type: 'number',
    default: 600000,
    envKey: 'PASSWORD_ITERATIONS',
    label: 'Password Hash Iterations',
    description: 'PBKDF2 iteration count (OWASP 2023 recommended)',
    min: 100000,
    max: 1000000,
    visibility: 'internal',
  },
  'encryption.password_version': {
    key: 'encryption.password_version',
    type: 'string',
    default: 'pbkdf2v1',
    envKey: 'PASSWORD_VERSION',
    label: 'Password Hash Version',
    description: 'Password hashing algorithm version identifier',
    visibility: 'internal',
  },
};

/**
 * Encryption Category Metadata
 */
export const ENCRYPTION_CATEGORY_META: CategoryMeta = {
  category: 'encryption',
  label: 'Encryption',
  description: 'Platform-level encryption and key management (read-only)',
  settings: ENCRYPTION_SETTINGS_META,
};

/**
 * Default Encryption settings values
 */
export const ENCRYPTION_DEFAULTS: EncryptionSettings = {
  'encryption.key_rotation_enabled': true,
  'encryption.key_rotation_interval': 7776000,
  'encryption.key_overlap_period': 604800,
  'encryption.default_signing_alg': 'RS256',
  'encryption.default_encryption_alg': 'RSA-OAEP-256',
  'encryption.default_encryption_enc': 'A256GCM',
  'encryption.pii_encryption_enabled': true,
  'encryption.pii_key_derivation': 'HKDF-SHA256',
  'encryption.pii_algorithm': 'AES-256-GCM',
  'encryption.pii_fields': 'email,phone_number,name,given_name,family_name',
  'encryption.pii_key_version': '1',
  'encryption.rp_token_encryption_enabled': true,
  'encryption.domain_hash_enabled': true,
  'encryption.domain_hash_salt_rotation': 2592000,
  'encryption.password_iterations': 600000,
  'encryption.password_version': 'pbkdf2v1',
};
