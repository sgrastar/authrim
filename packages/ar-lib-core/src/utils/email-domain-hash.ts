/**
 * Email Domain Hash Utility
 *
 * Generates blind indexes for email domains to enable domain-based
 * policy evaluation without storing PII.
 *
 * Algorithm: HMAC-SHA256(lowercase(domain), secret_key)
 * Output: 64-character hex string
 *
 * Supports key rotation with versioned secrets.
 */

import type { Env } from '../types/env';
import type { EmailDomainHashConfig, DEFAULT_EMAIL_DOMAIN_HASH_CONFIG } from '../types/jit-config';

// =============================================================================
// Domain Normalization
// =============================================================================

/**
 * Extract and normalize domain from email address
 *
 * @param email - Email address (e.g., "User@Example.COM")
 * @returns Normalized domain (e.g., "example.com")
 * @throws Error if email format is invalid
 */
export function normalizeDomain(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1 || atIndex === email.length - 1) {
    // PII Protection: Don't include email in error message
    throw new Error('Invalid email format');
  }
  const domain = email
    .slice(atIndex + 1)
    .toLowerCase()
    .trim();
  if (domain.length === 0) {
    throw new Error('Invalid email format: empty domain');
  }
  return domain;
}

// =============================================================================
// Hash Generation
// =============================================================================

/**
 * Generate HMAC-SHA256 hash of domain
 *
 * @param domain - Normalized domain
 * @param secretKey - HMAC secret key
 * @returns 64-character hex string
 */
async function hmacSha256(domain: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const msgData = encoder.encode(domain);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, msgData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate email domain hash from email address
 *
 * @param email - Email address
 * @param secretKey - HMAC secret key
 * @returns 64-character hex string (blind index)
 */
export async function generateEmailDomainHash(email: string, secretKey: string): Promise<string> {
  const domain = normalizeDomain(email);
  return hmacSha256(domain, secretKey);
}

/**
 * Generate email domain hash with specific version
 *
 * @param email - Email address
 * @param config - Email domain hash configuration
 * @param version - Optional version (defaults to current_version)
 * @returns Hash and version used
 */
export async function generateEmailDomainHashWithVersion(
  email: string,
  config: EmailDomainHashConfig,
  version?: number
): Promise<{ hash: string; version: number }> {
  const targetVersion = version ?? config.current_version;
  const secret = config.secrets[targetVersion];

  if (!secret) {
    throw new Error(`No secret found for version ${targetVersion}`);
  }

  const hash = await generateEmailDomainHash(email, secret);
  return { hash, version: targetVersion };
}

/**
 * Generate hashes for all active versions
 * Used during migration to enable lookup by any version
 *
 * @param email - Email address
 * @param config - Email domain hash configuration
 * @returns Array of hashes with their versions
 */
export async function generateEmailDomainHashAllVersions(
  email: string,
  config: EmailDomainHashConfig
): Promise<Array<{ hash: string; version: number }>> {
  const results: Array<{ hash: string; version: number }> = [];

  for (const [versionStr, secret] of Object.entries(config.secrets)) {
    const version = parseInt(versionStr, 10);
    if (isNaN(version)) continue;

    // Skip deprecated versions unless migration is in progress
    if (!config.migration_in_progress && config.deprecated_versions.includes(version)) {
      continue;
    }

    const hash = await generateEmailDomainHash(email, secret);
    results.push({ hash, version });
  }

  return results;
}

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Get email domain hash configuration
 *
 * Priority: KV → ENV → Error
 *
 * @param env - Environment bindings
 * @returns EmailDomainHashConfig
 * @throws Error if no secret is configured
 */
export async function getEmailDomainHashConfig(env: Env): Promise<EmailDomainHashConfig> {
  // Try KV first
  if (env.SETTINGS) {
    try {
      const kvConfig = await env.SETTINGS.get('email_domain_hash_config');
      if (kvConfig) {
        const parsed = JSON.parse(kvConfig) as EmailDomainHashConfig;
        if (parsed.secrets && Object.keys(parsed.secrets).length > 0) {
          return parsed;
        }
      }
    } catch {
      // Ignore KV errors, fall through to env vars
    }
  }

  // Fall back to environment variable
  const envSecret = env.EMAIL_DOMAIN_HASH_SECRET;
  if (envSecret) {
    return {
      current_version: 1,
      secrets: { 1: envSecret },
      migration_in_progress: false,
      deprecated_versions: [],
      version: '1',
    };
  }

  // No configuration found
  throw new Error(
    'EMAIL_DOMAIN_HASH_SECRET not configured. ' +
      'Set it in environment variables or KV (email_domain_hash_config).'
  );
}

/**
 * Get secret for current version
 * Convenience function for simple use cases
 *
 * @param env - Environment bindings
 * @returns Secret key string
 */
export async function getEmailDomainHashSecret(env: Env): Promise<string> {
  const config = await getEmailDomainHashConfig(env);
  const secret = config.secrets[config.current_version];

  if (!secret) {
    throw new Error(`No secret found for current version ${config.current_version}`);
  }

  return secret;
}

// =============================================================================
// Migration Helpers
// =============================================================================

/**
 * Check if a hash version needs migration
 *
 * @param userVersion - User's current hash version
 * @param config - Email domain hash configuration
 * @returns True if user should be migrated to current version
 */
export function needsMigration(userVersion: number, config: EmailDomainHashConfig): boolean {
  if (!config.migration_in_progress) {
    return false;
  }
  return userVersion !== config.current_version;
}

/**
 * Check if a version is deprecated
 *
 * @param version - Version to check
 * @param config - Email domain hash configuration
 * @returns True if version is in deprecated list
 */
export function isDeprecatedVersion(version: number, config: EmailDomainHashConfig): boolean {
  return config.deprecated_versions.includes(version);
}

/**
 * Build SQL WHERE clause for domain hash lookup
 * Handles multiple versions during migration
 *
 * @param domainHash - Primary domain hash to search
 * @param config - Email domain hash configuration
 * @param allHashes - Optional array of hashes for all versions
 * @returns SQL condition string and bind values
 */
export function buildDomainHashLookupCondition(
  domainHash: string,
  config: EmailDomainHashConfig,
  allHashes?: Array<{ hash: string; version: number }>
): { condition: string; values: string[] } {
  if (!config.migration_in_progress || !allHashes || allHashes.length <= 1) {
    // Simple case: single version lookup
    return {
      condition: 'domain_hash = ?',
      values: [domainHash],
    };
  }

  // Migration in progress: check all versions
  const placeholders = allHashes
    .map(() => '(domain_hash = ? AND domain_hash_version = ?)')
    .join(' OR ');
  const values: string[] = [];

  for (const { hash, version } of allHashes) {
    values.push(hash, version.toString());
  }

  return {
    condition: `(${placeholders})`,
    values,
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate email domain hash format
 *
 * @param hash - Hash to validate
 * @returns True if valid 64-character hex string
 */
export function isValidDomainHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

/**
 * Validate email domain hash configuration
 *
 * @param config - Configuration to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateDomainHashConfig(config: EmailDomainHashConfig): string[] {
  const errors: string[] = [];

  if (typeof config.current_version !== 'number' || config.current_version < 1) {
    errors.push('current_version must be a positive integer');
  }

  if (!config.secrets || typeof config.secrets !== 'object') {
    errors.push('secrets must be an object');
  } else {
    const versions = Object.keys(config.secrets).map((v) => parseInt(v, 10));

    if (versions.length === 0) {
      errors.push('secrets must contain at least one version');
    }

    if (!versions.includes(config.current_version)) {
      errors.push(`secrets must contain current_version (${config.current_version})`);
    }

    for (const [version, secret] of Object.entries(config.secrets)) {
      if (typeof secret !== 'string' || secret.length < 16) {
        errors.push(`Secret for version ${version} must be at least 16 characters`);
      }
    }
  }

  if (config.deprecated_versions) {
    for (const version of config.deprecated_versions) {
      if (version === config.current_version) {
        errors.push('current_version cannot be in deprecated_versions');
      }
    }
  }

  return errors;
}
