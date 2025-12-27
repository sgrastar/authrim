/**
 * SDK Compatibility Types
 *
 * Type definitions for SDK version compatibility checking.
 * This is a preparation stage for future SDK development.
 *
 * Request Header: Authrim-SDK-Version: authrim-js/1.0.0
 * Response Headers:
 * - X-Authrim-SDK-Warning: outdated; recommended=1.2.0
 * - X-Authrim-SDK-Recommended: 1.2.0
 *
 * @module sdk-compatibility-types
 * @see https://docs.authrim.com/sdk/versioning
 */

/**
 * SDK identifier format: {sdk-name}/{version}
 * Examples:
 * - authrim-js/1.0.0
 * - authrim-python/2.1.0
 * - authrim-go/0.5.0
 */
export type SdkVersionString = string;

/**
 * SDK version pattern: {name}/{semver}
 * name: lowercase letters, numbers, hyphens (1-50 chars, must start with letter)
 * version: semver format (x.y.z, each part 1-5 digits)
 *
 * Security: Pattern is designed to prevent ReDoS:
 * - SDK name limited to 50 chars with strict character set
 * - Version numbers limited to 5 digits each
 * - No nested quantifiers or ambiguous alternations
 */
export const SDK_VERSION_PATTERN = /^[a-z][a-z0-9-]{0,49}\/\d{1,5}\.\d{1,5}\.\d{1,5}$/;

/**
 * Maximum SDK version header length (security: prevent ReDoS/DoS)
 * Format: sdk-name/x.y.z (reasonable max: 100 chars)
 */
export const MAX_SDK_VERSION_LENGTH = 100;

/**
 * SDK compatibility status
 */
export type SdkCompatibilityStatus =
  | 'compatible' // SDK version is fully compatible
  | 'outdated' // SDK version is older than recommended
  | 'deprecated' // SDK version will be unsupported soon
  | 'unsupported' // SDK version is no longer supported
  | 'unknown'; // SDK not recognized

/**
 * SDK compatibility entry stored in KV
 *
 * KV key: sdk_compatibility:{sdk-name}
 * Example: sdk_compatibility:authrim-js
 */
export interface SdkCompatibilityEntry {
  /** Minimum supported version (semver) */
  minVersion: string;

  /** Recommended version (semver) */
  recommendedVersion: string;

  /** Latest available version (semver) */
  latestVersion: string;

  /** Deprecated versions that will be unsupported (semver list) */
  deprecatedVersions?: string[];

  /** Sunset date for deprecated versions (ISO 8601) */
  deprecationSunsetDate?: string;

  /** Whether this SDK is enabled for compatibility checking */
  enabled: boolean;

  /** Compatible API versions for this SDK */
  compatibleApiVersions?: string[];

  /** Download/documentation URL */
  documentationUrl?: string;
}

/**
 * Parsed SDK version info
 */
export interface ParsedSdkVersion {
  /** SDK name (e.g., "authrim-js") */
  name: string;

  /** SDK version (e.g., "1.0.0") */
  version: string;

  /** Parsed major version */
  major: number;

  /** Parsed minor version */
  minor: number;

  /** Parsed patch version */
  patch: number;
}

/**
 * SDK compatibility check result
 */
export interface SdkCompatibilityResult {
  /** Whether SDK version header was provided */
  hasHeader: boolean;

  /** Parsed SDK info (null if no header or invalid format) */
  sdk: ParsedSdkVersion | null;

  /** Compatibility status */
  status: SdkCompatibilityStatus;

  /** Warning message (if any) */
  warningMessage?: string;

  /** Recommended version to upgrade to */
  recommendedVersion?: string;

  /** Documentation URL for upgrade guide */
  documentationUrl?: string;
}

/**
 * SDK compatibility configuration (from KV or defaults)
 */
export interface SdkCompatibilityConfig {
  /** Whether SDK compatibility checking is enabled */
  enabled: boolean;

  /** Known SDKs and their compatibility info */
  sdks: Record<string, SdkCompatibilityEntry>;
}

/**
 * SDK compatibility context stored in Hono context
 */
export interface SdkCompatibilityContext {
  /** Check result */
  result: SdkCompatibilityResult;

  /** Whether any warning should be sent */
  hasWarning: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Request header for SDK version */
export const SDK_VERSION_REQUEST_HEADER = 'Authrim-SDK-Version';

/** Response header for SDK warning */
export const SDK_WARNING_HEADER = 'X-Authrim-SDK-Warning';

/** Response header for recommended SDK version */
export const SDK_RECOMMENDED_HEADER = 'X-Authrim-SDK-Recommended';

/** KV prefix for SDK compatibility entries */
export const SDK_COMPATIBILITY_PREFIX = 'sdk_compatibility:';

/** KV key for SDK compatibility config */
export const SDK_COMPATIBILITY_CONFIG_KEY = 'sdk_compatibility:config';

// ============================================================================
// Default Values
// ============================================================================

/** Default SDK compatibility config */
export const DEFAULT_SDK_COMPATIBILITY_CONFIG: SdkCompatibilityConfig = {
  enabled: false, // Disabled by default until SDKs are developed
  sdks: {},
};

/** Default SDK compatibility context */
export const DEFAULT_SDK_COMPATIBILITY_CONTEXT: SdkCompatibilityContext = {
  result: {
    hasHeader: false,
    sdk: null,
    status: 'unknown',
  },
  hasWarning: false,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse SDK version string
 *
 * Security: Validates length before regex to prevent ReDoS
 *
 * @param sdkVersion - SDK version string (e.g., "authrim-js/1.0.0")
 * @returns Parsed SDK version or null if invalid
 */
export function parseSdkVersion(sdkVersion: string): ParsedSdkVersion | null {
  // Security: Check length before regex (ReDoS prevention)
  if (!sdkVersion || sdkVersion.length > MAX_SDK_VERSION_LENGTH) {
    return null;
  }

  if (!SDK_VERSION_PATTERN.test(sdkVersion)) {
    return null;
  }

  const [name, version] = sdkVersion.split('/');
  const [majorStr, minorStr, patchStr] = version.split('.');

  // Parse version numbers with NaN protection
  const major = parseInt(majorStr, 10);
  const minor = parseInt(minorStr, 10);
  const patch = parseInt(patchStr, 10);

  // Should not happen due to regex, but defense-in-depth
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return null;
  }

  return {
    name,
    version,
    major,
    minor,
    patch,
  };
}

/**
 * Compare two semver versions
 *
 * Security: Returns null for invalid versions instead of treating them as 0.0.0
 * This prevents type coercion vulnerabilities where invalid versions could
 * be incorrectly compared as valid.
 *
 * @param v1 - First version (e.g., "1.0.0")
 * @param v2 - Second version (e.g., "1.2.0")
 * @returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2, null if either is invalid
 */
export function compareSemver(v1: string, v2: string): -1 | 0 | 1 | null {
  const parse = (v: string): [number, number, number] | null => {
    const parts = v.split('.');
    if (parts.length !== 3) return null;

    const nums = parts.map((p) => {
      const n = parseInt(p, 10);
      return Number.isNaN(n) ? null : n;
    });

    // Check if any part is invalid
    if (nums.some((n) => n === null)) return null;

    return [nums[0]!, nums[1]!, nums[2]!];
  };

  const parsed1 = parse(v1);
  const parsed2 = parse(v2);

  // Return null if either version is invalid
  if (!parsed1 || !parsed2) return null;

  const [major1, minor1, patch1] = parsed1;
  const [major2, minor2, patch2] = parsed2;

  if (major1 !== major2) return major1 < major2 ? -1 : 1;
  if (minor1 !== minor2) return minor1 < minor2 ? -1 : 1;
  if (patch1 !== patch2) return patch1 < patch2 ? -1 : 1;
  return 0;
}

/**
 * Format SDK warning message
 *
 * @param status - Compatibility status
 * @param recommendedVersion - Recommended version
 * @returns Formatted warning message
 */
export function formatSdkWarning(
  status: SdkCompatibilityStatus,
  recommendedVersion?: string
): string {
  switch (status) {
    case 'outdated':
      return recommendedVersion ? `outdated; recommended=${recommendedVersion}` : 'outdated';
    case 'deprecated':
      return recommendedVersion ? `deprecated; recommended=${recommendedVersion}` : 'deprecated';
    case 'unsupported':
      return recommendedVersion ? `unsupported; recommended=${recommendedVersion}` : 'unsupported';
    default:
      return '';
  }
}
