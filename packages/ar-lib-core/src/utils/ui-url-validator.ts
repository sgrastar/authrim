/**
 * UI URL Validation Utility
 *
 * Validates UI base URL (for login, consent, error pages) to prevent:
 * - Open Redirect attacks
 * - Protocol downgrade (HTTP → HTTPS)
 * - Unauthorized domain usage
 *
 * Security Model:
 * 1. HTTPS required (except localhost for development)
 * 2. Same-origin with ISSUER_URL: Always allowed
 * 3. Pre-registered in ALLOWED_ORIGINS: Allowed
 * 4. All others: Rejected
 *
 * This follows the same pattern as custom-redirect.ts for consistency.
 */

import { createLogger } from './logger';

const log = createLogger().module('UIUrlValidator');

/**
 * Result of UI URL validation
 */
export interface UIUrlValidationResult {
  /** Whether the URL is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Normalized URL (if valid) */
  normalizedUrl?: string;
  /** Reason why the URL was allowed */
  allowedReason?: 'same_origin' | 'pre_registered' | 'localhost';
}

/**
 * Validate UI base URL for security
 *
 * @param uiUrl - The UI base URL to validate
 * @param issuerUrl - The ISSUER_URL for same-origin comparison
 * @param allowedOrigins - Pre-registered allowed origins (from ALLOWED_ORIGINS)
 * @returns Validation result
 *
 * @example
 * // Same origin as issuer allowed
 * validateUIBaseUrl(
 *   'https://auth.example.com/ui',
 *   'https://auth.example.com',
 *   []
 * ); // { valid: true, allowedReason: 'same_origin' }
 *
 * // Pre-registered origin allowed
 * validateUIBaseUrl(
 *   'https://login.example.com',
 *   'https://auth.example.com',
 *   ['https://login.example.com']
 * ); // { valid: true, allowedReason: 'pre_registered' }
 *
 * // Unregistered origin rejected
 * validateUIBaseUrl(
 *   'https://evil.com',
 *   'https://auth.example.com',
 *   []
 * ); // { valid: false, error: 'Origin not allowed...' }
 */
export function validateUIBaseUrl(
  uiUrl: string | undefined | null,
  issuerUrl: string | undefined,
  allowedOrigins: string[]
): UIUrlValidationResult {
  // If no UI URL provided, nothing to validate
  if (!uiUrl || uiUrl.trim() === '') {
    return { valid: true };
  }

  // Parse UI URL
  let uiUrlParsed: URL;
  try {
    uiUrlParsed = new URL(uiUrl);
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format',
    };
  }

  // Fragment identifiers are forbidden
  if (uiUrlParsed.hash && uiUrlParsed.hash.length > 1) {
    return {
      valid: false,
      error: 'Fragment identifiers (#) are not allowed',
    };
  }

  // HTTPS required (localhost excepted for development)
  if (!isSecureProtocol(uiUrlParsed)) {
    return {
      valid: false,
      error: 'HTTPS is required (except localhost)',
    };
  }

  // Localhost is always allowed (development)
  if (isLocalhost(uiUrlParsed)) {
    return {
      valid: true,
      normalizedUrl: uiUrlParsed.origin + uiUrlParsed.pathname.replace(/\/$/, ''),
      allowedReason: 'localhost',
    };
  }

  // Parse ISSUER_URL for origin comparison
  if (issuerUrl) {
    try {
      const issuerParsed = new URL(issuerUrl);
      if (uiUrlParsed.origin.toLowerCase() === issuerParsed.origin.toLowerCase()) {
        return {
          valid: true,
          normalizedUrl: uiUrlParsed.origin + uiUrlParsed.pathname.replace(/\/$/, ''),
          allowedReason: 'same_origin',
        };
      }
    } catch {
      // ISSUER_URL is invalid, continue to allowlist check
      log.warn('ISSUER_URL is invalid, skipping same-origin check');
    }
  }

  // Allowlist check
  const normalizedUiOrigin = uiUrlParsed.origin.toLowerCase();
  const normalizedAllowedOrigins = allowedOrigins.map((o) => normalizeOrigin(o));

  if (normalizedAllowedOrigins.includes(normalizedUiOrigin)) {
    return {
      valid: true,
      normalizedUrl: uiUrlParsed.origin + uiUrlParsed.pathname.replace(/\/$/, ''),
      allowedReason: 'pre_registered',
    };
  }

  // Not allowed - potential Open Redirect
  return {
    valid: false,
    error: `Origin not allowed: ${uiUrlParsed.origin}. Must be same origin as ISSUER_URL or registered in ALLOWED_ORIGINS.`,
  };
}

/**
 * Parse ALLOWED_ORIGINS from environment variable (comma-separated)
 *
 * @param envValue - Environment variable value
 * @returns Array of origin strings
 */
export function parseAllowedOriginsEnv(envValue: string | undefined): string[] {
  if (!envValue) {
    return [];
  }
  return envValue
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Normalize an origin string for comparison
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin.toLowerCase();
  } catch {
    return origin.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Check if URL uses a secure protocol
 */
function isSecureProtocol(url: URL): boolean {
  if (url.protocol === 'https:') {
    return true;
  }

  // HTTP is only allowed for localhost
  if (url.protocol === 'http:') {
    return isLocalhost(url);
  }

  return false;
}

/**
 * Check if URL is localhost
 */
function isLocalhost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Log UI configuration change for audit trail
 *
 * @param action - The action performed (create, update, delete)
 * @param adminId - The admin who performed the action (if available)
 * @param details - Configuration change details
 */
export function logUIConfigChange(
  action: 'create' | 'update' | 'delete',
  adminId: string | undefined,
  details: {
    field: string;
    oldValue?: string | null;
    newValue?: string | null;
    validationResult?: UIUrlValidationResult;
  }
): void {
  // Always log to structured logger for audit trail
  log.info('UI config change', {
    action: action.toUpperCase(),
    adminId: adminId ?? 'unknown',
    field: details.field,
    oldValue: details.oldValue ?? 'null',
    newValue: details.newValue ?? 'null',
    allowedReason: details.validationResult?.allowedReason,
  });
}

/**
 * Log UI configuration validation failure
 */
export function logUIConfigValidationFailure(
  adminId: string | undefined,
  url: string,
  error: string
): void {
  log.warn('UI config validation rejected', {
    action: 'REJECTED',
    adminId: adminId ?? 'unknown',
    url,
    error,
  });
}
