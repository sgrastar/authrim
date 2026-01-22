/**
 * PII Encryption Configuration Manager
 *
 * Environment variable-based configuration for PII field encryption.
 *
 * Configurations:
 * - PII_ENCRYPTION_ENABLED: Enable/disable PII field encryption (default: true)
 * - PII_ENCRYPTION_ALGORITHM: Algorithm to use (default: AES-256-GCM)
 * - PII_ENCRYPTION_FIELDS: Fields to encrypt (default: email,phone_number,name,given_name,family_name)
 * - PII_ENCRYPTION_KEY_VERSION: Key version for rotation support (default: 1)
 *
 * Encrypted data format: enc:v{version}:{algorithm}:{base64_payload}
 * This self-describing format ensures data portability and future migration capability.
 */

import type { Env } from '../types/env';

/**
 * Supported encryption algorithms
 */
export type EncryptionAlgorithm = 'AES-256-GCM' | 'AES-256-CBC' | 'NONE';

/**
 * PII fields that can be encrypted
 */
export const ENCRYPTABLE_PII_FIELDS = [
  'email',
  'phone_number',
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'address_formatted',
  'address_street_address',
  'address_locality',
  'address_region',
  'address_postal_code',
  'address_country',
] as const;

export type EncryptablePIIField = (typeof ENCRYPTABLE_PII_FIELDS)[number];

/**
 * Encryption configuration values
 */
export interface EncryptionConfig {
  /** Enable PII field encryption */
  PII_ENCRYPTION_ENABLED: boolean;

  /** Encryption algorithm to use */
  PII_ENCRYPTION_ALGORITHM: EncryptionAlgorithm;

  /** Fields to encrypt */
  PII_ENCRYPTION_FIELDS: EncryptablePIIField[];

  /** Key version for key rotation support */
  PII_ENCRYPTION_KEY_VERSION: number;
}

/**
 * Default values for encryption configuration
 * Security-first: encryption is enabled by default
 */
export const DEFAULT_ENCRYPTION_CONFIG: EncryptionConfig = {
  PII_ENCRYPTION_ENABLED: true, // Enabled by default for security
  PII_ENCRYPTION_ALGORITHM: 'AES-256-GCM', // NIST recommended, AEAD
  PII_ENCRYPTION_FIELDS: [
    'email',
    'phone_number',
    'name',
    'given_name',
    'family_name',
  ] as EncryptablePIIField[],
  PII_ENCRYPTION_KEY_VERSION: 1,
};

/**
 * Configuration key names
 */
export const ENCRYPTION_CONFIG_NAMES = [
  'PII_ENCRYPTION_ENABLED',
  'PII_ENCRYPTION_ALGORITHM',
  'PII_ENCRYPTION_FIELDS',
  'PII_ENCRYPTION_KEY_VERSION',
] as const;

export type EncryptionConfigName = (typeof ENCRYPTION_CONFIG_NAMES)[number];

/**
 * Configuration metadata for Admin UI
 */
export const ENCRYPTION_CONFIG_METADATA: Record<
  EncryptionConfigName,
  {
    type: 'boolean' | 'select' | 'multiselect' | 'number';
    label: string;
    description: string;
    options?: string[];
    min?: number;
    max?: number;
  }
> = {
  PII_ENCRYPTION_ENABLED: {
    type: 'boolean',
    label: 'PII Encryption Enabled',
    description:
      'Enable encryption for PII fields. Requires PII_ENCRYPTION_KEY environment variable to be set.',
  },
  PII_ENCRYPTION_ALGORITHM: {
    type: 'select',
    label: 'Encryption Algorithm',
    description:
      'Algorithm for PII encryption. AES-256-GCM (recommended) provides authenticated encryption.',
    options: ['AES-256-GCM', 'AES-256-CBC', 'NONE'],
  },
  PII_ENCRYPTION_FIELDS: {
    type: 'multiselect',
    label: 'Fields to Encrypt',
    description: 'PII fields to encrypt. email_blind_index is always unencrypted for searching.',
    options: [...ENCRYPTABLE_PII_FIELDS],
  },
  PII_ENCRYPTION_KEY_VERSION: {
    type: 'number',
    label: 'Encryption Key Version',
    description: 'Current encryption key version. Used for key rotation and migration.',
    min: 1,
    max: 9999,
  },
};

/**
 * Parse boolean from string
 */
function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Algorithm mapping for type-safe parsing (Issue 4: type safety improvement)
 */
const ALGORITHM_MAP: Record<string, EncryptionAlgorithm> = {
  'AES-256-GCM': 'AES-256-GCM',
  'AES-256-CBC': 'AES-256-CBC',
  NONE: 'NONE',
};

/**
 * Parse algorithm from string
 */
function parseAlgorithm(
  value: string | undefined,
  defaultValue: EncryptionAlgorithm
): EncryptionAlgorithm {
  if (!value) return defaultValue;
  const normalized = value.toUpperCase();
  return ALGORITHM_MAP[normalized] ?? defaultValue;
}

/**
 * Parse fields array from comma-separated string
 * Use "none" to explicitly set an empty field list (Issue 5: allow empty list)
 */
function parseFields(
  value: string | undefined,
  defaultValue: EncryptablePIIField[]
): EncryptablePIIField[] {
  if (!value) return defaultValue;

  // Allow explicit "none" to set empty field list
  if (value.trim().toLowerCase() === 'none') {
    return [];
  }

  const fields = value
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f && ENCRYPTABLE_PII_FIELDS.includes(f as EncryptablePIIField));

  return fields.length > 0 ? (fields as EncryptablePIIField[]) : defaultValue;
}

/**
 * Parse number from string
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get encryption config from environment variables
 */
export function getEncryptionConfigFromEnv(env: Partial<Env>): EncryptionConfig {
  return {
    PII_ENCRYPTION_ENABLED: parseBool(
      env.ENABLE_PII_ENCRYPTION,
      DEFAULT_ENCRYPTION_CONFIG.PII_ENCRYPTION_ENABLED
    ),
    PII_ENCRYPTION_ALGORITHM: parseAlgorithm(
      env.PII_ENCRYPTION_ALGORITHM,
      DEFAULT_ENCRYPTION_CONFIG.PII_ENCRYPTION_ALGORITHM
    ),
    PII_ENCRYPTION_FIELDS: parseFields(
      env.PII_ENCRYPTION_FIELDS,
      DEFAULT_ENCRYPTION_CONFIG.PII_ENCRYPTION_FIELDS
    ),
    PII_ENCRYPTION_KEY_VERSION: parseNumber(
      env.PII_ENCRYPTION_KEY_VERSION,
      DEFAULT_ENCRYPTION_CONFIG.PII_ENCRYPTION_KEY_VERSION
    ),
  };
}

/**
 * Required key length for AES-256 (32 bytes = 64 hex characters)
 */
export const PII_ENCRYPTION_KEY_LENGTH = 64;

/**
 * Error thrown when encryption is enabled but key is not configured or invalid
 */
export class EncryptionKeyMissingError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'PII encryption is enabled but PII_ENCRYPTION_KEY is not set. ' +
          'Either set the encryption key or set ENABLE_PII_ENCRYPTION=false to disable encryption.'
    );
    this.name = 'EncryptionKeyMissingError';
  }
}

/**
 * Error thrown when encryption key has invalid format
 */
export class EncryptionKeyInvalidError extends Error {
  constructor(reason: string) {
    super(
      `PII_ENCRYPTION_KEY format is invalid: ${reason}. ` +
        `Key must be exactly ${PII_ENCRYPTION_KEY_LENGTH} hex characters (256-bit key). ` +
        'Generate a valid key with: openssl rand -hex 32'
    );
    this.name = 'EncryptionKeyInvalidError';
  }
}

/**
 * Detect weak key patterns (low entropy)
 * Returns reason string if weak, undefined if OK
 */
function detectWeakKeyPattern(key: string): string | undefined {
  const lowerKey = key.toLowerCase();

  // Check for all identical characters (e.g., "0000...0000", "aaaa...aaaa")
  if (/^(.)\1+$/.test(lowerKey)) {
    return 'key contains all identical characters (zero entropy)';
  }

  // Check for short repeating patterns (2-8 chars)
  for (let patternLen = 2; patternLen <= 8; patternLen++) {
    const pattern = lowerKey.slice(0, patternLen);
    const repeated = pattern
      .repeat(Math.ceil(lowerKey.length / patternLen))
      .slice(0, lowerKey.length);
    if (lowerKey === repeated) {
      return `key is a repeating pattern of "${pattern}"`;
    }
  }

  return undefined;
}

/**
 * Validate encryption key format (hex string of correct length)
 * Also checks for obviously weak key patterns
 */
function isValidEncryptionKey(key: string): { valid: boolean; reason?: string } {
  if (key.length !== PII_ENCRYPTION_KEY_LENGTH) {
    return {
      valid: false,
      reason: `expected ${PII_ENCRYPTION_KEY_LENGTH} characters, got ${key.length}`,
    };
  }
  // Check if all characters are valid hex
  if (!/^[0-9a-fA-F]+$/.test(key)) {
    return { valid: false, reason: 'contains non-hex characters' };
  }

  // Check for weak patterns
  const weakReason = detectWeakKeyPattern(key);
  if (weakReason) {
    return { valid: false, reason: weakReason };
  }

  return { valid: true };
}

/**
 * Encryption Configuration Manager
 *
 * Simple environment variable-based configuration manager.
 * Throws EncryptionKeyMissingError if encryption is enabled but key is not set (fail-fast).
 * Throws EncryptionKeyInvalidError if key format is invalid.
 */
export class EncryptionConfigManager {
  private config: EncryptionConfig;

  constructor(env: Partial<Env>) {
    this.config = getEncryptionConfigFromEnv(env);

    // Fail-fast validation - throw error if enabled but no key or invalid key
    if (this.config.PII_ENCRYPTION_ENABLED) {
      if (!env.PII_ENCRYPTION_KEY) {
        throw new EncryptionKeyMissingError();
      }
      const validation = isValidEncryptionKey(env.PII_ENCRYPTION_KEY);
      if (!validation.valid) {
        throw new EncryptionKeyInvalidError(validation.reason!);
      }
    }
  }

  /**
   * Check if PII encryption is enabled
   */
  async isEncryptionEnabled(): Promise<boolean> {
    return this.config.PII_ENCRYPTION_ENABLED;
  }

  /**
   * Get encryption algorithm
   */
  async getAlgorithm(): Promise<EncryptionAlgorithm> {
    return this.config.PII_ENCRYPTION_ALGORITHM;
  }

  /**
   * Get fields to encrypt
   */
  async getEncryptionFields(): Promise<EncryptablePIIField[]> {
    return this.config.PII_ENCRYPTION_FIELDS;
  }

  /**
   * Get encryption key version
   */
  async getKeyVersion(): Promise<number> {
    return this.config.PII_ENCRYPTION_KEY_VERSION;
  }

  /**
   * Get all encryption configuration values
   */
  async getAllConfig(): Promise<EncryptionConfig> {
    return { ...this.config };
  }

  /**
   * Check if a specific field should be encrypted
   */
  async shouldEncryptField(field: string): Promise<boolean> {
    if (!this.config.PII_ENCRYPTION_ENABLED) return false;
    if (this.config.PII_ENCRYPTION_ALGORITHM === 'NONE') return false;
    return this.config.PII_ENCRYPTION_FIELDS.includes(field as EncryptablePIIField);
  }

  /**
   * Get configuration status for diagnostics
   */
  getStatus(): {
    enabled: boolean;
    algorithm: EncryptionAlgorithm;
    fields: EncryptablePIIField[];
    keyVersion: number;
  } {
    return {
      enabled: this.config.PII_ENCRYPTION_ENABLED,
      algorithm: this.config.PII_ENCRYPTION_ALGORITHM,
      fields: this.config.PII_ENCRYPTION_FIELDS,
      keyVersion: this.config.PII_ENCRYPTION_KEY_VERSION,
    };
  }
}

/**
 * Create an encryption config manager
 */
export function createEncryptionConfigManager(env: Partial<Env>): EncryptionConfigManager {
  return new EncryptionConfigManager(env);
}
