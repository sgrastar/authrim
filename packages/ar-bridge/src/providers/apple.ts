/**
 * Apple Sign In Provider Configuration
 * Pre-configured settings for Apple OIDC authentication
 *
 * Apple Sign In is OIDC-compliant but has unique requirements:
 * - client_secret is a JWT signed with the app's private key (ES256)
 * - User name is only provided on first authorization (in POST body)
 * - ID token validation follows OIDC standard
 * - User may choose to hide their email (relay addresses)
 *
 * Key Concepts:
 * - Team ID: 10-character Apple Developer Team identifier
 * - Service ID: Identifier for the "Sign in with Apple" service
 * - Key ID: 10-character identifier for the private key
 * - Private Key: P-256 (ES256) key from Apple Developer Console (.p8 file)
 *
 * Scopes:
 * - openid: Required for OIDC (not explicitly listed but implied)
 * - name: Request user's name (only provided on first auth)
 * - email: Request user's email
 *
 * References:
 * - https://developer.apple.com/documentation/sign_in_with_apple
 * - https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api
 * - https://developer.apple.com/documentation/sign_in_with_apple/generate_and_validate_tokens
 */

import type { UpstreamProvider } from '../types';

// =============================================================================
// Apple Constants
// =============================================================================

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_AUTHORIZATION_ENDPOINT = 'https://appleid.apple.com/auth/authorize';
export const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
export const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';
export const APPLE_REVOCATION_ENDPOINT = 'https://appleid.apple.com/auth/revoke';

// =============================================================================
// Apple-Specific Quirks
// =============================================================================

/**
 * Apple provider quirks configuration
 */
export interface AppleProviderQuirks {
  /**
   * Apple Developer Team ID (10 characters)
   * Found in Apple Developer Account → Membership
   */
  teamId: string;

  /**
   * Sign in with Apple Key ID (10 characters)
   * Found in Apple Developer Console → Keys
   */
  keyId: string;

  /**
   * P-256 private key in PEM format (encrypted)
   * From the .p8 file downloaded from Apple Developer Console
   * Must be encrypted using envelope encryption before storage
   */
  privateKeyEncrypted: string;

  /**
   * JWT client_secret validity period in seconds
   * Default: 30 days (2592000)
   * Maximum: 6 months (15552000)
   */
  clientSecretTtl?: number;

  /**
   * Use form_post response mode
   * Recommended for better compatibility
   * Default: true
   */
  useFormPost?: boolean;
}

// =============================================================================
// Apple Default Configuration
// =============================================================================

/**
 * Default configuration for Apple provider
 * Use this as a template when creating a new Apple provider via Admin API
 *
 * Note: providerQuirks must be populated with valid values before use:
 * - teamId: Your Apple Developer Team ID
 * - keyId: Your Sign in with Apple Key ID
 * - privateKeyEncrypted: Your encrypted P-256 private key
 */
export const APPLE_DEFAULT_CONFIG: Partial<UpstreamProvider> = {
  name: 'Apple',
  providerType: 'oidc',
  issuer: APPLE_ISSUER,
  authorizationEndpoint: APPLE_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: APPLE_TOKEN_ENDPOINT,
  jwksUri: APPLE_JWKS_URI,
  // Note: Apple doesn't have a standard userinfo endpoint
  // User info comes from ID token and first-auth POST body
  userinfoEndpoint: undefined,
  // Request name and email (name only provided on first auth)
  scopes: 'openid name email',
  // Attribute mapping for ID token claims
  attributeMapping: {
    sub: 'sub', // Unique user identifier (stable per app)
    email: 'email',
    email_verified: 'email_verified',
    // Note: name is NOT in ID token, must be extracted from POST body
    // is_private_email: 'is_private_email', // Custom claim
  },
  autoLinkEmail: true,
  jitProvisioning: true,
  requireEmailVerified: true,
  iconUrl: 'https://www.apple.com/favicon.ico',
  buttonColor: '#000000',
  buttonText: 'Continue with Apple',
  providerQuirks: {
    teamId: '', // Required: Must be set by admin
    keyId: '', // Required: Must be set by admin
    privateKeyEncrypted: '', // Required: Must be set by admin
    clientSecretTtl: 2592000, // 30 days
    useFormPost: true,
  },
};

// =============================================================================
// Apple Claim Mappings
// =============================================================================

/**
 * Apple ID Token claims
 * Standard OIDC claims plus Apple-specific ones
 */
export const APPLE_CLAIM_MAPPINGS = {
  // Standard OIDC claims
  sub: 'sub', // User identifier (stable per app, not global)
  email: 'email',
  email_verified: 'email_verified',

  // Apple-specific claims
  is_private_email: 'is_private_email', // true if using relay email
  real_user_status: 'real_user_status', // 0=unsupported, 1=unknown, 2=likely_real
  nonce_supported: 'nonce_supported', // true if nonce validation is supported

  // Note: These are NOT in ID token, only in first-auth POST body
  // name: 'name', // From user object
  // given_name: 'name.firstName',
  // family_name: 'name.lastName',
};

/**
 * Real User Status values from Apple
 */
export const APPLE_REAL_USER_STATUS = {
  UNSUPPORTED: 0, // Device doesn't support
  UNKNOWN: 1, // Couldn't determine
  LIKELY_REAL: 2, // Likely a real person
} as const;

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate Apple-specific requirements
 */
export function validateAppleConfig(provider: Partial<UpstreamProvider>): string[] {
  const errors: string[] = [];

  if (!provider.clientId) {
    errors.push('clientId (Service ID or Bundle ID) is required');
  }

  // Apple doesn't use traditional client_secret, but we store it for consistency
  // The actual secret is generated dynamically from the private key
  // We allow empty clientSecretEncrypted since we use the private key instead

  const quirks = provider.providerQuirks as AppleProviderQuirks | undefined;

  // Validate Team ID
  if (!quirks?.teamId) {
    errors.push('providerQuirks.teamId (Apple Developer Team ID) is required');
  } else if (quirks.teamId.length !== 10) {
    errors.push('providerQuirks.teamId must be exactly 10 characters');
  }

  // Validate Key ID
  if (!quirks?.keyId) {
    errors.push('providerQuirks.keyId (Sign in with Apple Key ID) is required');
  } else if (quirks.keyId.length !== 10) {
    errors.push('providerQuirks.keyId must be exactly 10 characters');
  }

  // Validate private key (encrypted)
  if (!quirks?.privateKeyEncrypted) {
    errors.push('providerQuirks.privateKeyEncrypted (encrypted P-256 private key) is required');
  }

  // Validate TTL if provided
  if (quirks?.clientSecretTtl !== undefined) {
    if (quirks.clientSecretTtl <= 0) {
      errors.push('providerQuirks.clientSecretTtl must be positive');
    } else if (quirks.clientSecretTtl > 15552000) {
      errors.push('providerQuirks.clientSecretTtl cannot exceed 15552000 (6 months)');
    }
  }

  // Validate scopes
  const scopes = provider.scopes?.split(/[\s,]+/) || [];
  // Note: 'openid' is implied for Apple and doesn't need to be explicit
  // but we recommend including it for clarity
  if (!scopes.some((s) => ['name', 'email', 'openid'].includes(s))) {
    errors.push('At least one scope (name, email) is required');
  }

  return errors;
}

/**
 * Safely check if a URL's host matches expected hosts
 * This prevents URL substring attacks
 */
function urlHostMatches(url: string | undefined, allowedHosts: string[]): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return allowedHosts.some((allowed) => {
      const normalizedAllowed = allowed.toLowerCase();
      return host === normalizedAllowed || host.endsWith('.' + normalizedAllowed);
    });
  } catch {
    return false;
  }
}

/**
 * Check if a provider is Apple (by checking issuer or endpoints)
 */
export function isAppleProvider(provider: Partial<UpstreamProvider>): boolean {
  // Check by issuer
  if (provider.issuer === APPLE_ISSUER) {
    return true;
  }

  // Check by authorization endpoint - must be appleid.apple.com domain
  if (urlHostMatches(provider.authorizationEndpoint, ['appleid.apple.com'])) {
    return true;
  }

  // Check by token endpoint - must be appleid.apple.com domain
  if (urlHostMatches(provider.tokenEndpoint, ['appleid.apple.com'])) {
    return true;
  }

  // Check by name (case insensitive)
  if (provider.name?.toLowerCase() === 'apple') {
    return true;
  }

  return false;
}

/**
 * Create Apple provider config with custom options
 */
export function createAppleConfig(options: {
  teamId: string;
  keyId: string;
  privateKeyEncrypted: string;
  clientSecretTtl?: number;
  overrides?: Partial<UpstreamProvider>;
}): Partial<UpstreamProvider> {
  const config = { ...APPLE_DEFAULT_CONFIG };

  config.providerQuirks = {
    teamId: options.teamId,
    keyId: options.keyId,
    privateKeyEncrypted: options.privateKeyEncrypted,
    clientSecretTtl: options.clientSecretTtl || 2592000,
    useFormPost: true,
  };

  if (options.overrides) {
    return { ...config, ...options.overrides };
  }

  return config;
}
